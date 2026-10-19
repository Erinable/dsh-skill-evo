# failures 报告收成一个 core 用例；CLI 和 bundle 只做 I/O 映射

SKIL-189（父 SKIL-188，来源：架构扫描 SKIL-187 第 1 项 = SKIL-184 第 3 项）。基线 `origin/main` @ `4875010`。

## 1. 现状

### 1.1 读了什么

- 两个 adapter：`packages/skill-evolution/bin/dsh-skill-evolution.mjs:80-85`（CLI `failures`）、`packages/dsh-bundle/index.js:247-262`（slash 命令 `failures`）。
- 渲染：`packages/skill-evolution/src/report.ts:76-102`（`CorrectionReportInput`、`renderFailuresMarkdown`）。
- 数据来源：`packages/skill-evolution/src/service.ts:166-180`（`listFailures`、`metrics`）、`service.ts:83-84`（两个私有计数）、`service.ts:542-596`（`refreshDerived` / `refreshDerivedUnlocked`）；`metrics.ts:31-40`（`EvolutionMetrics`）、`metrics.ts:127-142`（`correctionMetrics`，私有）；`correction.ts:116`（`assessPattern`）；`workflow.ts:33-41`（`WorkflowSnapshot`）。
- 测试：`tests/cli.spec.mjs`（没有一条覆盖 `failures`）、`tests/correction.spec.ts:46-50`、`tests/evolution.spec.ts:831`（直接测 `renderFailuresMarkdown`）、`dsh-bundle/tests/bundle.spec.mjs:542-560`（bundle 命令测试的写法，`seedCorrectionSessions` 辅助函数）。
- 约束来源：ADR-0006、ADR-0014、ADR-0026、ADR-0027；`docs/design/derived-projection-module.md` §3.3–3.4、§9（SKIL-183 的 T2–T5）；`specs/derived-projection-module/tasks.md`；`specs/skill-window-posterior-attribution/requirements.md` R-33、R-34、R-39，`tasks.md` Task 6（SKIL-165）；`CONTEXT.md`。

### 1.2 两条路径各拼一份报告

| | CLI | bundle |
|---|---|---|
| 读派生记录 | `service.listFailures()`，一次 refresh | `service.refreshDerived()`，**再** `service.metrics()`：第二次 refresh，`metrics()` 里再全量读一次 Observation log（`service.ts:172`），并读当前 Skill 正文。refresh 本身每次都全量读 Observation log（`service.ts:547`），所以一次报告共读三遍 |
| 渲染输入 | `renderFailuresMarkdown(records)`，没传第二个参数 | 在 core 外手工拼 5 个字段：`patterns`、`episodes`、`proposals`、`recognizerVersion`、`classifierFailures` |
| Self-corrections 一节 | 没有 | 有 |
| JSON | `--format json` 输出 `SkillFailureCase[]` | 无 |

bundle 调 `metrics()` 只是为了拿 `corrections.recognizer.version` 和 `corrections.classifierFailures` 两个数，后者在 service 的私有字段里，没有别的公开读法。

### 1.3 探针（在空的 State directory 上运行，结果如下；探针脚本已删除）

```text
$ node packages/skill-evolution/bin/dsh-skill-evolution.mjs failures --root $T
# Skill Evolution Failures

Total: 0

No failure cases recorded.

$ node packages/skill-evolution/bin/dsh-skill-evolution.mjs failures --root $T --format json
[]

$ node probe.mjs $T        # apply(ctx) 后调用 registered[0].handler({ rawInput: 'failures', … })
# Skill Evolution Failures

Total: 0

No failure cases recorded.

## Self-corrections

Policy: `correction-policy-v1` (N=2, K=3, D=30d); recognizer: none; episodes: 0; classifier failures: 0; now: 2026-10-19T02:38:23.250Z

No correction patterns recorded.
```

### 1.4 下一个需求会怎么拉扯这里

SKIL-165 Task 6（R-33、R-34）要给 failures 报告加每个 Skill 的 windows、steps、`weightedFailures`，加全局 `uncoveredFailures` 和未覆盖一节，并让 `metrics()` 和 `failures()` 读同一份派生记录。按现状这些字段要在 CLI 和 bundle 各接一遍，而且两边已经在 Self-corrections 一节上分叉了。

## 2. 设计问题与选项

