> 状态：SKIL-126 设计提案（父 issue SKIL-125 的 S1）。不可逆决策见 ADR-0022、0023、0024，三份都是 `proposed`，等成员确认。
> 本文合并后冻结，不随代码更新。与现状不一致时，以代码、ADR 和 spec 为准。

本文给维护闭环里的 follow-up 意图分类出设计：分类器的 interface、意图取值、规则降级、显式反馈优先、派生记录的形状、「确定性」的定义、bundle 的增量字段和边界。基线是 `origin/main` @ `2a442af`。只出设计，不写实现代码。

## 1. 现状

### 1.1 读了什么

- core：`packages/skill-evolution/src/experience.ts`、`workflow.ts`、`service.ts`、`types.ts`、`metrics.ts`、`projection.ts`、`maintenance.ts`、`report.ts`、`events.ts`、`records.ts`，都读了全文；`state-root.ts:1-100`、`locking.ts:80-95`、`proposal.ts:140-146`、`index.ts` 读了相关段落。
- 调用方：`packages/dsh-bundle/index.js`（`createDefaultEventMapper`、`apply`、`executeMaintenanceCommand`、`mapUserMessage`、`mapToolCall`、`mapToolResult`、`cleanupMapperState`）、`packages/dsh-adapter/src/adapter.ts`、`packages/skill-evolution/bin/dsh-skill-evolution.mjs:23,72-86`。
- 测试：`packages/skill-evolution/tests/evolution.spec.ts:49-86,447-460,572-596`、`tests/core.spec.ts:213-230,360-378`、`packages/dsh-bundle/tests/bundle.spec.mjs:163-183,298-330`。
- 文档：`CONTEXT.md`、`AGENTS.md`、ADR-0002、0003、0014、0016、0019，`docs/agents/domain.md`，`research/designer-subagent-readonly-tools-zh.md`，SKIL-101、SKIL-104 的决议评论。
- 基线：`npm --prefix packages/skill-evolution run build` 通过，`npx vitest run tests` 输出 `Tests  134 passed (134)`。

### 1.2 follow-up 怎么变成失败

- bundle 只看顺序，不看内容：同一个 session 里第二条及以后的人类用户消息，一律写成 `user-follow-up`，`payload` 里只有脱敏后的 `text`、`eventType`、`sessionSeq`（`packages/dsh-bundle/index.js:378-395`）。这条记录不带 `skill`。
- `buildFailureCases` 在 session 里恰好加载过一个 Skill 时，把每条隐式 follow-up 都算成那个 Skill 的 `medium` 失败（`experience.ts:119-132`）。
- `attributionFor` 把 follow-up 标成 `unknown`（`experience.ts:245`），`confidenceFor` 给 0.35（`experience.ts:256`）。
- `diagnoseFailureCluster` 按失败描述里的子串判根因：含 `load` 就判 `composition`，含 `follow-up` 就判 `content`（`experience.ts:179-181`）。

### 1.3 探针（`2a442af`，脚本已删）

单 Skill session，依次写入 `谢谢`、`好的`、一条没有 `text` 的 follow-up：

```text
{"failures":[["failure:f1","medium","谢谢"],["failure:f2","medium","好的"],["failure:f3","medium","User follow-up after Skill use"]],
 "diagnoses":[["cluster:api-debugging:谢谢","uncertain","observe-only"],["cluster:api-debugging:好的","uncertain","observe-only"],
              ["cluster:api-debugging:after-follow-skill-up-use-user","content","patch-content"]],
 "attribution":[["unknown",0.35]]}
```

同一个 session，改写一条不带 `skill` 的显式 `satisfied` 反馈、`please reload the page`、`Please correct step two`：

```text
{"failures":[["failure:fb","medium"],["failure:f2","medium"],["failure:f3","medium"]],
 "diagnoses":[["cluster:api-debugging:great","uncertain"],["cluster:api-debugging:page-please-reload-the","composition"],["cluster:api-debugging:correct-please-step-two","uncertain"]]}
[{"skillName":"api-debugging",...,"loadSucceeded":1,...,"followUps":0,...,"followUpRate":0}]
```

### 1.4 从探针和代码读出的问题

