# 派生投影收成一个 deep module；「失败意图」集合只定义一次

SKIL-181（父 issue SKIL-179，来源：架构扫描 SKIL-178 第 1、5 项）。基线 `origin/main` @ `c916c36`，文中行号都按这个基线。写作期间 main 前进到 `82a9aef`（合入 #114 SKIL-171、#115），结论不变，行号有偏移：`service.ts` 中 `metrics()` 到 `proposeChange()` 一段 +2，`refreshDerivedUnlocked` 一段 +42（`derivationKey` 在 `:545`，`replaceAll` 在 `:575-582`）；`workflow.ts` 的 `propose` +17（`:62`）；四处失败意图字面量的行号不变。

## 1. 现状

### 1.1 读了什么

- `packages/skill-evolution/src/service.ts`：构造函数里的 store 字段（`:59-107`）、`metrics()`（`:168-178`）、`recordCorrectionClassifierFailure()`（`:180-187`）、`repair()`（`:203-217`）、`proposeChange()`（`:254-261`）、`refreshDerived` / `refreshDerivedUnlocked`（`:490-544`）。
- `packages/skill-evolution/src/state-root.ts`：`StoreRole`、`StoreName`、`ProjectionCursor`（`:11-28`），`resolveLayout` 的 store 清单（`:55-91`），`readCursor` / `writeCursor`（`:93-115`）。
- `packages/skill-evolution/src/workflow.ts`（全文）、`maintenance.ts:28-42`、`bin/dsh-skill-evolution.mjs:74`、`packages/dsh-bundle/index.js:255-259`。
- `packages/skill-evolution/src/experience.ts:138-160,216-223,290-320`，`metrics.ts:144-156`，`follow-up.ts:1-40`，`types.ts:390-400`，`correction.ts:92-97`，`operations.ts:150-160`，`index.ts`。
- 测试：`tests/correction.spec.ts:128-150`、`tests/core.spec.ts:510-530`、`tests/archive-health-repair.spec.ts:157-229`。
- ADR-0002、0016、0026、0034、0035；`CONTEXT.md` 的 Derived record、Projection、Projection cursor、Classification memo；`docs/design/skill-window-posterior-attribution.md` §3.4、§4；`docs/design/tool-correction-create-skill.md` §4.5；`specs/skill-window-posterior-attribution/tasks.md` Task 4–8。
- PR 的 diff：#113（SKIL-162，posterior 投影，draft）、#114（SKIL-171，pattern 提案，写作期间已合入）、#111（SKIL-174）。

### 1.2 一个投影今天散在哪些地方

以 main 上的 `skill-windows` 和 PR #113 新加的三个 store 为例，新增一个派生投影要手改：

| 位置 | 改什么 | 漏改的后果 |
|---|---|---|
| `state-root.ts:12` `StoreName` | 加名字 | 编译失败（唯一有保护的一处） |
| `state-root.ts:57-72` `resolveLayout` | 加 `[name, role, …, path]` 行 | 运行时 `find(...)!` 拿到 `undefined` |
| `service.ts:59-73` 字段 + `:93-106` 构造 | 加 `JsonlRecordStore` | 无 |
| `service.ts:503` `derivationKey` | 加版本 / memo 指纹 | **静默走过期 fast path** |
| `service.ts:504-515` fast path 返回 | 加 `readAll()` | 调用方读不到 |
| `service.ts:516-540` 全量重建 | 计算 + `replaceAll` | 不落盘 |
| `service.ts:543` 全量返回 | 加字段 | 调用方读不到 |
| `workflow.ts:33-41` `WorkflowSnapshot` | 加字段 | 无 |
| `state-root.ts:21-28` + `:93-115` cursor | 新计数 / `judges` 字段 | 计数丢失 |
| `service.ts:254-261` `proposeChange` | 再算一遍 | Designer 看到另一份结果 |

已经发生的漏改：

- `skill-windows` 在 `service.ts:533` 落盘，但 fast path（`:507-514`）和全量返回（`:543`）都不带它，`refreshDerived()` 的调用方读不到窗口。
- PR #113 的 `refreshDerivedUnlocked` 加了 `skill-posteriors`、`failure-attributions`，两条返回路径也都没带上。
- `windowRulesVersion`、`correctionRulesVersion` 只进 `derivationKey`，投影代码不读它们；反过来，main 上 `skill-attribution.ts:94`（`inferSkillAttribution`，main 的 service 还没调用它）已经把模型版本 `'hmm-1'` 和 emission 版本 `'rule-1'` 写成字面量，PR #113 的 service 又另写了一遍 `'hmm-1'` 进 key。版本靠两处手抄保持一致；而 `'rule-1'` 恰好与 `CORRECTION_RULES_VERSION`（`correction.ts:6`）同值，按值核对分不出两者（§4 G4 因此按名字核对）。

### 1.3 探针：`proposeChange` 和存储的投影分叉

`proposeChange`（`service.ts:254-261`）先 `refreshDerived()`，然后丢掉结果，用过滤掉 correction memo 的 memo 新建一个 `EvolutionWorkflow` 再算一遍。这条路径不跑 correction 识别，所以 `experienceForEpisode` 产出的 Experience 进不了 Designer。

临时探针（两个 session，各有一段 `git push` 失败 ×2 → 加代理成功，外加 `skill-load-failed` 凑出一个 cluster；跑完已删）输出：

```text
{"storedExperiences":4,"storedCorrection":2,"designerTotal":2,"designerCorrection":0,"fastPathHasSkillWindows":false}
```

存储的投影有 4 条 Experience，其中 2 条是 correction；Designer 只拿到 2 条，0 条 correction。SKIL-163（Task 4）会把 failure attribution 传进 `buildFailureCases`、改 `workflow.propose()` 的门槛；如果到那时 `proposeChange` 还在自己重算，它算出的 cluster 不带 attribution，id 和存储的 cluster 对不上，`proposeChange(storedClusterId)` 会直接报 `unknown failure cluster`。

### 1.4 「失败意图」字面量

`['incorrect', 'constraint', 'retry', 'dissatisfied', 'other']` 原样出现在 `experience.ts:141`（建 Failure case）、`experience.ts:296`（`attributionFor`）、`experience.ts:317`（`confidenceFor`）、`metrics.ts:154`（`intentMetrics`）。`FOLLOW_UP_INTENTS`（`types.ts:392`）加一个值时，四处都不会报错，新值默认被当成「不是失败」。

