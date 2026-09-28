---
status: proposed
---

# EvaluationPolicy 加 schema 2：分类别成本门槛和 R 次采样；Evaluation artifact 存 policy 快照、`policyHash`、原始 Sample 和统计方法 id

`EvaluationPolicy` 以 `schema: 2` 区分新形状，没有 `schema` 的 policy 按 schema 1 执行、行为不变。schema 2 包含 `sampling.runs`（缺省 5）、`significance.alpha`（缺省 0.05）、`originalFailure`（`requireImprovement`、`costMetric` 缺省 `steps`、`minCostReduction` 缺省 0.2）、`historicalSuccess`（`maxPassRateDrop` 0.05、`maxStepIncrease` 0.1、`maxTokenIncrease` 0.1）、`context`（`maxCatalogIncreaseTokens` 64、`maxLoadIncreaseTokens` 1024）。字段缺省取缺省值，`null` 显式关掉一项检查。original-failure 的改进要求是「通过用例数增加」或「双方都通过的用例上成本显著下降」二者之一。缺数据的成本检查记为「无数据」且不通过。`DEFAULT_EVALUATION_POLICY` 保持 schema 1。

Evaluation artifact 新增 `schemaVersion: 2`、归一化后的 `policy` 快照、`policyHash`、每个用例每一侧的原始 Sample，以及统计方法 id `stratified-permutation-v1`（分层精确置换检验，单侧，超过 10 000 个排列时用由 `candidateContentHash` 派生种子的确定性抽样）。promote 时 artifact 带 `policyHash` 就要求它等于当前 policy 的 hash，不带时只比 `policyVersion`。`DecisionRecord` 可选写 `policyHash`。

policy 文件和 artifact 都是会被长期读取的数据格式：artifact 是 Fact record（ADR-0016），promote 依据它判断证据是否对应当前门槛。字段名、缺省值和「缺数据不通过」的语义一旦有 artifact 落盘，就不能改义。

## Considered Options

- 在 schema 1 上直接加可选字段、不分 schema：`requireOriginalFailureImprovement` 与新的改进规则、全局比例与分类别比例会同时存在，同一个意思有两处写法，老文件的含义也会因为新增缺省值而改变。被否。
- 把默认 policy 换成 schema 2：默认的 content-check runner 不报步数和 token，每次评测都会卡在「无数据」。被否。
- 只靠人手写的 `version` 绑定 artifact 与门槛：改了阈值忘了改版本号，旧证据会被当成新门槛的证据。被否，加 `policyHash`。
- 统计方法用 Welch t 检验或置信区间：步数是小整数、偏态，R = 5 时正态假设不成立；Base 和 Candidate 都恒定（6 步对 2 步）时方差为 0，检验无定义。被否。
- bootstrap 区间：R = 5 时覆盖率差，区间退化成一个点。被否。
- 跨用例符号检验：只有一个用例的类别永远不可能显著。被否。
- artifact 只存汇总统计、不存原始 Sample：以后换统计方法就只能重跑 2RN 次模型调用。被否。
- R 允许在 CLI 上覆盖：同一个 policy 版本号会对应两种证据强度。被否，R 只在 policy 里配。

来源：[docs/design/evaluation-execution-cost.md §4、§6、§7](../design/evaluation-execution-cost.md)
