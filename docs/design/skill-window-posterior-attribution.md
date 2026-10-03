# Skill 窗口、逐步 Skill 后验与多 Skill 归因

SKIL-132（父 issue SKIL-131）的 S1 设计。本文定下窗口边界与降级、序列模型与发射接口、后验派生记录形状、归因权重规则、下游对接、因果校验操作和验收阈值，供 S2 Spec Writer 写 spec。

采集字段（工具参数摘要、命令、报错签名、脱敏）一律**以 SKIL-128 为准**，本文只引用，不定义。依赖点在 §8 逐一列出。

## 1. 现状

### 1.1 读了什么

- `CONTEXT.md`：Derived record、Projection、Attribution、Failure case（「一次能定位到某个 Skill 的失败」）、Failure cluster 的定义。
- `docs/adr/0002`、`0003`、`0014`、`0015`、`0016`、`0020`。
- `packages/skill-evolution/src/experience.ts` @ `9975647`：`buildExperiences`（:21-75）、`buildFailureCases`（:78-152）、`clusterFailureCases`（:160）、`diagnoseFailureCluster`（:193，按 `origin` 定根因）、`withAttribution`（:260-265）、`attributionFor`（:276-285）、`confidenceFor`（:292-306）。
- `packages/skill-evolution/src/types.ts` @ `9975647`：`ObservationKind`、`RuntimeObservation`、`Attribution`、`Experience`（:83）、`FailureOrigin`（:99）、`SkillFailureCase`（:101）、`FailureCluster`（:120）、`FEEDBACK_KINDS`（:313）。
- `packages/skill-evolution/src/workflow.ts`（`snapshot()` 同步投影链）、`service.ts`（`refreshDerived` :387-414 的游标和 `replaceAll`；`metrics()` :133-135 不刷新派生；`recordFeedback` :75-128）、`state-root.ts`（`StoreName`、`resolveLayout` :51-61）、`metrics.ts`、`evaluator.ts`、`lifecycle.ts`（`readCurrent`、`listVersions`、`contentHash`）、`events.ts`（`createContentHash`、`isObservationValue` :41 不校验 payload 内部）、`proposal.ts`（`isClusterReadyForProposal` :141）。
- `packages/dsh-bundle/index.js`：`createDefaultEventMapper`（:17）、`mapUserMessage`（:343）、`mapToolCall`（:400）、`mapToolResult`（:431）、`skillContentHash`（:505）、`isObservationInput` 的 kind 白名单（:322）。
- `packages/dsh-adapter/src/types.ts`、`evaluator.ts`（`DshEvaluationRunResult.toolCalls`、`tokenCost`）。
- 已合并的相邻设计：ADR-0022（SKIL-134，`FailureOrigin`、`attributionConfidence` 是证据强度不是概率、稳定 cluster id）；SKIL-128 的 `docs/design/tool-correction-create-skill.md`（§3 采集字段与脱敏、§4.1 `ToolAttempt`、§4.2 `DerivedJudge<Input,Output>`、§4.3 意图规则、§4.4 `CorrectionEpisode`、§4.5 cursor 的 `judges`、§6.2 目标判断规则）和 ADR-0023、ADR-0024。
- 未合并的相邻设计：#81 SKIL-126（`FollowUpClassifier`、Classification memo 与 ADR-0034、cursor 的 `derivationKey`、「follow-up 之前恰好加载一个 Skill」的归因目标规则）。
- DSH 源码 `github.com/lens077/deepseek-harness` @ `6ce94ee1`，文件见 §2.1。

### 1.2 探针：多 Skill session 今天完全没有归因

在 `origin/main` 上构造一个双 Skill session：加载 git-workflow → 一次失败的 bash → 加载 api-debugging → 一次工具调用 → 隐式 follow-up「不对，超时应该先查代理」→ `task-finished` 失败。跑 `EvolutionWorkflow.snapshot()` 和 `aggregateMetrics`：

```
{"failures":0,"experiences":[["experience:s1\u0000git-workflow","unknown",0.2],["experience:s1\u0000api-debugging","unknown",0.2],["experience:s1\u0000unattributed","not-attributable",0.5]]}
[["api-debugging",1,0],["git-workflow",1,0]]
```

合并 SKIL-134 / SKIL-128 之后在 `9975647` 上重跑 `buildFailureCases` 和 `buildExperiences`，结论不变：`{"failures":0,"experiences":[["experience:s1\u0000git-workflow","unknown"],["experience:s1\u0000api-debugging","unknown"],["experience:s1\u0000unattributed","not-attributable"]]}`。

Failure case 为 0（`experience.ts:134` 的 `skills.length !== 1` 直接跳过），follow-up 进了 `unattributed` 组并标为 `not-attributable`，metrics 的 `followUps` 两个 Skill 都是 0（bundle 的 follow-up 不带 `skill`）。

## 2. Skill 窗口边界与降级

### 2.1 查证：DSH 暴露了压缩和正文移除事件

结论：**DSH 已经暴露，不需要 DSH 侧新增事件**。缺的是 bundle 的映射：这些事件今天进 Observation log 时丢了语义。依据（DSH @ `6ce94ee1`）：

- `session/event` 是每条追加事件的提交后通知，包括只写日志的事件（`packages/core/session/src/index.ts:66-72`）。fork / resume 的构造期 seed 不经过它，seed 结尾用 `session/end-seed` 标记（`index.ts:600-609`，`types.ts:411`）。
- 摘要式压缩：`compaction/start` → `compaction/summary {summary, shadowedRange, shadowedSeqs, shadowedTokenCount, …}` → `compaction/end`（类型在 `packages/compaction/compaction/src/types.ts:20-90`，发出在 `compaction-basic/src/region.ts:475`），之后跟一条 `surfaceOp: {op:'replace'}`、source 为 `{kind:'plugin', plugin:'compact'}` 的 `user/message` checkpoint（`compaction/src/checkpoint.ts:21`）。触发点是 `agent/pre-step` 的上下文压力、上下文超限错误和 `/compact` 命令，所以**压缩可以发生在一个 task 中间**。
- 工具结果裁剪：`compaction/prune {shadowedRange, shadowedSeqs, shadowedTokenCount}`，紧跟一条同 `callId`、内容被截断、`surfaceOp: replace` 的 `tool/result`（`compaction-tool-result-pruner/src/index.ts:162-171`）。它可以裁掉 `skill` 工具的结果，也就是 Skill 正文。
- 上下文移除：`compaction/prune` 加一条空内容、source 为 `{kind:'plugin', plugin:'context-remove'}`、`surfaceOp: replace` 的 `user/message`（`context-remove/src/index.ts:338-347`）。
- Skill 加载：模型调用 `skill` 工具，或用户 `/name` 经 `agent/pre-step` 注入 source 为 `skill-invocation` 的 `user/message`（`skill/tool-skill/src/index.ts:196`）。DSH 没有「卸载 Skill」，压缩后也不会重新注入 Skill 正文；只有 catalog 掉出 surface 时会重新发布（`tool-skill/src/index.ts:362`）。
- fork（`api/session-controller/src/commands.ts:258`）在 `turn/end` 边界建一个带 seed 的新 session，父 session 里加载过的 Skill 正文随 seed 进入子 session 的上下文，但子 session 的 Observation 里没有对应的加载事件。

### 2.2 探针：bundle 今天怎么映射这些事件

把 `skill` 调用 → 结果 → `compaction/prune` → 替换 `tool/result` → context-remove checkpoint 喂给 `createDefaultEventMapper`：