1. **寒暄也算失败**：`谢谢`、`好的` 各自成为一条 `medium` Failure case，还各自单独成一个 Failure cluster。
2. **显式反馈的优先级只在带 `skill` 时成立**：`experience.ts:89` 要求 `explicit === true && event.skill !== undefined`。bundle 的 `/skill-evolution feedback` 里 `--skill` 是可选的（`packages/dsh-bundle/index.js:246`）。不带 `--skill` 的显式 `satisfied` 会落进隐式分支，被算成 `medium` 失败（探针 2 的 `failure:fb`）。父 issue 的第 4 条今天就被违反了。
3. **根因靠子串猜**：`please reload the page` 因为含 `load` 被判成 `composition`；带原文的 follow-up 失败描述里没有 `follow-up` 这个词，所以只会判成 `uncertain`。只有没有 `text` 时的兜底描述才会判成 `content`。
4. **Skill 加载前的跟进也被归给它**：`buildFailureCases` 按整个 session 收集加载过的 Skill（`experience.ts:78-85`）。在 Skill 加载之前说的话，也会算成它的失败。
5. **`metrics` 数不到隐式跟进**：`aggregateMetrics` 只统计带 `skill` 的记录（`metrics.ts:36`），而 bundle 写的 `user-follow-up` 从不带 `skill`，所以 `followUps` 恒为 0（探针 2）。父 issue 说「`failures` 和 `metrics` 的数字虚高」，实际情况是 `failures` 虚高，`metrics` 偏低。
6. **Projection cursor 只看 Observation**：`refreshDerivedUnlocked` 的快路径只比较条数、`lastId` 和 fingerprint（`service.ts:396`）。只要推导规则或分类器变了而 Observation 没变，就会一直返回旧的 Derived record。
7. **Projection 是同步的，也是纯函数**：`EvolutionWorkflow.snapshot()` 是同步调用（`workflow.ts:31-37`），而且在 projection 锁里执行（`service.ts:387-413`）。锁的缺省等待时间是 5 秒（`locking.ts:82`）。如果在锁里调用模型，并发的 `failures` 会拿到 `LockBusyError`。
8. **顺带发现，本设计不修**：mapper 在 session 空闲 30 分钟后会清掉状态（`index.js:553`），之后的下一条消息不再记成 `user-follow-up`。`diagnoseFailureCluster` 的 `createdAt` 缺省取当前时间（`experience.ts:176`），因此重投影时 Diagnosis 的这个字段每次都不同。

## 2. 设计问题、选项与取舍

每个问题列出选项，推荐项标 ★。标「不可逆」的题见 §6 和对应的 ADR，其余题都是 `采用默认答案，成员可推翻`。

### 2.1 分类在哪一步调用模型

| 选项 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|
| A1 Projection 改成异步，在 `refreshDerived` 的锁里逐条调用分类器 | 低 | 差：每次投影都要 mock 模型 | 高 | 高：`buildFailureCases` 等导出函数都要改成异步；锁要持有几十秒，并发调用会 `LockBusyError` |
| A2 `refreshDerived` 在拿锁之前先跑一遍分类，结果写进 memo，再拿锁做纯投影 | 中 | 中 | 高 | 中：但 `failures`、`observe`、`metrics`、`MaintenanceWorker` 都会隐式花钱，失败了要不要重试也难定 |
| ★A3 分类是一个显式的 Maintenance operation（占位 `classifyFollowUps`），只负责写 memo；Projection 保持同步和纯函数，只读 memo | 中 | 好：纯投影直接喂 memo 就能测，分类用假分类器测 | 高 | 低：导出函数签名只加可选参数 |

推荐 A3。理由有三条。第一，`repair` 和重投影里不会出现任何模型调用，「确定性重算」直接成立。第二，花钱的时机只有一个，就是人或 worker 显式触发的那次。第三，Projection 仍在锁里，几毫秒就能完成。代价是注入了分类器但还没跑 `classifyFollowUps` 时，新的 follow-up 先按规则处理，结果里标 `source: 'rule'`，能看出来。

### 2.2 分类器的 interface 和注入点（不可逆，ADR-0024）

- C1 裸函数，和 `Designer` 一样，另传 `classifierVersion`：换实现时容易忘记换版本号，memo 会把新模型的输出记在旧版本名下。
- ★C2 带 `version` 的对象：`{ version, classify(context, signal) }`，版本和行为绑在一起。
- C3 批量 `classifyMany`：超时、部分失败、写 memo 的粒度都变复杂；需要批量的实现可以在对象内部自己合并请求。

注入点：放在 `EvolutionServiceOptions.followUpClassifier`，这是父 issue 的要求。这里和 Designer 的注入方式有一处不同，需要写明：`Designer` 是每次调用时传入的参数（`service.ts:165`，SKIL-101 定下的第六个用例函数也是 `{ clusterId, designer }`）。两者相同的地方是 SKIL-101 定下的那条依赖方向：core 定义形状，宿主构造实现，core 不引用 DSH。分类器不能按次传入，原因是 `refreshDerived` 有很多调用方（`failures`、`observe`、`metrics`、`repair`、worker），它们都要用同一个 `classifierVersion` 去选 memo，否则同一个 Skill root 在不同入口看到的 Failure cluster 会不一样，违反 SKIL-104 的约束「Designer 看到的 cluster 与 `failures` 一致」。