### 2.1 用例放在哪、interface 什么形状

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| U1. `operations.ts` 风格的自由函数 `reportFailures(service, options)` | 只用 service 的公开 API 取数据：`refreshDerived()`、`proposals.readAll()`，再给 service 新增一个公开的计数读取方法 | 中 | 好 | 可逆 | service 多一个公开方法，存在的理由只是这个函数 |
| **U2. service 方法 `failuresReport(options)`，组装和渲染是 `failures-report.ts` 里的纯函数（推荐）** | 与 `metrics()` 并列；两者共用一个私有的取数方法 `readDerivedInputs()`；计数仍是私有的 | 中 | 纯函数直接测；service 层只测「和 `metrics()` 一致」 | 可逆 | service 多一个公开方法 `failuresReport`，内部多一个私有方法 |
| U3. 自由函数，Self-corrections 的数据取自 `service.metrics()` | 等于把 bundle 今天的写法搬进 core | 低 | 好 | 可逆 | 最低；但每次报告要 refresh 两次，并全量读 Observation log 和 Skill 正文，工作量随全库规模增长 |

推荐 U2。R-34 要的是「`metrics()` 和 `failures()` 读同一份派生记录」：U2 下两者都只经过 `readDerivedInputs()` 这一个入口，这是结构上的保证，不靠测试去追。分类器失败计数保持私有，SKIL-183 T4 把它挪到 `view.counters` 时只改这一处。U1 为了一个函数把计数公开出去，T4 还得一直保住这个公开方法。U3 把 bundle 今天的额外开销固定进 core。

与 ADR-0006 的关系：ADR-0006 否决的是新增 facade 或命令分发器（更宽、带状态或按字符串分派的 interface）。U2 是在 `metrics()` 旁边加一个按用例命名的方法，不是分派层；adapter 照样只做输入输出映射。不冲突。

采用默认答案，成员可推翻。

### 2.2 用例返回什么、Markdown 谁来渲染

| 选项 | 做法 | 取舍 |
|---|---|---|
| **R1. 返回数据 `FailuresReport`，渲染是纯函数 `renderFailuresReport(report)`（推荐）** | adapter 选输出格式：Markdown 就调渲染函数，JSON 就序列化 | service 不碰 Markdown；数据和渲染可以分开测 |
| R2. 返回 `{ report, markdown }` | adapter 只挑字段 | 每次都渲染（开销小）；service 依赖渲染模块 |
| R3. `failuresReport({ format })` 返回字符串 | adapter 最薄 | 按字符串分派，正是 ADR-0006 否决的形状 |

推荐 R1。采用默认答案，成员可推翻。

### 2.3 现有导出 `renderFailuresMarkdown` 怎么处理

`index.ts` 用 `export *` 导出了它，两处测试在直接调用。

| 选项 | 取舍 |
|---|---|
| **K1. 保留签名，内部改成 `buildFailuresReport` + `renderFailuresReport`，标 `@deprecated`（推荐）** | 不删公开导出；渲染只剩一份实现；旧测试不用改 |
| K2. 删除 | 删公开导出是破坏性变更 |
| K3. 原样保留，另写一份新渲染 | 两份渲染会再次分叉，正是本票要消除的问题 |

推荐 K1。采用默认答案，成员可推翻。

### 2.4 CLI `--format json` 的输出形状（公开输出格式，单独列出）

| 选项 | 做法 | 取舍 |
|---|---|---|
| **J1. 保持数组：输出 `report.failures`，与今天 `listFailures()` 逐字节一致（默认）** | JSON 形状不变 | 现有脚本不受影响；符合 R-39「已有 JSON 只做追加」。Self-corrections 和 R-33 的每 Skill 汇总不进 failures JSON，改由 `metrics` JSON 提供（`metrics` 本来就是对象，`corrections` 已在里面） |
| J2. 改成整个 `FailuresReport` 对象 | 一份 JSON 带全部信息 | 把数组改成对象，按数组解析的调用方会坏掉；违反 R-39；需要写 ADR |
| J3. 保持数组，另加 `--format report-json` 输出对象 | 追加式 | 多一个公开的格式值，以后要撤就是破坏性变更；现在没有调用方要它 |

**默认答案：J1。** 采用默认答案，成员可推翻。