### 1.5 `correctionClassifierFailures`

它只在 `classifyCorrections`（`operations.ts:157,160`）失败时由 `recordCorrectionClassifierFailure()` 加一，持 cursor 锁写进 cursor。Projection 不产生它，也没法从 Observation log 重建。`repair()` 走 `refreshDerived({ force: true })`，全量重建时 `:497` 先读回旧值、`:542` 原样写回，所以 repair 不清零；只有手动删除 cursor 文件才会归零。

## 2. 方案选项与取舍

### 2.1 module 的形状

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. 投影规格注册表 | 每个投影注册 `{ store, dependsOn, version, build(ctx, deps) }`，module 做拓扑排序、逐个算 | 高：experiences 要合并 workflow 和 episode 的结果，failures 要依赖 attribution，依赖图要表达成泛型 | 每个投影可单测，但依赖注入的类型很难写对 | 可逆 | 每个投影都要改成规格对象 |
| **B. 类型化 store 注册表 + 单个纯投影函数 + 持久化 module（推荐）** | store 只在一张表里注册一次；`projectDerived(ctx)` 是纯函数，返回类型由注册表映射出来；`DerivedProjection` 负责 key、fast path、重建、读取 | 中 | 纯函数直接测；fast path 和全量重建可以对所有注册项做通用断言 | 可逆 | 现有计算逻辑原样搬进纯函数 |
| C. 留在 service，加测试守卫 | 不动结构，只补「fast path 等于全量重建」的测试 | 低 | 只有测试，没有编译期保护 | 可逆 | 最低 |

推荐 B。A 把依赖关系做成了运行时数据，但投影之间的依赖今天只有一条直线（follow-up → failures → clusters → diagnoses，加上 correction 和 attribution 两路汇入），用普通函数调用表达更直接，类型也更好写。C 不解决「改 10 处」的问题，只是让漏改晚一点被发现。采用默认答案，成员可推翻。

### 2.2 `derivationKey` 怎么算

| 选项 | 做法 | 漏改风险 |
|---|---|---|
| K1. 现状：手写一个对象做 hash | 新投影的作者要记得往里加字段 | 静默过期 |
| **K2. 投影只能从 `DerivationContext` 取输入，key 是 context 里除 Observation 外全部内容的 hash（推荐）** | `versions` 整个进 hash；memo 指纹按注册表里所有 `memo` store 遍历；正文哈希集合进 hash | 新的 memo store 自动进 key；新版本号不进 `versions` 就传不进投影函数 |

K2 下 key 不是第二份手写清单，而是投影输入本身的指纹，所以「改了输入却没改 key」在结构上做不到。剩下的漏洞是投影代码直接 import 一个常量或写字面量（如 main 上 `skill-attribution.ts:94` 的 `'hmm-1'`、`'rule-1'`），由 §4 的 G4 测试和 `VERSION_SOURCES` 的穷举类型兜住。采用默认答案，成员可推翻。

### 2.3 `proposeChange` 的读取路径

| 选项 | 做法 | 取舍 |
|---|---|---|
| **P1. 读存储的投影（推荐）** | `refresh()` 返回的 view 就是 Designer 的输入，cluster、case、experience 全部取自同一份记录 | 只有一个真相来源；不重复计算；`proposeChange(id)` 用的 id 一定存在于存储的 cluster 里 |
| P2. 重算，但走同一个 `projectDerived(ctx)` | 计算路径统一了，读取路径没统一 | 每次提案多算一遍；锁外重算和锁内落盘之间仍可能看到不同的 Observation |

推荐 P1。`refresh()` 在 cursor 锁内完成，Designer 在锁外运行（它可能很慢），这和今天的锁范围一样。#114 的 `proposePattern` 已经是「refresh 后读 store」，P1 让两条提案路径一致。采用默认答案，成员可推翻。

### 2.4 `correctionClassifierFailures` 放在哪

| 选项 | 做法 | 取舍 |
|---|---|---|
| **C1. 留在 cursor，由 `DerivedProjection` 代管（推荐）** | 磁盘格式不变；module 读写 cursor 时原样带上这个字段，`recordClassifierFailure()` 是它唯一的写入口 | 不需要 ADR；手动删 cursor 会归零，和今天一样 |
| C2. 搬进一个新的 fact store（每次失败追加一条，带 session、原因、分类器版本） | 删 cursor 不丢；能按 session 查 | 磁盘格式变更，要单独写 ADR；要从旧 cursor 迁移计数；要定 Retention |

推荐 C1，不搬。理由：这个计数只用于 `metrics().corrections.classifierFailures` 的展示，不进任何门槛、不触发重试；`repair()` 不会清零它（§1.5）；手动删 cursor 本来就是「我要重置投影状态」的操作。把它搬进 fact store 的收益是按 session 追溯，现在没有需求用到。以后有门槛或重试要读它时，再按 C2 写 ADR。采用默认答案，成员可推翻。

### 2.5 失败意图集合

| 选项 | 做法 | 新意图加进 `FOLLOW_UP_INTENTS` 时 |
|---|---|---|
| F1. `FAILURE_INTENTS` 常量数组 | 四处改为引用它 | 静默算作「不是失败」 |
| **F2. 穷尽映射 `INTENT_OUTCOME: Record<FollowUpIntent, IntentOutcome>`，`FAILURE_INTENTS` 和 `isFailureIntent()` 从它派生（推荐）** | 每个意图必须显式归类 | 编译失败，直到作者给它归类 |

推荐 F2，放在 `follow-up.ts`，紧挨 `INTENT_POLICY_VERSION`。「哪些意图算失败」本身就是意图策略的一部分：改了归类会改变 Projection 的输出，必须同时升 `INTENT_POLICY_VERSION`，而这个版本已经在 `derivationKey` 里。放在一起，改的人看得见。`follow-up.ts` 只依赖 `events.ts` 和 `types.ts`，`experience.ts`、`metrics.ts` 引用它不会成环。采用默认答案，成员可推翻。

## 3. 推荐方案：接口

三层，依赖方向从上到下：`service.ts` → `derivation.ts`（`DerivedProjection`）→ `projection-steps.ts`（纯函数 `projectDerived`）→ `store-registry.ts`（注册表）。`state-root.ts` 也依赖 `store-registry.ts`，不再自己维护 store 清单。`projection-steps.ts` 还依赖 `workflow.ts`，以复用 `projectWorkflow`（§3.5 第 4 条）；`workflow.ts` 不反向依赖新文件。文件名避开已有的 `store.ts`（Observation log）和 `projection.ts`（exposure view），这两个文件不动。

