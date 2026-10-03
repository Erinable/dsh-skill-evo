---
status: accepted
---

# `user-follow-up` Observation 追加两个可选字段，记录跟进所回应那一轮的最后一次工具活动，只用 core 词汇

bundle 的默认 mapper 写 `user-follow-up` 时，在 `payload` 里多写两个可选字段。「那一轮」指同一 session 里、上一条人类用户消息之后到这条跟进之前的这段：

- `precedingToolKind`：这一轮里最后一条 `skill-load-requested` / `skill-loaded` / `skill-load-failed` / `tool-result` 的 `ObservationKind`。这一轮没有这几类记录时不写。
- `precedingToolFailed`：上面那条是 `skill-load-failed`，或者是 `payload.failed === true` 的 `tool-result` 时，写 `true`；否则不写。

已有字段的名字和语义都不变，没有这两个字段的旧记录照常能读。离线规则优先读这两个字段；字段缺失时（旧记录、自定义 `config.mapEvent`、mapper 的 session 状态已过期），按 Observation log 里同一 session 的顺序推断，以上一条非显式的 `user-follow-up` 或 session 开头作为这一轮的起点。字段一旦写进 Observation log，就不能删，也不能改义（ADR-0002、ADR-0016），所以字段名、取值和「只用 core 词汇」这条约束要现在定。

与 ADR-0014 的关系：取值只用 core 的 `ObservationKind`，不记 DSH 原始的 `event.type`，core 规则因此不需要认识 DSH 的事件名。与 ADR-0003 的关系：这两个字段照常经 `ObservationLog` 写入，去重规则不变。

## Considered Options

- 不改 bundle，只按 log 顺序离线推断。默认 mapper 下大多能推出来，但有三个缺口：session 的第一条用户消息落成通用的 `agent-step`，只有 DSH 的 `payload.eventType` 能认出它，core 不能用，因此第一轮的起点只能取 session 开头；Retention 删掉前一段 Archive segment 以后推不出来；自定义 mapper 的记录顺序没有保证。这条保留为旧记录的退路，不作为唯一来源。成员不同意加字段时，这是默认的替代方案。
- 记紧邻的前一条 Observation 的 kind：每轮结束都会先写 `task-finished`，助手回复落成 `agent-step`，这个字段几乎永远是这两个值之一，没有信息量。被否。
- 记 DSH 原始的 `precedingEventType`（如 `tool/result`）：core 规则就得解析 DSH 的事件名，违反 ADR-0014 的依赖方向。被否。
- 记前一条助手回复的摘录，给分类器当上下文：会把模型输出写进事实流，有隐私和体积风险，也超出「向后兼容的增量字段」。被否。

来源：[docs/design/follow-up-intent-classification.md §2.8](../design/follow-up-intent-classification.md)

成员确认：SKIL-126