```
tool/call | skill-load-requested | {"eventType":"tool/call","sessionSeq":5,"toolCallId":"c1"} | []
tool/result | skill-loaded | {...,"sessionSeq":6,"toolCallId":"c1","toolName":"skill"} | ["s1:5"]
compaction/prune | agent-step | {"eventType":"compaction/prune","sessionSeq":9} | []
tool/result | tool-result | {"eventType":"tool/result","sessionSeq":10,"toolCallId":"c1"} | []
user/message | agent-step | {"eventType":"user/message","sessionSeq":12} | []
```

- 压缩和裁剪只剩一个带 DSH 事件名的 `agent-step`，没有被遮蔽的 seq。core 按 ADR-0014 不能靠 `payload.eventType === 'compaction/prune'` 判断。
- 替换用的 `tool/result` 因为 `callId` 已经在 `mapToolResult`（`dsh-bundle/index.js:431-435`）里删掉，变成一条不关联任何调用的 `tool-result`，会被当成一个多出来的步骤。

所以要在 bundle 里补映射，用 core 自己的词汇记录「哪些 session seq 被遮蔽了」，见 ADR-0025。映射规则：

| DSH 事件 | 映射成 | payload 增量 |
|---|---|---|
| `compaction/summary`、`compaction/prune` | 新 kind `context-shadowed` | `shadowedSeqRanges: [start, end][]`（由 `shadowedSeqs` 合并相邻值得到）、`shadowedTokenCount`、`mechanism: 'summary' \| 'prune'` |
| 任何 `surfaceOp.op === 'replace'` 的事件（替换用的 `tool/result`、compact checkpoint、context-remove 的空 `user/message`） | kind 不变（`tool/result` 也不再走 `mapToolResult` 的配对） | `surfaceReplace: true` |
| `skill-loaded`（`skill` 工具结果和 `skill-invocation` 两条路径） | kind 不变 | `shadowTracked: true` |

三项都是 `schemaVersion` 1 下的可选增量。新 kind 要同时加进 core 的 `ObservationKind`、bundle 的白名单（`dsh-bundle/index.js:322`）和 dsh-adapter 的 kind 列表（`dsh-adapter/src/types.ts:20`）。`compaction/start`、`compaction/end` 仍是 `agent-step`，不需要额外语义。

### 2.3 窗口和资格区间是两件事

需求给的四个结束条件里，「用户新消息」和 `task-finished` 并不会把 Skill 正文移出上下文：下一个 task 里模型仍然能照着它做。所以设计里分开两个概念：

- **Skill window**（确定性，Derived record）：从 `skill-loaded` 开始，遇到下面任一条就结束：同一 session 的下一条 `skill-loaded`（包括同一个 Skill 重新加载）、`user-follow-up`、`task-finished`、遮蔽了本次加载的 `context-shadowed`。结束它的那条 Observation 记作 `endObservationId`，不算窗口内的步骤。
- **资格区间**（HMM 的约束，不单独存）：一个 Skill 从加载开始，到它的加载 Observation 的 `sessionSeq` 被 `context-shadowed` 遮蔽为止，一直是可选的隐状态；在这个区间外它的后验恒为 0。区间可以跨越多个窗口、多个 task。

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| W1 窗口即资格 | 窗口只在遮蔽或 session 结束时关闭 | 低 | 好 | 窗口形状一旦被下游消费就难改 | 无 |
| **W2 窗口与资格分开（推荐）** | 窗口按需求的四个条件切；资格区间只给 HMM 用 | 中 | 好，两套判据各自可测 | 资格区间不落盘，可随时改 | 无 |
| W3 只有资格区间 | 不做窗口 | 低 | 差，需求第 1 条和验收第 1 项无从测 | — | 无 |

W1 违反需求给的边界；W3 丢掉验收项。选 W2。采用默认答案，成员可推翻。

步骤：窗口内除结束条件以外的 Observation 都是步骤。bundle 标了 `surfaceReplace` 的替换事件（ADR-0025）不算步骤。`skill-load-requested` / `skill-load-failed` 算步骤，`skill-load-failed` 仍走现有的 composition 归因（`experience.ts:276-285`），不开窗口。

### 2.4 降级规则

| 情况 | 能观测到的 | 规则 |
|---|---|---|
| 新 bundle，加载时带 `shadowTracked: true` | 遮蔽事件可靠 | 窗口 `endCertainty: 'observed'`；资格区间到遮蔽为止 |
| 旧日志，或加载 Observation 不带 `shadowTracked` | 压缩可能发生过但看不到 | 窗口照四个条件切，`endCertainty: 'uncertain'`；资格区间延续到 session 结束 |
| 窗口遇不到任何结束条件（日志到头） | — | `endReason: 'open'`，`endCertainty: 'uncertain'` |
| session 第一条 Observation 的 `sessionSeq > 0`（fork 子 session，或 bundle 中途启动） | 前缀里可能有加载，看不到 | session 标 `unknownPrefix: true`；该 session 不产生「现有 Skill 未覆盖」标记（§5.3） |

`shadowTracked` 标在 `skill-loaded` 上，是因为「这次加载的正文被移除时会不会报告」只和这条加载有关；缺了它就说明产生这条 Observation 的 bundle 还不懂遮蔽，不能把「没看到遮蔽」当成「没有遮蔽」。

### 2.5 窗口的记录形状

```ts
interface SkillWindow {
  readonly id: string                    // `window:${startObservationId}`
  readonly sessionId: string
  readonly skillName: string
  readonly contentHash?: string          // 取自 skill-loaded 的 skill.contentHash
  readonly startObservationId: string    // 那条 skill-loaded
  readonly endObservationId?: string     // 结束条件那条；endReason 为 'open' 时没有
  readonly endReason: 'skill-loaded' | 'user-follow-up' | 'task-finished' | 'context-shadowed' | 'open'
  readonly endCertainty: 'observed' | 'uncertain'
  readonly stepObservationIds: readonly string[]
}
```

窗口不依赖发射模型，放进独立的派生 store `skill-windows`（ADR-0026）。

### 2.6 需要 DSH 侧新增的事件

无。已知缺口单列在这里，均不需要 DSH 改动：

- fork seed 前缀里的加载在子 session 看不到。降级见 §2.4 的 `unknownPrefix`。要补的话由 bundle 在 fork 时写一条「继承的 Skill」Observation，本设计不做。
- bundle 的 `sessions` 状态只在内存里（`dsh-bundle/index.js:18`）。进程重启后，第一条真实用户消息不会被记成 `user-follow-up`，窗口会少一个结束条件。这属于 follow-up 采集，交给 SKIL-126 / SKIL-128 一侧处理。

## 3. 序列模型与发射接口

### 3.1 时间步取什么

| 选项 | 时间步 | 复杂度 | 可测性 | 问题 |
|---|---|---|---|---|
| T1 每条 Observation | 所有 Observation | 低 | 中 | bundle 把没认出的 DSH 事件都记成 `agent-step`（§2.2），大量无信息步骤会稀释后验，而且数量随 DSH 版本变 |
| **T2 每次工具尝试（推荐）** | SKIL-128 的 `ToolAttempt`（一次 `tool/call` 加它的结果），排除 `skill` 工具本身和 `surfaceReplace` 事件 | 低 | 好 | 纯文本回答没有时间步；它们对归因的影响通过 §5.2 的「附近步骤」间接体现 |
| T3 每个窗口 | 窗口 | 最低 | 差 | 回答不了「这一步是哪个 Skill 的」 |

选 T2。`ToolAttempt` 的形状和配对规则以 `tool-correction-create-skill.md` §4.1 为准：按 `correlationIds` 把一条 `agent-step`（tool/call）和对应的 `tool-result` 配成一次尝试，排序用 `sessionSeq`，没有时用 `occurredAt`。本设计在它之上只多一道过滤：`toolName === 'skill'` 的尝试和带 `surfaceReplace` 的事件不是时间步。替换用的 `tool/result` 本来就不带被配对调用的 correlation id（§2.2），过滤是为了不让它变成一条只有结果的孤立尝试。采用默认答案，成员可推翻。

