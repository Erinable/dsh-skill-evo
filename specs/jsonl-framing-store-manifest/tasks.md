# Builder 任务（按阻塞依赖排序）

每条任务可在其前置任务合并后独立交付。T1 是从磁盘字节读取、分帧、隔离、追加到再次读取的最薄端到端闭环；其余调用方按上游设计 §4 分批迁移。T5 无前置依赖，可与 T1 并行。每条完成时运行 `npm --prefix packages/skill-evolution run build`、`npm --prefix packages/skill-evolution test`、`npm --prefix packages/dsh-adapter test`、`npm --prefix packages/dsh-bundle test` 并保持通过。

## Task 1 — 建立分帧到隔离追加的闭环

- **Depends on:** none。
- **Requirements:** R-1、R-4、R-14。
- **范围:** 新增内部 `packages/skill-evolution/src/jsonl.ts` 和 `packages/skill-evolution/tests/jsonl.spec.ts`，实现 `splitFrames`、`readFrames`、`appendFrames`、`quarantinePath`；保留现有调用方，暂不导出公开 API。所有带 I/O 的写操作要求调用方已持有文件锁。
- **验收:** 临时文件测试覆盖空文件、无尾、普通残行、可解析残行、截断 UTF-8 残行、空白行和无换行符文件；完整行解析由测试调用方完成，验证残行不进入记录。无残行时直接追加；有残行时端到端读取、隔离、截断、追加、再读取，断言 `.invalid-<ms>-<pid>-<uuid>` 文件字节与原残行逐字节相同，新文件是「完整前缀 + 新记录及换行符」。注入隔离失败，断言原文件字节不变且追加抛错。

## Task 2 — 迁移通用 record 与 event store

- **Depends on:** Task 1。
- **Requirements:** R-1、R-2、R-4、R-14。
- **范围:** `JsonlRecordStore`、`JsonlEventStore` 的初始化、读/查询、刷新 id 与 append 改用 T1；删除两处独立的分帧实现，保留各自的解析器、锁、写队列与公开签名。
- **验收:** probe A：在完整记录 `a` 后写入残行 `{"id":"b","torn":tr`，`append(c)` 返回 `true`，`readAll()` 是 `[a, c]`，`append(d)` 继续成功，隔离文件含残行原字节；另为 `JsonlEventStore` 做同形测试。可解析残行 id 不参与判重；完整坏行仍使读取或 append 抛错；原有两类 store 测试与四项包命令通过。
- **风险:** 部署期间旧版进程仍可把记录接到残行后，所有写入进程升级后才消失。

## Task 3 — 迁移 Observation log 与 Rotation

- **Depends on:** Task 1。
- **Requirements:** R-1、R-2、R-3、R-4、R-5、R-10、R-14。
- **范围:** `ObservationLog` 当前文件的读取、判重和 append、Archive segment 的读取及 `rotateFile` 改用 T1；保留跨归档去重、同一当前文件锁与现有 Rotation 接口。
- **验收:** probe B：`e1` 后留 30 字节残行，`recordObservation(e2)` 返回 `true`，`readAll()` 是 `[e1, e2]`；`service.repair()` 后仍是 `[e1, e2]`，observations 的 `removedInvalidLines` 为 `0`，原残行可从隔离文件按字节找回。同一 id 写在残行中后重投递仅出现一次。Archive segment 有残行时 `readAll()`、`query()` 和 append 均带段路径失败；Rotation 使用 `quarantinePath` 命名并仅归档完整前缀。四项包命令通过。
- **风险:** 混跑旧版写入进程时仍可能发生拼行；隔离完成后、截断前崩溃可能留下两份相同隔离文件。

## Task 4 — 统一 health、repair 与 Observation schema 校验

- **Depends on:** Task 1。
- **Requirements:** R-1、R-6、R-7、R-8、R-9、R-11、R-14。
- **范围:** `health.ts`、`repair.ts` 改用 T1；`events.ts` 导出统一 `isObservationValue` 并替代 service/repair 两份本地实现。`repairJsonlFile` 与 `repairJsonlFileUnlocked` 的锁契约、原子替换和报告类型保持不变。
- **验收:** probe C：完整行 `a` 后接可解析但无换行符的 `b`，`readAll()`、health `completeRecords`、repair `validRecords` 都为 1，`truncatedTrailingBytes` 等于 `b` 的字节数，`removedInvalidLines` 为 1。截断 UTF-8 残行隔离文件与原字节相同；完整坏行及残行共存时隔离内容符合 R-9。当前文件残行 health 报 `trailingPartial: true` 且不因此标不可读；Archive segment 残行标不可读，repair 后仅保留完整行。隔离失败时原文件不变。
- **现有断言迁移:** `archive-health-repair.spec.ts` 中原来期望 `['kept', 'also-kept', 'tail']` 的两处改为 `['kept', 'also-kept']`，并断言 `tailPath` 的 `invalidQuarantine` 等于原尾部字节；其余 archive health/repair、`repair.spec.ts:104-112`、`core.spec.ts:172-182,248-262,264-316` 的行为继续通过。四项包命令通过。
- **风险:** 可解析但未换行的外部记录，以及 Archive segment 上这样的尾部，都会进入隔离文件而不自动恢复；这是 ADR-0020 对「记录」的定义，不能按旧断言封口保留。

## Task 5 — 让 service 只消费 layout 的 store 清单

- **Depends on:** none；可与 Task 1 并行。
- **Requirements:** R-12、R-13、R-14。
- **范围:** `service.ts` 的 `health()` 遍历 `layout.stores`，当前 Observation 用 schema 校验，随后追加匹配 Archive segment；`repair()` 用 `layout.stores` 过滤 observations 生成 `jsonlPaths`，Observation 当前文件和段仍在当前文件锁内单独修复。构造中的类型化字段和按名字取路径保持不变；如 T4 尚未合并，先使用现有校验器，合并 T4 后改用其导出。
- **验收:** 对默认 layout 与覆盖 Observation 路径分别断言 health 路径按 `layout.stores` 顺序恰好出现一次、随后是匹配段；repair `jsonl` 的路径集合恰好为当前 descriptor 路径与匹配段，无遗漏/重复；无 archive 目录时两者均返回九个当前 store。当前 Observation 完整行含 schema 错误时 health 报该路径 `readable: false`；独立 `repairEvolutionRoot` 调用签名与报告保持兼容。四项包命令通过。
- **风险:** health 数组顺序随 `layout.stores` 改变；仓库内按路径查找的调用方不依赖旧顺序。
