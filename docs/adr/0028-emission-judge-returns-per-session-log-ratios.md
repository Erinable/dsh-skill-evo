---
status: accepted
---

# 发射模型的注入 interface 按 session 批量返回相对 none 的对数似然比，硬约束和跳过步骤由 core 计算

宿主可以注入 embedding 或 LLM 发射模型，这是一个会被外部实现的公开 interface。决定：`SkillEmissionJudge = DerivedJudge<EmissionInput, EmissionOutput>`，`DerivedJudge` 直接用已合并的 `docs/design/tool-correction-create-skill.md` §4.2 的定义。一个 session 调用一次，输入是这个 session 的工具步（字段与同一份设计稿 §4.1 的 `ToolAttempt` 同名同义：`toolName`、`command`、`argKeys`、`outcome`、`exitCode`、`errorLine`，采集与脱敏见 ADR-0023）和出现过的全部 Skill（名字、`contentHash`、能取到时的正文）；输出是 `[step][skill]` 的对数似然比矩阵，none 恒为 0，另可选地给出 `{stepIndex, skillName, skillStep}` 对齐。`version` 是契约：同版本同输入必须同输出。

发射实现不知道资格区间，对每个 Skill 都打分；core 在 forward-backward 里只用资格区间内的列，所以「未加载的 Skill 后验恒为 0」只有一处实现，任何注入都破坏不了。core 校验输出（维度、有限数、裁剪到 [−10, 10]），不合格时这个 session 回退到规则实现。「Skill 里哪些步骤被跳过」由 core 根据对齐结果算出，发射实现只报告对齐。

## Considered Options

- **逐对打分 `score(step, skill)`**：被拒绝。LLM 实现一个 session 要调 T×S 次，而且失去了整个 session 的上下文。
- **注入实现直接返回后验**：被拒绝。硬约束和转移模型要由每个实现各自保证，验收「未加载 Skill 后验恒为 0」就没法在 core 里保证。
- **返回概率而不是对数似然比**：被拒绝。none 的发射没有自然的绝对尺度，相对 none 的比值让规则实现和模型实现落在同一个尺度上，也便于裁剪。
- **发射实现自己报告跳过的步骤**：被拒绝。每个实现都要各写一遍，结果口径不一致。

## Consequences

- 规则实现 `rule-1` 同样实现这个 interface，测试可以用假实现替换它。
- 改 interface 要改所有宿主实现，所以 `EmissionStep` 只放 `ToolAttempt` 已有的字段；新增字段只能是可选的。
- 来源：`docs/design/skill-window-posterior-attribution.md` §3.3。