### 3.2 模型

每个 session 单独算，跨 task，不跨 session。

- **隐状态**：第 t 步的可选状态集 `E_t = {none} ∪ {在 t 之前加载、且加载 Observation 尚未被遮蔽的 Skill}`（§2.3 的资格区间）。状态按 Skill 名区分，同一个 Skill 重新加载不产生新状态，发射用最近一次加载的 `contentHash` 对应的正文。
- **硬约束**：不在 `E_t` 里的 Skill 不参与计算，结构上就不存在，不是一个小概率。记录里只写 `E_t` 内的后验，其余隐含为 0（§4）。
- **转移**：保持概率 ρ，其余 `1 − ρ` 平均分给 `E_t` 里的其他状态。第 t−1 步到第 t 步之间有新的加载 k 时，那一步的转移改为：进入 k 的概率 λ，其余 `1 − λ` 按原规则分。状态在两步之间失去资格时，它的概率质量按「从 none 出发」的规则重新分配。
- **初始**：session 第一个时间步之前没有任何加载时，`p(z_0 = none) = 1`。
- **发射**：每个 Skill 状态给出相对 none 的对数似然比 `ℓ_t(k)`，none 固定为 0。
- **推断**：带缩放的 forward-backward，得到每步边缘后验 `p(z_t | τ)`。每步的最大后验状态取边缘分布的 argmax（后验解码）而不是 Viterbi 路径，因为验收测的是逐步一致率，归因也用逐步边缘分布。
- **轨迹级分布**：`π(k) = (1/T) Σ_t p(z_t = k | τ)`，包含 none。每个窗口、每个 task 也按同样方式汇总。

默认参数：ρ = 0.9，λ = 0.8。它们和发射参数一起写进后验记录（§4）。采用默认答案，成员可推翻。

与逐步独立打分（每步只看发射取 argmax，不要转移）的对比见 §3.6，差距主要出在中性命令和一次性跨 Skill 命令上。

### 3.3 发射接口

| 选项 | 形状 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| E1 逐对打分 | `score(step, skill) → number` | 低 | 好 | 公开接口，改动要改所有宿主实现 | LLM 实现一个 session 要调 T×S 次 |
| **E2 按 session 批量（推荐）** | `judge({ sessionId, steps, skills }) → { logRatios, alignment? }` | 低：一个方法 | 注入假实现即可测 HMM 和归因；规则实现用夹具测 | 同上 | 无 |
| E3 发射直接给后验 | 注入实现自己算后验 | 最低 | 差 | — | 硬约束无法由 core 保证，违反验收第 3 项，被否 |

选 E2。形状直接用已合并的 `tool-correction-create-skill.md` §4.2 定义的 `DerivedJudge<Input, Output>`（`version` 加 `judge(input)`，同版本同输入必须同输出），本设计不另定义：

```ts
type SkillEmissionJudge = DerivedJudge<EmissionInput, EmissionOutput>

interface EmissionInput {
  readonly sessionId: string
  readonly steps: readonly EmissionStep[]        // 由 ToolAttempt 投影出来，见 §8
  readonly skills: readonly EmissionSkill[]      // 本 session 里出现过的全部 Skill
}
/** 字段名、类型与 ToolAttempt（tool-correction-create-skill.md §4.1）的同名字段一一对应。 */
interface EmissionStep {
  readonly index: number                         // 时间步序号；对应 PosteriorStep 的下标
  readonly toolName: string                      // ToolAttempt.toolName
  readonly command?: string                      // ToolAttempt.command，ADR-0023 已脱敏
  readonly argKeys: readonly string[]            // ToolAttempt.argKeys
  readonly outcome: 'failure' | 'success' | 'unknown'   // ToolAttempt.outcome
  readonly exitCode?: number                     // ToolAttempt.exitCode
  readonly errorLine?: string                    // ToolAttempt.errorLine，ADR-0023 已脱敏
}
interface EmissionSkill {
  readonly skillName: string
  readonly contentHash?: string
  readonly content?: string                      // 正文，取不到时缺（§3.5）
}
interface EmissionOutput {
  readonly logRatios: readonly (readonly number[])[]   // [step][skill]，相对 none，none 恒为 0
  readonly alignment?: readonly { readonly stepIndex: number; readonly skillName: string; readonly skillStep: number }[]
}
```

- 发射实现只打分，不知道资格区间：它对每个 Skill 都给分，core 在 forward-backward 里只用 `E_t` 内的列。这样硬约束只有一处实现。
- core 校验输出：维度一致、全是有限数、裁剪到 [−10, 10]、`skillStep` 为正整数。不合格时整个 session 回退到规则实现，记 `fallbackReason: 'invalid-output'`。
- **跳过的步骤由 core 算**，发射实现只报告对齐：对一个窗口里对齐到 Skill k 的最大 `skillStep = m`，`1..m` 里没有任何动作对齐到的就是跳过的步骤。发射实现不用各自实现一遍「跳过」。
- 输入里有 `command`、`errorLine`，都来自 ADR-0023 已脱敏的字段；本设计不另外采集，也不另外脱敏。发给外部模型的内容就是这些字段和 Skill 正文。ADR-0023 列出的「会留在事实里的」值（代理地址、URL 的 host 和路径、位置参数）因此也会到达注入的 judge，这是注入方要知道的暴露面，本设计不扩大它。
- `EmissionStep` 不带 `signal`、`timedOut`、`commandTruncated`：`ToolAttempt` 本身不带它们，前两者已经折进 `outcome`。

### 3.4 注入点和调用时机

沿用 SKIL-126 的 A3：Projection 保持同步、纯函数，不调模型。

- `EvolutionServiceOptions.emissionJudge?: SkillEmissionJudge`。没注入时用规则实现 `RULE_EMISSION`（`version: 'rule-1'`），它是同步纯函数，直接在 Projection 里调。
- 注入的实现只在显式的 Maintenance operation `scoreSkillEmissions({ signal, limit })` 里调用，结果写进 memo store `emissions`，键是 `emission:<judge version>:<inputHash>`。Projection 只读 memo；memo 里没有当前版本、当前输入的条目时，这个 session 回退到规则实现，记 `fallbackReason: 'not-scored'`。
- 投影 cursor 的版本键里加入序列模型版本、参数哈希、发射版本、memo 条数和 lastId、正文来源的哈希集合（§3.5）。任何一项变了就全量重投影。移除注入后版本键回到 `rule-1`，结果回到规则结果。本文用 `derivationKey` 指这个版本键。main 上已合并的是 `tool-correction-create-skill.md` §4.5 的 `judges` 字段，它是记版本的 record，老 cursor 没有就按不一致处理；SKIL-126（#81，未合并）提议的是一个哈希 `derivationKey`。这几项写进先落地的那个机制：`judges` 先落地时，加 `emission`、`posteriorModel`、`posteriorParams`、`emissionMemo`、`skillContent` 五个键。两者以后合成一个时本设计跟着改，记录形状不变。采用默认答案，成员可推翻。

已合并的 SKIL-128 识别器在 Projection 里直接调用，按 `inputHash` 复用上次结果；SKIL-126 是显式 operation 写 memo。两者接口形状相同，只是调用时机不同。发射模型可能是 LLM，一个 session 一次调用，放在 Projection 里会让 `failures`、`metrics` 隐式花钱，所以这里选 SKIL-126 的时机。SKIL-128 的 `rule-1` 识别器是同步纯函数，不受影响；以后有人给它注入模型识别器，也会遇到同样的隐式花钱问题。采用默认答案，成员可推翻。

### 3.5 默认规则实现 `rule-1` 与正文来源

正文来源是一条 seam，有两个 adapter，是真 seam：

