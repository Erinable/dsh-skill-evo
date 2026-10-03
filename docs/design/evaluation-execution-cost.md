> 状态：SKIL-130 设计（父 issue SKIL-129 的 S1）。不可逆决策见 ADR-0029、0030、0031，成员 ack7 已于 2026-10-03 确认，三份都是 `accepted`。
> 本文合并后冻结，不随代码更新；与现状不一致时以代码、ADR 和 spec 为准。

本文回答 SKIL-129 的七个问题：步数口径、token 口径、多次采样与统计、上下文成本算法、分类别门槛、兼容、验收用例。基线是 `origin/main` @ `2a442af`（起草后合入的 `6accc8b` 只新增台账 record id 的设计稿和 ADR，没有改代码；`63d2007`（SKIL-134）只改了 `experience.ts`、`types.ts`、README 和测试，`evaluator.ts` 和 adapter 没动，`types.ts` 的行号已按 `63d2007` 更新；`9975647`（SKIL-128）只新增设计稿和 ADR-0023、0024，没有改代码。三次都已复核）。本文只出设计，不写实现代码。

优化目标（来自 SKIL-129）：

```text
min_S  E_x [ steps(τ) + λ·tokens(τ) + μ·ctx(S) ]
s.t.   P(V(τ)=pass | x, S) ≥ P(V(τ)=pass | x, S_base)，且不新增安全违规和副作用
```

本设计不把三项加权成一个总分（CONTEXT.md：Evaluation「不是总分」），λ、μ 落成三组独立门槛：约束项先判，三项成本各自一个门槛。

## 1. 现状

### 1.1 读了什么

- core：`packages/skill-evolution/src/evaluator.ts`、`types.ts`、`metrics.ts`、`report.ts`（全文），`service.ts:195-235,280-300,420-431`、`operations.ts:123-141,187-270`、`lifecycle.ts`（公开方法）、`bin/dsh-skill-evolution.mjs:20-40,84-135`。
- adapter：`packages/dsh-adapter/src/evaluator.ts`、`fake-executor.ts`、`reference-executor.ts`（全文），`tests/adapter.spec.ts:110-180`。
- bundle：`packages/dsh-bundle/index.js:185-225,340-380`（评测入口、catalog 与 Skill 加载的映射）。
- 测试：`packages/skill-evolution/tests/evolution.spec.ts:110-175`、`tests/cli.spec.mjs:60-115`。
- 文档：`CONTEXT.md`、`AGENTS.md`、`docs/agents/domain.md`、ADR-0004、0006、0014、0015、0016，`docs/governance/documentation.md`。
- 相邻设计：SKIL-128（PR #82，已在 `9975647` 合入 main；`docs/design/tool-correction-create-skill.md` §6.1、§7，Base = absent 的评测）。
- 基线：`npm --prefix packages/skill-evolution run build` 通过，`npx vitest run tests` 输出 `Tests  134 passed (134)`；`dsh-adapter` 输出 `Tests  9 passed (9)`；`dsh-bundle` 输出 `ℹ tests 15`、`ℹ pass 15`。

### 1.2 现状要点

| 位置 | 现状 | 对本需求的影响 |
|---|---|---|
| `evaluator.ts:12-22` `CaseRunResult` | 有 `tokenCost?`、`contextCost?`，没有步数 | 步数进不了 core |
| `evaluator.ts:64-95` | 每个用例 Base、Candidate 各跑一次；只累加全体用例的 token、context 总和 | 没有采样，也没有分类别成本 |
| `evaluator.ts:104-105` | `maxTokenIncreaseRatio`、`maxContextIncreaseRatio` 比较全体总和；Base 总和为 0 时直接跳过 | 不分类别；缺数据时静默通过 |
| `evaluator.ts:111-113` | original-failure 只认「通过数增加」 | 已能通过、只是更省的 Candidate 过不了 |
| `evaluator.ts:119,228-241` | `boundaryHighFailures` 对 high boundary 用例把 Base 再跑一遍 | 多余的 runner 调用；采样后会放大 R 倍 |
| `types.ts:203-225` `SkillEvalResult` | 没有任何成本字段，累加出来的 token 总和不写进结果 | 报告和 artifact 看不到成本 |
| `types.ts:243-252` `EvaluationPolicy` | 只有两个全局比例 | 没有分类别门槛，没有采样配置 |
| `types.ts:254-266` core 的 `ProposalComparison` | 已经有 `toolCalls: number` | core 里「工具调用次数」这个词已经存在 |
| adapter `evaluator.ts:38-50` | `DshEvaluationRunResult` 有 `toolCalls?` | — |
| adapter `evaluator.ts:66-79` | `createDshEvaluationRunner` 不传 `toolCalls`；用 `content === baseContent` 猜 Base 还是 Candidate | 步数被丢掉；Base 与 Candidate 正文相同、或 Base 为空（SKIL-128）时会猜错 |
| adapter `evaluator.ts:162-167` | executor 抛错或超时时写 `toolCalls: 0` | 「没数据」被记成「0 步」 |
| `fake-executor.ts:17-19` | `toolCalls` 恒为 0，token 和 context 都取正文长度 | 构造不出「6 步降到 2 步」 |
| `metrics.ts:45-46` | `contextCost` 累加 Observation 的 `payload.inputTokens` | bundle 从不写这个字段（`grep -rn inputTokens packages` 只命中 `metrics.ts`），DSH 部署下恒为 0；和评测里的 context 无关 |
| bundle `index.js:347-361` | catalog 条目是 `{ name, description }` | 目录曝光的成本 = 名字 + 描述 |
| bundle `index.js:363-375` | 用户调用 Skill 时注入的是整份正文 | 加载成本 = 整份 `SKILL.md` |
| `service.ts:427-431`、`operations.ts:260`、`service.ts:297` | policy 只校验两个比例；promote 要求 artifact 的 `policyVersion` 等于当前 policy | policy 版本号是 artifact 与门槛语义之间唯一的绑定 |

### 1.3 复现（`2a442af`，build 之后用一次性脚本跑，脚本已删除）

