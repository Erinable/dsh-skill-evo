---
status: proposed
---

# JSONL 记录以 `\n` 结尾；残行永远不是记录，任何写入前先隔离并截断

所有演化状态 JSONL 文件（当前文件、Archive segment、派生 store）采用同一条分帧规则：一条记录是以 `\n` 结尾的一行 UTF-8 JSON；文件最后一个 `\n` 之后的字节是**残行**，不论能否解析都不算记录。持锁的读取方跳过残行并报告它，不改文件。持锁的写入方（append、Rotation、repair）写之前先把残行原样写进隔离文件 `<path>.invalid-<ms>-<pid>-<uuid>`，再把文件截断到最后一个 `\n`，然后再写。Archive segment 只读，不做截断：Archive segment 里出现残行说明文件已损坏，读取方直接报错，只有 repair 负责把它隔离。

这样做是因为 append 和读取都在 `<path>.lock` 下进行，持锁时看到的残行只可能是崩溃遗留，不可能是另一个写入方正在写的数据。先隔离再写，下一条记录才不会和残行拼成一行。否则 ADR-0002 就被打破：append 返回 `true` 的 Observation 在 repair 隔离那一整行之后，就不在 Observation log 里了。

与已有 ADR 的关系：

- **ADR-0002**：隔离文件不属于 Observation log。本规则保证每条 append 返回 `true` 的记录都留在 Observation log 里，直到 Retention 显式删掉它所在的段。
- **ADR-0003**：跨归档去重仍然放在 observation log 类里。残行不是记录，所以去重看不到它。同一 id 重投递时会重新追加，结果只出现一次。
- **ADR-0016**：这里明确一个解释：append-only 约束的是**记录**。截断残行不算修改事实，因为残行从来没有被确认写入（写入方在 append 返回之前就崩溃了），而且它的字节原样保存在隔离文件里。

## Considered Options

- **只封口**（append 前补一个 `\n`）：被拒绝。残行会变成一行完整的非法记录，读取方要么一直抛错（和今天的 `JsonlRecordStore` 一样卡住，Runtime loop 的 append 也跟着失败），要么静默跳过非法行、掩盖真正的损坏。
- **直接截断，不隔离**：被拒绝。它会悄悄丢掉字节，出事后没法排查。repair 和 Rotation 现在都保留非法输入，这条惯例要继续保持。
- **能解析的残行封口后保留，不能解析的才隔离**（今天 `repair.ts` 的做法）：被拒绝。这样「是不是记录」就取决于解析器，读取方、health、repair 得各自判断，而今天它们已经不一致：同一个文件，`readAll` 返回 1 条，health 报 2 条，repair 保留 2 条。一个能解析的残行等于缺了换行符的一整条记录，这种情况只会在写入中途失败时出现，它的字节仍然留在隔离文件里。
- **读取方跳过所有非法行**：被拒绝。完整行损坏是真正的数据损坏，必须报出来，不能静默丢掉。
- **改成长度前缀或带校验和的帧格式（v2）**：被拒绝。它要迁移全部线上文件，会破坏 `jq` / `grep` 这类逐行工具，而这里的问题只出在文件尾部。

## Consequences

- 隔离文件名统一为 Rotation 现在用的 `<path>.invalid-<ms>-<pid>-<uuid>`，repair 不再用另一种拼法。
- repair 对能解析的残行，行为从「封口保留」改为「隔离」，`truncatedTrailingBytes` 统一按字节计。health 的 `completeRecords` 不再计入残行。
- 部署期间旧版进程仍可能不先隔离就追加，把两段拼成一行。所有进程都升级之后，这个风险才消失。

来源：[docs/design/jsonl-framing-store-manifest.md §2.1](../design/jsonl-framing-store-manifest.md)