超时和报错（推荐：逐条处理，互不影响）：

- 每次调用 `classify` 时传入 `AbortSignal.any([调用方的 signal, AbortSignal.timeout(timeoutMs)])`，`timeoutMs` 缺省 10 000。做法和 SKIL-102 对 `subagents.start` 的结论一致：超时由调用方自己合成 signal。
- 以下情况只把这一条记进返回值的 `failed`，不写 memo，接着处理下一条：抛错、超时、返回值不合格（`intent` 不在允许的取值里，或者取值是 `other`；`confidence` 不是 [0, 1] 之间的有限数）。下次运行会重试这一条。
- 调用方的 signal 被 abort 时，立刻停止，返回已经完成的部分。已经写进 memo 的条目保留。
- Projection 看不到这些失败。凡是 memo 里没有有效条目的 follow-up，Projection 一律走规则，并标 `fallbackReason: 'not-classified'`。

### 2.3 意图取值和对齐表（不可逆，ADR-0024）

- 选项 I1：另起一套意图词表，再维护一张到 `FEEDBACK_KINDS` 的映射表。同一个意思会有两个名字。
- 选项 I2：把「继续」和「无关」拆成两个值。下游对这两个值的处理完全一样。
- ★选项 I3：`FOLLOW_UP_INTENTS = [...FEEDBACK_KINDS, 'not-attributable', 'unknown']`。显式反馈的 kind 就是意图本身。分类器和规则都不输出 `other`。

下表给每个意图定下游的行为（占位名 `INTENT_POLICY`，带 `INTENT_POLICY_VERSION`）。严重度按来源分两列：显式反馈的严重度和今天的 `experience.ts:98` 一致；推断来源最多只到 `medium`。这样一条推断出来的纠正过不了 Designer 的证据门槛（`isClusterReadyForProposal`，`proposal.ts:141-146`：至少 2 次，或者至少一条 `high`），显式纠正的门槛和今天一样。

| 意图 | 在 `FEEDBACK_KINDS` 里 | 显式来源的严重度 | 推断来源的严重度 | `attributionFor` 的归因 | `diagnoseFailureCluster` 的根因 → operation |
|---|---|---|---|---|---|
| `incorrect` | 是 | high | medium | `content` | `content` → `patch-content` |
| `constraint` | 是 | low | low | `content` | `content` → `patch-content` |
| `retry` | 是 | medium | medium | `unknown` | `uncertain` → `observe-only` |
| `dissatisfied` | 是 | medium | medium | `unknown` | `uncertain` → `observe-only` |
| `other` | 是 | low | 不输出 | `unknown` | `uncertain` → `observe-only` |
| `satisfied` | 是 | 不是失败 | 不是失败 | `unknown` | — |
| `goal-changed` | 是 | 不是失败（今天是 low，这是行为变化） | 不是失败 | `task-change` | — |
| `not-attributable` | 否 | — | 不是失败 | `not-attributable` | — |
| `unknown` | 否 | — | 不是失败 | `unknown` | — |

按前一轮工具活动修正。只在三个条件同时满足时生效：来源是推断（classifier 或 rule），意图会成为失败，这条 follow-up 没有 `attributionOverride`。

- `precedingToolKind === 'skill-load-failed'`：归因改为 `composition`，根因改为 `composition` → `edit-metadata`。
- `precedingToolFailed === true`，并且是 `tool-result`：归因改为 `tool`，根因改为 `not-skill` → `observe-only`，严重度降为 `low`。这类失败仍然记成 Failure case，也就是保留「不是 Skill 的原因」这条证据，但不会推动 `patch-content`。

置信度（写进 `Experience.confidence`，也写进解析结果）：

- 显式来源：取 `payload.attributionConfidence`，没有时取 1。
- 分类器来源：取分类器给的 `confidence`。
- 规则来源：取该条规则固定的置信度（见 §2.4）。
- 没有 follow-up 决定归因时，沿用今天的 `confidenceFor`。

`attributionFor` 对一组 Observation 的判断顺序是：组内任一条 `attributionOverride` → 有 `skill-load-failed` 时判 `composition` → 多个 Skill 时判 `not-attributable` → 组内第一条会成为失败的 follow-up，取它的解析归因 → 没有这样的 follow-up 但有 `goal-changed` 时判 `task-change` → `unknown`。前三步和今天一样（`experience.ts:239-244`）。