```text
P1 runner keys: passed,status,reason,evidence,tokenCost,contextCost,sideEffects,securityViolations,positiveFeedback
P2 failed run toolCalls: 0 tokenCost: undefined
P3 runner calls for 2 cases: 5 | gate: false [ 'original-failure pass count did not improve' ] | result keys has cost? false
```

- P1：executor 返回 `toolCalls: 6/2`，经 `createDshEvaluationRunner` 后结果里没有这个键。
- P2：executor 抛错，`runDshComparison` 给出 `toolCalls: 0`。
- P3：一个 original-failure 加一个 high boundary 用例，runner 被调了 5 次（boundary 的 Base 多跑一次）。Candidate 在 original-failure 上 Base 和 Candidate 都通过、token 从 100 降到 50，门槛仍然拒绝；结果里没有成本字段。

## 2. 模块与 seam

### 2.1 选项

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. 全写进 `evaluateCandidate` | 采样、统计、门槛都在 `evaluator.ts` 里继续累加 | 低起步，函数会长到四五百行 | 差：每个统计分支都要造 runner 才能测 | 可逆 | 无 |
| B. 新增纯函数 module `evaluation-cost.ts`（推荐） | `evaluator.ts` 只管按 policy 跑 R 次、收集 Sample；统计、成本门槛、上下文成本全在新 module，interface 是两个函数 | 中 | 好：直接喂 Sample 数组测，不需要 runner | 可逆 | 无 |
| C. 统计方法做成可注入的 strategy | 在 service options 上挂一个 `EvaluationStatistics` | 高 | 好 | 可逆 | 无 |

推荐 B。seam 放在「Sample 收集」和「Sample 分析」之间，理由是两边的变化频率不同：统计方法、阈值、估算器会随着使用经验反复调，runner 编排（隔离、超时、顺序）很少动。测试成本也集中在分析这一侧：显著性、无数据、不稳定、零基线这些分支要几十组输入，纯函数上每组只要一行数组。C 只有一个 adapter，是假想的 seam，现在不开；统计方法的 id 写进 artifact（§4.4），以后要换方法时再加。

### 2.2 interface

```ts
// packages/skill-evolution/src/evaluation-cost.ts
export function measureSkillContext(content: string): SkillContextCost
export function analyzeEvaluationCost(input: {
  readonly cases: readonly SkillEvaluationCase[]
  readonly samples: readonly EvaluationSample[]
  readonly baseContent: string
  readonly candidateContent: string
  readonly candidateContentHash: string
  readonly policy: NormalizedEvaluationPolicy
}): EvaluationCostReport
```

- `measureSkillContext` 同时给评测和 `metrics` 用，两处的上下文成本由此打通（§5）。
- `analyzeEvaluationCost` 只读，不碰文件系统，不调 runner。它返回的 `checks` 由 `evaluateCandidate` 拼进 `gateReasons`。
- 硬约束（schema、调用策略、安全、副作用、回归、high boundary）仍在 `evaluator.ts`，改动只是把单次结果换成 Sample 的多数判定（§4.3）。
- 依赖方向不变：`evaluation-cost.ts` 只 import `types.ts` 和 `events.ts`（`createContentHash`），不 import DSH，也不 import `service.ts`（ADR-0014）。

## 3. 步数与 token 口径（不可逆，ADR-0029）

### 3.1 步数计什么

| 选项 | 定义 | 取舍 |
|---|---|---|
| A. 工具调用次数（推荐） | 一条轨迹里模型发出的工具调用总数；失败的、重试的都算 | 与 DSH 的 `tool/result` 一一对应，也就是 SKIL-128 的 `tool-result` Observation；自我纠正浪费的正是这些调用 |
| B. 模型轮次 | 模型回复的次数 | 一轮里可以并行发多个调用，轮次会低估工作量 |
| C. 两者相加 | — | 串行工具循环里每步都数两次，数值没有单一含义 |

推荐 A：`steps = toolCalls`。模型轮次作为可选的 `modelTurns` 一并报告，不进门槛。细则：

- 失败的工具调用算一步；模型自己发起的重试每次都算一步。省掉「失败 → 重试」就是 SKIL-127 要量化的收益，两边口径一致。
- 加载 Skill 如果是一次工具调用，也算一步。Base 和 Candidate 同样计，不影响比较；Base = absent（SKIL-128）时 Candidate 多出的一次加载是真实成本。
- harness 层面的重跑不算：executor 一次调用就是一条轨迹，不得自行重跑整条用例。
- 没有数据写 `undefined`，不写 `0`。adapter 的出错和超时分支今天写 `toolCalls: 0`（P2），要改成 `undefined`。

### 3.2 token 计什么

`tokenCost` = 整条轨迹所有模型调用的输入 token + 输出 token，缓存命中的输入 token 按全量计入。

| 选项 | 取舍 |
|---|---|
| A. 含缓存命中（推荐） | 缓存命中率取决于运行顺序和服务端状态，与 Skill 无关；含进去以后 R 次 Sample 之间可比。Skill 正文在多轮里被缓存，不含缓存会低估它的上下文占用 |
| B. 不含缓存命中 | 更接近账单，但同一对 Base / Candidate 按不同顺序跑，数字就不一样 |
| C. 拆成 input / output / cached 三项 | 信息最全；interface 变宽，门槛要多选一个维度 |

推荐 A。拆分字段以后要加是加法，不影响已有数据，现在不加。报告里每个用例、每个类别都分 Base 和 Candidate 给出（§4.4）。

### 3.3 只比较通过的 Sample

失败的运行可能很早就放弃，步数少不代表好。所以步数和 token 的均值、方差、显著性只在**通过的 Sample** 上算，而且只在**可比用例**上算：Base 和 Candidate 在用例级都通过（§4.3 的多数判定）的用例。其余用例不参与成本比较。这对应目标式里的约束优先：先保证通过，再比成本。`unknown`（超时、出错）的 Sample 不参与成本。

### 3.4 runner 契约