### 3.1 store 注册表（新文件 `store-registry.ts`，唯一的注册位置）

```ts
// 一个 store 只在这里出现一次。key 是 view 上的属性名，name 是文件名。
export const STORES = {
  observations:        store<RuntimeObservation>('observations', 'fact', { projectionInput: true }),
  proposals:           store<SkillProposal>('proposals', 'fact'),
  decisions:           store<DecisionRecord>('decisions', 'fact'),
  feedback:            store<FeedbackRecord>('feedback', 'fact'),
  evaluations:         store<EvaluationArtifact>('evaluations', 'fact'),
  classifications:     store<ClassificationMemo>('classifications', 'memo'),
  experiences:         store<Experience>('experiences', 'derived'),
  followUps:           store<FollowUpResolution>('follow-ups', 'derived'),
  failures:            store<SkillFailureCase>('failures', 'derived'),
  clusters:            store<FailureCluster>('clusters', 'derived'),
  diagnoses:           store<SkillDiagnosis>('diagnoses', 'derived'),
  skillWindows:        store<SkillWindow>('skill-windows', 'derived'),
  episodes:            store<CorrectionEpisode>('episodes', 'derived'),
  patterns:            store<CorrectionPattern>('patterns', 'derived'),
  // PR #113 合并后由 T2 迁入：skillPosteriors、failureAttributions（derived），emissions（memo）
} as const

export type StoreKey = keyof typeof STORES
export type DerivedKey = { [K in StoreKey]: (typeof STORES)[K]['role'] extends 'derived' ? K : never }[StoreKey]
export type MemoKey = { [K in StoreKey]: (typeof STORES)[K]['role'] extends 'memo' ? K : never }[StoreKey]
export type RecordOf<K extends StoreKey> = (typeof STORES)[K] extends StoreSpec<infer T, string, StoreRole> ? T : never
export type DerivedRecords = { readonly [K in DerivedKey]: readonly RecordOf<K>[] }
export type StoreName = (typeof STORES)[StoreKey]['name']   // 替换 state-root.ts:12 的手写联合
```

- `store<T>(name, role, opts?)` 返回 `{ name, role, projectionInput }`，`T` 只是类型标记（phantom），不占运行时字段。
- `resolveLayout` 改为遍历 `STORES` 生成 `layout.stores`，顺序、路径、`projectionInput` 与今天逐字节一致（`tests/core.spec.ts:113` 的 layout 断言保持通过）。
- service 的 store 字段由 `openStores(layout)` 按注册表批量创建，现有的公开字段名（`service.experiences`、`service.patterns`……）保留为同一批实例的引用，测试和已合入的 #114 不用改。

### 3.2 纯投影函数（新文件 `projection-steps.ts`）

```ts
export interface DerivationVersions {            // 写进 cursor.judges，整份进 derivationKey
  readonly followUpRules: string                 // FOLLOW_UP_RULES_VERSION
  readonly intentPolicy: string                  // INTENT_POLICY_VERSION（含 §3.6 的失败归类）
  readonly followUpClassifier: string            // 注入分类器的 version，没注入为 'none'
  readonly windowRules: string                   // SKILL_WINDOW_RULES_VERSION（T3 从字面量提成常量）
  readonly correctionRules: string
  readonly correctionPolicy: string
  readonly correctionClassifier: string
  readonly posteriorModel: string                // POSTERIOR_MODEL_VERSION（T3 把 skill-attribution.ts:94 的 'hmm-1' 提成常量）
  readonly emissionRules: string                 // EMISSION_RULES_VERSION（T3 把同一行的 'rule-1' 提成常量）
  // PR #113 合并后由 T3 迁入：emission judge 版本、posteriorParams
}

/** 每个版本字段的来源，按名字登记。Record 穷举 DerivationVersions：少一项编译失败。 */
export const VERSION_SOURCES: { readonly [K in keyof DerivationVersions]:
  | { readonly kind: 'constant'; readonly name: string; readonly value: string;          // name = 导出常量的标识符
      readonly override?: 'windowRulesVersion' | 'correctionRulesVersion' }           // 测试用的覆盖选项（§1.2）
  | { readonly kind: 'injected'; readonly option: 'followUpClassifier' | 'correctionClassifier' } } = {   // 取注入对象的 version，缺省 'none'
  followUpRules:  { kind: 'constant', name: 'FOLLOW_UP_RULES_VERSION', value: FOLLOW_UP_RULES_VERSION },
  intentPolicy:   { kind: 'constant', name: 'INTENT_POLICY_VERSION', value: INTENT_POLICY_VERSION },
  followUpClassifier: { kind: 'injected', option: 'followUpClassifier' },
  windowRules:    { kind: 'constant', name: 'SKILL_WINDOW_RULES_VERSION', value: SKILL_WINDOW_RULES_VERSION, override: 'windowRulesVersion' },
  // …其余字段同理
}

export interface DerivationContext {
  readonly observations: readonly RuntimeObservation[]
  readonly memos: { readonly [K in MemoKey]: readonly RecordOf<K>[] }
  readonly skillContents: ReadonlyMap<string, string>   // contentHash → 正文（ADR-0026 §3.5）
  readonly versions: DerivationVersions
}

export interface Derivation {
  readonly records: DerivedRecords                 // 每个 derived 注册项一份，缺一个就编译失败
  readonly counters: { readonly correctionRejectedDrafts: number }
}

/** 同步纯函数：同一个 context 永远得到逐字节相同的 records。不调模型，不读墙钟，不做 IO。 */
export function projectDerived(ctx: DerivationContext): Derivation

export function resolveDerivationVersions(options: Pick<EvolutionServiceOptions,
  'followUpClassifier' | 'correctionClassifier' | 'windowRulesVersion' | 'correctionRulesVersion'>): DerivationVersions
```

