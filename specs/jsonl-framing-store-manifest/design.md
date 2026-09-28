# 设计：统一 JSONL 分帧与 store 清单

## 决定与当前假设

- **已接受决定：**残行不是记录；持锁写入前先隔离原始字节再截断，Archive segment 只读且遇残行报错。见 ADR-0020。Observation log 的完整事实流、跨归档去重及事实 append-only 语义见 ADR-0002、ADR-0003、ADR-0016；维护用例归 core 见 ADR-0006。本文不重复这些决定。
- **本次实现选择：**按已合并设计 `docs/design/jsonl-framing-store-manifest.md` §2.2 A 和 §2.3 A，在 core 新增内部 `jsonl.ts`；`health()`、`repair()` 从 `layout.stores` 派生路径，构造保留公开的类型化字段。采用默认答案，成员可推翻。
- **当前假设：**`resolveLayout` 的九个 descriptor 及顺序仍是唯一清单，匹配 Archive segment 仍由 `archivePaths` 枚举；公开报告类型和 `repairEvolutionRoot` 签名不变。新增 store 时通过遍历自动进入 health/repair，无需再维护服务内的路径数组。

## 模块与数据流

`packages/skill-evolution/src/jsonl.ts` 仅依赖 `node:*`，不持锁、不解析 JSON/schema、不从 `src/index.ts` 导出。调用方继续负责 `${path}.lock`、逐行解析、id 去重和公开返回值。内部接口按以下语义实现，名称沿用上游设计：

| 接口 | 输入与输出 |
|---|---|
| `splitFrames(bytes: Buffer)` | 返回无尾随换行符、已滤去空白行的完整行字符串，以及最后一个换行符之后的原始 `Buffer` 残行。无换行符的整个文件都是残行。 |
| `readFrames(path)` | 从文件读取并调用 `splitFrames`；文件不存在返回空行和空残行，其他 I/O 错误继续抛出。 |
| `appendFrames(path, lines)` | 调用方已持锁，`lines` 是不含换行符的序列化记录。残行先写到 `quarantinePath(path)`，成功后截断，再一次追加以换行符结尾的记录；返回隔离路径。 |
| `quarantinePath(path)` | 统一生成 `<path>.invalid-<ms>-<pid>-<uuid>`。 |

`records.ts`、`store.ts` 和 `state-root.ts` 的当前文件读取、初始化及刷新 id 都通过 `readFrames` 得到完整行；各自保留 JSON/schema 解析和去重。三处 append 在原有锁与写队列内调用 `appendFrames`，Observation 序列化结果须传入不含结尾换行符的行。`ObservationLog` 继续先检查 Archive segment 再检查当前文件；段使用 `readFrames`，发现 `tail.length > 0` 时带路径报错。`rotateFile` 使用 `splitFrames` 与 `quarantinePath`，保留现有锁、归档命名和 `RetentionResult`。

`health.ts` 用 `splitFrames` 只数完整行；当前文件有残行时报告 `trailingPartial`，匹配 Archive segment 还要求尾部完整。`repair.ts` 以 `Buffer` 读取并分帧，完整坏行可按文本隔离，残行必须按原始字节拼入隔离文件；有隔离内容时先写成功再原子替换原文件。`events.ts` 导出 `isObservationValue`，供 `service.ts` 和 `repair.ts` 调用，避免两个本地实现再次分叉。`repairJsonlFileUnlocked` 仍由调用方在 Observation 当前文件锁内调用。

`EvolutionService` 的构造保留按名字从 `layout.stores` 取路径的公开类型化 store 字段。`health()` 遍历 `layout.stores`，当前 Observation 额外传 `isObservationValue`，再追加匹配段的 health 报告。`repair()` 从 `layout.stores` 过滤掉 observations 得到 `jsonlPaths`；observations 和段沿用当前文件锁内的独立修复路径。这样 store 清单只在 `resolveLayout` 定义，输出路径集合由它决定；健康报告的数组顺序有意随 descriptor 顺序改变。

依赖方向为 `records.ts`、`store.ts`、`state-root.ts`、`health.ts`、`repair.ts` → `jsonl.ts` → `node:*`。`events.ts` 只负责 Observation schema。CLI、bundle 仍通过 core 的既有接口操作，不新增 adapter 逻辑。

## 失败处理与兼容性

- 隔离写入失败：append/Rotation/repair 抛错，原文件不变。完整行解析失败：读取方抛错，repair 负责隔离；读取方不得跳过完整坏行。
- 隔离完成但截断前崩溃：下一次操作可能生成内容相同的第二份隔离文件；原始字节仍可追溯。旧版进程混跑期间仍可能直接把新记录接在残行后；需要所有写入进程升级才能消除这一风险。
- 外部工具写入的可解析但未换行 JSON 仍是残行，第一次 append 或 repair 会隔离它，不自动恢复。Archive segment 上同样适用；这改变了 `archive-health-repair.spec.ts` 对 `tail` 的旧预期，按 ADR-0020 该字节串从未构成记录，不与既有 spec 的「有效记录保留」冲突。
- health 是只读检查且不获取文件锁；它观察到的 `trailingPartial` 可能来自并行写入。store/Observation 读取与追加仍沿用原锁。磁盘格式和现有公开 API 不迁移。

## 验证策略

以真实临时文件验证分帧和字节隔离，尤其是可解析残行与截断 UTF-8；用故障注入验证隔离失败时原文件不变。用上游设计 §1.3 的 probe A、probe B、probe C 建回归测试，并覆盖 Archive segment 残行的读错、health 标红、repair 隔离。对 `layout.stores` 比较 health/repair 报告的路径集合与顺序，同时验证覆盖的 Observation 路径、schema 错误以及无归档目录。每个 Builder task 合并前运行 core、adapter、bundle 三个包的测试；核心变更还运行 core build。