理由：R-39 要求扩展已有 JSON 时只追加字段，数组改对象不满足；R-33 的每 case 权重和归因来源是 `SkillFailureCase` 上的追加字段（PR #113 / ADR-0027），在 J1 下会自然出现在数组元素里；每 Skill 汇总和全局数在 `metrics` JSON 里有（§3.6）。J1 不碰任何公开格式，是最容易回退的选择：以后真有调用方要整份报告，再按 J3 追加，J3 本身也是追加式的。成员改选 J2 时需要补一份 ADR，并通知 SKIL-165 改写 R-33 的 JSON 部分。

**SKIL-165 的 spec 按 J1 读 R-33**：R-33「WHEN `failures` or `metrics` is rendered」里的每 Skill 汇总、全局数和未覆盖一节，落在 failures Markdown 和 metrics JSON 上；failures JSON 只多出每个 case 上的追加字段，不带汇总。

### 2.5 锁定「CLI 和 bundle 输出一致」的测试放在哪

| 选项 | 取舍 |
|---|---|
| **T1. 放在 `dsh-bundle/tests/bundle.spec.mjs`（推荐）** | bundle 已经依赖 core（`file:../skill-evolution`），能同时调到 bundle handler 和 core 的 bin；依赖方向不变（ADR-0014） |
| T2. 放在 core 的 `cli.spec.mjs` | core 要反向 import bundle，依赖方向反了 |
| T3. 在仓库根加一个跨包测试 | 根目录没有 package，要新建测试工程 |

推荐 T1。采用默认答案，成员可推翻。

### 2.6 R-33 的汇总数在哪里算

| 选项 | 取舍 |
|---|---|
| **A1. `metrics.ts` 里的纯函数 `summarizeSkillAttribution(records)`，`aggregateMetrics` 和 `buildFailuresReport` 都调它（推荐）** | 一份计算，两处输出；依赖方向 `failures-report.ts → metrics.ts` 是单向的 |
| A2. 在 `failures-report.ts` 里算，`metrics` 再读报告 | `metrics` 要反过来依赖报告模块 |
| A3. 持久化成新的 derived store | 新增落盘格式要写 ADR，要注册进 Projection；汇总数从现有 derived store 现算就行，不值得 |

推荐 A1。这和 Self-corrections 一节的做法一样：把 `metrics.ts:127` 的私有 `correctionMetrics` 改成导出的 `summarizeCorrections`，报告和 metrics 共用。采用默认答案，成员可推翻。

## 3. 推荐方案：接口

依赖方向：`service.ts → failures-report.ts → metrics.ts / correction.ts / types.ts`。`report.ts` 里的兼容包装依赖 `failures-report.ts`。不成环。新文件 `packages/skill-evolution/src/failures-report.ts`，由 `index.ts` 的 `export *` 导出。

### 3.1 metrics.ts：抽出 Self-corrections 汇总（不改行为）

```ts
/** 原 EvolutionMetrics['corrections'] 的形状，起名后导出。 */
export type CorrectionSummary = NonNullable<EvolutionMetrics['corrections']>

export interface CorrectionSummaryInput {
  readonly episodes: readonly CorrectionEpisode[]
  readonly patterns: readonly CorrectionPattern[]
  readonly proposals?: readonly SkillProposal[]
  readonly policy?: CorrectionPolicy
  readonly now?: string
  readonly classifierFailures?: number
  readonly rejectedDrafts?: number
}

/** 即今天 metrics.ts:127 的 correctionMetrics 函数体，原样改名导出。 */
export function summarizeCorrections(input: CorrectionSummaryInput): CorrectionSummary
```

`aggregateMetrics` 的第 6 个参数类型改成 `CorrectionSummaryInput`（结构完全一样），内部调用 `summarizeCorrections`。`EvolutionMetrics` 的形状不变。

### 3.2 failures-report.ts：数据、组装、渲染

