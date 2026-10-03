---
status: accepted
---

# EvaluationPolicy 加 schema 2：分类别成本门槛和 R 次采样；Evaluation artifact 存 policy 快照、`policyHash`、原始 Sample 和统计方法 id

`EvaluationPolicy` 以 `schema: 2` 区分新形状，没有 `schema` 的 policy 按 schema 1 执行、行为不变。schema 2 包含 `sampling.runs`（缺省 5）、`significance.alpha`（缺省 0.05）、`originalFailure`（`requireImprovement`、`costMetric` 缺省 `steps`、`minCostReduction` 缺省 0.2）、`historicalSuccess`（`maxPassRateDrop` 0.05、`maxStepIncrease` 0.1、`maxTokenIncrease` 0.1）、`context`（`maxCatalogIncreaseTokens` 64、`maxLoadIncreaseTokens` 1024）。字段缺省取缺省值，`null` 显式关掉一项检查。original-failure 的改进要求是二者之一：「通过用例数增加」；或者「每个可比用例（双方用例级都通过）上 Candidate 的 Sample 级通过次数不少于 Base，**并且**可比用例上成本显著下降」。`steps-or-tokens` 的两次检验各用 α/2，`steps-and-tokens` 各用 α（交并检验，不校正）。historical-success 的 `maxPassRateDrop` 是用例级的，R = 1 时与 schema 1 同义。缺数据的成本检查记为「无数据」且不通过。`DEFAULT_EVALUATION_POLICY` 保持 schema 1。

Evaluation artifact 新增 `schemaVersion: 2`、归一化后的 `policy` 快照、`policyHash`、每个用例每一侧的原始 Sample，以及统计方法 id `stratified-permutation-v1`。这个 id 固定整套算法：分层精确置换检验，单侧，层是按输入顺序排列的可比用例；排列数不超过 10 000 时精确枚举；超过时抽 10 000 次，`p = (1 + #) / 10 001`，随机源是 `seed = sha256(candidateContentHash ‖ '\n' ‖ category ‖ '\n' ‖ metric)`、第 `j` 块 `sha256(seed ‖ uint32be(j))` 拼成的字节流，每 4 字节大端读成 uint32，用拒绝采样取区间整数，每层对 `[base 通过 Sample, candidate 通过 Sample]` 做 Fisher–Yates（`k` 从 `L−1` 降到 1，`j ∈ [0, k]`）。改其中任何一步都要换新 id。

promote 按当前 policy 归一化后的 schema 校验：schema 2 时 artifact 必须带 `policyHash` 且与当前 policy 的 hash 相等，不带或不等都是 `evaluation-mismatch`；schema 1 时 artifact 带 `policyHash` 就要求相等，不带只比 `policyVersion`，与今天一致。`DecisionRecord` 可选写 `policyHash`。

policy 文件和 artifact 都是会被长期读取的数据格式：artifact 是 Fact record（ADR-0016），promote 依据它判断证据是否对应当前门槛。字段名、缺省值和「缺数据不通过」的语义一旦有 artifact 落盘，就不能改义。

## Considered Options

- 在 schema 1 上直接加可选字段、不分 schema：`requireOriginalFailureImprovement` 与新的改进规则、全局比例与分类别比例会同时存在，同一个意思有两处写法，老文件的含义也会因为新增缺省值而改变。被否。
- 把默认 policy 换成 schema 2：默认的 content-check runner 不报步数和 token，每次评测都会卡在「无数据」。被否。
- 只靠人手写的 `version` 绑定 artifact 与门槛：改了阈值忘了改版本号，旧证据会被当成新门槛的证据。被否，加 `policyHash`。
- schema 2 下也允许不带 `policyHash` 的 artifact 退回只比 `policyVersion`：policy 换成 schema 2 却没换版本号时，没有 R 次 Sample 和成本统计的老证据会被当成新门槛的证据。`validateEvaluationPolicy` 无法检查版本号是否变过。被否。
- 成本路径只看可比用例上的成本、不看 Sample 级通过次数：Base 5/5 每次 6 步、Candidate 3/5 每次 2 步时，用例级双方都通过，成本降 66.7%、p = 1/56，门槛会放过一个通过概率从 1.0 掉到 0.6 的 Candidate。被否。
- 成本路径改为「Candidate 不稳定的用例不进检验」：Base 2/5、Candidate 3/5 的改进会被误挡，双方都是 4/5 时又不起作用，和「通过率不下降」对不上。被否。
- 统计方法用 Welch t 检验或置信区间：步数是小整数、偏态，R = 5 时正态假设不成立；Base 和 Candidate 都恒定（6 步对 2 步）时方差为 0，检验无定义。被否。
- bootstrap 区间：R = 5 时覆盖率差，区间退化成一个点。被否。
- 跨用例符号检验：只有一个用例的类别永远不可能显著。被否。
- artifact 只存汇总统计、不存原始 Sample：以后换统计方法就只能重跑 2RN 次模型调用。被否。
- R 允许在 CLI 上覆盖：同一个 policy 版本号会对应两种证据强度。被否，R 只在 policy 里配。

来源：[docs/design/evaluation-execution-cost.md §4、§6、§7](../design/evaluation-execution-cost.md)