```ts
export interface CaseRunResult {
  // 已有字段不变
  readonly toolCalls?: number   // 新增，步数
  readonly modelTurns?: number  // 新增，只报告
  readonly tokenCost?: number   // 口径按 §3.2
  readonly contextCost?: number // 保留；schema 2 下只报告，不进门槛（ADR-0031）
}

export interface EvaluationRunContext {
  readonly exposure: 'base' | 'candidate'
  readonly sample: number        // 0 .. R-1
}

export type EvaluationRunner = (
  content: string,
  evaluationCase: SkillEvaluationCase,
  context?: EvaluationRunContext,  // 新增可选参数，老 runner 忽略即可
) => CaseRunResult | Promise<CaseRunResult>
```

第三个参数修掉 adapter 用 `content === baseContent` 猜 Base 的问题：两边正文相同，或 Base 为空而 Candidate 也为空时都会猜错。

### 3.5 dsh-adapter 怎么传

- `DshEvaluationRunInput` 加 `exposure`、`sample`；`DshEvaluationRunResult` 加 `modelTurns?`。
- `createDshEvaluationRunner` 返回的 runner 接收 `context`，用 `context.exposure` 决定 exposure（没有 `context` 时退回今天的正文比较），并把 `toolCalls`、`modelTurns` 原样放进 `CaseRunResult`。
- `runDshCase` 的 catch 分支（`evaluator.ts:162-167`）把 `toolCalls: 0` 改成不写。
- `createFakeDshExecutor` 加一个 `script?: (input) => Partial<DshEvaluationRunResult>` 选项，按 `caseId`、`exposure`、`sample` 返回步数、token 和结果。验收用例都靠它构造（§8）。默认行为不变。
- 步数和 token 的来源（DSH 事件流里怎么数）仍然由部署方的 executor 或 `judge` 负责，core 不认识 DSH 事件名（ADR-0014）。

## 4. 多次采样与统计（不可逆部分见 ADR-0030）

### 4.1 R 的默认值和配置位置

- R 只在 `EvaluationPolicy.sampling.runs` 里配置，不加 CLI 参数。R 会改变门槛的含义，它必须和 policy 一起进入 artifact 的 policy 快照（§6.3）；CLI 覆盖会让同一个 policy 版本号对应两种证据。
- schema 2 的 policy 缺省 `runs: 5`，取值 1–20 的整数。schema 1（老 policy 文件，包括 `DEFAULT_EVALUATION_POLICY`）固定 `runs: 1`。
- 为什么是 5：单个用例 Base、Candidate 各 R 次、结果完全确定时，§4.2 的检验能达到的最小 p 值是 `1 / C(2R, R)`。R = 3 时是 1/20 = 0.05，正好压在 α 上；R = 5 时是 1/252 ≈ 0.004，单用例的类别也能判出显著。R 为奇数时多数判定不会平票。代价是 runner 调用从 `2N + high boundary 数` 变成 `2RN`，N = 10 时是 100 次；DSH 进程 executor 的单次超时是 120 s（`evaluator.ts:125`），最坏情况要按小时算，写进 README。
- 运行顺序：每个用例依次跑 `base#0, candidate#0, base#1, candidate#1, …`，交错排列，减少模型服务端漂移对单边的影响。顺序是确定的。

### 4.2 统计方法

| 选项 | 做法 | 小样本 | 零方差（6→2 恒定） | 确定性 | 复杂度 |
|---|---|---|---|---|---|
| A. 分层精确置换检验（推荐） | 每个用例是一层，层内打乱 Base / Candidate 标签；统计量是各层均值差之和；单侧 | 精确，不假设分布 | 能判：只有原排列达到观测值，p = 1/252 | 枚举是确定的；超过上限时用由 `candidateContentHash` 派生种子的抽样，也确定 | 中，约 60 行纯函数 |
| B. Welch t 检验 / 置信区间 | 均值差 ± t·SE | 假设正态，步数是小整数，偏态 | 方差为 0 时 SE = 0，无定义 | 确定 | 低，但要引 t 分布分位数表 |
| C. bootstrap 百分位区间 | 重抽样取分位数 | R = 5 时覆盖率差 | 区间退化成一个点 | 要固定种子 | 低 |
| D. 跨用例符号检验 | 每个用例的均值差取符号 | 要求用例数多，单用例类别永远不显著 | 能判 | 确定 | 低 |

推荐 A，方法 id 记为 `stratified-permutation-v1`，写进 artifact。细则：

- 层 = 一个可比用例（§3.3：双方用例级都通过）；层内只用双方**通过的** Sample。层按输入 `cases` 的顺序排列，记为 `i = 0..m−1`。
- 统计量 `T = Σ_i (mean_base,i − mean_candidate,i)`，按 `i` 递增的顺序累加，检验「Candidate 更低」的单侧假设。
- 全部排列数 `Π_i C(n_b,i + n_c,i, n_b,i)` 不超过 10 000 时精确枚举，`p = #{T_perm ≥ T_obs − 1e-9} / 总数`。精确枚举不用随机数，结果与枚举顺序无关。
- 超过 10 000 时抽 10 000 次，`p = (1 + #{T_perm ≥ T_obs − 1e-9}) / 10 001`。抽样的随机源完全由下面几条确定，`stratified-permutation-v1` 这个 id 指的就是这整套算法，改其中任何一步都要换 id：
  - **种子**：`seed = sha256(utf8(candidateContentHash + '\n' + category + '\n' + metric))` 的 32 字节摘要，`metric` 取 `steps` 或 `tokens`。每次检验各有一个种子，互不共享流。
  - **字节流**：第 `j` 块（`j = 0, 1, 2, …`）是 `sha256(seed ‖ uint32be(j))` 的 32 字节，依次拼接；每次取 4 字节按大端读成 `u ∈ [0, 2^32)`。用 core 已有的 `node:crypto`（`events.ts:1` 的 `createHash`），不引依赖。
  - **区间整数**：要 `[0, n)` 里的整数时，令 `limit = 2^32 − (2^32 mod n)`，`u ≥ limit` 就丢掉再取，否则返回 `u mod n`（拒绝采样，没有取模偏差）。
  - **一次抽样**：按 `i` 递增遍历每一层；把层内 Sample 值排成 `[base 的通过 Sample（按 sample 序号）, candidate 的通过 Sample（按 sample 序号）]`，长度 `L`，做 Fisher–Yates：`for k = L−1 down to 1: j = 区间整数(k + 1); swap(a[k], a[j])`；前 `n_b,i` 个记为 Base，其余为 Candidate，算出该层均值差。所有层算完累加成一个 `T_perm`。10 000 次抽样连续消费同一条字节流，不重置。