```ts
interface SkillContentSource {
  readonly id: string
  read(contentHash: string, skillName: string): Promise<string | undefined>
}
```

- 默认 adapter 读 Skill root 的版本（`lifecycle.ts` 的 `listVersions` / `readCurrent`，按 `createContentHash` 匹配）。宿主（bundle）可以另外注入一个读 DSH skill 目录的 adapter。
- 只按 `contentHash` 精确匹配。正文按内容寻址，同一个哈希永远是同一份正文，所以 Projection 仍然确定。取不到的 Skill 发射恒为 0（等于不提供信息），记录上标 `profile: 'missing'`；它照样是一个隐状态，只是只靠转移和加载先验。
- `refreshDerived` 在拿锁、投影之前先按 hash 读正文，把 `ReadonlyMap<contentHash, content>` 交给纯投影；取到了哪些 hash 进 `derivationKey`。

`rule-1` 的画像（profile）从正文抽取：

1. 代码块和行内代码里的 shell 命令行，按 `tool-correction-create-skill.md` §4.3 第 2 步的意图规则（按 `&&`、`||`、`;`、`|` 切段取最后一段；去掉 `VAR=值` 和 `sudo`、`env`、`command`、`time` 前缀；程序名加第一个非 flag 参数，跳过 `git -C` 这类全局选项的值）得到 `intents` 和 `programs`。**意图规则以该节为准**，两边共用同一个函数，它的已知限制（`bash -c`、`npx <pkg>`）在这里同样成立。
2. 正文里出现的工具名（frontmatter `allowed-tools`，以及和 `EmissionStep.toolName` 取值相同的行内代码）。
3. 带扩展名或通配符的文件模式（`*.ts`、`package.json`、`.github/workflows/*`），只和 `command` 里的路径匹配，因为 ADR-0023 不采集非命令型工具的参数值，`command` 也只对 `bash`、`pwsh` 采集。
4. 有序列表项（`1.`）或 `Step N` 标题下的命令，额外记下所在的步骤号，用于对齐。

打分：步骤的意图在画像里 +2；否则程序名在画像里 +1；否则如果这一步有可识别的意图，−0.5（不匹配惩罚）；没有 `command` 的步骤只看工具名和文件模式，命中 +1，否则 0。命中第 4 条里的命令时报告 `skillStep`。`errorLine` 在 `rule-1` 里不用，留给注入的实现。

### 3.6 原型验证

用一次性原型（未提交）在三个手工标注的双 Skill 轨迹上跑 §3.2 的模型和 `rule-1` 式打分：clean 为 20 步，git-workflow / api-debugging 交替主导；noisy 为 20 步，混入 `cat`、`ls` 这类中性命令和一次跨 Skill 命令；withNone 为 17 步，其中 6 步 npm 操作标为 none。MAP 与人工标注的一致率：

| ρ | 不匹配惩罚 | clean | noisy | withNone |
|---|---|---|---|---|
| 0.9 | 0 | 1.000 | 1.000 | 0.647 |
| **0.9** | **0.5** | **1.000** | **1.000** | **0.941** |
| 0.9 | 1.0 | 1.000 | 0.950 | 1.000 |
| 0.9 | 1.5 | 1.000 | 0.850 | 1.000 |
| 0.8 | 0.5 | 1.000 | 0.950 | 0.941 |
| 逐步独立 argmax | 0.5 | 0.800 | 0.600 | 0.941 |

每种参数下，未加载 Skill 的后验都是 0。没有不匹配惩罚时 none 几乎不会胜出；惩罚太大时，一次跨 Skill 命令会把状态拉走。中性步骤落在接近平局的位置（例如 `cat app.log` 为 0.459 / 0.504），这也是 §5.3 的置信度和 none 占比标记需要存在的原因。

### 3.7 跨 session EM：先不做

| 选项 | 做法 | 取舍 |
|---|---|---|
| X1 现在做 Baum-Welch | 跨 session 估计每个 Skill 的发射参数和 ρ | 没有标注，带硬约束的 EM 容易收敛到「全是 none」或「全是最后加载的 Skill」这类退化解；参数依赖全部历史，一条新 Observation 就会改变所有 session 的后验，Retention 删段后结果也跟着变；每个 Skill 的样本量今天很小 |
| **X2 留作后续（推荐）** | 先用固定参数的 `rule-1` 和可注入的 judge | 原型显示结果对参数不敏感（§3.6）；校准信号由 §7 的因果校验给，比无监督 EM 可靠 |
| X3 只估 ρ | 用窗口长度估计保持概率 | 收益小，窗口和资格区间不同（§2.3），估出来的也不是同一个量 |

选 X2。重新评估的前提：§7 的校准报告显示系统性偏差，并且每个待估 Skill 至少有 50 个 session。到那时 EM 作为 Maintenance operation 产出一个带版本的参数文件，参数版本进 `derivationKey`，不进 Projection。采用默认答案，成员可推翻。

## 4. 后验派生记录

### 4.1 module 形状

投影新增一个深 module，interface 只有一个纯函数：

```ts
function inferSkillAttribution(
  observations: readonly RuntimeObservation[],
  inputs: {
    readonly emissions: EmissionLookup          // memo 命中则用 memo，否则 rule-1
    readonly contents: ReadonlyMap<string, string>   // contentHash → 正文
    readonly params?: SkillPosteriorParams      // 缺省为 §3.2 的默认值
  },
): { windows: SkillWindow[]; posteriors: SkillPosterior[]; attributions: FailureAttribution[] }
```

窗口切分、资格区间、forward-backward、「失败附近」的汇总核都在实现里，是内部 seam，测试都走这一个 interface。`EvolutionWorkflow.snapshot()` 在 `buildExperiences` 之前调用它，把 `attributions` 交给 `buildExperiences` 和 `buildFailureCases`。

| 选项 | 做法 | 取舍 |
|---|---|---|
| **P1 一个深 module（推荐）** | 上面的单函数 | 下游只认三种输出；窗口和后验的一致性（同一套资格区间）在一处保证 |
| P2 三个独立投影 | `buildWindows`、`buildPosteriors`、`attributeFailures` 各自导出 | 每个都要重新算资格区间，调用方要按顺序拼；interface 是三倍大 |

采用默认答案，成员可推翻。

### 4.2 记录形状

每个 session 一条，存进派生 store `skill-posteriors`（ADR-0026）：

```ts
interface SkillPosterior {
  readonly id: string                        // `posterior:${sessionId}`
  readonly sessionId: string
  readonly model: { readonly version: 'hmm-1'; readonly params: SkillPosteriorParams; readonly paramsHash: string }
  readonly emission: {
    readonly version: string                 // 'rule-1' 或注入 judge 的 version
    readonly source: 'rule' | 'judge'
    readonly fallbackReason?: 'no-judge' | 'not-scored' | 'invalid-output'
    readonly inputHash: string
  }
  readonly skills: readonly { readonly skillName: string; readonly contentHash?: string; readonly profile: 'ok' | 'missing' }[]
  readonly unknownPrefix: boolean
  readonly steps: readonly PosteriorStep[]
  readonly distribution: StateShares         // 轨迹级 π
  readonly windows: readonly { readonly windowId: string; readonly distribution: StateShares; readonly skippedSkillSteps?: readonly number[] }[]
  readonly createdAt: string                 // 取本 session 最后一条输入 Observation 的 occurredAt
}

interface PosteriorStep {
  readonly observationIds: readonly string[] // 这次工具尝试的 call 和 result
  readonly shares: StateShares               // 只含资格区间内的 Skill
  readonly map: string | null                // null 表示 none
  readonly alignment?: { readonly skillName: string; readonly skillStep: number }
}

interface StateShares {
  readonly none: number
  readonly skills: Readonly<Record<string, number>>   // 不在资格区间的 Skill 不出现，隐含为 0
}

interface SkillPosteriorParams {
  readonly stay: number        // ρ
  readonly enterOnLoad: number // λ
  readonly minShare: number    // §5.2
  readonly uncoveredShare: number
}
```