- `projectDerived` 的函数体就是今天 `refreshDerivedUnlocked` 里 `:516-532` 的计算加 `buildSkillWindows`。它分成几个导出的步骤函数，其中第一步是 `projectWorkflow(observations, options)`（§3.5），即今天 `EvolutionWorkflow.snapshot()` 的函数体原样搬出，返回 `WorkflowSnapshot`。`projectDerived` 在它之后接 correction、skill windows、attribution 几步，再把 correction 经验拼进 `experiences`。步骤函数是内部 seam，只给 module 自己的测试和 `EvolutionWorkflow` 用。
- `DerivationContext` 不含 `now`、`taskCluster`（`ExperienceProjectionOptions`，`experience.ts:16-19`）：service 今天构造 `EvolutionWorkflow` 时从不传这两个（`service.ts:558` @ `82a9aef`），`projectDerived` 按默认值调用 `projectWorkflow`，行为不变。它们只留在 `EvolutionWorkflow` 的构造参数上，见 §3.5 第 4 条。
- `resolveDerivationVersions` 遍历 `VERSION_SOURCES` 生成 `DerivationVersions`，是读取版本常量和注入对象 `version` 的唯一位置。`windowRulesVersion`、`correctionRulesVersion` 两个选项今天只进 key、不进计算（§1.2）；保持这个语义，它们只覆盖 `versions` 里对应的值，用来在测试里强制重投影。投影步骤要用版本号时一律读 `ctx.versions`。
- `memos` 的类型由注册表映射出来：新增一个 `memo` store，`DerivationContext.memos` 自动多一个字段。`DerivedProjection` 按注册表遍历读取所有 memo store，不用手写读取代码；它的指纹也自动进 key（§3.3）。

### 3.3 持久化 module（新文件 `derivation.ts`）

```ts
export interface DerivedView {
  readonly records: DerivedRecords
  readonly counters: { readonly correctionRejectedDrafts: number; readonly correctionClassifierFailures: number }
}

export class DerivedProjection {
  constructor(options: {
    readonly layout: EvolutionLayout
    readonly stores: OpenStores                  // openStores(layout) 的结果
    readonly versions: DerivationVersions
    readonly skillContentSource?: SkillContentSource
  })
  /** 持 cursor 锁：key 和 cursor 一致时读存储（fast path），否则全量重建。force 跳过 fast path。 */
  refresh(options?: { readonly force?: boolean }): Promise<DerivedView>
  /** 持 cursor 锁，给 cursor 里的分类器失败计数加一（C1）。 */
  recordClassifierFailure(): Promise<void>
}
```

interface 只有两个方法。全量重建入口就是 `refresh({ force: true })`，`repair()` 已经这样调。它负责：

1. **组装 context**：读 Observation log；按注册表遍历所有 `memo` store 填 `memos`；按 Observation 里出现的 `contentHash` 读正文填 `skillContents`。
2. **算 key**：`derivationKey = hash({ versions, memoFingerprints, skillContentHashes })`。`memoFingerprints` 对每个 `MemoKey` 记 `{ count, lastId }`，遍历注册表生成；`skillContentHashes` 是 `skillContents` 的键排序后的数组。这就是 ADR-0026 §3.4 的合并形状：`judges` 是可读的 `versions`，`derivationKey` 是 `judges` 加 memo 指纹加正文哈希的 hash，cursor 只比 `count`、`lastId`、`fingerprint`、`derivationKey`。
3. **fast path**：一致时对每个 `DerivedKey` 执行 `readAll()` 组成 `records`，计数取自 cursor。遍历的是注册表，不是手写清单。
4. **全量重建**：调用 `projectDerived(ctx)`；对每个 `DerivedKey` 执行 `replaceAll`；**最后**写 cursor。写 cursor 前崩溃，下次 key 对不上，再全量重建一次，与今天的顺序（`service.ts:533-542`）一致。`replaceAll` 只对 `derived` 注册项调用，类型上就碰不到 `memo` 和 `fact`（ADR-0034）。
5. **cursor 代管**：cursor 形状不变（`count`、`lastId?`、`fingerprint`、`derivationKey?`、`judges?`、`correctionRejectedDrafts?`、`correctionClassifierFailures?`）。全量重建写 cursor 时，`correctionClassifierFailures` 取锁内读到的旧值原样写回。`readCursor` / `writeCursor` 之后只有这个 module 调用。

### 3.4 service 和其他调用方

- `refreshDerived(options)` 变成 `this.projection.refresh(options)`，返回 `{ ...view.records }`（属性名就是注册表的 key：`experiences`、`followUps`、`skillWindows`……）。返回类型从 `WorkflowSnapshot` 改为 `DerivedRecords`。`DerivedRecords` 是 `WorkflowSnapshot` 的结构超集：五个必有字段同名同类型，`episodes`、`patterns` 在后者里是可选、在前者里是必有，另外多了 `skillWindows` 等字段。所以 `const s: WorkflowSnapshot = await service.refreshDerived()` 照样能编译，调用方只读的话不受影响。`maintenance.ts:30`、`bin/dsh-skill-evolution.mjs:74`、`dsh-bundle/index.js:255-259` 只读其中几个字段，不用改。
- **`WorkflowSnapshot` 保持现状**（`workflow.ts:33-41`），不改成别名，字段和可选性都不动。它继续是 `EvolutionWorkflow.snapshot()` 和 `projectWorkflow()` 的返回类型。
- `metrics()` 从 `view.counters` 取两个计数，删掉 service 上的 `correctionClassifierFailures`、`correctionRejectedDrafts` 两个私有字段（`service.ts:81-82`）。
- `recordCorrectionClassifierFailure()` 保留为公开方法（`operations.ts` 在用），内部改为委托 `recordClassifierFailure()`。
- `skillContents`、`skillContentSource` 和 cursor 的 `judges` 字段要等 PR #113 合入才有。按 §6 的顺序 T3 和 T4 在 #113 之后开工，可以直接按上面的形状写。如果 #113 被撤回，这几项就从 interface 里删掉，其余部分不变。

### 3.5 统一读取路径（proposeChange）

现在 `proposeChange`（`service.ts:254-261`）自己 new 一个 `EvolutionWorkflow`，喂入去掉 correction 条目的 memo，然后重新投影。它看到的 experiences 里没有 `experience:correction:*`，与存储视图不一致（§1.3 探针：存储里 4 条，其中 correction 2 条；Designer 看到 2 条，correction 0 条）。

推荐 P1，Designer 读存储视图：