- 不给置信区间：置换检验反推区间要对每个候选偏移量重复检验，代价和解释成本都不划算。报告给相对变化的点估计加 p 值，已经能回答「是否显著下降」。票面允许二选一。
- 两个指标的组合：`costMetric: 'steps-or-tokens'` 是「任一显著下降即可」，做两次检验，每次用 α/2（Bonferroni），免得两次机会放大误判率。`'steps-and-tokens'` 是「两项都显著下降」，两次检验各用 α，不做校正：两项都要过才成立，这是交并检验（intersection-union），总的误判率不超过 α。

### 4.3 每用例的判定和「不稳定」

- 每个用例、每一边统计 R 个 Sample 里的通过次数 `k`。**通过次数过半（`2k > R`）记为该用例通过**。R = 1 时和今天完全一样，所以 `categories`、`baseline`、`regressions`、`total/passed/failed/unknown` 这些老字段的含义不变，都是用例级计数。
- `0 < k < R` 记为不稳定（`unstable`），Base 和 Candidate 分开报告。不稳定本身不进门槛，只在报告和 `gateReasons` 之外的 `cost.unstable` 里列出。不稳定的 Candidate 往往已经被回归或通过率门槛拦下；再单独拦一次，R 较小时误拒太多。采用默认答案，成员可推翻。
- 用例状态：过半通过为 `passed`；否则 `unknown` 的 Sample 不少于一半时为 `unknown`；其余为 `failed`。
- 安全违规、副作用：对 Candidate 的全部 Sample 求和，与今天对单次结果求和一致；任何一次 Sample 出现安全违规都会触发 `maxSecurityViolations: 0`。
- high boundary：直接复用主循环里 Base 的 Sample，删掉 `boundaryHighFailures` 的重复运行（`evaluator.ts:119,228-241`）。runner 不确定时，今天同一个用例的 Base 会跑两次、可能得到两个答案；改完以后只有一个答案。

### 4.4 报告内容

每个用例（`CaseEvaluation` 新增可选字段）：

- `runs`、`passRate`、`baselinePassRate`、`unstable`、`baselineUnstable`
- `cost.steps`、`cost.tokens`、`cost.modelTurns`：各自的 `MetricComparison`
- `samples.base[]`、`samples.candidate[]`：每次 Sample 的 `passed`、`status`、`toolCalls`、`modelTurns`、`tokenCost`、`contextCost`、`durationMs`，不含 evidence

每个类别（`SkillEvalResult.cost.categories[category]`）：

- `passRate.base`、`passRate.candidate`（Sample 级）
- `steps`、`tokens`、`modelTurns`：`MetricComparison`

```ts
interface MetricSummary { readonly n: number; readonly mean?: number; readonly variance?: number; readonly min?: number; readonly median?: number; readonly max?: number }
interface MetricComparison {
  readonly status: 'ok' | 'no-data' | 'not-applicable'
  readonly base: MetricSummary
  readonly candidate: MetricSummary
  readonly comparableCases: number
  readonly relativeChange?: number   // (mean_c − mean_b) / mean_b；mean_b = 0 时不写
  readonly pValue?: number           // 单侧，「Candidate 更低」
}
```

- `variance` 用 n − 1 做分母，n < 2 时不写。类别均值是各可比用例均值的算术平均，每个用例权重相同，免得 R 次都通过的用例压过只通过一次的用例。
- `comparableCases` 是 §3.3 定义的可比用例数（双方用例级都通过）。
- `no-data`：类别里有双方都通过的用例，但其中任何一个通过的 Sample 缺这个指标。只要缺一处就整类 `no-data`，不在剩下的用例上算，避免挑着算。
- `not-applicable`：类别里没有双方都通过的用例（包括类别为空）。
- 原始 Sample 存进 artifact，是为了以后换统计方法时能直接重算，不必重跑 2RN 次模型调用。

## 5. 上下文成本算法（不可逆，ADR-0031）

### 5.1 算什么

```ts
interface SkillContextCost {
  readonly estimator: 'utf8-bytes-div4-v1'
  readonly catalogTokens: number  // 目录曝光：frontmatter 的 name + description
  readonly loadTokens: number     // 加载：整份 SKILL.md
}
```

- **目录描述**：bundle 的 catalog 条目就是 `{ name, description }`（`index.js:347-361`），每个能看到这个 Skill 的 session 都付这笔成本。`catalogTokens = est(name) + est(description)`。frontmatter 用 `evaluator.ts:216-226` 同一个解析器，和 `validateSkillDocument` 看到的一致。已知局限：多行 YAML 描述（`description: |`）这个解析器读不出来，今天的校验也同样读不出来，不在本票修。
- **加载正文**：用户或模型调用 Skill 时注入的是整份正文（`index.js:363-375`），`loadTokens = est(content)`，含 frontmatter。
- Base = absent（SKIL-128）时 Base 的两项都是 0，增量就是 Candidate 的全量。

### 5.2 token 估算

| 选项 | 做法 | 取舍 |
|---|---|---|
| A. `ceil(UTF-8 字节数 / 4)`（推荐） | 纯函数，零依赖 | 英文约 4 字节一个 token；中文 3 字节一个字，按 0.75 token 计，偏低但稳定。门槛比的是 Base 和 Candidate 的差，估算偏差大部分抵消 |
| B. `ceil(字符数 / 4)` | 同上 | 中文低估到 1/4，中文 Skill 的增量几乎看不出来 |
| C. 引入某家模型的 tokenizer | 最准 | core 今天没有运行时依赖（`package.json` 的 `dependencies` 为空）；绑定一家模型；各家不一致 |
| D. 注入 `ContextEstimator` | 部署方传真 tokenizer | 只有一个 adapter，是假想的 seam |