```ts
export interface FailuresReportInput {
  /** 用 WorkflowSnapshot 的公共字段作类型：今天的返回类型和 T4 之后的 DerivedRecords 都能直接传入。 */
  readonly records: Pick<WorkflowSnapshot, 'failures' | 'episodes' | 'patterns'>
  readonly proposals: readonly SkillProposal[]
  readonly counters: { readonly correctionClassifierFailures: number; readonly correctionRejectedDrafts: number }
  readonly policy?: CorrectionPolicy        // 缺省 DEFAULT_CORRECTION_POLICY
  readonly now: string                       // ISO 时刻；纯函数不读墙钟
}

export interface CorrectionPatternLine {
  readonly patternId: string
  readonly intent: string
  readonly errorSignature: string
  readonly correction: readonly string[]
}

export interface FailuresReport {
  readonly generatedAt: string                          // = input.now
  readonly failures: readonly SkillFailureCase[]        // 与 listFailures() 同序同内容
  readonly corrections: CorrectionSummary               // 与 metrics().corrections 同一个函数算出
  readonly correctionPatterns: readonly CorrectionPatternLine[]   // 与 corrections.assessments 同序，按 patternId 对应
  // SKIL-165 追加：readonly attribution: SkillAttributionSummary（§3.5）
}

/** 同步纯函数：同一份输入永远得到相同的报告。 */
export function buildFailuresReport(input: FailuresReportInput): FailuresReport

/** 同步纯函数；末尾带一个换行，与今天 renderFailuresMarkdown 一致。 */
export function renderFailuresReport(report: FailuresReport): string
```

- `buildFailuresReport` 调 `summarizeCorrections({ episodes: records.episodes ?? [], patterns: records.patterns ?? [], proposals, policy, now, classifierFailures: counters.correctionClassifierFailures, rejectedDrafts: counters.correctionRejectedDrafts })`。
- `renderFailuresReport` 的输出与今天 bundle 的输出逐字节相同（同一个 `now` 下）。各行的来源：Policy 行取 `corrections.policy`、`corrections.recognizer.version`、`corrections.episodes`、`corrections.classifierFailures` 和 `generatedAt`；pattern 行的 `windowSessionCount/minSessions since …`、`candidate` 或 `candidateReason ?? 'blocked'`、`target` 取自 `corrections.assessments`，`intent | errorSignature | correction` 取自 `correctionPatterns`。
- **Self-corrections 一节总是输出**，没有 pattern 时写 `No correction patterns recorded.`。这是 CLI Markdown 唯一的变化，即让 CLI 和 bundle 一致；Markdown 是给人看的输出。

### 3.3 report.ts：兼容包装

`renderFailuresMarkdown(failures, correction = {})` 保留签名，标 `@deprecated Use EvolutionService.failuresReport + renderFailuresReport`，内部直接组一个 `FailuresReport` 再调 `renderFailuresReport`：

- 旧入参里 `episodes` 是个数、不是数组，所以 `corrections` 取 `summarizeCorrections({ episodes: [], patterns, proposals, policy, now, classifierFailures })` 的结果，再用旧入参覆盖两项：`episodes: correction.episodes ?? 0`，`recognizer.version: correction.recognizerVersion ?? 'none'`。这与今天的渲染逐字节一致。
- `now` 缺省时取墙钟，与今天一样。
- 今天 `correction.patterns === undefined` 时**不输出** Self-corrections 一节，`evolution.spec.ts:831` 依赖这一点。包装函数在这种情况下只渲染 failures 部分（`failures-report.ts` 内部拆出一个不导出的 `renderFailureLines` 供两处共用）。

### 3.4 service.ts

```ts
export interface DerivedReadOptions {
  /** ISO 时刻，用于 correction 窗口评估（assessPattern 的 since、candidate）。缺省取一次墙钟。 */
  readonly now?: string
}

/** 与 metrics() 共用的取数入口：refresh 一次，解析一次 now，返回派生记录、proposals、两个计数和 now。 */
private async readDerivedInputs(options: DerivedReadOptions): Promise<{ readonly records: Awaited<ReturnType<EvolutionService['refreshDerived']>>; readonly proposals: readonly SkillProposal[]; readonly counters: FailuresReportInput['counters']; readonly now: string }>

async failuresReport(options: DerivedReadOptions = {}): Promise<FailuresReport> {
  const { records, proposals, counters, now } = await this.readDerivedInputs(options)
  return buildFailuresReport({ records, proposals, counters, now })
}

async metrics(options: DerivedReadOptions = {}): Promise<EvolutionMetrics>   // 追加的可选参数
```