1. 把 `workflow.propose(clusterId, designer)` 里组装 `DesignerInput` 的逻辑抽成纯函数 `proposeFromRecords(records, clusterId, designer)`，放在 `workflow.ts`，`records` 的类型见第 4 条。找 cluster、证据门槛检查、找 diagnosis、组装 input、调 designer、`createProposal`（`workflow.ts:45-73`）整段搬过去，行为不变。
2. `proposeChange(clusterId, designer)` = `const view = await this.projection.refresh()`，然后 `proposeFromRecords(view.records, clusterId, designer)`。refresh 在锁内，designer 在锁外调用，因为 designer 可能是慢的 LLM 调用，不应该占着 cursor 锁。
3. `proposePattern`（#114，已合入，`service.ts:266` @ `82a9aef`）已经是"先 refresh 再读 patterns/episodes store"，改为直接读 `view.records`，语义不变，只是少读一次盘。
4. `EvolutionWorkflow` 保留导出（`index.ts:26`），**签名和语义都不变**：
   - 构造参数仍是 `ExperienceProjectionOptions & { memo?, classifierVersion? }`，`now`、`taskCluster` 照旧从这里传。
   - `snapshot(): WorkflowSnapshot` 的函数体搬到 `workflow.ts` 里新导出的纯函数 `projectWorkflow(observations, options)`，`snapshot()` 只调用它。输出与今天逐字节一致，**不含** correction 经验，不含 `episodes`、`patterns`。
   - `propose()` = `proposeFromRecords(this.snapshot(), clusterId, designer)`。`proposeFromRecords` 的第一个参数类型取两者的公共部分 `Pick<WorkflowSnapshot, 'experiences' | 'failures' | 'clusters' | 'diagnoses'>`，`WorkflowSnapshot` 和 `DerivedRecords` 都能传。
   - `projectDerived` 通过 `projectWorkflow` 复用同一份计算（依赖方向 `projection-steps.ts → workflow.ts`），不再 new `EvolutionWorkflow`。service 也不再 new 它；它只给现有单测和外部调用方用。
5. 后果：Designer 的 `input.experiences` 里会出现 correction 经验。这正是 SKIL-179 要的（Designer 能看到纠正经验）。`DesignerInput` 的类型不变，因为 correction 经验本来就是 `Experience`（`correction.ts:92`）。存储里的 diagnoses 是在拼入 correction 经验之前算的（`workflow.ts:41`），所以 `supportingExperienceIds` / `addressedExperienceIds` 与今天一致。要不要让 diagnosis 也引用 correction 经验是行为变更，不在本设计里做。
- `experience.ts:14` 已经 import `follow-up.ts`，§3.6 的改动不会引入新的依赖方向。

### 3.6 失败意图集合单一定义

推荐 F2，放在 `follow-up.ts`，紧挨着 `INTENT_POLICY_VERSION`：

```ts
export type IntentOutcome = 'failure' | 'success' | 'task-change' | 'neutral'

/** 意图 → 结果分类。改这张表必须同时升级 INTENT_POLICY_VERSION。 */
export const INTENT_OUTCOME: Readonly<Record<FollowUpIntent, IntentOutcome>> = {
  incorrect: 'failure', constraint: 'failure', retry: 'failure', dissatisfied: 'failure', other: 'failure',
  satisfied: 'success',
  'goal-changed': 'task-change',
  'not-attributable': 'neutral', unknown: 'neutral',
}

export const FAILURE_INTENTS: readonly FollowUpIntent[] =
  FOLLOW_UP_INTENTS.filter((intent) => INTENT_OUTCOME[intent] === 'failure')

export function isFailureIntent(intent: FollowUpIntent): boolean {
  return INTENT_OUTCOME[intent] === 'failure'
}
```

- `Record<FollowUpIntent, …>` 是穷举的：往 `FOLLOW_UP_INTENTS`（`types.ts:408` @ `82a9aef`）里加一个意图，这里不补就编译失败。这一点比单纯导出一个数组（F1）强，F1 漏分类时不会报错。只往 `FEEDBACK_KINDS` 里加不会触发这条保护：`FollowUpIntent` 由 `FOLLOW_UP_INTENTS` 手写数组推出，类型不变，而 `follow-up.ts:95` 用 `as FollowUpIntent` 强转了显式反馈。所以 T1 同时在 `types.ts` 加一条编译期断言，要求 `FeedbackKind` 是 `FollowUpIntent` 的子集：`const _feedbackKindsAreIntents: readonly FollowUpIntent[] = FEEDBACK_KINDS`。这样漏同步 `FOLLOW_UP_INTENTS` 会编译失败，同步之后再被 `INTENT_OUTCOME` 的穷举拦住。
- 四处字面量（`experience.ts:141,296,317`、`metrics.ts:154`）改成 `isFailureIntent(x)` 或 `FAILURE_INTENTS`。`metrics.ts` 新增一个对 `follow-up.ts` 的依赖。`follow-up.ts` 只依赖 `events.js`、`types.js`，不会形成环。
- 实施前要逐个确认上表里 `satisfied`、`goal-changed` 的现有语义与四处调用一致：四处用的都是"属于这 5 个就算失败"，所以只有 `failure` 一类会影响行为，其余三类是新增的命名，不改行为。
- 升版本的约束靠测试 G6 守住（§4）：对 `INTENT_OUTCOME` 做快照，快照变了而 `INTENT_POLICY_VERSION` 没变就失败。`INTENT_POLICY_VERSION` 已经进 key，所以分类一改，下次 refresh 就会全量重建。
- `experience.ts:216-223` 的 rootCause switch 也是按意图分支的，但它是另一种映射（意图 → 根因），不在 SKIL-179 S1 的范围里，记为后续候选，这次不动。

## 4. 漏注册即失败

| 漏掉什么 | 怎么失败 | 在哪一层 |
|---|---|---|
| 新 derived store 没写进投影函数 | `Derivation.records: DerivedRecords` 是注册表的映射类型，`projectDerived` 少返回一个 key 就编译失败 | `tsc`（`npm run build`） |
| 新 memo store 没进 key | 不可能漏：key 的 memo 指纹按注册表遍历生成 | 结构保证，G3 兜底 |
| fast path 漏返回某个投影（今天的 skill-windows） | 不可能漏：fast path 按 `DERIVED_KEYS` 遍历读取；G1 兜底 | 结构保证 + vitest |
| 新版本常量没进 key（今天的 `windowRulesVersion` 只进 key；`'hmm-1'`、`'rule-1'` 在 `skill-attribution.ts:94` 硬编码） | `DerivationVersions` 新增字段而 `VERSION_SOURCES` 没登记：编译失败。导出了 `*_VERSION` 常量却没登记：G4 **按名字**核对 | `tsc` + vitest |
| 新代码绕过 module 直接写 derived store 或 cursor | G5：架构测试 grep `src/`，`.replaceAll(` 作用在 derived store 上、`readCursor` / `writeCursor`、`new EvolutionWorkflow` 只允许出现在白名单文件里 | vitest |
| 改了意图分类不升版本 | G6：`INTENT_OUTCOME` 快照与 `INTENT_POLICY_VERSION` 绑定 | vitest |