推荐 A，估算器 id 写进每一处结果。以后要换成 C 或 D，只需要新 id；老 artifact 的数字仍然按老 id 解读，不会和新数字混比。

### 5.3 进入评测

- `SkillEvalResult.cost.context = { estimator, base, candidate, delta: { catalogTokens, loadTokens } }`，每次评测都算，与 policy schema 无关。
- 门槛（schema 2）：`context.maxCatalogIncreaseTokens`（缺省 64）、`context.maxLoadIncreaseTokens`（缺省 1024），比的是绝对增量。用绝对值而不是比例：比例对 Base = absent 没有定义；一个 200 token 的小 Skill 翻倍，和一个 4000 token 的 Skill 涨 10% 相比，前者的实际代价更小。缺省值的意思是：描述多约 256 字节、正文多约 4 KiB 以内算通过。create-skill 的 Candidate 超过这个量时要在 policy 里调高，采用默认答案，成员可推翻。
- runner 自报的 `contextCost`：schema 2 下只进 Sample 和报告，不进门槛。schema 1 的 `maxContextIncreaseRatio` 仍按今天的方式比较 runner 自报值的总和（§7.1）。

### 5.4 进入 `metrics`

- `aggregateMetrics` 增加可选参数 `currentSkills?: readonly { name: string; content: string }[]`。`service.metrics()` 对 `skills` 里出现的每个 Skill 调 `versions.readCurrent`，读到的传进去；没有 current 的 Skill 不写 `context`。
- 每个 `SkillUsageMetric` 新增 `context?: { catalogTokens, loadTokens, exposureWeightedTokens }`，其中 `exposureWeightedTokens = catalogTokens × exposed + loadTokens × loadSucceeded`，是目标式里 `μ·ctx(S)` 在真实使用频率下的估计。
- 顶层新增 `skillContext: { estimator, catalogTokens, loadTokens, exposureWeightedTokens }`，是上面三项的合计。
- 顶层 `contextCost`（累加 `payload.inputTokens`）保持原义，不改名。它是宿主自报的运行时输入 token，DSH bundle 今天不写这个字段，所以恒为 0；README 写明这一点。改它的语义会破坏已有的 `metrics` 输出消费者，采用默认答案，成员可推翻。
- 评测和 `metrics` 都调 `measureSkillContext`，同一份正文在两处给出同一个数，这就是「打通」。

## 6. 分类别门槛与 policy 形状（不可逆，ADR-0030）

### 6.1 policy schema 2

```ts
type EvaluationPolicy = EvaluationPolicyV1 | EvaluationPolicyV2   // V1 就是今天的类型，不变

interface EvaluationPolicyV2 {
  readonly schema: 2
  readonly version: string
  readonly maxRegressionCount: number
  readonly maxSecurityViolations: number
  readonly requireNoNewSideEffects: boolean
  readonly requirePositiveFeedback?: boolean
  readonly sampling?: { readonly runs?: number }                     // 缺省 5，1–20
  readonly significance?: { readonly alpha?: number }                // 缺省 0.05，(0, 0.5]
  readonly originalFailure?: {
    readonly requireImprovement?: boolean                            // 缺省 true
    readonly costMetric?: 'steps' | 'tokens' | 'steps-or-tokens' | 'steps-and-tokens' | null  // 缺省 'steps'
    readonly minCostReduction?: number                               // 缺省 0.2，(0, 1)
  }
  readonly historicalSuccess?: {
    readonly maxPassRateDrop?: number                                // 缺省 0.05，[0, 1]
    readonly maxStepIncrease?: number | null                         // 缺省 0.1，≥ 0
    readonly maxTokenIncrease?: number | null                        // 缺省 0.1，≥ 0
  }
  readonly context?: {
    readonly maxCatalogIncreaseTokens?: number | null                // 缺省 64，≥ 0
    readonly maxLoadIncreaseTokens?: number | null                   // 缺省 1024，≥ 0
  }
}
```

- 没有 `schema` 字段的 policy 就是 schema 1，按今天的规则执行。`DEFAULT_EVALUATION_POLICY` 保持 schema 1、`version: '1'`：默认的 `runContentChecks` 不报步数和 token，默认换成 schema 2 会让每次评测都卡在「无数据」。成本门槛由 `--policy` 显式开启。
- 字段缺省取缺省值，`null` 表示关掉这项检查，报告里记为 `disabled`。关掉必须显式写，免得「没写」被理解成「不查」。
- schema 2 里出现 `requireOriginalFailureImprovement`、`maxTokenIncreaseRatio`、`maxContextIncreaseRatio` 时，`validateEvaluationPolicy` 报错：一个意思只有一处写法。
- 运行时统一先 `normalizeEvaluationPolicy(policy)` 得到 `NormalizedEvaluationPolicy`（所有缺省值填好、schema 1 映射到同一形状），门槛只读归一化后的对象。

### 6.2 门槛

约束先判，成本后判。下表的「理由」一列是写进 `gateReasons` 的建议文案，最终字符串由 S2 spec 定。