归因目标（采用默认答案，成员可推翻）：一条 follow-up 只归给同一 session 里、按 log 顺序在它之前加载过的 Skill；这样的 Skill 恰好有一个时才归。显式反馈带了 `skill` 就用它。这一条修掉 §1.4 的问题 4，只影响新增的解析结果和 `buildFailureCases`，`buildExperiences` 的分组不变。

### 2.4 规则降级

规则是纯函数，输入是一条 follow-up 及其所在的这一轮（§2.8），带版本常量 `FOLLOW_UP_RULES_VERSION`（如 `rules/1`）。按以下顺序匹配，第一条命中即停：

| 顺序 | 规则 id | 输入 | 命中条件（示例，词表由 spec 定死） | 意图 | 置信度 |
|---|---|---|---|---|---|
| 1 | `empty` | `text` | 没有文本，或者规范化之后为空 | `unknown` | 0 |
| 2 | `correction` | `text` | 否定或纠正词：`不对`、`错了`、`不正确`、`应该是`、`wrong`、`incorrect`、`should be`、`please correct` | `incorrect` | 0.6 |
| 3 | `constraint` | `text` | 追加约束：`还要`、`别忘了`、`必须`、`不要`、`make sure`、`must`、`don't` | `constraint` | 0.5 |
| 4 | `retry` | `text` | 重试词：`再试`、`重试`、`重新来`、`try again`、`retry`、`redo` | `retry` | 0.6 |
| 5 | `goal-changed` | `text` | 换话题的标记：`换个话题`、`另一个问题`、`顺便问`、`by the way`、`new task` | `goal-changed` | 0.6 |
| 6 | `acknowledgement` | `text` | **整条消息**只由致谢或确认词和标点组成：`谢谢`、`好的`、`收到`、`ok`、`thanks`、`great` | `satisfied` | 0.7 |
| 7 | `continue` | `text` | 以继续词**开头**的短消息：`继续`、`接着`、`下一步`、`go on`、`continue`、`next` | `not-attributable` | 0.6 |
| 8 | `no-match` | — | 以上都不命中 | `unknown` | 0.2 |

- 文本规范化：NFKC，转小写，去掉首尾空白。纠正类排在致谢类前面，所以「好的，但是不对」命中 `correction`。致谢类要求整条消息匹配，所以「好的，接下来改一下标题」不会命中 `acknowledgement`。
- `precedingToolKind` / `precedingToolFailed` 不决定意图，只按 §2.3 修正归因和根因。「紧跟在 Skill 加载之后」的作用是 §2.3 的归因目标：跟进之前没有加载过 Skill，就没有归因目标，不会成为任何 Skill 的失败。
- 匹配不上就标 `unknown`，**不再默认算失败**。
- 词表写成 spec 里的固定表，并带正例和反例。spec 必须把现有测试的原文列为 `correction` 的正例：`Please correct step two.`、`Please correct timeout diagnosis.`、`Please correct this.`；把 `that's correct` 列为反例。
- 规则只能识别有明显标记的换话题。隐式的换话题（直接问一个无关的问题）只有分类器能识别，规则给出的是 `unknown`，同样不算失败。

### 2.5 优先级：显式反馈和 `attributionOverride`

对每条 `user-follow-up`，按下面的顺序解析意图。第一条命中即停：

1. **显式**：`payload.explicit === true`。意图取 `payload.feedbackKind`；取值不在 `FEEDBACK_KINDS` 里时按 `other` 处理。`source: 'explicit'`。`classifyFollowUps` 跳过这类记录，Projection 也不去查 memo。**不论带不带 `skill`，都走这一步**，这一条修掉 §1.4 的问题 2。
2. **分类器**：当前注入了分类器，而且 memo 里有键为 `classification:<当前 version>:<inputHash>` 的有效条目。`source: 'classifier'`。
3. **规则**：`source: 'rule'`，同时写 `fallbackReason`：没注入分类器时写 `no-classifier`，注入了但 memo 里没有条目时写 `not-classified`。

归因独立于意图：这条 follow-up 的 `payload.attributionOverride` 是合法的 `Attribution` 时，归因取它，写 `attributionSource: 'override'`，§2.3 的表和工具修正都不再生效。`attributionFor` 现有的「组内任一条 override 优先」（`experience.ts:239-240`）保持不变。

### 2.6 派生记录的形状（ADR-0016）