- `readDerivedInputs()` 内部 `now = options.now ?? new Date().toISOString()`，是两个公开方法里唯一读墙钟的地方。
- `metrics()` 改为先调 `readDerivedInputs(options)`，再像今天一样读 events、decisions、当前 Skill 正文；计数取自 `counters`，并把 `now` 传进 `aggregateMetrics` 的 correction 参数（今天它缺省时在 `metrics.ts:129` 自己取墙钟）。不传 `options` 时行为不变。
- 为什么 `now` 也要同源：没有 promoted proposal 时，`assessments[].since = now - windowDays`（`correction.ts:122-124`），`candidate` 也取决于 `now`。两次调用各取一次墙钟，`since` 就相差几毫秒。R-34 的「同一份派生记录」只有在 `now` 也相同时才能用深度相等来验证。
- `listFailures()` 保留（公开方法，测试在用）。
- 今天 `readDerivedInputs()` 在 refresh 之后读两个私有字段。T4 合入后改成取 `this.projection.refresh()` 返回 view 里的 `records` 和 `counters`。只有这一处要跟着改，见 §5。
- 只有 `metrics()` 和 `failuresReport()` 调用 `readDerivedInputs()`；R-34 的「同一份派生记录」靠这个单一入口保证。

### 3.5 adapter 映射

CLI（`bin/dsh-skill-evolution.mjs:80-85`）：

```js
async function failures() {
  const report = await service.failuresReport()
  const format = value('--format') ?? 'markdown'
  if (format === 'json') console.log(JSON.stringify(report.failures, null, 2))   // J1
  else console.log(renderFailuresReport(report))
}
```

bundle（`dsh-bundle/index.js:258-261`）：

```js
if (action === 'failures') return { kind: 'success', text: renderFailuresReport(await service.failuresReport()) }
```

两边 import 的 `renderFailuresMarkdown` 如果不再使用就删掉，改为 import `renderFailuresReport`。参数解析的现有行为保持不变：`--format` 取 json 以外的值时照旧输出 Markdown。bundle 每次报告从两次 refresh、三次 Observation log 全量读（两次 refresh 各一次，`metrics()` 自己 `service.ts:172` 一次），减到一次 refresh、一次全量读，并且不再读当前 Skill 正文。refresh 本身仍会全量读 Observation log（`service.ts:547`），这不是本票要解决的规模问题，不作为验收项。

### 3.6 SKIL-165 R-33 / R-34 的落点

| 要求 | 落在哪 | adapter 要不要改 |
|---|---|---|
| 每个 case 显示权重和归因来源 | `SkillFailureCase` 上的追加字段（`attributionWeight`、`attributionSource`、`dominant`、`uncovered`，来自 #113 / ADR-0027）；`renderFailuresReport` 在 case 行里追加 `w=<weight> · <source>`；CLI JSON（J1）的数组元素自动带上这些字段 | 不改 |
| 每个 Skill 的 `windows`、`uncertainWindows`、`eligibleSteps`、`dominantSteps`、`dominantStepShare?`、`expectedSteps`、`attributedFailures`、`weightedFailures`；全局 `uncoveredFailures`、`noneExpectedSteps` | `metrics.ts` 新增 `summarizeSkillAttribution(records: Pick<DerivedRecords, 'skillWindows' \| 'skillPosteriors' \| 'failureAttributions' \| 'failures'>): SkillAttributionSummary`；`FailuresReport.attribution` 和 `EvolutionMetrics.attribution` 存的是同一个函数的输出（追加字段） | 不改 |
| 未覆盖一节 | `SkillAttributionSummary.uncovered: readonly { subjectId; evidenceEventIds }[]`；`renderFailuresReport` 输出 `## Uncovered by existing Skills` | 不改 |
| R-34：`metrics()` 先 refresh，与 `failures()` 读同一份派生记录 | 两者都只经过 `readDerivedInputs()`（§3.4）；今天的 `metrics()` 已经先 refresh | 不改 |

SKIL-165 的落地方式：把 `FailuresReportInput.records` 从 `Pick<WorkflowSnapshot, …>` 扩成 `Pick<DerivedRecords, …>`。这一步需要 T4（`refreshDerived()` 返回 `DerivedRecords`）和 #113 已经合入，与 `specs/derived-projection-module/tasks.md` 已定的「SKIL-165 在 T5 之后开工」一致。**验收时可以机械检查：SKIL-165 的 diff 不碰 `bin/` 和 `packages/dsh-bundle/` 下的任何文件。**

## 4. 测试计划

### 4.1 core 单测（新文件 `tests/failures-report.spec.ts`）