| 类别 | 检查 | 失败时 |
|---|---|---|
| 全部 | schema、Candidate 边界、调用策略、安全违规、新增副作用、回归（non-original-failure 用例 Base 过 Candidate 不过）、新增 high boundary 失败 | 不变（`evaluator.ts:98-123`） |
| original-failure | 没有这类用例 | `no original-failure cases`，不变 |
| original-failure | Base 过、Candidate 不过的用例 | `original-failure case regressed: <id>`。今天这种情况被 `evaluator.ts:83` 排除在回归之外，只要别的用例多过一个就能掩盖；「通过率不下降」要求补上。只进 schema 2 |
| original-failure | 改进要求（`requireImprovement`）：**(a)** Candidate 的通过用例数多于 Base，或 **(b)** 同时满足：**(b1)** 每个可比用例上 Candidate 的 Sample 级通过次数不少于 Base（`k_c,i ≥ k_b,i`）；**(b2)** 在可比用例上，`costMetric` 指定的指标 `relativeChange ≤ −minCostReduction` 且 `pValue ≤ α`（`steps-or-tokens` 各用 α/2，`steps-and-tokens` 各用 α，§4.2） | 两条都不满足：`original-failure did not improve`；(b1) 不满足时 detail 写出违反的用例 id 和双方的 `k`；(a) 不满足且 (b2) 为 `no-data`：`original-failure <metric>: no data`。schema 1 只有 (a)，与今天一致 |
| historical-success | 用例级通过率下降超过 `maxPassRateDrop` | schema 1 保留原字符串 `historical-success pass rate regressed by more than five points` |
| historical-success | 双方都通过的用例上，步数均值 `relativeChange > maxStepIncrease` | `historical-success steps increase exceeded policy` |
| historical-success | 同上，token | `historical-success tokens increase exceeded policy` |
| historical-success | 上两项为 `no-data` | `historical-success <metric>: no data` |
| 上下文 | `delta.catalogTokens > maxCatalogIncreaseTokens`；`delta.loadTokens > maxLoadIncreaseTokens` | `catalog context increase exceeded policy`；`load context increase exceeded policy` |
| boundary | 不设成本门槛，只报告 | — |

- 为什么要 (b1)：用例级按多数判定，Base 5/5 通过、每次 6 步，Candidate 3/5 通过、每次 2 步时，双方用例级都算通过，不是回归；只看 (b2) 的话降幅 66.7%、p = 1/C(8,3) = 1/56 ≈ 0.018，门槛会放过。但目标式的约束是 `P(pass | S) ≥ P(pass | S_base)`，这里通过概率从 1.0 掉到 0.6，票面第 5 条也写明「通过率不下降前提下」才比成本。(b1) 只在用成本证明改进时才要求；(a) 走的是通过数增加，本身就是通过率上升，不加这条。另一个修法是「Candidate 不稳定的用例不进 (b)」，被否：Base 2/5、Candidate 3/5 时 Candidate 不稳定，但通过率没降，不该被挡；而 Base 和 Candidate 都是 4/5 时它又挡不住任何东西，判据和目标式对不上。
- historical-success 的 `maxPassRateDrop` 有意保持用例级（通过用例数之比），不改成 Sample 级：R = 1 时它必须和 schema 1 的含义一致；单个 historical-success 用例从 Base 过变成 Candidate 不过，已经被上面的「回归」检查拦下；Sample 级的掉落（例如 5/5 → 4/5）在 R = 5 时只差一次运行，按 Sample 级拦截误拒太多，它会出现在 `unstable` 和 `cost.categories[...].passRate` 里供人看。采用默认答案，成员可推翻。
- historical-success 的上升比较用点估计，不要求显著：这是守护约束，举证责任在 Candidate。R 较小时噪声可能误拒，缺省留了 10% 的余量。采用默认答案，成员可推翻。
- Base 均值为 0（`relativeChange` 无定义）时：Candidate 均值也为 0 算通过；否则按上升无穷大处理，historical-success 不通过，original-failure 的 (b) 不成立。
- `not-applicable`（类别里没有双方都通过的用例）的成本检查不产生理由：original-failure 退回只看 (a)；historical-success 已由通过率检查覆盖。
- 成本检查的失败都归 `needs-review`，不归 `rejected`；`decision` 的计算（`evaluator.ts:143`）不变。
- 每项检查另写一条结构化记录 `cost.checks[]: { id, status: 'passed' | 'failed' | 'no-data' | 'not-applicable' | 'disabled', detail }`，报告据此渲染，「无数据」因此总能在报告里看到。

### 6.3 artifact 与台账

- `EvaluationArtifact` 新增 `schemaVersion: 2`、`policy: NormalizedEvaluationPolicy`（快照）、`policyHash`（快照的规范 JSON 的 sha256）。`SkillEvalResult` 新增 `cost`（§4.4、§5.3）和 `policyHash`。
- promote 的校验（`operations.ts:260`、`service.ts:297`）按**当前** policy 归一化后的 schema 分两种：
  - 当前 policy 是 schema 2：artifact 必须带 `policyHash`，且等于当前 policy 的 hash。不带（老 artifact，或 schema 1 下评出的 artifact）或不相等，都报 `evaluation-mismatch`。
  - 当前 policy 是 schema 1：artifact 带 `policyHash` 时要求相等；不带时只比 `policyVersion`，与今天一致。
  
  policy 的 `version` 是人手写的字符串，改了阈值或换了 schema 却忘了改版本号，今天会被当成同一个 policy；hash 把这个漏洞堵上。schema 2 不留「只比版本号」的退路，是因为 schema 2 门槛要的证据（R 次 Sample、成本统计）老 artifact 里根本没有，版本号相等也不能说明证据对得上。
- `sameArtifactEvidence`、`sameResultEvidence`（`operations.ts:225-250`）在双方都有 `policyHash` 时多比这一项。
- `DecisionRecord` 新增可选 `policyHash`，`evaluated` 和 `promoted` 两条记录写入。`policyVersion` 照旧写。

## 7. 兼容

### 7.1 老 policy 文件（schema 1）

- 按今天的规则判：R = 1，没有分类别成本门槛，`requireOriginalFailureImprovement` 只看通过数，historical-success 仍是 5 个百分点。
- 唯一的行为变化：设了 `maxTokenIncreaseRatio` 或 `maxContextIncreaseRatio`、但 Base 总和为 0 或任何一次运行没报这个值时，今天静默跳过（`evaluator.ts:104-105` 的 `baselineTokenCost > 0`），改成写 `token cost: no data` / `context cost: no data` 进 `gateReasons`。这是票面第 6 条的要求；只影响「配了比例、runner 却不报」的部署，而这种部署今天的门槛本来就是空的。采用默认答案，成员可推翻。
- schema 1 的结果同样带 `cost` 报告（R = 1 时没有显著性，`pValue` 不写），报告和 CLI 都能看到。
- high boundary 不再重跑 Base（§4.3）：确定性 runner 的结果不变，runner 调用次数从 `2N + H` 变成 `2N`。