- 选项 D1：只在 `SkillFailureCase` 上加字段。但不是失败的意图（`satisfied`、`goal-changed`、`unknown`）就无处可存，`metrics` 数不到它们。
- ★选项 D2：新增一种 Derived record，占位名 **Follow-up resolution**，每条 `user-follow-up` 一条，存进新的 derived store `follow-ups.jsonl`。`SkillFailureCase` 再加两个可选字段，指回它。
- 选项 D3：写回 Observation。违反 ADR-0016，被否。

```ts
// 占位名，命名留给 spec
interface FollowUpResolution {
  readonly id: string                    // `follow-up:${observationId}`
  readonly observationId: string
  readonly sessionId?: string
  readonly skillName?: string            // §2.3 的归因目标；没有目标时不写
  readonly intent: FollowUpIntent
  readonly confidence: number
  readonly source: 'explicit' | 'classifier' | 'rule'
  readonly version: string               // explicit 时为 'explicit'；否则是分类器的 version 或 FOLLOW_UP_RULES_VERSION
  readonly ruleId?: string               // 只在 source 为 rule 时写
  readonly fallbackReason?: 'no-classifier' | 'not-classified'
  readonly inputHash?: string            // 只在 source 为 classifier 时写
  readonly attribution: Attribution
  readonly attributionSource: 'override' | 'intent'
  readonly policyVersion: string         // INTENT_POLICY_VERSION
  readonly evidenceEventIds: readonly string[]  // 这条 follow-up，以及决定工具修正的那条 Observation（如果有）
}

// SkillFailureCase 增加的字段（都是可选字段，只增不改）
readonly origin?: 'explicit' | 'classifier' | 'rule' | 'observation'   // skill-load-failed 写 'observation'
readonly attribution?: Attribution
```

- `failure:${observationId}` 这个 id 格式不变。`failure` 字段的文本也不变，所以 Failure cluster 的签名和 id 不受影响（不替换聚类算法）。
- `diagnoseFailureCluster` 不再按子串猜根因，改为读 case 的 `attribution`，映射为 `composition → composition`、`content → content`、`tool` / `not-attributable → not-skill`，其余映射为 `uncertain`。同一个 cluster 里有多种根因时，按 `composition > content > not-skill > uncertain` 取第一个。没有 `attribution` 的旧 case 仍按子串规则判断。这一条修掉 §1.4 的问题 3。
- **`failures`**：JSON 输出里的每个 case 多出 `origin`、`attribution` 两个字段。SKIL-104 说过 `--format json` 保持不动，这里只是追加字段，不改已有字段。Markdown 的每一行在严重度后面追加来源，例如 `[medium · rule]`、`[high · explicit]`。SKIL-104 把 `failures` 改成按 cluster 分组的改动先合并的话，每个 cluster 的摘要里再加一列按来源的计数。
- **`metrics`**：每个 Skill 新增 `followUpIntents: { explicit, classifier, rule }`，每个来源下是 `{ total, failures, byIntent }`。现有的 `followUps` / `followUpRate` 保持今天的语义，不改（§1.4 的问题 5 记为已知缺口）。`service.metrics()` 改为先调用 `refreshDerived()`，取到 Follow-up resolution 之后，作为第 4 个可选参数传给 `aggregateMetrics`。

### 2.7 「确定性」的定义（不可逆，ADR-0023）

- 选项 M1：不做 memo，每次投影都调用分类器。结果会漂移，每次运行 `failures` 都要花钱。被否。
- 选项 M2：把分类结果当作 Fact record 写入。模型的判断就成了权威事实，违反 ADR-0016。被否。
- ★选项 M3：Classification memo 是 State directory 下的 `classifications.jsonl`，在 `layout.stores` 里的 role 是 `memo`。Projection 只读它，从不重建它。

**定义**：给定 Observation log、`FOLLOW_UP_RULES_VERSION`、`INTENT_POLICY_VERSION`、当前分类器的 `version`（没注入时为 `none`）和 memo，Projection 的输出是唯一确定的。

