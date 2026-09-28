---
status: proposed
---

# 多 Skill 失败扇出成按 Skill 的加权 Failure case，提案门槛只数主导 case

今天多 Skill session 里的失败被直接跳过（`buildFailureCases`），或标为 `not-attributable`。决定：一个失败主体（隐式 follow-up、显式反馈、未恢复的工具失败）按失败位置之前最近 3 个工具步的平滑后验汇总份额，份额 ≥ 0.1 的每个 Skill 各得一个 Failure case。case 带 `attributionWeight`（在这些 Skill 之间归一化，和为 1）、`noneShare`、`uncovered`、`attributionSource` 和指回 `failure-attributions` 的 `attributionId`。份额为 1 的 case（显式反馈指定了 Skill、override 指定了 Skill、只加载过一个 Skill）id 保持 `failure:<subjectId>`；扇出的 case 用 `failure:<subjectId>#<skillName>`。

优先级固定为：显式反馈 > `attributionOverride` > 只加载一个 Skill > 没加载 Skill > 后验。后验永远不改写显式反馈的目标，也不改写 override 的 Attribution 类别。`noneShare ≥ 0.5` 标「现有 Skill 未覆盖」，这时没有 Skill 达到份额下限就不产生 Failure case。session 前缀不可见时不标未覆盖。

Failure cluster 仍按 Skill 分，新增 `weightedOccurrence`。`isClusterReadyForProposal` 的 `occurrenceCount` 只数主导 case，也就是这个主体里份额最大的那个 Skill 的 case。后验尚未校准，少数份额的 case 能被看到，但不单独触发提案。`FailureOrigin` 增加 `tool-failure`。

## Considered Options

- **一个主体一个 case，带权重向量**：被拒绝。Failure cluster、诊断、提案都是按 Skill 组织的（`clusterFailureCases` 按 `skillName` 分组），带向量的 case 在每一处都要特殊处理。
- **只给份额最大的 Skill 一个 case**：被拒绝。丢掉了分摊信息，父 issue 要求「按后验分摊给各个 Skill」。
- **扇出的 case 全部计入门槛**：被拒绝。一次失败会同时在多个 Skill 上计数，而且让未校准的份额间接进入门槛（SKIL-133 交接要求校准之前置信度不进门槛或权重）。
- **所有 case 的 id 都改成 `#<skill>` 形式**：被拒绝。单 Skill case 的 id 今天已经被 Proposal 的证据引用，改了会让已有引用失效。

## Consequences

- `SkillFailureCase` 新增的字段全部可选，缺省视为权重 1，老数据和 SKIL-134 / SKIL-126 的字段不冲突。
- 份额下限、未覆盖阈值、K 都是 `SkillPosteriorParams` 的一部分，改动走重投影，不改这条 ADR。
- 来源：`docs/design/skill-window-posterior-attribution.md` §5。