- none 和 Skill 分开存，Skill 名叫 `none` 也不会冲突。
- 概率存到小数点后 6 位，序列化结果跨平台一致。每步 `none + Σ skills = 1`，误差不超过 1e-6。
- `createdAt` 取证据时间而不是当前时间，这样同样的输入重投影时逐字节相同（与 SKIL-126 对 Projection 确定性的定义一致）。
- 后验只在派生 store 里，不写回 Observation（ADR-0016）。重投影的触发看 `derivationKey`（§3.4）。

### 4.3 Failure attribution

每个「失败主体」一条，存进派生 store `failure-attributions`（ADR-0026）。失败主体有四种：隐式 follow-up（SKIL-126 判为失败类意图的那些）、显式反馈、未恢复的工具失败（§5.1）、SKIL-128 的 Correction episode。

```ts
interface FailureAttribution {
  readonly id: string                          // `attribution:${subjectId}`
  readonly subjectId: string                   // Observation id；episode 用 episode id
  readonly origin: FailureOrigin               // 见 ADR-0027
  readonly sessionId: string
  readonly source: 'explicit' | 'override' | 'single-skill' | 'posterior' | 'none-loaded'
  readonly shares: StateShares
  readonly margin: number                      // 最大份额减第二大份额；未校准的强度分，不是概率
  readonly uncovered: boolean
  readonly stepObservationIds: readonly string[]   // 汇总用到的步骤
  readonly posteriorId?: string
}
```

`margin` 按 SKIL-133 的交接说明处理：它是证据强度分，不是概率；在 §7 的校准被成员采纳之前，不进任何门槛，也不进权重。

## 5. 归因权重规则

### 5.1 失败主体和优先级

按顺序判断，第一条命中就停，结果写进 `FailureAttribution.source`：

1. **explicit**：显式反馈带 `skill`（`recordFeedback` 给了 `skillName`）。目标就是这个 Skill，份额 1。后验不参与。
2. **override**：Observation 带 `attributionOverride`。Attribution 类别取 override 的值；目标 Skill 若同时给出则同上，没给出时目标照下面的规则算，但类别不被后验改动。
3. **single-skill**：这个 session 在失败之前只加载过一个 Skill。目标是这个 Skill，份额 1，与 SKIL-126 的「follow-up 之前恰好加载一个 Skill」规则、以及今天 `experience.ts:121` 的结果一致。`uncovered` 仍按 §5.3 计算并展示，但不删掉这个 case。
4. **none-loaded**：失败之前没有加载任何 Skill。份额全给 none，`uncovered: true`。
5. **posterior**：其余情况，也就是多 Skill session。份额按 §5.2 从后验汇总。

失败主体：

| origin | 什么时候产生 | severity |
|---|---|---|
| `explicit-feedback` | 与 SKIL-134 相同 | 与 SKIL-134 相同 |
| `implicit-follow-up` | SKIL-126 判为失败类意图的 `user-follow-up` | `medium`（不变） |
| `load-failure` | 与今天相同，走 composition，不经后验 | `high`（不变） |
| `tool-failure`（新） | task 以失败结束（`task-finished` 的 outcome 为 failed），且这个 task 里最后一次失败的 ToolAttempt 之后没有同意图的成功 | `low` |
| Correction episode | SKIL-128 定义；只做分流（§6.3），不产生 Failure case | — |

`tool-failure` 只看以失败结束的 task，因为探索性的失败（`grep` 没搜到退出 1）在成功的 task 里很常见，不是 Skill 的问题。已经恢复的失败由 SKIL-128 的 Correction episode 覆盖。采用默认答案，成员可推翻。

### 5.2 「失败附近」怎么汇总

| 选项 | 做法 | 取舍 |
|---|---|---|
| K1 只看失败那一步 | 取失败位置上一个工具步的后验 | follow-up 前如果是一次中性的 `cat`，份额几乎是平局（§3.6） |
| **K2 最近 K 步平均（推荐）** | 同一 task 里、失败之前最近 K = 3 个工具步的平滑后验取平均；没有工具步时取 HMM 在失败位置的前向预测分布 | 简单、可解释，平滑后验已经带了前后文 |
| K3 按距离指数衰减 | 所有之前的步按 `γ^d` 加权 | 多一个参数，原型上和 K2 差别不大 |

选 K2。`tool-failure` 以失败那一步为最后一步；episode 用它引用的全部失败、纠正、成功步骤。

汇总后：

- 份额低于 `minShare = 0.1` 的 Skill 丢掉，剩下的 Skill 份额和 none 份额一起归一化。
- 每个剩下的 Skill 产生一个 Failure case，`attributionWeight` = 它的份额 ÷ 所有 Skill 份额之和（不含 none）。一个主体产生的 Skill case 的权重和为 1。
- none 份额写在每个 case 的 `noneShare` 上。

### 5.3 「现有 Skill 未覆盖」

`noneShare ≥ uncoveredShare = 0.5` 时，主体标 `uncovered: true`：

- 没有任何 Skill 份额达到 `minShare` 时，不产生 Failure case（Failure case 按定义要落到某个 Skill）。这个主体只出现在 `failure-attributions` 和 `failures` 输出的「未覆盖」一节。
- 有 Skill 份额达标时，照常产生 Skill case，同时带 `uncovered: true`。
- session 的 `unknownPrefix` 为 true 时（§2.4），不标 `uncovered`：看不到的前缀里可能加载过 Skill。

### 5.4 Failure case 的变化

```ts
// 在 SKIL-134 / SKIL-126 的字段之上，全部可选
readonly attributionWeight?: number     // 缺省等于 1
readonly noneShare?: number
readonly uncovered?: boolean
readonly attributionSource?: FailureAttribution['source']
readonly attributionId?: string         // 指回 failure-attributions
```

- id：份额 1 的 case（explicit、override 给了 Skill、single-skill）保持 `failure:<subjectId>`，与今天一致；后验分摊出来的 case 用 `failure:<subjectId>#<skillName>`。
- Failure cluster 仍然按 Skill 分（`experience.ts:143`），一个主体的多个 case 各进各的 Skill 的簇，簇本身不用改。
- 簇上新增 `weightedOccurrence = Σ attributionWeight`，诊断的证据加权按 SKIL-133 的公式读它。`isClusterReadyForProposal`（`proposal.ts:141`）的 `occurrenceCount` 只数这个 Skill 份额最大的 case（主导 case），少数份额的 case 能看到但不单独触发提案。理由：后验还没校准（§7），少数份额的 case 触发提案等于让一个未校准的数进了门槛。采用默认答案，成员可推翻。
- `margin` 不写进 case，也不参与上面任何计算，只在 `failure-attributions` 和输出里展示。

### 5.5 Experience 的变化

`buildExperiences` 不再产生 `unattributed` 组：

- 多 Skill session 里，工具步按它的 MAP 状态分进 `session\0<skill>` 组；follow-up、`task-finished` 按对应 `FailureAttribution` 份额最大的一方分组；MAP 为 none 的进一个 none 组（键与 Skill 名不冲突），Attribution 为 `unknown`。
- `attributionFor` 不再因为「follow-up 跨多个 Skill」返回 `not-attributable`；`not-attributable` 只在显式 override 给出时出现。
- `withAttribution`（`experience.ts:222-227`）的「只加载一个 Skill 才填 skill」改为读 `FailureAttribution`。
- `Experience.confidence` 由 SKIL-133 改，本设计不动。

## 6. 下游对接