- **分类器的输入**：由纯函数 `classificationInputFor(events, observationId)` 从 log 算出。内容包括：这条 follow-up 的脱敏原文；它所回应的那一轮（§2.8）里的 Observation，最多 20 条，每条只保留 `kind`、`skill.name`、`payload.failed`、`payload.toolName`；之后同一轮的 Observation，截到下一条人类跟进或第一条 `task-finished` 为止，同样最多 20 条；以及按 §2.3 算出的归因目标 Skill 名。时间戳和 `sessionSeq` 都不放进输入。
- **闭合**：「之后」那一段还在增长时，这条 follow-up 算 `pending`。`classifyFollowUps` 跳过 pending 的条目，不调用分类器，Projection 对它走规则。「之后」那一段在以下三种情况下算闭合：看到了下一条人类跟进、看到了 `task-finished`，或者已经到 20 条。闭合之后，输入就不会再变。
- **键**：`inputHash = sha256(canonical JSON(input))`。memo 条目的 id 是 `classification:<version>:<inputHash>`，内容是 `{ id, classifierVersion, inputHash, observationId, intent, confidence, rationale?, createdAt }`。`rationale` 经过 `redactSensitiveText`，并截断到 500 字符。
- **何时失效**：条目永远不删，也不重写。只有两种情况会让条目不再被命中：分类器换了 `version`（旧条目留在文件里，但不再命中），或者输入变了（例如 Retention 删掉了前一段 Archive segment）。这两种情况下都回到规则，直到重新分类。memo 文件丢失或损坏时，按分帧规则隔离坏行，缺的部分回到规则。清理旧版本的条目属于 Retention 的范围，不在本需求内。
- **Projection cursor**：新增 `derivationKey = sha256(rulesVersion, policyVersion, classifierVersion ?? 'none', memo 的条数和 lastId)`。`derivationKey` 不一致时，走完整投影。旧的 cursor 文件没有这个字段，按不一致处理，第一次调用会重投影一次。这一条修掉 §1.4 的问题 6。
- **`repair`**：`refreshDerived({ force: true })` 只读 memo，不调用分类器。它对 memo 做 health 检查和残行隔离，但不删它，也不重写它。

### 2.8 Observation 增量字段（不可逆，ADR-0022）

- 选项 O1：不改 bundle，只按 log 顺序离线推断。
- ★选项 O2：`user-follow-up` 的 payload 里追加 `precedingToolKind`、`precedingToolFailed` 两个字段，O1 作为旧记录的退路。
- 选项 O3：记录紧邻的前一条 Observation 的 kind。这个值几乎总是 `task-finished` 或 `agent-step`，没有信息量。
- 选项 O4：记录 DSH 原始的事件类型。违反 ADR-0014。

**「这一轮」的定义**：同一个 session 里，从上一条人类用户消息之后，到这条跟进之前。bundle 在 session 状态里维护 `lastToolKind` / `lastToolFailed`：每条人类用户消息（`source.kind === 'user'`）都把它们清空；`mapToolCall` 映射出 `skill-load-requested` 时，以及 `mapToolResult` 映射出 `skill-loaded`、`skill-load-failed`、`tool-result` 时，都更新它们。写 `user-follow-up` 时，把当前值带上。离线的退路从这条 follow-up 往前扫描同一个 session，扫到上一条非显式的 `user-follow-up` 或 session 开头为止。显式反馈不使用这两个字段。

### 2.9 边界

- **运行闭环**：bundle 只多写两个同步计算的字段，不调用模型，也不改变会话行为。
- **维护闭环**：只有 `classifyFollowUps` 会调用分类器。`refreshDerived`、`repair`、`failures`、`metrics`、`MaintenanceWorker.runOnce` 都不调用分类器。
- **ADR-0014**：`FollowUpClassifier` 是 core 定义的结构类型；规则只认 core 的 `ObservationKind`。core 不 import 任何 DSH 模块。
- **不在本需求内，采用默认答案，成员可推翻**：DSH 上真实的分类器后端（adapter 工厂加上 bundle 起 subagent，思路同 SKIL-101、SKIL-102）、`/skill-evolution classify` 子命令和 CLI 入口都不做。本需求只交付 core 的 interface、规则、memo、`classifyFollowUps`，以及用假分类器写的验收测试。成员要的话，可以在父 issue 上另起一张票。

## 3. 推荐方案的 interface

名字都是占位，命名留给 spec。