1. **渲染兼容**：沿用 `correction.spec.ts:46` 的 pattern fixture，固定 `now`。断言 `renderFailuresReport(buildFailuresReport(input))` 与 `renderFailuresMarkdown(failures, { patterns, episodes: n, proposals, recognizerVersion, classifierFailures, now })` 逐字节相等（锁住 bundle 今天的输出）。
2. **与 metrics 同源（纯函数层）**：同一组 episodes、patterns、proposals、`now`、计数，断言 `buildFailuresReport(input).corrections` 与 `aggregateMetrics([], [], [], [], [], {同一组}).corrections` 深度相等。
3. **空输入**：Markdown 依次包含 `Total: 0`、`No failure cases recorded.`、`## Self-corrections`、`No correction patterns recorded.`。
4. **兼容包装**：`renderFailuresMarkdown(failures)` 不传第二个参数时，输出不含 `## Self-corrections`（锁住 `evolution.spec.ts:831` 的语义）。

### 4.2 service 层（放进 `tests/correction.spec.ts` 或新单测文件）

5. 在已有记录的 store 上（一条显式反馈形成的 Failure case，再用 correction 测试的 session 辅助函数生成 episode 和 pattern；时间戳用相对 `Date.now()` 的近期时刻，保证在 30 天窗口内）：取一个固定的 `now`（`new Date().toISOString()` 只算一次），`const report = await service.failuresReport({ now })`。断言 `report.failures` 与 `await service.listFailures()` 深度相等；`report.corrections` 与 `(await service.metrics({ now })).corrections` 深度相等；`report.corrections.assessments` 非空，确认比较的确实是带 `since` 的数据。两边必须传同一个 `now`：不传时各取一次墙钟，`since` 不同，深度相等必然失败（评审第 1 轮实测：两次调用相隔 5ms，`since` 相差 7ms）。

### 4.3 CLI（`tests/cli.spec.mjs`，补上 `failures`）

6. 空 root 下运行 `failures`：退出码 0，stdout 包含 `# Skill Evolution Failures`、`Total: 0`、`## Self-corrections`。
7. 先执行 `feedback --session s1 --kind incorrect --skill api-debugging --note "..."`，再运行 `failures`：Markdown 里有该 case 的 id 那一行。
8. 同一个 root 下运行 `failures --format json`：`Array.isArray(JSON.parse(stdout))` 为真，长度为 1，元素满足 `{ skillName: 'api-debugging', origin: 'explicit-feedback' }`，并与 `new EvolutionService({ root }).listFailures()`（从 `../lib/index.js` import）深度相等。这条锁住 J1。

### 4.4 一致性锁定（`dsh-bundle/tests/bundle.spec.mjs`）

9. 同一个 `dir`、同一个 `eventsPath`，先 seed 一条反馈 case，再用已有的 `seedCorrectionSessions` 生成 pattern。分别执行 bundle handler `failures`，以及 `spawn(process.execPath, [<bundle 包目录>/node_modules/@dsh-skill-evo/core/bin/dsh-skill-evolution.mjs, 'failures', '--root', dir, '--store', eventsPath])`。CLI 和 bundle 是两次独立运行，各取一次墙钟，所以 Policy 行的 `now: <ISO>` 和每条 pattern 行的 `since <ISO>`（`now - windowDays`，`report.ts:97`）都会不同。比较前把两边**所有** ISO 时刻替换成同一个占位：

```js
const normalize = text => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, '<ISO>')
assert.equal(normalize(cli.stdout), normalize(bundle.text) + '\n')   // console.log 多一个换行
```

再加两条断言：归一后的文本包含 `## Self-corrections`，并且至少有一行 pattern 行包含 `since <ISO>`，确认比较的确实是带 pattern 的输出。两边跑的是同一份 core 构建。seed 的时间戳用近期时刻，与窗口边界（30 天）相距远大于两次运行的间隔，`candidate` 的判定不会因为两次 `now` 不同而变化。

不为这条测试给 CLI 或 bundle 加注入 `now` 的参数：那是新的公开接口，只为测试服务。

### 4.5 要跑的命令

```bash
cd packages/skill-evolution && npm ci && npm test          # pretest 会先 build
cd ../dsh-adapter && npm ci && npm run build
cd ../dsh-bundle && npm ci && npm test
```

README 里 `dsh-bundle/README.md:58-70` 关于 `failures` 的描述要同步一句：两条入口现在输出同一份报告，`--format json` 仍是 Failure case 数组。

## 5. 与 SKIL-183（派生投影 T2–T5）的关系：只有文本冲突，没有语义交集