### 6.1 `failures` 和 `metrics`

两处按 Skill 各多出一组数，定义相同：

| 字段 | 定义 |
|---|---|
| `windows` | 这个 Skill 的 Skill window 数；另给 `uncertainWindows`（`endCertainty: 'uncertain'` 的个数） |
| `eligibleSteps` | 这个 Skill 在资格区间内的工具步数 |
| `dominantSteps` | 其中 MAP 为这个 Skill 的步数 |
| `dominantStepShare` | `dominantSteps / eligibleSteps`，`eligibleSteps` 为 0 时不给 |
| `expectedSteps` | `Σ_t p(z_t = k)`，即按后验分到这个 Skill 的步数（§6.2） |
| `attributedFailures` | 主导 case 个数；另给 `weightedFailures = Σ attributionWeight` |

另加两个全局数：`uncoveredFailures`（`uncovered: true` 的主体数）和 `noneExpectedSteps`。`failures` 的输出在每个 case 行上显示权重和 `attributionSource`，末尾加「现有 Skill 未覆盖」一节，列出 `uncovered` 的主体和它的证据 id。

`metrics()` 今天不刷新派生（`service.ts:133-135`），直接从 Observation 算。这些新数来自派生 store，所以 `metrics()` 改为先 `refreshDerived()` 再读。

| 选项 | 取舍 |
|---|---|
| **M1 `metrics()` 先刷新（推荐）** | 多一次拿锁；和 `failures` 看到的是同一份投影 |
| M2 `metrics()` 自己再算一遍后验 | 不拿锁，但两处结果可能因 memo 不同而不一致 |

采用默认答案，成员可推翻。今天 `followUps` 只数带 `skill` 的 follow-up，bundle 的 follow-up 恒为 0（§1.2）；改为数 `FailureAttribution` 里份额最大的一方，没加载 Skill 的不计。

### 6.2 SKIL-129 的步数和 token

步数和 token 的口径**以 SKIL-130 为准**。本设计只给分摊规则：

- 步数：Skill k 分到 `expectedSteps(k) = Σ_t p(z_t = k)`，none 分到剩下的部分，总和等于总步数。
- token：带 token 的 Observation（字段以 SKIL-130 为准，今天 `metrics.ts:45` 读 `payload.inputTokens`）按紧邻它之后的工具步的后验分摊；之后没有工具步的，按之前最近一步分摊；这个 session 没有工具步的全给 none。
- 评测里的 `CaseRunResult`（`evaluator.ts:12`）一次只跑一个 Skill 的正文，不需要分摊，本设计不改评测。

### 6.3 Correction episode 的分流

episode 的份额按 §5.2 从它引用的全部步骤汇总，引用的步骤是 `CorrectionEpisode` 的 `failureObservationIds`、`correctionObservationIds`、`successObservationId`（`tool-correction-create-skill.md` §4.2、§4.4）。`tool-correction-create-skill.md` §6.2 的规则 2（「过半 episode 加载过同一个 Skill（`loadedSkills`）」）改为：

- 2a. pattern 里过半 episode 的 `noneShare ≥ uncoveredShare`：跳过规则 2、3，直接走规则 4 `create-skill`。
- 2b. 否则，pattern 里过半 episode 的主导 Skill 是同一个：`patch-content` 这个 Skill。
- 都不满足时照 SKIL-128 的规则 3、4。

规则 0（已 promote 过）和规则 1（人给了 `--skill`）仍然先于它。判断理由照 SKIL-128 写进 `source.targetReason`，写明用了哪条规则和各 episode 的主导 Skill。后验没校准，但这里只选提案目标，不是门槛，提案仍要走评测和人工。

这一条修改的是已合并的 `tool-correction-create-skill.md` §6.2，那里写明目标判断规则是可逆的业务判断（「可逆，规则在 core 里」），所以不需要新 ADR。本 PR 不改那份设计稿的正文，以本节为准；S2 写 spec 时两处合成一条规则。没有后验（单 Skill、没加载 Skill、旧日志）的 episode，2a、2b 都按原规则 2 的 `loadedSkills` 计。

## 7. 因果校验操作（可选，抽样）

### 7.1 形状

一个显式的 Maintenance operation，不进默认投影，不进评测门槛：

```ts
function calibrateSkillPosteriors(
  service: EvolutionService,
  options: {
    readonly replay: CounterfactualReplay      // 宿主注入，core 不带实现
    readonly sample: { readonly sessions: number; readonly seed: string; readonly skills?: readonly string[] }
    readonly signal?: AbortSignal
  },
): Promise<CalibrationReport>

interface CounterfactualReplay {
  readonly version: string
  replay(input: { readonly sessionId: string; readonly task: string; readonly skills: readonly EmissionSkill[]; readonly withheld?: string; readonly signal: AbortSignal }): Promise<{ readonly steps: readonly EmissionStep[]; readonly outcome: 'passed' | 'failed' | 'unknown' }>
}
```

- core 定义 `CounterfactualReplay`，dsh-adapter 用 `DshEvaluationExecutor`（`dsh-adapter/src/evaluator.ts:52`）实现一个 adapter。`DshEvaluationRunInput` 今天只带一个 `skillContent`，adapter 需要支持「一组 Skill、去掉其中一个」，这属于 dsh-adapter 的改动，由 S3 Builder 做，不影响 core。
- 抽样：从有 `posterior` 来源的多 Skill session 里，按 `seed` 确定性地抽 `sessions` 个（默认 20）。每个 session 对每个被加载的 Skill k 跑两次：全部 Skill，和去掉 k。任务文本取 `payload.taskSummary`，也就是 `taskText`（`experience.ts:312`）读的那个字段；取不到的 session 跳过并计数。已合并的 SKIL-128 没有定义任务文本的采集。在 `9975647` 上，bundle 和 dsh-adapter 都不写 `taskSummary`，第一条用户消息也不落正文（`mapUserMessage` 只给 follow-up 记 `text`，`dsh-bundle/index.js:377-394`）。所以今天每个 session 都会被跳过。补任务文本的采集属于采集层，要另立一张票，并且要先过 ADR-0023 那样的隐私确认，本设计不定义（见 §13 待定项）。
- 花钱：每次调用最多 `sessions × (1 + 加载的 Skill 数)` 次重放。只在成员显式运行时发生，不在 `refreshDerived`、worker 或评测里调用。

### 7.2 比较什么

对 session 里的每个 Skill k：

- **后验侧**：`π(k)`（§3.2 的轨迹级份额）。
- **重放侧**：去掉 k 之后的行为变化 `Δ(k)`：两次重放的工具步序列按意图（`tool-correction-create-skill.md` §4.3 的意图规则）做编辑距离，除以较长一方的长度；outcome 变了另记一项。
- **报告**：
  - 按 `π(k)` 分 5 档，每档的 `Δ(k)` 均值和样本数（可靠性曲线的数据）。
  - `π(k)` 与 `Δ(k)` 的 Spearman 秩相关。
  - 以「`Δ(k) ≥ 0.3` 或 outcome 改变」为正例，`margin` 与正例的 Brier 分数，以及拟合出的 Platt 参数（样本 ≥ 200 时另给 isotonic 映射）。
  - 报告里写明重放 adapter 的 `version`、发射版本、模型参数哈希、抽样 seed 和被跳过的 session 数。

### 7.3 结果怎么用

报告写成 State directory 下的一份文件（`calibration/<timestamp>.json`），不是派生 store，也不参与 `derivationKey`。**校准参数不会自动生效**：成员看过报告后，把 Platt 参数作为模型参数的一部分显式写进配置，它才进 `SkillPosteriorParams` 和 `derivationKey`。在那之前，`margin` 和 `π` 都不进任何门槛或权重（SKIL-133 的交接要求）。