```ts
// types.ts
export const FOLLOW_UP_INTENTS = [...FEEDBACK_KINDS, 'not-attributable', 'unknown'] as const
export type FollowUpIntent = typeof FOLLOW_UP_INTENTS[number]

// follow-up.ts（新 module，纯函数，没有 I/O）
export interface FollowUpClassificationInput {
  readonly observationId: string
  readonly text?: string
  readonly skillName?: string                       // §2.3 的归因目标
  readonly before: readonly ObservationDigest[]     // 这一轮，最多 20 条
  readonly after: readonly ObservationDigest[]      // 闭合后的后续，最多 20 条
}
export interface ObservationDigest { readonly kind: ObservationKind; readonly skillName?: string; readonly toolName?: string; readonly failed?: true }
export interface FollowUpClassification { readonly intent: Exclude<FollowUpIntent, 'other'>; readonly confidence: number; readonly rationale?: string }
export interface FollowUpClassifier {
  readonly version: string
  classify(input: FollowUpClassificationInput, signal: AbortSignal): Promise<FollowUpClassification>
}
export function classificationInputFor(events: readonly RuntimeObservation[], observationId: string): { readonly input: FollowUpClassificationInput; readonly pending: boolean; readonly inputHash: string }
export function resolveFollowUps(events: readonly RuntimeObservation[], options?: { readonly memo?: ReadonlyMap<string, ClassificationMemoEntry>; readonly classifierVersion?: string }): FollowUpResolution[]

// experience.ts：只加可选参数，缺省时按规则解析
export function buildFailureCases(events: readonly RuntimeObservation[], resolutions?: readonly FollowUpResolution[]): SkillFailureCase[]

// service.ts
export interface EvolutionServiceOptions { /* 现有字段不变 */ readonly followUpClassifier?: FollowUpClassifier; readonly classifierTimeoutMs?: number }

// operations.ts：第 N 个 Maintenance operation
export function classifyFollowUps(service: EvolutionService, options?: { readonly signal?: AbortSignal; readonly limit?: number }): Promise<{
  readonly classifierVersion: string
  readonly classified: number
  readonly cached: number
  readonly skipped: { readonly explicit: number; readonly pending: number }
  readonly failed: readonly { readonly observationId: string; readonly reason: 'timeout' | 'error' | 'invalid-output'; readonly message: string }[]
}>
```

- 没有注入分类器时，`classifyFollowUps` 抛 `OperationError`，占位码为 `classifier-unavailable`。
- `WorkflowSnapshot` 增加 `followUps: readonly FollowUpResolution[]`。`EvolutionWorkflow` 的构造选项增加 `memo` 和 `classifierVersion`。`snapshot()` 仍是同步调用。
- `resolveFollowUps` 是这次改动的 deep module：意图优先级、规则、策略表、工具修正、归因目标都藏在它后面。`buildFailureCases`、`attributionFor`、`diagnoseFailureCluster`、`aggregateMetrics` 都只读它的输出。以后改规则或策略表，只改这一个 module，外加一个版本常量。

### 3.1 这些 seam 会被什么拉扯

- **`FollowUpClassifier`**：会换后端（本地模型、DSH subagent、远程 API），会换 prompt。后端换得频繁，而测试成本主要在模型调用上，所以 seam 开在这里，让规则、memo 和 Projection 都能用假分类器在 Vitest 里测。
- **`resolveFollowUps` 和策略表**：会改词表、改严重度、加意图取值。这几项改动的频率高于 Failure cluster 算法，所以它们与 `clusterFailureCases` 分开，靠版本常量触发重投影。
- **bundle 的增量字段**：只会因为 DSH 事件形状变化而改动，改动集中在 mapper 里。core 只认 `ObservationKind`。

## 4. 父 issue 第 7 条验收用例由什么保证

| 用例 | 保证它的规则或 interface 行为 | 测试做法 |
|---|---|---|
| 「谢谢 / 好的 / 继续」不产生失败 | §2.4 的 `acknowledgement` 规则得到 `satisfied`，`continue` 规则得到 `not-attributable`；§2.3 规定这两个意图都不是失败 | 不注入分类器，单 Skill session 写入这三条，`failures` 为空，Follow-up resolution 的来源是 `rule` |
| 「不对，应该…」产生 content 类失败 | §2.4 的 `correction` 规则得到 `incorrect`；§2.3 映射为 medium、`content`；§2.6 的 `diagnoseFailureCluster` 按 `attribution` 判为 `content`，operation 为 `patch-content` | 同上，断言 case 的 `origin: 'rule'`、`attribution: 'content'`，以及 Diagnosis 的 `rootCause: 'content'` |
| 换话题识别为 goal-changed，不算失败 | 带标记的换话题由 §2.4 的 `goal-changed` 规则识别；隐式换话题由分类器给 `goal-changed`（§2.5 第 2 步）；§2.3 规定不算失败，归因为 `task-change` | 两条都测：规则路径用 `顺便问一下…`；分类器路径注入对这条返回 `goal-changed` 的假分类器 |
| 显式反馈不会被覆盖 | §2.5 第 1 步：显式反馈不查 memo，也不走规则，不论带不带 `skill`；`attributionOverride` 优先于策略表 | 注入对所有条目都返回 `incorrect` 的假分类器，跑 `classifyFollowUps`。断言：不带 `skill` 的显式 `satisfied` 不是失败；显式 `incorrect` 仍是 high；带 `--attribution tool` 的纠正，归因仍是 `tool`；`classifyFollowUps` 的 `skipped.explicit` 计数正确 |
| 注入假分类器后重投影结果改变，移除后回到规则结果 | §2.7：memo 按 `version + inputHash` 命中；cursor 的 `derivationKey` 含分类器版本，注入或移除都会触发完整投影 | 同一个 root：① 不注入分类器，`refreshDerived` 得到规则结果 R；② 用注入了分类器的 service 跑 `classifyFollowUps` 再 `refreshDerived`，结果不等于 R，来源为 `classifier`；③ 新建一个不注入分类器的 service，`refreshDerived` 的结果深等于 R。另测 `repair()` 在注入分类器时不调用 `classify`（假分类器记调用次数） |

