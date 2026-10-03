---
status: accepted
---

# Skill 的上下文成本由 core 从正文确定性算出：目录描述 token 加加载正文 token，估算器 `utf8-bytes-div4-v1`，评测和 `metrics` 共用

core 的 `measureSkillContext(content)` 返回 `{ estimator: 'utf8-bytes-div4-v1', catalogTokens, loadTokens }`：`catalogTokens` 是 frontmatter 里 `name` 与 `description` 各自 `ceil(UTF-8 字节数 / 4)` 之和，`loadTokens` 是整份 `SKILL.md` 的 `ceil(UTF-8 字节数 / 4)`。Base 不存在时两项都是 0。评测结果给出 Base、Candidate 和增量，schema 2 的门槛比较绝对增量；`metrics` 对每个有当前版本的 Skill 给出同样的两项，以及按曝光和加载次数加权的合计。runner 自报的 `contextCost` 在 schema 2 下只报告，不进门槛；`metrics` 顶层的 `contextCost`（宿主自报的 `payload.inputTokens`）保持原义。

估算器 id 写进每一处结果，老数字只按它当时的估算器解读。换估算器只能新增 id，不能改写 `utf8-bytes-div4-v1` 的算法。

## Considered Options

- 继续只靠 runner 自报 `contextCost`：各 executor 口径不一，与 Skill 正文没有绑定，和 `metrics` 也对不上。被否。
- 按字符数除以 4：中文 Skill 的成本被低估到约四分之一，增量几乎看不出来。被否。
- 引入某家模型的 tokenizer：core 今天没有运行时依赖，会绑定一家模型，各家结果也不一致。被否。
- 注入可替换的 `ContextEstimator`：只有一个 adapter，是假想的 seam；需要时新增估算器 id 即可。暂不采用。
- 门槛比比例：Base = absent（create-skill）时比例没有定义；小 Skill 翻倍的实际代价可能小于大 Skill 涨 10%。被否，比绝对 token 增量。
- 把 `metrics.contextCost` 改成正文估算：会破坏已有的 `metrics` 输出消费者。被否，另加 `skillContext`。

来源：[docs/design/evaluation-execution-cost.md §5](../design/evaluation-execution-cost.md)