| 选项 | 取舍 |
|---|---|
| **C1 报告 + 人工采纳（推荐）** | 重放结果有随机性，自动生效会让投影随一次抽样漂移；人工采纳让参数变化和 `derivationKey` 一一对应 |
| C2 报告写进 memo，投影自动读取 | 省一步人工，但抽样一次就改变全部派生结果，也让重放花的钱变成投影的隐式依赖 |

采用默认答案，成员可推翻。

## 8. 对 SKIL-128 的依赖

SKIL-128 已合并（`9975647`）。采集字段和脱敏以 ADR-0023 和 `tool-correction-create-skill.md` §3 为准，投影层形状以同一份设计稿的 §4 为准。本设计不定义、不另外脱敏。逐项核对结果如下，「来源」都指那份设计稿：

| 用在哪 | 本设计用的名字 | 来源 | 核对 |
|---|---|---|---|
| §3.1 时间步 | `ToolAttempt`；按 `correlationIds` 配对；按 `sessionSeq`，缺省用 `occurredAt` 排序 | §4.1、§4.3 第 3 步 | 一致 |
| §3.3 `EmissionStep.toolName` | `toolName` | §4.1；payload 已有字段 | 一致 |
| §3.3 `EmissionStep.command` | `command` | §3.1（tool/call，只限 `bash` / `pwsh`，前 16 token，≤ 240 字符，R1–R7 已脱敏），§4.1 | 一致。`commandTruncated` 在 §3.1 里有，但 `ToolAttempt` 不带，本设计也不用；上一版写依赖它，已删 |
| §3.3 `EmissionStep.argKeys` | `argKeys: readonly string[]` | §3.1（≤ 16 个），§4.1 | 一致；老记录缺字段时为 `[]` |
| §3.3 `EmissionStep.outcome` | `'failure' \| 'success' \| 'unknown'` | §4.1（core 按 `failed`、`exitCode ≠ 0`、`signal`、`timedOut` 判） | 一致。`signal`、`timedOut` 只通过 `outcome` 间接使用 |
| §3.3 `EmissionStep.exitCode` | `exitCode?: number` | §3.1（tool/result），§4.1 | 本轮新增，上一版漏了。可选字段，`rule-1` 不用 |
| §3.3 `EmissionStep.errorLine` | `errorLine` | §3.1、§3.3（失败时才写，≤ 200 字符，已脱敏），§4.1 | 一致；`rule-1` 不用 |
| §3.5 画像抽取、§5.1「同意图的成功」、§7.2 编辑距离 | 意图规则 | §4.3 第 2 步 | 一致，两边共用一个函数 |
| §5.1、§5.2「同一 task」 | Observation 的 `taskId` | `RuntimeObservation.taskId`（`types.ts`）；`ToolAttempt` 不带，按 `callObservationId` 回查 | `ToolAttempt` 没有 `taskId`，本设计不往它上面加字段 |
| §6.3 分流 | `CorrectionEpisode` 的 `failureObservationIds`、`correctionObservationIds`、`successObservationId`、`loadedSkills`；§6.2 的规则 0–4 | §4.2、§4.4、§6.2 | 一致 |
| §3.3 注入接口 | `DerivedJudge<Input, Output>` | §4.2 | 一致，已定稿；SKIL-126（#81）跟随 |
| §3.4 重投影 | cursor 的 `judges` | §4.5 | 本设计加 5 个键（§3.4） |
| §7.1 任务文本 | `payload.taskSummary` | SKIL-128 没有定义 | 依赖缺口，见 §13 |

字段名都对上了，`EmissionStep` 的映射是一对一的字段拷贝，没有改名。

## 9. 验收判据

父 issue 第 6 条逐项对应。夹具都是手工构造的 Observation 序列，跑纯函数 `inferSkillAttribution` 或 `EvolutionWorkflow.snapshot()`，不起 DSH。

1. **单 Skill 窗口**：一个 session 加载 git-workflow，之后 3 个工具步、一条 `user-follow-up`、2 个工具步、`task-finished`。断言得到 1 个窗口，`startObservationId` 是那条 `skill-loaded`，`endObservationId` 是 follow-up，`endReason: 'user-follow-up'`，`stepObservationIds` 恰好是前 3 个工具步的 call 和 result。再各构造一个以另一个 Skill 加载、同一个 Skill 重新加载、`task-finished`、`context-shadowed` 结束的变体，断言对应的 `endReason`；日志到头的变体断言 `'open'` 和 `'uncertain'`；加载 Observation 不带 `shadowTracked` 的变体断言 `endCertainty: 'uncertain'`。
2. **双 Skill 一致率**：把 §3.6 的 clean 和 noisy 两条轨迹（git-workflow / api-debugging 交替主导，逐步人工标注）作为测试夹具提交，连同两个 Skill 的正文。默认参数、`rule-1` 下，每条轨迹的 MAP 与人工标注一致率 **≥ 0.9**（原型为 1.0 和 1.0，逐步独立 argmax 为 0.8 和 0.6，这个阈值能区分有无序列模型）。带 none 段的 withNone 轨迹 **≥ 0.85**（原型为 0.941）。
3. **未加载 Skill 后验恒为 0**：注入一个假 judge，对所有 Skill（包括尚未加载、已被遮蔽的）每一步都给 +10。断言每一步 `shares.skills` 的键都属于该步的资格区间，而且 `none + Σ skills = 1`（误差 ≤ 1e-6）。再对随机生成的 200 个 session（随机加载、遮蔽、步数）做同一断言。
4. **多 Skill 失败按权重归属**：§1.2 的探针 session。断言 Failure case 不再是 0 条；隐式 follow-up 产生的 case 里 api-debugging 的 `attributionWeight` 最大，所有 case 的权重和为 1；Experience 里没有 `unattributed` 组，也没有 `not-attributable`。再构造一个 follow-up 紧跟在 git-workflow 主导段之后的变体，断言权重最大的一方变成 git-workflow。
5. **显式反馈不被覆盖**：在第 4 项的 session 里加一条 `recordFeedback({ skillName: 'git-workflow', kind: 'incorrect' })`，注入一个把所有步都推向 api-debugging 的 judge。断言这条反馈的 case 为 `failure:<id>`、`skillName: 'git-workflow'`、`attributionWeight` 缺省（等于 1）、`attributionSource: 'explicit'`。对带 `attributionOverride` 的 Observation 断言 Attribution 类别等于 override 的值。
6. **换发射模型重新投影**：同一个 Skill root，先不注入，记下 `skill-posteriors` 和 `failures`；注入一个 `version: 'fake-2'` 的假 judge 并运行 `scoreSkillEmissions`，之后 `failures()` 不带 `force` 就重投影，断言后验记录的 `emission.version === 'fake-2'` 且至少一个主体的份额改变；移除注入再调用 `failures()`，断言结果与第一次逐字节相同。

额外判据：

7. **遮蔽映射**（bundle）：把 §2.2 的事件序列喂给新的 mapper，断言 `compaction/prune` 映射成 `context-shadowed`，`shadowedSeqRanges` 覆盖 seq 6；替换用的 `tool/result` 带 `surfaceReplace: true`，不是 `tool-result`；`skill-loaded` 带 `shadowTracked: true`。core 侧断言遮蔽之后的步骤里 git-workflow 不再出现在 `shares` 里。
8. **确定性**：同一份 Observation log 和 memo，投影两次的 `skill-posteriors` 逐字节相同；Observation 顺序打乱（`sessionSeq` 不变）后结果相同。
9. **未覆盖**：withNone 轨迹里 npm 段内的一次失败，断言 `uncovered: true` 且不产生 Failure case，出现在 `failures` 输出的「未覆盖」一节；给同一 session 设 `unknownPrefix` 后断言不再标 `uncovered`。
10. **metrics**：第 4 项的 session 里断言每个 Skill 的 `windows`、`dominantStepShare`、`attributedFailures` 与手算值相等，`Σ_k expectedSteps(k) + noneExpectedSteps` 等于总工具步数。