`tsconfig.json` 只 include `src`，测试文件不做类型检查。所以编译期保证只覆盖 `src` 里的代码，测试里的类型错误要靠 vitest 运行时才暴露。这对上表没有影响：表里编译期的那一行全在 `src` 里。

### 4.1 守护测试（新文件 `tests/derivation.spec.ts`）

- **G1 fast path ≡ 全量重建**：用覆盖所有投影的 fixture 跑 `refresh({ force: true })`，再跑一次 `refresh()` 走 fast path，对每个 `DERIVED_KEYS` 做 deep-equal。fixture 本身先断言每个 derived store 至少产出一条记录，否则 deep-equal 两个空数组没有意义。
- **G2 版本进 key**：对 `DerivationVersions` 的每个 key 单独改一个值，断言 `derivationKey` 变了，且下一次 `refresh()` 走了重建（用 `replaceAll` 的调用计数或 cursor 的变化判断）。key 列表取自 `Object.keys(VERSION_SOURCES)`，加版本时测试自动覆盖。
- **G3 memo 进 key**：对每个 `MemoKey` 追加一条记录，断言 key 变了。
- **G4 常量登记（按名字，不按值）**：`import * as` 投影步骤模块（`follow-up`、`correction`、`skill-attribution`、`workflow`，以及 #113 引入的 emission 模块），收集所有名字以 `_VERSION` 结尾的字符串导出 `[name, value]`。断言三件事：
  1. 每个导出名都等于 `VERSION_SOURCES` 里某个 `kind: 'constant'` 项的 `name`；
  2. 该项的 `value` 与导出值相同，防止登记了名字、取的却是别的常量；
  3. 反向检查：每个 `constant` 项的 `name` 都能在这些模块的导出里找到，防止登记了已删除或拼错的名字。

  值相同也分得开：例如 T3 新增 `EMISSION_RULES_VERSION = 'rule-1'` 却没登记时，第 1 条以名字 `EMISSION_RULES_VERSION` 失败，不会因为 `CORRECTION_RULES_VERSION` 也是 `'rule-1'` 而通过。G2 的 key 列表也改为取自 `Object.keys(VERSION_SOURCES)`（由 `DerivationVersions` 穷举），不再取 `resolveDerivationVersions()` 的输出。残余风险：没写成导出常量的内联字面量逃得过 G4，所以 T3 要把 `skill-attribution.ts:94` 的 `'hmm-1'`、`'rule-1'`，以及 `service.ts` 的 `'skill-windows-v1'` 都改成导出常量。G5 再加一条，禁止投影步骤模块里出现 `version: '<字面量>'` 形式的写法。
- **G5 架构约束**：读 `src/*.ts` 文本，按上表白名单断言。白名单：`derivation.ts`（cursor、derived `replaceAll`）、`state-root.ts`（cursor 函数定义）、`workflow.ts`（`EvolutionWorkflow` 定义）。另加一条：投影步骤模块（G4 列出的那几个）里不允许出现 `version: '…'` 形式的字符串字面量，版本值只能来自导出常量。这条是文本匹配，属于兜底，主保护仍是 G4。main 上命中两处，T3 都要清掉：`skill-attribution.ts:94` 是值，`skill-attribution.ts:21` 是类型 `readonly version: 'hmm-1'`。类型这一处改成 `typeof POSTERIOR_MODEL_VERSION`，常量本身用 `as const` 声明。
- **G6 意图分类**：`expect({ version: INTENT_POLICY_VERSION, table: INTENT_OUTCOME }).toMatchInlineSnapshot()`，并在测试旁注明：表变了就同时升版本再更新快照。

### 4.2 回归测试（SKIL-179 要求点名）

- **R1 Designer 看到纠正经验**：用 §1.3 探针的 fixture（2 条普通经验 + 2 条 correction 经验）。断言 `proposeChange` 交给 designer 的 `input.experiences` 与 `service.experiences.readAll()` deep-equal，并且至少含一条 id 以 `experience:correction:` 开头的记录。放在 `tests/correction.spec.ts`。今天这条测试会失败（Designer 看到 2 条、correction 0 条），T5 之后通过。
- **R2 cluster id 一致**：从 `refreshDerived()` 返回的 `clusters` 里取一个 id 调 `proposeChange`，断言不抛 `unknown failure cluster`，并且 designer 收到的 `cases`、`diagnosis` 与存储视图里的对应记录 deep-equal。放在 `tests/core.spec.ts`。这条测试在 SKIL-163 改变 failure 投影之后才真正有区分力（见 §6），现在先把行为钉住。
- 现有测试保持绿色，特别是 `tests/correction.spec.ts:128-150` 与 `tests/core.spec.ts:113,521,530` 这几条 derivationKey / layout 测试。key 的输入变了（K2），旧 cursor 的 key 对不上，升级后第一次 `refresh()` 会全量重建一次。这是 ADR-0016 允许的，测试里断言"升级后重建一次、再次调用走 fast path"即可。

## 5. ADR-0026 的后续投影怎么接进来

| 后续投影 | 角色 | 接入时要写的东西 | 自动得到的东西 |
|---|---|---|---|
| skill posterior（`skill-posteriors`，SKIL-162） | derived | 注册表一行；`projectDerived` 里一个步骤；`DerivationVersions` 加 `posteriorModel`、`posteriorParams` | 落盘、fast path 读取、`refreshDerived()` 返回、全量重建、G1 覆盖 |
| failure attribution（`failure-attributions`，SKIL-162/163） | derived | 注册表一行；`projectDerived` 里一个步骤 | 同上 |
| emission memo（`emissions`，SKIL-162/164） | memo | 注册表一行；`DerivationVersions` 加 `emission`（judge 版本） | memo 读取进 `ctx.memos`、memo 指纹进 key、G3 覆盖；`replaceAll` 类型上碰不到它 |

