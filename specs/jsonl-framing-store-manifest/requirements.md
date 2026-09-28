# JSONL 分帧与 store 清单：可验证需求

本 spec 落实已合并设计 `docs/design/jsonl-framing-store-manifest.md` 的第 2.2、2.3、4 节，范围仅为架构扫描 SKIL-109 的编号 1、2。残行的持久化语义见 ADR-0020；Observation log、去重和事实语义分别见 ADR-0002、ADR-0003、ADR-0016。

### R-1 分帧边界

WHEN 分帧器收到任意 JSONL 字节 THE SYSTEM SHALL 仅把以 `\n` 结束的非空白行返回为完整行，并把最后一个 `\n` 之后的原始字节作为残行返回；即使残行是可解析的 JSON，也不得把它算作记录。

### R-2 当前文件读取

WHEN `JsonlRecordStore`、`JsonlEventStore` 或 `ObservationLog` 读取当前文件及刷新判重 id THE SYSTEM SHALL 只解析完整行、跳过残行且不修改文件，并在完整行的 JSON 或适用 schema 无效时抛错。

### R-3 Archive segment 读取

WHEN 匹配的 Observation Archive segment 含有残行 THE SYSTEM SHALL 使 `ObservationLog.readAll()`、`query()` 和 append 判重失败并指出该段路径，不把残行当记录，也不在读取时改写该段。

### R-4 追加前隔离

WHEN 三个 append 入口在各自当前文件的锁内发现残行且要追加新记录 THE SYSTEM SHALL 先把残行字节原样写入 `<path>.invalid-<ms>-<pid>-<uuid>`，再截断当前文件至最后一个 `\n`，然后追加以 `\n` 结尾的新记录；隔离写入失败时 SHALL 抛错且保持当前文件原字节不变。

### R-5 追加与去重

WHEN `ObservationLog.append()` 收到一个出现在残行、当前文件完整行或匹配 Archive segment 中的 id THE SYSTEM SHALL 仅用完整行及匹配 Archive segment 做判重：仅在残行出现时允许重新追加，已在完整行或段中出现时返回 `false` 且不追加；成功返回 `true` 的记录在后续 repair 后 SHALL 仍可从 Observation log 读取。

### R-6 当前文件 health

WHEN `inspectJsonlHealth` 检查有残行的当前文件 THE SYSTEM SHALL 返回 `trailingPartial: true`，`completeRecords` 仅计可解析且通过适用 schema 校验的完整行；单独的残行不得使当前文件 `readable: false`，完整坏行 SHALL 使其 `readable: false`，且检查不得修改文件。

### R-7 Archive segment health

WHEN health 检查匹配的 Observation Archive segment THE SYSTEM SHALL 对完整行验证 Observation schema，并在存在残行或坏完整行时返回该段路径、`readable: false`；`completeRecords` 不计残行。

### R-8 repair 残行

WHEN repair 处理有残行的当前文件或 Archive segment THE SYSTEM SHALL 不论残行能否解析都隔离其原始字节，`truncatedTrailingBytes` 计实际字节数、`removedInvalidLines` 为残行增加一条，并只把有效完整行写回；隔离失败时 SHALL 不替换原文件。

### R-9 repair 坏完整行

WHEN repair 同时发现无效完整行与残行 THE SYSTEM SHALL 将无效完整行以 `\n` 连接并在末尾加 `\n`，再接上残行原始字节写入同一隔离文件；有效完整行和现有同段去重结果 SHALL 保留在修复文件中。

### R-10 Rotation

WHEN Observation 当前文件轮转且含残行 THE SYSTEM SHALL 复用统一分帧与隔离文件命名，仅将完整前缀归档，`RetentionResult.invalidQuarantine` 指向原始残行字节；隔离失败时 SHALL 不更改当前文件或生成归档。

### R-11 Observation 校验器

WHEN health 或 repair 校验 Observation 值 THE SYSTEM SHALL 共用 `events.ts` 导出的同一个 schema 判定函数，且与 `parseObservation` 对合法值的判定一致。

### R-12 health 的 store 清单

WHEN `EvolutionService.health()` 或 `healthReport()` 运行 THE SYSTEM SHALL 按 `layout.stores` 顺序恰好检查每个当前 store 一次，随后检查每个匹配 Observation Archive segment；当前 Observation 文件 SHALL 执行与 `parseObservation` 一致的 schema 校验。

### R-13 repair 的 store 清单

WHEN `EvolutionService.repair()` 运行 THE SYSTEM SHALL 恰好修复 `layout.stores` 中每个当前 store 一次及每个匹配 Observation Archive segment 一次；非 Observation store 路径从 `layout.stores` 派生，Observation 当前文件和段仍在当前文件锁内修复，`repairEvolutionRoot` 的公开签名不变。

### R-14 兼容范围

WHEN 本次分帧和清单迁移完成 THE SYSTEM SHALL 保留现有 store、service、health、repair 和 Rotation 的公开调用签名及 Observation log 的跨归档去重行为；新分帧模块仅作为 core 内部依赖，不从 `index.ts` 导出。