### 7.2 老 Evaluation artifact

- 没有 `schemaVersion` 的 artifact 按 1 读，没有 `cost`、`policy`、`policyHash`。`normalizeArtifact`（`operations.ts:203-210`）不变。
- 当前 policy 是 schema 1 时，promote 对老 artifact 只比 `policyVersion`，和今天一样。当前 policy 是 schema 2 时，老 artifact 没有 `policyHash`，一律报 `evaluation-mismatch`、要求重评（§6.3），不依赖写 policy 的人记得换版本号：`validateEvaluationPolicy` 不检查版本号是否变过，也检查不了。README 仍建议换 schema 时换版本号，那只是为了台账可读。
- `renderProposalMarkdown` 遇到没有 `cost` 的结果写 `- Execution cost: not recorded`。
- `evaluations.jsonl` 是 Fact record（ADR-0016），新字段都是加法，不改写老记录。

### 7.3 runner 与 adapter

- `CaseRunResult` 新字段、`EvaluationRunner` 第三个参数都是可选的，已有 runner 不用改。
- `DshEvaluationRunResult` 已经有 `toolCalls`，部署方的 executor 不用改就能得到步数。`modelTurns` 是新的可选字段。

## 8. 验收用例清单（供 S2 写进 spec）

下面的「fake executor」指 §3.5 带 `script` 的 `createFakeDshExecutor`，经 `createDshEvaluationRunner` 接进 `evaluateCandidate`。除特别说明外 policy 为 schema 2，其余字段取缺省值（R = 5，α = 0.05）。

1. **original-failure 6 → 2 通过**：1 个 original-failure 用例，Base、Candidate 5 次全部通过，Base 每次 6 步，Candidate 每次 2 步，token 相同；1 个 historical-success 用例，双方步数和 token 相同。期望 `passedGate: true`；`cost.categories['original-failure'].steps` 的 `relativeChange ≈ −0.667`、`pValue = 1/252`；`cost.checks` 里 original-failure 改进项为 `passed`，detail 写明走的是成本下降。
2. **historical-success 步数超阈值被拒**：original-failure 用例 Base 不过、Candidate 过；historical-success 用例双方都过，Base 4 步、Candidate 5 步（+25%）。期望 `passedGate: false`，`gateReasons` 含 historical-success 步数超限，`decision: 'needs-review'`。
3. **上下文成本超阈值被拒**：Candidate 正文比 Base 多 4100 字节以上（loadTokens 增量 > 1024）。期望 `gateReasons` 含 load context 超限；另一组把 `description` 加长 300 字节，期望含 catalog context 超限。`cost.context` 的数值等于 `measureSkillContext` 对两份正文的直接计算。
4. **R 次通过不一致报告不稳定**：某用例 Candidate 5 次里过 3 次，期望该用例 `passed: true`、`unstable: true`、`passRate: 0.6`；过 2 次时 `passed: false`、`unstable: true`。Base 侧同理报 `baselineUnstable`。
5. **无成本数据报告「无数据」**：runner 不报 `toolCalls` 和 `tokenCost`，original-failure 用例双方都过。期望 `passedGate: false`，`gateReasons` 含 original-failure 步数无数据；`cost.checks` 对应项为 `no-data`；报告 Markdown 里能看到「no data」。
6. **执行出错不算 0 步**：executor 抛错，经 adapter 后 `toolCalls` 为 `undefined`；这个 Sample 为 `unknown`，不进成本统计。
7. **老 policy 兼容**：`evolution.spec.ts:149-159` 的 policy（schema 1）得到与今天相同的 `gateReasons`；runner 调用次数为 `2N`。设了 `maxTokenIncreaseRatio`、runner 不报 token 时出现 `token cost: no data`。
8. **老 artifact 兼容**：没有 `schemaVersion`、`cost`、`policyHash` 的 artifact 仍能被 `normalizeArtifact` 读，schema 1 policy 下能 promote。
9. **policy 快照**：用 schema 2 policy 评测后，只改 `historicalSuccess.maxStepIncrease`、不改 `version`，promote 报 `evaluation-mismatch`。
10. **统计确定性**：同一组 Sample 调两次 `analyzeEvaluationCost`，输出逐字节相同；排列数超过 10 000 时走抽样，结果仍相同，且 p 值等于按 §4.2 字节流、拒绝采样和 Fisher–Yates 独立算出的值（S2 用一组固定输入，把参考值写进 spec）；`steps-or-tokens` 的每次检验用 α/2，`steps-and-tokens` 的每次检验用 α。
11. **adapter 透传**：`createDshEvaluationRunner` 把 `toolCalls`、`modelTurns` 放进 `CaseRunResult`；传了 `context` 时按 `context.exposure` 标 exposure，Base 与 Candidate 正文相同也不会标错。
12. **CLI `evaluate`**：`--policy` 给 schema 2 policy，默认的 content-check runner。stdout 的 JSON 里有 `cost.categories`（含 `passRate`）、`cost.context`、`cost.checks`（步数和 token 为 `no-data`）；`--report` 的 Markdown 里有成本表。步数、方差、p 值的具体数值在 `evaluateProposal` 层用第 1 条的 fake runner 断言，两层的 JSON 形状相同。
13. **CLI `metrics`**：有 current 版本的 Skill，stdout 的 `skills[].context` 有 `catalogTokens`、`loadTokens`、`exposureWeightedTokens`，顶层有 `skillContext`；数值与第 3 条的 `measureSkillContext` 一致。
14. **通过率下降不能靠成本路径过关**：1 个 original-failure 用例，Base 5/5 通过、每次 6 步；Candidate 3/5 通过、每次 2 步（通过的 Sample），token 相同。双方用例级都通过，不算回归，(a) 不成立。(b2) 单独看是成立的：`steps.relativeChange ≈ −0.667`、`pValue = 1/56 ≈ 0.018`。期望 `passedGate: false`，`gateReasons` 含 `original-failure did not improve`，`cost.checks` 的改进项为 `failed`、detail 写出该用例 `k_b = 5`、`k_c = 3`。对照组把 Candidate 改成 5/5、每次 2 步，期望通过、`pValue = 1/252`。
15. **换成 schema 2 后老证据不能 promote**：用 schema 1 policy（`version: '1'`）评测得到不带 `policyHash` 的 artifact；把 policy 换成 schema 2，`version` 仍写 `'1'`，promote 报 `evaluation-mismatch`。同样不改 `version`，手工去掉 schema 2 artifact 的 `policyHash`，promote 也报 `evaluation-mismatch`。