## 10. Seam 清单

| seam | adapter | 会被什么变化拉扯 | 为什么现在开 |
|---|---|---|---|
| `SkillEmissionJudge` | `rule-1`；宿主注入的 embedding / LLM 实现；测试用假实现 | 发射模型换代最频繁；真实模型测试成本高 | 两个以上 adapter 已确定（规则和假实现立刻就有） |
| `SkillContentSource` | Skill root 版本；DSH skill 目录 | Skill 从哪里装进 DSH 的方式会变（SKIL-128 §6.5 的发布范围缺口） | 两个 adapter 已确定 |
| `CounterfactualReplay` | dsh-adapter 的执行器；测试用假实现 | DSH 执行器和评测环境 | 真实实现要起 DSH，测试必须能替换 |
| bundle 的遮蔽映射（ADR-0014） | 现有 bundle | DSH 压缩插件的事件形状 | 已有 seam，只补映射 |

不开的 seam：转移模型只有一个实现，参数进记录就够了，不单独注入；「失败附近」的汇总核（§5.2）和窗口切分是 `inferSkillAttribution` 的内部 seam，只给它自己的测试用。

## 11. Builder 拆分建议

| # | 内容 | 依赖 |
|---|---|---|
| B1 | bundle 遮蔽映射；core 增加 `context-shadowed` kind（ADR-0025） | 无 |
| B2 | Skill window 切分与 `skill-windows` store；验收 1、7 的 core 部分 | B1 |
| B3 | 序列模型、`rule-1`、`SkillContentSource`、`skill-posteriors` store、cursor 版本键；验收 2、3、8 | B2、SKIL-128 S3 第 1 张（采集）和第 2 张（`ToolAttempt` 与意图规则）的实现 |
| B4 | `failure-attributions`、Failure case 扇出、Experience 与 `failures` / `metrics` 输出；验收 4、5、9、10 | B3、SKIL-126 实现（SKIL-134 已在 main） |
| B5 | judge 注入、`emissions` memo、`scoreSkillEmissions`；验收 6 | B3、SKIL-126 的 memo |
| B6 | `tool-correction-create-skill.md` §6.2 分流对齐、SKIL-129 步数和 token 分摊 | B4、SKIL-128 S3 第 3 张、SKIL-130 实现 |
| B7 | `calibrateSkillPosteriors` 和 dsh-adapter 的重放 adapter | B3 |

## 12. 与已有 ADR 和相邻设计的关系

- _与 ADR-0002 的字面冲突_：`emissions` memo 保存注入模型的输出，派生记录不再只靠 Observation log 就能重建，而是靠 Observation log 加 memo。SKIL-126 的 ADR-0034（#81，未合并）为 Classification memo 做了同样的解释，本设计沿用那份解释，不另起一套。没有注入 judge 时，派生记录仍只依赖 Observation log 和按内容寻址的 Skill 正文。
- CONTEXT.md 的 Derived record 定义和列表随之更新，并补 Skill window、Skill posterior、Failure attribution 和资格区间（本 PR 已改）。Failure case 仍然「定位到某个 Skill」，只是多了权重，定义补一句。
- ADR-0014：core 只读 bundle 写的核心词汇，不读 `payload.eventType`，一致。
- ADR-0015：后验不改 Provider rank，也不改会话行为，一致。
- ADR-0016：后验、窗口、归因都是派生，引用 Observation id，不写回事实，一致。
- ADR-0022（SKIL-134，已合并）：本设计给 `FailureOrigin`（`types.ts:99`）增加 `tool-failure`，扩展的是已接受的取值集合，不改另外三个值的含义，也不改 cluster id 规则。扇出 case 的 id `failure:<subjectId>#<skillName>` 按同样的 `createdAt`、`id` 排序参与聚类，最早的 case id 仍然决定簇 id。`diagnoseFailureCluster`（`experience.ts:193`）对只含 `tool-failure` 的簇得到 `rootCause: 'uncertain'`，结论是 `observe-only`，也就是只看不提案。诊断规则不改，采用默认答案，成员可推翻。
- ADR-0023（SKIL-128，已合并）：只读它定义的字段，不新增采集，不另外脱敏（§8）。
- ADR-0024（SKIL-128，已合并）：Correction episode 留在 `episodes` store，不冒充 Failure case；「未覆盖」的主体同样不产生 Failure case（§5.3），一致。
- SKIL-126（#81）：single-skill 的归因结果与它的规则一致；多 Skill 由本设计补上。
- `tool-correction-create-skill.md`（SKIL-128，已合并）：§6.3 修改了它 §6.2 的规则 2。那条规则在原设计稿里写明可逆，不涉及 ADR。

## 13. 不可逆决策

- **ADR-0025**：bundle 把 DSH 的上下文遮蔽记为 `context-shadowed` Observation，替换事件标 `surfaceReplace`，加载标 `shadowTracked`。
- **ADR-0026**：Skill window、Skill posterior、Failure attribution 是按 session 的派生记录，带模型和发射版本；注入 judge 的输出只进 `emissions` memo，Projection 不调模型。
- **ADR-0027**：多 Skill 失败扇出成按 Skill 的 Failure case，带 `attributionWeight`，id 为 `failure:<subject>#<skill>`；提案门槛只数主导 case。
- **ADR-0028**：发射模型的注入 interface 是按 session 的 `SkillEmissionJudge`，输出相对 none 的对数似然比；硬约束和跳过步骤由 core 计算。

ADR 编号：`origin/main`（`9975647`）最大号是 0024。开着的设计 PR 的号段由 Mika 在 SKIL-132 上统一分配：本 PR 是 0025–0028，#83 是 0029–0031，#80 是 0032，#81 是 0033–0035。四条 ADR 都是 `status: proposed`，成员确认后在本 PR 里改成 `accepted`。

## 14. 可逆取舍（采用默认答案，成员可推翻）

§2.3 W2 窗口与资格区间分开；§3.1 T2 以工具尝试为时间步；§3.2 ρ = 0.9、λ = 0.8、后验解码而非 Viterbi；§3.4 judge 走显式 operation 和 memo；§3.5 `rule-1` 的打分值（+2 / +1 / −0.5）；§3.7 EM 留作后续；§4.1 P1 单个深 module；§5.1 `tool-failure` 只看以失败结束的 task；§5.2 K2、K = 3、`minShare = 0.1`；§5.3 `uncoveredShare = 0.5`；§5.4 门槛只数主导 case；§6.1 M1 `metrics()` 先刷新；§7.1 抽 20 个 session；§7.3 C1 校准参数人工采纳；§3.4 新键写进 `judges`；§12 只含 `tool-failure` 的簇只看不提案。

## 15. 待定项

- **ADR-0025–0028 待成员确认**（不可逆）。确认之前 S2 不定稿。
- **§7.1 任务文本没有采集来源**：`payload.taskSummary` 今天没人写。在补上之前，`calibrateSkillPosteriors` 会把所有 session 都跳过，报告里只有跳过计数。补采集属于采集层，会把用户原话写进事实，需要另立一张票，并像 ADR-0023 那样先做隐私确认。这一项只影响可选的 §7，不影响验收 1–10。默认：本票不做，S2 把 §7 的 `CounterfactualReplay` 写成接受宿主传入的 `task`。采用默认答案，成员可推翻。
- **cursor 版本键的落点**：main 上已有 `judges`（§4.5），SKIL-126 提议 `derivationKey`，两者谁统一谁，留给 SKIL-126 合并时决定（§3.4）。