对照 §1.2：今天加一个投影要手改大约 10 处（store 字段、layout、`StoreName`、key、fast path、全量返回、`replaceAll`、返回类型、调用方……），漏一处不报错。按本设计只改 2 处：注册表一行加投影步骤；涉及新判定器时再加 `DerivationVersions` 一项。漏写投影步骤会编译失败，漏登记版本会被 G4 拦住。

PR #113 现在的写法（新 store 写在 service 里、`judges` 和 key 手写、两条返回路径都不带 posteriors/attributions）在 T2–T4 里迁到上面的形状。迁移不改落盘格式，见 §9。

## 6. 与 SKIL-164、SKIL-167、SKIL-127 的顺序和冲突

状态以写作时为准：#114（SKIL-171）已合入 main，#113（SKIL-162）是 draft，SKIL-172 进行中，SKIL-163 到 SKIL-167 都在 backlog。

1. **#113（SKIL-162）先合，T2–T5 在它之后开工。** #113 用 prettier 重排了整个 `service.ts`（+1177 行），本设计改动的正是同一段。先做本设计再 rebase #113 会是一次整文件冲突；反过来只需要把 #113 新加的三个 store 迁进注册表，工作量小得多。
2. **T1（失败意图）现在就能做，必须在 SKIL-163 之前合入。** T1 只碰 `follow-up.ts`、`experience.ts`、`metrics.ts`，与 #113 不重叠（#113 不改这几处字面量）。SKIL-163 要重写 `buildFailureCases`（`experience.ts:141` 正好在里面），先有 `isFailureIntent` 它就不会再复制一份字面量。
3. **SKIL-163、165、166 等 T5 合入后再开工。** SKIL-163 会改 failure 投影并把门槛搬进 `workflow.propose`。如果它先合，而 `proposeChange` 还在自己重新投影，那么存储视图（带 attribution 加权）和 Designer 看到的 cluster 会不一致，用存储里的 cluster id 调 `proposeChange` 可能抛 `unknown failure cluster`。R2 就是钉这个的。SKIL-163 的门槛改为写进 `proposeFromRecords`。
4. **SKIL-164 的范围需要收窄。** 它的 Task 5（emission memo 操作和 judge 替换）与 #113 大面积重合：`scoreSkillEmissions`、`emissions` store、key 里的 emission 版本 #113 都已经做了。按本设计，SKIL-164 不再写任何 `derivationKey` 或 cursor 代码，只剩"替换 judge 时升 `DerivationVersions.emission`"和 memo 操作本身。由 Mika 决定是改写 SKIL-164 还是并入 #113，见 §11。
5. **SKIL-167 可以与 T2–T5 并行，没有冲突。** 它是可选的反事实校准 seam，保持 `derivationKey` 不变，只读 posteriors。校准报告依赖外部运行结果，不能从 Observation log 重建，所以**不注册为 derived**；如果要落盘，作为 fact 注册。它从 `refreshDerived()` 的返回里读 `skillPosteriors`（T4 之后有）。
6. **SKIL-127 的子 issue 没有冲突。** SKIL-171 已合入，`proposePattern` 在 T5 里改成读 view（§3.5 第 3 条）。SKIL-172（accept/promote）和 SKIL-173（adapter 流程）都不新增投影，最多与 T4/T5 在 `service.ts` 上有文本冲突，后合的一方 rebase。
7. **#111（SKIL-174）** 只动 publication repair 一段，与本设计只有文本冲突。

以上排序是可逆的业务判断，采用默认答案，成员可推翻。

## 7. 迁移步骤（给 S2 写 `specs/<slug>/tasks.md`）

每一步单独成 PR，单独可回滚，合入后 `npm run build` 和 `npx vitest run tests` 全绿。T1 独立；T2–T5 串行，并且都在 #113 合入之后。

**T1 失败意图单一定义**（可以立刻开工）
- 文件：`src/follow-up.ts`（加 `IntentOutcome`、`INTENT_OUTCOME`、`FAILURE_INTENTS`、`isFailureIntent`），`src/types.ts`（加 `FeedbackKind ⊆ FollowUpIntent` 的编译期断言，§3.6），`src/experience.ts:141,296,317`，`src/metrics.ts:154`，`src/index.ts` 导出。
- 验收：`grep -rn "'incorrect', 'constraint'" packages/skill-evolution/src` 只剩 `types.ts` 的两个常量定义；新增 G6；现有测试全绿，`derivationKey` 不变（`INTENT_POLICY_VERSION` 不升，因为分类没变）。

**T2 store 注册表**
- 文件：新增 `src/store-registry.ts`（§3.1）；`src/state-root.ts` 的 `StoreName`、`resolveLayout` 改为从注册表派生；`src/service.ts` 的 store 字段改为 `openStores(layout)`；把 #113 新增的三个 store 迁进注册表。
- 验收：`tests/core.spec.ts:113` 的 layout 断言不改且通过；`StoreName` 不再是手写联合；service 公开字段名不变。

**T3 纯投影函数**
- 文件：
  - 新增 `src/projection-steps.ts`，包含 `projectDerived`、`resolveDerivationVersions`、`VERSION_SOURCES`、`DerivationVersions`、`DerivationContext`、`Derivation`。
  - `src/workflow.ts` 抽出 `projectWorkflow(observations, options)`，`EvolutionWorkflow.snapshot()` 改为调用它，签名不变。
  - 字面量改为导出常量：`service.ts` 的 `'skill-windows-v1'` 改为 `SKILL_WINDOW_RULES_VERSION`；`skill-attribution.ts:94` 的 `'hmm-1'` 改为 `POSTERIOR_MODEL_VERSION`，同一行的 `'rule-1'` 改为 `EMISSION_RULES_VERSION`。这三个常量都登记进 `VERSION_SOURCES`。
- 验收：
  - 同一个 ctx 调两次 `projectDerived`，结果 deep-equal。
  - 结果与旧的 `refreshDerivedUnlocked` 全量路径产出 deep-equal。这是迁移期对照测试，T4 合入后删除。
  - 现有直接用 `EvolutionWorkflow` 的单测不改且通过。
  - 新增 G4（按名字核对），并加一条反例自测：临时导出一个与 `CORRECTION_RULES_VERSION` 同值、但未登记的 `*_VERSION` 常量，G4 必须失败。

