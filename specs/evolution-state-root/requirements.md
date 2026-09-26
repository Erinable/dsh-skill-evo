# 演化状态根目录：可验证需求

本 spec 落实已合并设计 `docs/design/evolution-state-root.md` 的 §3–§6，以及 SKIL-42 的评审意见。成员已确认：A1 保持现有布局，A2 归档属于事实，A3 缺省不删除归档。`root` 指 SkillVersionStore 的根目录；`observationStore` 是可独立覆盖的事实文件路径。

### R-1 布局唯一来源

WHEN 调用 `resolveLayout({ root, observationStore? })` THE SYSTEM SHALL 返回现有 `<root>/.skill-evolution/` 的九个具名 store 描述（五个 fact、四个 derived，只有 observations 是 projection input）、cursor、locks、candidates、报告目录和 `<root>/<skill>/versions/` 的路径；提供 `observationStore` 时 SHALL 只覆盖 observations 的路径，归档目录 SHALL 位于该文件的同级 `archive/`，其他路径不变。

### R-2 历史文件就地使用

WHEN 升级已有状态目录 THE SYSTEM SHALL 不移动文件、不改变 JSONL schema 或归档文件名 `<basename>.<ISO-with-colons-replaced>.<pid>.jsonl`，并能读取升级前形成的匹配归档段；旧 cursor 与完整事实流不匹配时 SHALL 在下一次正常 refresh 中重投影。

### R-3 完整事实流

WHEN `ObservationLog.readAll()` 或 `query()` 读取 observations THE SYSTEM SHALL 按匹配归档段的文件名字典序、随后当前文件的顺序，返回每个 event id 的首条记录；不属于当前 store basename 的归档文件 SHALL 被忽略，`query()` 的现有过滤条件和边界 SHALL 保持不变。

### R-4 幂等追加

WHEN `ObservationLog.append()` 收到已存在于任一匹配归档段或当前文件的 id THE SYSTEM SHALL 返回 `false` 且不追加任何字节；收到新 id 时 SHALL 只向当前文件追加，跨实例和跨进程的并发写入 SHALL 沿用当前文件的锁互斥。

### R-5 追加热路径

WHEN 同一 `ObservationLog` 实例连续追加、归档段未改变 THE SYSTEM SHALL 按段文件名及至少 `ino + size + mtimeMs` 的文件签名缓存归档 id，后续 append 仅重新读取当前文件，不重新读取已缓存归档内容；WHEN 匹配归档段新增、经原子替换修复或被显式 retention 删除 THE SYSTEM SHALL 在下次判重前根据磁盘签名更新或失效受影响的缓存，而不使用过期 id。每个进程独立检查磁盘签名，重启后 SHALL 从磁盘重建。

### R-6 轮转语义

WHEN 当前 observation 文件达到 `maxBytes` 并执行 `ObservationLog.rotate()` THE SYSTEM SHALL 在同一当前文件锁下将最后一个 `\n` 之后的未换行尾部字节先原样保存到该文件旁的 `.invalid-*` 隔离文件，再只将完整行归档并建立空的当前文件；即使没有完整行也 SHALL 建立空归档段。返回的 `RetentionResult` SHALL 在隔离发生时给出 `invalidQuarantine` 路径；隔离写入失败时 SHALL 抛错且不改当前文件或生成归档。归档后的 `readAll()` 与投影输入 SHALL 包含轮转前全部完整事实，`append()` SHALL 可正常追加新事实；低于阈值时 SHALL 不轮转。

### R-7 保留期

WHEN `retentionDays` 未传入 THE SYSTEM SHALL 不自动删除任何匹配归档段且 `RetentionResult.deleted` 为空；WHEN 显式传入合法正数 THE SYSTEM SHALL 仅按现有 mtime 截止规则删除当前 store 的过期匹配段，并在结果中列出实际删除的路径。

### R-8 派生状态不丢失

WHEN 已投影的 observations 轮转后调用 `EvolutionService.refreshDerived()` THE SYSTEM SHALL 保持 experiences、failures、clusters、diagnoses 的内容及确定性 id；WHEN 旧版本已因轮转清空派生文件而完整归档仍在 THE SYSTEM SHALL 在首次 refresh 后从完整事实流恢复这些派生记录。

### R-9 归档坏行可见