## 5. 迁移与拆分

### 5.1 现有测试

- 保持通过，不用改：`bundle.spec.mjs:298-330`。原因：`Please correct timeout diagnosis.` 命中 `correction`，`snapshot.failures.length` 仍为 1，显式 `incorrect` 仍为 high。`evolution.spec.ts:49-62`（`Please correct step two.` 仍然产生失败，数量仍为 2）、`:572-596`、`core.spec.ts:213-230` 同样不用改。
- 行为变化，需要在 spec 里标出：显式 `goal-changed` 从 low 级失败变为不算失败；不带 `skill` 的显式反馈不再按隐式跟进处理；Skill 加载之前的跟进不再归给这个 Skill；旧的 projection cursor 第一次会触发一次重投影。

### 5.2 Builder 拆分建议

- **T1 规则与解析（core，纯函数）**：`FOLLOW_UP_INTENTS`、`follow-up.ts` 里的规则、策略表、`resolveFollowUps`、`classificationInputFor`；把 `buildFailureCases`、`attributionFor`、`confidenceFor`、`diagnoseFailureCluster` 改成读解析结果；`SkillFailureCase` 的可选字段；`failures` 的输出。覆盖用例 1–4 的规则路径。
- **T2 分类器、memo 和 cursor（core）**：`FollowUpClassifier`、`EvolutionServiceOptions.followUpClassifier`、`classifications.jsonl`（role `memo`）、`follow-ups.jsonl`、`classifyFollowUps`、`derivationKey`、`metrics` 的来源拆分。覆盖用例 3 的分类器路径、用例 4 的分类器部分、用例 5。依赖 T1。
- **T3 bundle 增量字段**：按 ADR-0022 写两个字段，外加 `bundle.spec.mjs` 的映射测试。不依赖 T1、T2，可以并行。T1 的离线退路保证 T3 合并之前也能工作。

## 6. 不可逆决策

- ADR-0022：`user-follow-up` 的 payload 追加 `precedingToolKind`、`precedingToolFailed` 两个可选字段，只用 core 的词汇。
- ADR-0023：分类器的输出存进 Classification memo，Projection 是「Observation log + memo + 版本」的纯函数。
- ADR-0024：意图取值是 `FEEDBACK_KINDS` 的超集，分类器以带 `version` 的对象注入。

编号从 0022 开始，因为 0021 已被未合并的 PR #78（SKIL-123）占用；`origin/main` 上最大编号是 0020。

**ADR 冲突**：ADR-0023 修订了 ADR-0002 和 `CONTEXT.md` 里 **Derived record**、**Projection** 的表述（「从 Observation log 完整重建」），注入分类器以后还要加上 memo。之所以值得修订，是因为模型分类本身不确定，只靠 Observation log 做不到父 issue 要的「确定性重算」。ADR-0016 不冲突。

## 7. 待定项与默认答案

以下都是可逆的取舍，**采用默认答案，成员可推翻**：

- 分类时机取 A3，也就是显式的 `classifyFollowUps`，Projection 从不调用模型（§2.1）。
- `classify` 的超时缺省 10 s；失败的条目不写 memo，下次重试（§2.2）。
- 推断来源的严重度最多到 `medium`（§2.3）。
- 归因目标只取这条跟进之前加载过的、唯一的那个 Skill（§2.3）。
- 规则的词表和顺序以 §2.4 为准，spec 负责定死正例和反例。
- `followUps` / `followUpRate` 保持今天的语义（§2.6）。
- DSH 上的分类器后端和子命令不在本需求内（§2.9）。
- `CONTEXT.md` 要新增三个词条：**Follow-up intent**（对一条用户跟进的意图判断，取值见 ADR-0024）、**Follow-up resolution**（一条跟进的意图、来源和版本，属于 Derived record）、**Classification memo**（分类器输出的缓存，不是 Fact record，也不是 Derived record）。**Derived record**、**Projection** 两个词条按 ADR-0023 修订。成员确认 ADR 以后，这些改动放在同一个设计 PR 里提交。