- 本设计只读 `refreshDerived()` 返回值里的 `failures`、`episodes`、`patterns`。这三项在 `WorkflowSnapshot` 和 `DerivedRecords` 里同名同类型（后者只是把可选改成必有），所以无论 T4 先合还是后合都能编译。没有引用 `STORES`、`projectDerived`、`DerivedProjection` 等 T2–T5 新增的 interface。
- 文本冲突在 `service.ts` 的 `metrics()` 附近：T4 要把两个私有计数换成 `view.counters`，本设计把那两行挪进 `readDerivedInputs()`。后合入的一方把 `readDerivedInputs()` 改成取 `this.projection.refresh()` 的 `records` 和 `counters`，改动只有一处，计数的含义不变。
- 不规定合入顺序，后合入的分支负责解决这处文本冲突。采用默认答案，成员可推翻。
- 与准入 module（SKIL-185 / SKIL-186，PR #120）没有接口关系，不用等它。

## 6. 迁移步骤（供 S2 拆 `specs/<slug>/tasks.md`）

1. **core**：§3.1 抽出 `summarizeCorrections`（不改行为）；§3.2 新文件；§3.3 兼容包装；§3.4 新增 service 方法、私有取数方法，以及 `metrics()` 的可选 `{ now? }` 参数。测试 1–5。验收：core 的 build 和测试通过，已有 metrics、correction、evolution 测试不改且全绿。
2. **adapter**：§3.5 改 CLI 和 bundle，同步 README。测试 6–9。验收：bundle Markdown 与改动前逐字节相同（除 `now` 外）；CLI Markdown 多出 Self-corrections 一节；CLI JSON 与改动前逐字节相同。

第 2 步依赖第 1 步。两步都含代码，按 delivery-contract 由成员合并。SKIL-165 Task 6 在这两步和 SKIL-183 T5 都合入之后开工，按 §3.6 落地。

## 7. 不可逆决策

**无，本设计不新增 ADR。** 逐项检查：

- 落盘格式：报告不落盘，不新增 store，cursor 不变。
- 公开输出格式：CLI `--format json` 保持数组（J1，§2.4），逐字节不变。CLI Markdown 多一节，是给人看的输出，不算契约，可以随时回退。成员如果改选 J2，那就是不可逆变更，届时补 ADR。
- 公开接口：只有追加，包括 `EvolutionService.failuresReport`、`EvolutionService.metrics` 追加的可选参数 `{ now? }`（不传时行为不变）、`DerivedReadOptions` 类型、`buildFailuresReport`、`renderFailuresReport`、`summarizeCorrections`，以及 `FailuresReport`、`FailuresReportInput`、`CorrectionPatternLine`、`CorrectionSummary`、`CorrectionSummaryInput` 这几个类型。`renderFailuresMarkdown` 签名和行为不变，只是标了 deprecated。`aggregateMetrics` 的参数在结构上等价。没有删除导出，没有不兼容的签名变更。
- 依赖方向：新增的边是 `service → failures-report → metrics / correction / types` 和 `report → failures-report`，都不成环。锁定测试放在 bundle 包里，依赖方向仍是 bundle → core（ADR-0014）。

## 8. 可逆的默认选择（采用默认答案，成员可推翻）

- U2：service 方法加纯函数，不选自由函数 U1 或复用 `metrics()` 的 U3。
- R1：返回数据，渲染用独立的纯函数。
- K1：`renderFailuresMarkdown` 保留为兼容包装。
- J1：CLI JSON 保持数组。
- T1：一致性锁定测试放在 bundle 包。
- A1：R-33 的汇总数在 `metrics.ts` 用纯函数算，报告和 metrics 共用。
- 新代码放在新文件 `failures-report.ts`，不并进 `report.ts`。
- Self-corrections 一节总是输出（兼容包装除外）。
- 不规定与 SKIL-183 T4 的合入顺序。

## 9. 待定项

- **报告规模**：`failures` 今天输出全部 Failure case，没有上限，本设计沿用现状。case 数量很大时要不要加 `--limit` 或按 cluster 汇总（SKIL-104 提过按 cluster 分组），留给后续需求，不在本票范围。
- **词表**：`CONTEXT.md` 里的 Maintenance operation 只列了 propose、evaluate、review、promote、rollback，没有给 failures、metrics 这类只读报告起名字。本设计用「failures 报告用例」这个说法，不改词表；以后需要时由 `/domain-modeling` 补上。