WHEN 匹配归档段包含无效 JSON、无效 observation schema 或未换行的尾部残行 THE SYSTEM SHALL 使 `ObservationLog.readAll()`/`query()`/`append()` 明确失败并指出段路径，不跳过该段或返回不完整事实流；当前文件的未换行尾部残行 SHALL 保持现有读取容忍行为。

### R-10 health 覆盖归档

WHEN `EvolutionService.health()` 或 `healthReport()` 检查状态 THE SYSTEM SHALL 返回九个当前 store 及每个匹配 observation 归档段的 `JsonlHealth`，段路径可辨、坏行或残行使该段 `readable: false`；没有 archive 目录 SHALL 是正常空集合，health SHALL 不修改文件。

### R-11 repair 覆盖归档

WHEN `EvolutionService.repair()` 遇到匹配归档段中的坏行、残行或同段重复 id THE SYSTEM SHALL 持有 `${observationsPath}.lock` 隔离无效原文并原子替换修复该段，在报告的 `jsonl` 中包含该段的 `JsonlRepairResult`，且不嵌套获取当前文件锁或段锁；其他 store 的归档和不匹配文件 SHALL 不受影响。成功修复后，本进程和其他进程中既有实例的下一次读取 SHALL 根据文件签名使用修复后的内容。

### R-12 cursor 单一语义

WHEN `refreshDerived` 完成四个派生 store 的重投影 THE SYSTEM SHALL 用同一 `fingerprintOf(ids)` 算法原子写入 cursor 的 `count`、`lastId`、`fingerprint`；cursor 仅在四个派生写入全部成功后表示新鲜。WHEN cursor 缺失、损坏或字段不匹配 THE SYSTEM SHALL 重投影。

### R-13 repair 强制重投影

WHEN `EvolutionService.repair()` 成功修完当前文件与归档 THE SYSTEM SHALL 无条件用修复后的完整 observation 事实流重投影四个派生 store，并由 refresh 写入真实 cursor；即使修复前 cursor fingerprint 匹配也 SHALL 恢复被隔离的派生记录，不写入 `{}` 假 cursor。

### R-14 repair 报告与独立 API

WHEN 独立调用公开的 `repairEvolutionRoot(root, options)` THE SYSTEM SHALL 保留其导出和调用签名、执行 JSONL/锁/manifest 检查，但不读写或删除 projection cursor，且返回 `projectionCursorRebuilt: false`；WHEN `EvolutionService.repair()` 成功完成强制重投影和 cursor 写入 THE SYSTEM SHALL 返回 `projectionCursorRebuilt: true`，失败时 SHALL 抛错而不声称重建成功。独立调用遇到 observation 尾部残行 SHALL 不因重建 cursor 而抛 `SyntaxError`。

### R-15 公开兼容接口

WHEN 外部代码导入 `JsonlEventStore` 或 `rotateJsonl(path, options)` THE SYSTEM SHALL 保留两者的导出、签名及各自当前文件读写/通用 JSONL 轮转用途；文档 SHALL 将它们标为旧用法，指向归档感知的 `ObservationLog`，并说明 `JsonlEventStore` 不提供跨归档的逻辑事实流语义。`rotateJsonl` 与 `ObservationLog.rotate` SHALL 共用归档命名、锁、尾部隔离行为及缺省 retention 规则；`RetentionResult` 仅增加可选 `invalidQuarantine` 字段。

### R-16 入口接线

WHEN CLI 使用 `--store` 或 bundle 使用覆盖/默认 observation store THE SYSTEM SHALL 让观察写入、维护命令及 CLI 默认 rotate 作用于同一个 `resolveLayout` observation 路径；显式 `--file` SHALL 仍覆盖 CLI rotate 目标。bundle 的实时 adapter SHALL 构造 `ObservationLog`，不经 service 的写入 SHALL 也跨归档去重。

### R-17 路径调用方与文档

WHEN service、repair、lifecycle、CLI 或 bundle 需要演化状态路径 THE SYSTEM SHALL 从 `resolveLayout` 获取，保留 Skill 原位的 `versions/` 和现有发布锁位置；`docs/architecture-design-zh.md` §4.3 与 core、adapter、bundle 的相关 README SHALL 描述实际集中布局、可覆盖的 observation 路径及 archive/retention/cursor 语义。