CLI 今天不能注入 executor（`bin/dsh-skill-evolution.mjs:124-135` 只接 `--cases`），所以第 12 条用默认 runner 证明字段可见，数值在 operation 层断言。给 CLI 加 `--runner <module>` 会让 CLI 加载任意代码，不在本票。采用默认答案，成员可推翻。

## 9. 与 SKIL-127 / SKIL-128 对齐

- 用例类别仍是 `original-failure`、`historical-success`、`boundary` 三类，不新增。
- 步数 = 工具调用次数、失败和重试都算，正对应 SKIL-128 里每条 `tool-result` Observation。SKIL-127「省了多少」可以直接读 original-failure 的 `cost.categories[...].steps.relativeChange`。
- Base = absent（ADR-0024，accepted；它要求 Base 为空时 baseline 真跑 `runner('', case)`，正好就是 §4.3 复用的主循环 Base Sample）：Base 的上下文成本为 0；runner 收到 `context.exposure: 'base'` 和空正文，不需要再靠正文比较猜。create-skill 的 Candidate 可能超过 §5.3 的缺省上下文阈值，需要在 policy 里显式调高。

## 10. 实现拆分建议（供 S2）

- **T1 core 类型与 policy**：`types.ts` 的新字段，`EvaluationPolicyV2`，`normalizeEvaluationPolicy`、`validateEvaluationPolicy`、`policyHash`。其余 task 都依赖它。
- **T2 `evaluation-cost.ts`**：`measureSkillContext`、`analyzeEvaluationCost`（汇总、置换检验、成本检查）。纯函数测试覆盖验收第 1–5、10、14 条的分析部分。依赖 T1。
- **T3 `evaluator.ts`**：R 次交错采样、Sample 收集、多数判定、不稳定、boundary 复用、拼接成本检查、schema 1 的 no-data。依赖 T1、T2。
- **T4 artifact、promote、报告、CLI**：`service.ts`、`operations.ts` 的 policy 快照与 hash 校验，`report.ts` 成本表，验收第 8、9、12、15 条。依赖 T3。
- **T5 `metrics`**：`aggregateMetrics` 的 `currentSkills`、`service.metrics()`，验收第 13 条。依赖 T2，可与 T3、T4 并行。
- **T6 dsh-adapter**：runner 透传、`exposure`、出错不写 0、fake executor 的 `script`，验收第 6、11 条。只依赖 T1 的 `CaseRunResult` / `EvaluationRunContext` 形状，可以和 T2 并行。

## 11. 可逆取舍（采用默认答案，成员可推翻）

- 统计、上下文成本放进新 module `evaluation-cost.ts`，不做可注入的 strategy（§2）。
- 模型轮次只报告，不进门槛（§3.1）。
- token 暂不拆 input / output / cached（§3.2）。
- R 只能在 policy 里配，不加 CLI 参数（§4.1）。
- 不稳定只报告，不单独拦（§4.3）。
- 不给置信区间，只给点估计加 p 值（§4.2）。
- historical-success 的成本上升看点估计，不要求显著（§6.2）。
- historical-success 的 `maxPassRateDrop` 保持用例级（§6.2）。
- 上下文门槛缺省 64 / 1024 token（§5.3）。
- `DEFAULT_EVALUATION_POLICY` 保持 schema 1（§6.1）。
- schema 1 配了比例但缺数据时，改为「无数据」不通过（§7.1）。
- `metrics.contextCost` 保持原义，新增 `skillContext`（§5.4）。
- CLI 不加 `--runner`（§8）。

## 12. 不可逆决策

- ADR-0029：步数 = 工具调用次数（失败、重试都算，缺数据写 `undefined`）；`tokenCost` = 输入 + 输出、含缓存命中；成本只在通过的 Sample 上比较。
- ADR-0030：`EvaluationPolicy` schema 2 的形状、缺省值和成本路径的通过率前提；Evaluation artifact 写入 policy 快照和 `policyHash`、原始 Sample 和统计方法 id `stratified-permutation-v1`（含抽样算法）；schema 2 下 promote 必须 `policyHash` 相等。
- ADR-0031：上下文成本 = 目录描述 token + 加载正文 token，估算器 `utf8-bytes-div4-v1`，评测和 `metrics` 共用；门槛比绝对增量。

**ADR 编号**：0029–0031 是 Mika 在 SKIL-130 上统一分配给本 PR 的号段（#84 用 0025–0028，#80 改用 0032，#81 已用 0033–0035 合入 main）。合入前 `origin/main` @ `1bc544a` 的 `docs/adr/` 没有重号。

**ADR 冲突**：没有与已有 ADR 冲突。ADR-0014：步数和 token 由 adapter / executor 提供，core 只定义字段和口径，不认识 DSH 事件。ADR-0015：不碰 Provider rank，也不做运行时按成本选 Skill。ADR-0016：Sample 和统计结果写进 Evaluation artifact，是加法；不回写 Observation。ADR-0004：不涉及 Proposal status。ADR-0022：只动 Failure case 的来源和问题簇，与评测无交集。ADR-0024：Base = absent 时 baseline 真跑，本稿的 Sample 和上下文成本都按它处理（§9）。

**`CONTEXT.md` 词条**：本 PR 新增 **Sample**、**Execution cost**、**Context cost**，并在 **Evaluation** 词条补了「每个 Evaluation case 在两侧各跑 R 次」。