**T4 `DerivedProjection` 接管 cursor、key、fast path、重建**
- 文件：新增 `src/derivation.ts`（§3.3）；`service.ts` 的 `refreshDerived` / `refreshDerivedUnlocked` / `metrics` / `recordCorrectionClassifierFailure` 委托给它，删除 `:81-82` 两个私有计数字段；`refreshDerived()` 的返回类型改为 `DerivedRecords`。`WorkflowSnapshot` 不动。
- 验收：新增 G1、G2、G3、G5（G5 先不含 `new EvolutionWorkflow` 一条）；升级后第一次 `refresh()` 全量重建一次、之后走 fast path；`refreshDerived()` 返回里有 `skillWindows`、`skillPosteriors`、`failureAttributions`；`tests/correction.spec.ts:128-150`、`tests/archive-health-repair.spec.ts:157-229` 通过。

**T5 统一读取路径**
- 文件：
  - `src/workflow.ts` 抽出 `proposeFromRecords(records: Pick<WorkflowSnapshot, 'experiences' | 'failures' | 'clusters' | 'diagnoses'>, …)`，`EvolutionWorkflow.propose()` 改为调用它，签名和语义不变。
  - `service.ts` 的 `proposeChange`、`proposePattern` 改为读 view。
- 验收：
  - 新增 R1、R2。
  - `EvolutionWorkflow.snapshot()` 的输出不含 `experience:correction:*`，与 T5 之前逐字节一致。用现有 workflow 单测，再加一条对照断言。G5 加上 `new EvolutionWorkflow` 只在 `workflow.ts` 里出现这一条；`tests/pattern-design.spec.ts` 通过。

G1–G6 分别放进对应的 T 里交付，不单独成任务。

## 8. 与已有 ADR 的关系

- ADR-0016、0026、0034 的全量重建规则：保留。`refresh({ force: true })` 和 key 不一致时都走全量重建，fast path 只是"key 一致时读存储"，不做增量。
- ADR-0034（Projection 是 Observation log、memo、版本的纯函数）：`projectDerived` 把这句话写成了函数签名，比现在更严格。
- ADR-0026 §3.4（`judges` 与 `derivationKey` 合并成一个形状）：按 §3.3 第 2 条落实，`judges` = `versions`。
- ADR-0002、0035：不涉及。0035 规定的意图集合（`FOLLOW_UP_INTENTS`）不变，`INTENT_OUTCOME` 只是给它们分类。
- 没有冲突，不需要按 `docs/agents/domain.md` 的「Flag ADR conflicts」上报。

## 9. 不可逆决策

**无，本设计不新增 ADR。** 逐项检查：

- 落盘格式：store 文件名、路径、顺序、记录形状都不变（T2 的 layout 断言守住）。cursor 字段不变。`derivationKey` 和 `judges` 的内容会变，但 cursor 本来就可以删掉重建（ADR-0026），旧值只会触发一次全量重建。
- `correctionClassifierFailures` 不搬出 cursor（C1），所以不用为格式变更写 ADR。不搬的理由见 §2.4：这个计数只用于展示，不进门槛，也没有按 session 追溯的需求。将来门槛要读它时，再按 C2 写 ADR。
- 公开接口（`index.ts` 以 `export *` 导出 `workflow.ts`、`service.ts` 等）：
  - `WorkflowSnapshot` 不动。
  - `EvolutionWorkflow` 的构造参数、`snapshot()`、`propose()` 的签名和输出都不变（§3.5 第 4 条，由 T5 的对照断言守住）。
  - 唯一改变的签名是 `EvolutionService.refreshDerived()` 的返回类型，从 `WorkflowSnapshot` 收窄为它的结构子类型 `DerivedRecords`：可选字段变成必有，并增加字段。返回类型协变收窄，所有现有调用方都能编译。只有手写一个实现 `refreshDerived` 的替身类、且返回旧形状时才会报错，仓库里没有这种用法（`grep -rn "refreshDerived" packages` 只命中调用方）。
  - 新增的导出有 `FAILURE_INTENTS`、`isFailureIntent`、`INTENT_OUTCOME`、`projectWorkflow`、`proposeFromRecords`、`VERSION_SOURCES` 以及新模块的类型。
  - 没有删除导出，也没有不兼容的签名变更。返回类型收窄完全可以撤回（改回标注 `WorkflowSnapshot` 即可），所以不算不可逆。
- 依赖方向：`metrics.ts` → `follow-up.ts` 是新边，`experience.ts` → `follow-up.ts` 已有，都不成环；新文件之间是单向的 `service → derivation → projection-steps → store-registry`，另有 `projection-steps → workflow`，`workflow.ts` 只依赖已有模块，不成环。

## 10. 可逆的默认选择（采用默认答案，成员可推翻）

- module 形状 B（类型化注册表 + 纯投影函数 + 持久化 module），不选 A（投影规格注册表 + 拓扑排序）或 C（只补测试守卫）。持久化不再抽 storage seam：JSONL store 只有一个 adapter，抽出来是假想的 seam。
- key 方案 K2（整个 context 除 Observation 外的指纹），不选 K1（继续手写对象做 hash）。
- 读取路径 P1（Designer 读存储视图）。
- 计数位置 C1（留在 cursor）。
- `WorkflowSnapshot` 和 `EvolutionWorkflow` 保持现状，不改成 `DerivedRecords` 的别名、不改语义（评审第 1 轮的选项 a）。两者通过 `projectWorkflow` 共用一份计算。
- 版本登记用 `VERSION_SOURCES` 按名字核对（G4），不按值。
- 失败意图 F2（穷举映射放在 `follow-up.ts`）。
- §6 的合入顺序。
- 注册表 key 用 camelCase（`followUps`），文件名保持 kebab-case（`follow-ups`）。
- `windowRulesVersion`、`correctionRulesVersion` 两个选项保持"只覆盖 key 里的版本"的语义。

## 11. 待定项

- **SKIL-164 的范围**：改写成"只剩 judge 替换和 memo 操作"，还是并入 #113。由 Mika 决定，不阻塞 T1–T5。
- **注册表上挂校验器**：health 和 repair 现在分别校验各个 store，以后可以在注册项上声明 `validate`，让 health/repair 也遍历注册表。这是后续候选，不在本次范围。
