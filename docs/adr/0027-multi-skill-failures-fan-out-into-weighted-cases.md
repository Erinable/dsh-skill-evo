---
status: proposed
---

# 多 Skill 失败扇出成按 Skill 的加权 Failure case，提案门槛只数主导 case

今天多 Skill session 里的失败被直接跳过（`buildFailureCases`），或标为 `not-attributable`。决定：一个失败主体（隐式 follow-up、显式反馈、未恢复的工具失败）按截至锚点的最近 3 个工具步的平滑后验汇总份额，份额 ≥ 0.1 的每个 Skill 各得一个 Failure case。case 带 `attributionWeight`（在这些 Skill 之间归一化，和为 1）、`noneShare`、`uncovered`、`attributionSource` 和指回 `failure-attributions` 的 `attributionId`。份额为 1 的 case（显式反馈指定了 Skill、override 指定了 Skill、只加载过一个 Skill）id 保持 `failure:<subjectId>`；扇出的 case 用 `failure:<subjectId>#<skillName>`。没带 Skill 的显式反馈是事后写入的，写入时间和它评价的那一步无关，所以锚点按 `toolCallId`、`stepId`、`correlationIds` 依次找对应的工具尝试。都找不到时，份额取整个 session 的平均后验。

优先级固定为：显式反馈 > `attributionOverride` > 只加载一个 Skill > 没加载 Skill > 后验。后验永远不改写显式反馈的目标，也不改写 override 的 Attribution 类别。`noneShare ≥ 0.5` 标「现有 Skill 未覆盖」，这时没有 Skill 达到份额下限就不产生 Failure case。session 前缀不可见时不标未覆盖。

每个主体里份额最大的 case 标 `dominant: true`（并列时取 Skill 名字典序最小的），其余标 `false`。份额为 1 的 case 和老数据都视为主导 case。Failure cluster 仍按 Skill 分，`occurrenceCount` 语义不变，仍是 case 总数；新增 `dominantOccurrence`（主导 case 数）和 `weightedOccurrence`（权重和）。提案门槛有数量和 severity 两个分支，两个分支都只数主导 case：`dominantOccurrence >= 2`，或者有一个主导 case 是 `high`。门槛只实现在 `isClusterReadyForProposal` 里，`EvolutionWorkflow.propose()` 调用它，不再自己写一份判断。扇出的 case 照抄主体的 severity。后验尚未校准，少数份额的 case 能被看到，但两个分支都不会让它单独触发提案。`FailureOrigin` 增加 `tool-failure`。

## Considered Options

- **一个主体一个 case，带权重向量**：被拒绝。Failure cluster、诊断、提案都是按 Skill 组织的（`clusterFailureCases` 按 `skillName` 分组），带向量的 case 在每一处都要特殊处理。
- **只给份额最大的 Skill 一个 case**：被拒绝。丢掉了分摊信息，父 issue 要求「按后验分摊给各个 Skill」。
- **扇出的 case 全部计入门槛**：被拒绝。一次失败会同时在多个 Skill 上计数，而且让未校准的份额间接进入门槛（SKIL-133 交接要求校准之前置信度不进门槛或权重）。
- **扇出的少数份额 case 把 severity 降成 `low`**：被拒绝。severity 是失败本身的严重度，降级会让报告显示错的严重度，也会误导以后读 case severity 的地方。
- **改 `occurrenceCount` 的语义，让它只数主导 case**：被拒绝。`FailureCluster` 是公开类型，诊断置信度和报告都读这个字段，悄悄改义会让下游拿到口径变了的数。
- **所有 case 的 id 都改成 `#<skill>` 形式**：被拒绝。单 Skill case 的 id 今天已经被 Proposal 的证据引用，改了会让已有引用失效。

## Consequences

- `SkillFailureCase` 新增的字段（含 `dominant`）全部可选，缺省视为权重 1、主导 case，`FailureCluster.dominantOccurrence` 缺省时退回 `occurrenceCount`，老数据和 SKIL-134 / SKIL-126 的字段不冲突。
- 份额下限、未覆盖阈值、K 都是 `SkillPosteriorParams` 的一部分，改动走重投影，不改这条 ADR。
- 来源：`docs/design/skill-window-posterior-attribution.md` §5。
