> 状态：已实现（SKIL-38 → SKIL-61…69）。决策见 ADR-0001、0002、0003；实现契约见 `specs/evolution-state-root/`。
> 本文是历史提案，不随代码更新；与现状不一致时以代码、ADR 和 spec 为准。

本文为架构扫描条目 #4「演化状态根目录」出设计方案：把演化状态的目录布局收进一个 module，并修好 rotate 清空派生状态、rotate 后去重失效、`repair()` 覆盖刚重建的 cursor 三个问题。基线 `origin/main` @ `c168579`。只出设计，不写实现代码。

## 1. 现状（读了哪些代码）

读了 `packages/skill-evolution/src/` 下的 `service.ts`、`store.ts`、`records.ts`、`repair.ts`、`retention.ts`、`health.ts`、`lifecycle.ts`、`workflow.ts`、`experience.ts`、`index.ts`，`bin/dsh-skill-evolution.mjs`，`packages/dsh-bundle/index.js`，两个测试文件，以及 `docs/architecture-design-zh.md`（§4.3 文件布局、§10 关键不变量）、`AGENTS.md`、三个包的 `README.md`。三个包已装依赖、`build` 通过、`test` 33 passed。三个问题都用一次性脚本在 `c168579` 上复现过（下面每条附实际输出，脚本不入库）。

### 1.1 目录布局散在哪里

演化状态的路径没有单一 owner，`join(root, '.skill-evolution', …)` 这类拼接散落在 5 个 module：

- `service.ts:55-66` 构造 9 个 store 的路径 + `projection-cursor.json`；同一份 9 个 store 的清单在 `health()`（`service.ts:131`）和 `repair()`（`service.ts:139`）里**又各抄了一遍**。
- `repair.ts:89` 拼 `projection-cursor.json`、`:92` 拼 `observations.jsonl`、`:110` 拼 `locks/`。
- `retention.ts:15` 用 `join(dirname(path), 'archive')` 定义归档目录。
- `lifecycle.ts:66,107,217,257` 拼 `candidates/`、`locks/`、`<skill>/versions/`。
- `bin/…mjs:16,118,128,191` 与 `dsh-bundle/index.js:123,187,223` 各自拼 `.skill-evolution/…` 和 observation store 路径。

其中一个关键错位：CLI 的 `rotate` 默认轮转 `${root}/.skill-evolution/observations.jsonl`（`bin/…mjs:191`），但 bundle 把事实文件写到 `~/.dsh/skill-evolution/events.jsonl`（`index.js:123,187`），通过 `EvolutionServiceOptions.store` 传入。也就是说**事实文件可以落在 `.skill-evolution` 之外**，而派生 store 和 cursor 仍在 `<root>/.skill-evolution` 下。任何“状态根目录”的抽象都必须把 observation store 的位置和状态目录分开建模。

### 1.2 事实 / 派生的划分

- **事实**（append-only，权威）：`observations`、`proposals`、`decisions`、`feedback`、`evaluations`。
- **派生**（可重投影，`replaceAll` 覆盖）：`experiences`、`failures`、`clusters`、`diagnoses`。

关键事实：**投影的唯一输入是 `observations`**。`refreshDerivedUnlocked`（`service.ts:417`）只 `observations.readAll()`，`workflow.add(observations)` 后 `snapshot()` 产出四个派生集合再 `replaceAll`。cluster id 是 `cluster:${skillName}:${earliestCaseId}`（`experience.ts`）、diagnosis id 是 `diagnosis:${cluster.id}`，都由事实确定性推出——只要 observations 完整，派生 id 在重投影后稳定，proposal 里引用的 cluster id 不会漂。历史版本按签名生成的 cluster id 只在旧派生记录中有效；重投影会一次性换成按最早 case id 的新 id。**这条“派生可由事实完整重建”的不变量，正是三个问题的共同根因所在。**

### 1.3 三个问题（复现）

**问题 1 — rotate 清空派生状态。** `rotateJsonl(observations.jsonl)`（`retention.ts:12`）把文件 `rename` 进 `archive/` 再写一个空文件。之后 `refreshDerived` 读到空 observations → fingerprint 变了 → 对空集合投影 → `replaceAll([])` 把 experiences/failures/clusters/diagnoses 全清空，而现有 proposal 还引用着这些 cluster id。

```text
1) before rotate: failures=2 clusters=1
1) after rotate:  failures=0 clusters=0
```

**问题 2 — rotate 后去重失效。** `JsonlEventStore` 的 `knownIds` 和 `refreshKnownIds`（`store.ts:81`）只读当前文件。rotate 后当前文件为空 → `knownIds` 为空 → 同一个 event id 被重投递时 `append` 认不出来，追加成第二份。归档里的那份对去重不可见。

```text
2) re-append archived e1 accepted as new: true
```

**问题 3 — repair 覆盖刚重建的 cursor。** `service.repair()`（`service.ts:138-152`）先对 9 个文件跑 `repairJsonlFile`，再调 `repairEvolutionRoot`（它在 `repair.ts:89-99` 从修好的 observations **重建了 cursor**），紧接着 `service.ts:149` 又 `writeFile(cursorPath, '{}\n')` 把它覆盖成 `{}`。`{}` 的 `count` 是 `undefined`，`readCursor` 返回 `undefined`，下次 refreshDerived 判定 cursor 失效、重新投影——`repairEvolutionRoot` 那步重建等于白做。

```text
3) repair report projectionCursorRebuilt: true
3) cursor after repair: {"count":1,"lastId":"e1","fingerprint":"8b5cc4df…"}
```

**但 `:149` 并不是单纯的 bug，它在补偿一个更深的错误。** cursor 的含义是「派生 store == 对这批事实的投影」，fingerprint 却只覆盖 observations。`repairEvolutionRoot` 只看 observations 就重建 cursor，等于在没有核对派生 store 的情况下宣称它们是新鲜的。只要 repair 动过派生文件（隔离了坏行），这个宣称就是假的。`:149` 的 `{}` 恰好让 cursor 失效，结尾的 `refreshDerived()` 于是被迫重投影，`service.repair()` 的最终结果才是对的。两个复现：

```text
# repairEvolutionRoot 单独调用：派生文件已丢，cursor 却被重建成“匹配”
fresh failures: 2
after repairEvolutionRoot, failures: 0

# 模拟“只删掉 :149”：一行派生记录被隔离后，cursor 仍匹配，丢失的记录不再回来
fresh failures: 2
repair without :149 then refresh, failures: 1
```

所以问题 3 的准确表述是：**cursor 有两个写入者，其中 `repairEvolutionRoot` 写的是一个错误的 cursor，`:149` 用覆盖把它抵消掉。** 只删 `:149` 会引入派生记录丢失的回归。修复见 §4.3。

### 1.4 顺带暴露的三处

- **cursor 有两个写入者、两套 fingerprint 算法**：`repairEvolutionRoot`（`repair.ts:97`）按 `recordId(JSON.parse(line))` 逐行拼；`refreshDerivedUnlocked`（`service.ts:421`）按已解析 observation 的 `.id` 拼。两者对“残行”处理不同。
- **`refreshDerived` 写 cursor 用普通 `writeFile`**（`service.ts:437`），不是原子写；`repair.ts` 的 `atomicWrite` 是原子的。同一个文件两种写法。
- **`repairEvolutionRoot` 独立调用时会在残行上抛错**。它 `filter(Boolean)` 后 `JSON.parse(lines.at(-1))`，遇到没写完的尾行直接 `SyntaxError`——而 store 的 `readAll` 能容忍尾部残行。复现：

```text
store readAll tolerates torn tail: 1
repairEvolutionRoot throws: SyntaxError Unterminated string in JSON at position 15
```

（在 `service.repair()` 里因为 `repairJsonlFile` 先跑、已清掉残行，所以掩盖了；但接口本身不自洽。）

### 1.5 相关约束

- 架构红线：`core` 不依赖 DSH 内部（AGENTS.md）。本设计的 module 在 core 内，不碰红线。
- 不变量（`docs/architecture-design-zh.md` §10）：#1「不能修改已产生的原始 observation」、#2「派生归因必须引用 observation ID」。rotate 用 `rename` 归档、不改归档内容，跨文件去重只在读时按 id 过滤、不重写文件——两条都不破。
- 锁：SKIL-41（PR #16，draft，第 1 轮 BLOCK 待返工）在统一锁协议，写明「锁文件位置不变，布局留给 SKIL-38；锁路径由调用方传入」。分工：本设计决定锁文件**放在哪**，锁 module 决定**怎么加锁**。本设计不移动任何锁文件，两张票的设计互不依赖。
- `docs/architecture-design-zh.md` §4.3 画的是每个 Skill 旁置 `evolution/` 目录的布局，代码从没实现过，实际是 §2 的集中式 `.skill-evolution/`。本设计以代码为准，§4.3 的漂移在 §6 第 7 步随文档一起改。
- **bundle 绕过 service 直接写事实**：`dsh-bundle/index.js:124` 是 `new DshEvolutionAdapter(new JsonlEventStore(storePath))`，运行时观察不经过 `EvolutionService`。所以跨归档去重如果只做在 service 里，或者做在一个包在 store 外面的 module 里，bundle 这条最热的写路径照样会重复追加。**去重必须落在 observation store 这个类本身里**（今天的 `JsonlEventStore`，或取代它的类），不能落在 service 或外层包装里。这一条决定了 §3 的选型。

## 2. 现有布局

```text
<root>/                                  # SkillVersionStore 的 root，通常是 .dsh/skills
├── <skill>/SKILL.md, manifest.json, current.json, .publish.json, versions/<v>/
└── .skill-evolution/                    # 状态目录
    ├── observations.jsonl               # 事实；可被 --store / options.store 覆盖到别处
    ├── proposals.jsonl  decisions.jsonl  feedback.jsonl  evaluations.jsonl   # 事实
    ├── experiences.jsonl  failures.jsonl  clusters.jsonl  diagnoses.jsonl    # 派生
    ├── projection-cursor.json           # 派生的新鲜度标记
    ├── <store>.jsonl.lock  projection-cursor.json.lock
    ├── locks/<skill>.lock               # 发布锁
    ├── candidates/<proposalId>/SKILL.md, proposal.json
    ├── proposals/<id>.md                # CLI/bundle 生成的 proposal 报告
    ├── evaluations/<id>.json            # CLI 生成的评测结果
    └── archive/observations.jsonl.<ISO>.<pid>.jsonl       # rotate 产物

$DSH_HOME/skill-evolution/               # bundle 的 observation store
├── events.jsonl
└── archive/events.jsonl.<ISO>.<pid>.jsonl                 # 有人对它 rotate 才会出现
```

归档约定已经存在（`retention.ts:15,19`）：归档段落放在 store 文件**同目录**的 `archive/` 下，文件名 `<basename>.<ISO 时间，冒号换连字符>.<pid>.jsonl`。ISO 时间定长，按文件名字典序排就是按时间排。约定是相对 store 文件定义的，所以 store 落在状态目录之外时也成立。

## 3. 收口到哪个 module

一个新 module `state-root.ts`，三个东西，深度递增：

1. **`resolveLayout`（纯函数，浅数据）** —— 给定 root（和可选的 observation store 覆盖路径），返回状态目录、cursor 路径、locks 目录、9 个 store 的清单（每个带 name / path / role=fact\|derived / 是否投影输入）。这一层直接消掉 §1.1 的路径散布和 `service.ts` 里 health/repair 两处 9-store 副本。它是本设计里唯一的「布局知识」。
2. **`ObservationLog`（深行为）** —— observation 事实流的 owner：append 到当前文件、readAll 与 knownIds 跨「archives + 当前文件」、rotate 归档一个段落而不改变逻辑事实流。它**取代** observations 用的 `JsonlEventStore`，`EvolutionService` 和 `dsh-bundle` 都构造它——去重逻辑因此落在这一个类里，堵住 §1.5 说的 bundle 旁路。
3. **cursor 读写 + fingerprint（单一实现）** —— `readCursor` / `writeCursor`（原子）/ `fingerprintOf`。`refreshDerived` 和 repair 都走它，cursor 从此只有一个写入者、一套 fingerprint。

`records.ts` 的 8 个派生/其他事实 store 维持 `JsonlRecordStore` 不动——它们不跨归档、不喂投影，本设计不碰。只有 observations 需要「跨归档」这层深度。

### 3.1 接口草图（推荐形状，仅接口层）

```ts
export type StoreRole = 'fact' | 'derived'
export type StoreName =
  | 'observations' | 'proposals' | 'decisions' | 'feedback' | 'evaluations'
  | 'experiences' | 'failures' | 'clusters' | 'diagnoses'

export interface StoreDescriptor {
  readonly name: StoreName
  readonly path: string
  readonly role: StoreRole
  readonly projectionInput: boolean   // 今天只有 observations 为 true
}

export interface EvolutionLayout {
  readonly root: string
  readonly stateDir: string           // <root>/.skill-evolution
  readonly cursorPath: string
  readonly locksDir: string
  readonly stores: readonly StoreDescriptor[]     // repair/health 遍历它
  readonly observations: StoreDescriptor          // .path 可在 stateDir 之外
}

/** observationStore 覆盖时（bundle: ~/.dsh/skill-evolution/events.jsonl），archive/ 跟着它走。 */
export function resolveLayout(options: { readonly root: string; readonly observationStore?: string }): EvolutionLayout

export interface ProjectionCursor { readonly count: number; readonly lastId?: string; readonly fingerprint?: string }
export function readCursor(cursorPath: string): Promise<ProjectionCursor | undefined>
export function writeCursor(cursorPath: string, cursor: ProjectionCursor): Promise<void>   // 原子
export function fingerprintOf(ids: readonly string[]): string

/** observation 事实流的 owner，取代 observations 用的 JsonlEventStore。 */
export class ObservationLog {
  constructor(currentPath: string)          // archive/ 由 currentPath 同目录推出
  readonly currentPath: string
  append(event: RuntimeObservation): Promise<boolean>    // 只写当前文件；跨归档判重
  readAll(): Promise<RuntimeObservation[]>               // archives(旧→新)+当前，按 id 首现去重
  query(query?: ObservationQuery): Promise<RuntimeObservation[]>
  rotate(options: { readonly maxBytes: number; readonly retentionDays?: number }): Promise<RetentionResult>
}
```

深度检验（删除测试）：删掉这个 module，路径拼接散回 5 处、9-store 清单散回 3 处、fingerprint 散回 2 处、「事实流含不含 archive」的判断散回 store 和 service——正是今天。leverage：调用方只学一个「observation 事实流」概念，就同时拿到去重、投影输入、rotate 一致性。locality：「轮转后派生不丢」只需通过 `ObservationLog` 一个 interface 写回归测试。

### 3.2 备选与取舍

**问题 A：跨归档的深度放在哪。**

| 选项 | 形状 | 复杂度 | 可测性 | 可逆性 / 迁移 |
|---|---|---|---|---|
| **A-1（推荐）** | 新类 `ObservationLog` 取代 observations 用的 `JsonlEventStore`，service 与 bundle 都构造它 | 中：一个新类，`JsonlEventStore` 可保留为内部实现或删除 | 一个 interface 覆盖去重、读取、rotate 三条回归 | 可逆；bundle 改一行构造 |
| A-2 | 原地加深 `JsonlEventStore`：构造参数加 `archiveDir`，`initialize`/`refreshKnownIds`/`readAll` 读归档 | 低：改一个类 | 同 A-1 | 可逆；零调用方改动。但 rotate 仍在 `retention.ts`，「archive 格式」知识分在两处 |
| A-3 | service 层包一个 `EvolutionStateRoot`，读取时拼 archive，store 不动 | 低 | service 路径可测 | **否决**：bundle 直接写 `JsonlEventStore`（§1.5），问题 2 在热路径上仍在 |

A-1 和 A-2 的区别只在「rotate 要不要跟 readAll/去重住在同一个类里」。推荐 A-1，因为三者共用「archive 段怎么枚举、怎么排序」这一份知识，分开放 locality 差。A-2 是 A-1 的一个退化实现，如果 Spec 阶段想控制改动面，也可以接受，interface 行为一致。

**问题 B：rotate 后怎样让派生不丢（问题 1）。**

| 选项 | 做法 | 取舍 |
|---|---|---|
| **B-1（推荐）** | 归档算事实：投影读「archives + 当前」，rotate 不改逻辑事实流 | 语义最简单，「派生可由事实完整重建」不变量原样成立。代价是 readAll 的成本随全部历史增长，不随当前文件；今天的日志量下可忽略，将来由报告条目 #8 的 log module 处理性能 |
| B-2 | 归档不算事实：rotate 时把 cursor 改成「基线 + 增量」（记住已归档的 count/fingerprint），投影只对增量做、与已有派生合并 | 读取成本有上限，但投影必须变成增量合并（`EvolutionWorkflow.snapshot()` 今天是全量的），派生从此**不能**只靠当前事实重建，不变量被削弱。复杂度高、难测，改变 cursor 格式，不可逆 |

**问题 C：repair 的 cursor（问题 3）。**

| 选项 | 做法 | 取舍 |
|---|---|---|
| **C-1（推荐）** | 单一写入者：`repairEvolutionRoot` 不写 cursor，`service.repair()` 调 `refreshDerived({ force: true })` | 删代码而不是加代码；cursor 的含义只由一处保证 |
| C-2 | 保留 `repairEvolutionRoot` 重建 cursor，但让它先核对派生文件（repair 隔离过派生行就不重建） | 仍是两个写入者、两套 fingerprint；独立调用 `repairEvolutionRoot` 的人得知道「它有时写 cursor 有时不写」。interface 更复杂 |
| C-3 | 只删 `service.ts:149` | **否决**：§1.3 复现，会丢派生记录 |

### 3.3 这条 seam 会被什么拉扯

加第 10 个 store（改 `resolveLayout` 的清单一处）；上一个真正的 retention 策略（改 `ObservationLog.rotate` 与 §7 A2/A3 语义）；bundle 换宿主导致 store 再次搬家（`observationStore` 覆盖已经建模）；报告条目 #8 的 JSONL log module（`ObservationLog` 内部的框帧/去重实现是它未来的接入点，interface 不变）。

## 4. 三个问题各自的修复思路

三个问题都是 §1.2 那条不变量的不同破法：**「派生 == 对完整事实的投影」**。B-1、A-1 把「完整事实」重新定义成「archives + 当前文件」，C-1 把「投影是否新鲜」的判定交回给唯一的 cursor 写入者。前两个共用一个根：`ObservationLog` 让事实流跨归档；第三个是 cursor 写入者去重。

### 4.1 问题 1（rotate 清派生）— B-1：归档算事实

**根因**：投影的唯一输入是 observations（§1.2），而 rotate 把 observations 的一段搬进 `archive/`、当前文件清空（`retention.ts:20-21`）。`refreshDerivedUnlocked`（`service.ts:417`）只读当前文件 → 观测集合从 N 条变 0 条 → fingerprint 变 → 对空集合 `snapshot()` → `replaceAll([])` 把四个派生集合清空。proposal 仍引用着被清掉的 cluster id。

**修法**：`ObservationLog.readAll()` 读「archives（旧→新）+ 当前文件」，按 id 首现去重后按原始顺序拼回。rotate 只是把逻辑事实流的一段挪进 archive，**逻辑事实流不变** → fingerprint 不变 → `refreshDerived` 判定 cursor 仍匹配 → 不重投影、不清派生。`refreshDerivedUnlocked` 不再直接持有 `observations.filePath`，改成向 `ObservationLog.readAll()` 要完整事实流；service 一行都不用判断「要不要算 archive」，那是 `ObservationLog` 的实现细节。

回归测试（跨这一个 interface）：append N 条 → refreshDerived → rotate（maxBytes=1）→ refreshDerived，断言 failures/clusters 数量前后一致。正是 §1.3 复现脚本的断言，只是现在应当相等。

### 4.2 问题 2（rotate 后去重失效）— A-1：跨归档判重

**根因**：`JsonlEventStore.refreshKnownIds`（`store.ts:81-85`）和 `initialize`（`:70-79`）只读当前文件填 `knownIds`。rotate 后当前文件为空 → `knownIds` 空 → 归档里的 event id 对 `append` 不可见 → 同一 id 被重投递时当成新记录追加，事实流里出现两份同 id。

**修法**：`knownIds` 由「archives + 当前文件」共同填充。归档段是只读的历史事实，参与判重、不参与写入——`append` 仍只写当前文件（不破不变量 #1「不改已产生的 observation」），判重覆盖全历史。

**关键约束（§1.5）**：`dsh-bundle/index.js:124` 直接 `new JsonlEventStore(storePath)`，运行时观察不经过 `EvolutionService`。若把跨归档判重做在 service 层或做在一个包在 store 外面的壳里，bundle 这条最热的写路径照样重复追加。**所以判重必须落在 `ObservationLog` 内部**，让 service 和 bundle 都构造同一个类。这一条是 §3 选 `ObservationLog` 取代 `JsonlEventStore`（而非在外面加一层）的决定性理由。

回归测试：append e1 → rotate → 用一个新构造的 `ObservationLog`（模拟新进程）append 同一个 e1，断言返回 `false`。正是 §1.3 复现脚本第 2 条，现在应当被拒。

### 4.3 问题 3（repair 覆盖刚重建的 cursor）— C-1：cursor 单一写入者

**根因（§1.3 精确表述）**：cursor 有两个写入者。`repairEvolutionRoot`（`repair.ts:89-99`）只看 observations 就重建 cursor，宣称「派生 == 投影」为新鲜；但 repair 刚隔离过派生文件里的坏行，这个宣称是假的。`service.ts:149` 的 `writeFile(cursor,'{}')` 用一个失效 cursor 把假宣称抵消掉，结尾的 `refreshDerived()` 因此被迫重投影，`repair()` 的最终结果才对。**只删 :149 会引入派生记录丢失的回归**（§1.3 第二个复现：`failures: 1` vs fresh `2`）。

**修法**：把「宣称新鲜」的能力从 `repairEvolutionRoot` 拿掉，交回给唯一有资格判定的 `refreshDerived`。
1. `repairEvolutionRoot` **不再内联重建 cursor**（删 `repair.ts:89-99` 那段），它只负责修事实文件、隔离坏行、返回报告。cursor 从此只有一个写入者：`writeCursor`，只被 `refreshDerived` 调用。
2. `service.repair()` 删掉 `:149` 的 `writeFile(cursor,'{}')`，改为显式失效 + 强制重投影：`refreshDerived({ force: true })`。`force` 跳过 fingerprint 比较，直接对修好的完整事实流重投影，并用 `writeCursor` 写回一致的 cursor。
3. `refreshDerivedUnlocked` 写 cursor 从普通 `writeFile`（`service.ts:437`，非原子）改成 `writeCursor`（原子，§3.1）。同一个文件从此只有一种写法、一套 fingerprint（`fingerprintOf`）。

这样 repair 后 cursor 真实反映「派生 == 对修好的事实的投影」，不是靠两个写入者互相抵消凑出来的。**C-3（只删 :149）被否**：它保留了 `repairEvolutionRoot` 的假宣称，丢派生记录。

顺带修掉 §1.4 第三处：`repairEvolutionRoot` 不再 `JSON.parse(lines.at(-1))`，也就不再在残行上抛 `SyntaxError`；它与 store 对「尾部残行」的容忍度一致（残行留给报告条目 #8 的 JSONL log module 统一，本设计不展开）。

回归测试：先污染一行派生记录 → `repair()` → 断言 failures 恢复到 fresh 的数量，且 cursor 的 `count/lastId/fingerprint` 与重投影后一致（不是 `{}`）。

## 5. 现有数据的迁移路径

**结论：零迁移、就地兼容、可逆。** 不移动任何文件、不改任何 JSONL schema、不改文件名约定。

- **布局不动**：`resolveLayout` 返回的路径逐一等于今天硬编码的路径（`<root>/.skill-evolution/<name>.jsonl`、`projection-cursor.json`、`locks/`、observation store 的覆盖路径）。升级后 store 文件原地不动，`ObservationLog` 读的还是同一个当前文件 + 同一个 `archive/` 目录。归档文件名约定（`<basename>.<ISO>.<pid>.jsonl`，§2）不变，旧归档段直接被新的 `readAll`/`knownIds` 认出来。
- **cursor 自愈**：旧代码写的 cursor 只按当前文件的 observations 计数。升级后第一次 `refreshDerived`，事实流口径变成「archives + 当前」，count/fingerprint 与旧 cursor 不匹配 → 自动重投影一次 → 写回新口径 cursor。无需数据迁移脚本。
- **已被 bug 破坏的状态自动恢复**：若某个 root 在升级前已经 rotate 过、派生集合已被清空（问题 1 已触发），升级后第一次 `refreshDerived` 会对「archives + 当前」重投影，**把 experiences/failures/clusters/diagnoses 重新算出来**，proposal 引用的 cluster id 因确定性推导而稳定（§1.2）。升级本身就是修复。
- **失败与回滚**：本设计只改代码、不改数据。回滚 = 还原代码，数据文件原封不动，旧代码照常读当前文件。回滚会让三个 bug 重新出现，但**不丢任何数据**（事实文件 append-only，派生可重建）。因此上线不需要数据备份步骤，也没有「迁移写到一半崩溃」的中间态——没有迁移写。
- **已被 retention 删掉的归档找不回来**：今天默认 30 天删归档（`retention.ts:24`）。已经删掉的段落不在任何地方，升级后的重投影只能覆盖还在的 archives + 当前文件。这不是本设计引入的损失，但要写进 release note：升级前已经 rotate 过又过了 30 天的 root，派生只能部分恢复。
- **两处面向调用方的行为变化**：(1) `rotate` 之后 `readAll`/`query` 会带上归档段。`grep -rn rotateJsonl` 只命中 `bin/…mjs:192` 和 `tests/core.spec.ts:149`，两者都只为控制文件大小，不依赖「rotate 会截断可见事实」。(2) `retentionDays` 缺省不再删归档（A3），归档目录会一直增长，直到 retention 策略立项。

## 6. 5 个 module 怎么迁

按依赖顺序，每步都可独立编译、独立测试：

1. **新增 `src/state-root.ts`**：`resolveLayout` + `StoreDescriptor`/`EvolutionLayout` + `readCursor`/`writeCursor`/`fingerprintOf` + `ObservationLog`。`ObservationLog` 内部可复用现有 `parseLines`/`withFileLock`；跨归档读取用 §2 的 `archive/` 约定枚举段落（字典序即时间序）。
2. **`service.ts`**：构造函数（`:55-66`）改成 `const layout = resolveLayout({ root, observationStore: options.store })`，observations 用 `new ObservationLog(layout.observations.path)`，其余 8 个 store 仍是 `JsonlRecordStore`，路径取自 `layout`。`health()`（`:131`）、`repair()`（`:139`）遍历 `layout.stores` 而非各自抄的 9-store 数组。`refreshDerivedUnlocked` 的 fingerprint 改用 `fingerprintOf`、cursor 改用 `writeCursor`，并接受 `{ force }`。`repair()` 删 `:149`、改调 `refreshDerived({force:true})`。
3. **`retention.ts`**：`rotateJsonl` 的归档逻辑并入 `ObservationLog.rotate`（observations 专用），`retentionDays` 缺省时不删（A3）。`rotateJsonl` 是 `index.ts` 的公开导出，保留签名、内部委托给同一实现，避免破坏外部调用方；CLI 的 `--retention-days` 默认值从 `'30'` 改为不传。observations 的轮转统一走 `ObservationLog`，确保 rotate 与 readAll 用同一套「archive 参与投影」的语义。
4. **`repair.ts`**：删 `repairEvolutionRoot` 里内联重建 cursor 的段落（`:89-99`）与 `JSON.parse(lines.at(-1))`；它退回成「修事实文件 + 返回报告」，cursor 交给 service 的 `refreshDerived`。
5. **`lifecycle.ts`**：`candidates/`、`locks/`、`<skill>/versions/` 的路径拼接（`:66,107,217,257`）改从 `layout` 取（`layout.locksDir` 等）。锁怎么加仍归 SKIL-41，本步只改「锁文件放哪」的来源。
6. **`bin/dsh-skill-evolution.mjs` 与 `dsh-bundle/index.js`**：两处各自的 `.skill-evolution/…` 与 observation store 路径拼接（`bin:16,118,128,191`、`bundle:123,187,223`）改从 `resolveLayout` 取。bundle 的 `new JsonlEventStore(storePath)`（`:124`）换成 `new ObservationLog(layout.observations.path)`——**这一步是堵住 bundle 旁路去重的关键**，不做则问题 2 在最热写路径上仍在。CLI rotate 的默认目标从写死的 `observations.jsonl` 改成 `layout.observations.path`，与 bundle 的实际 store 位置对齐。
7. **文档**：`docs/architecture-design-zh.md` §4.3（旁置 `evolution/` 布局，从未实现）随实现 PR 改成 §2 的集中式 `.skill-evolution/` 实际布局。

**验证命令**（PR 里附实际输出）：
- `cd packages/skill-evolution && npm run build && npm test`（现基线 33 passed）。
- §4.1/4.2/4.3 三条回归测试新增到 `tests/core.spec.ts`（rotate/repair 现有测试所在），断言见各节。
- `grep -rn "\.skill-evolution" packages/*/src packages/*/bin packages/dsh-bundle/index.js` 应只在 `state-root.ts` 命中布局字面量（其余为注释/文档）。
- `grep -rn "projection-cursor" packages/skill-evolution/src` 的写入点应只剩 `writeCursor` 一处。

## 7. 不可逆决策（需成员拍板）

只列真正不可逆或影响数据/公开接口的项；可逆的实现细节不在此列。

| # | 决策 | 推荐默认 | 为什么可逆/不可逆 |
|---|------|----------|-------------------|
| A1 | 目录布局是否搬家 | **就地不动**：`resolveLayout` 复刻今天的 `.skill-evolution/` 集中式布局，不移动任何文件 | 一旦搬家，线上已存在的 root 需要数据迁移，且回滚要反向搬——不可逆。就地则零迁移、可逆（§5） |
| A2 | archive 是否算事实（是否参与投影与去重） | **算事实**：archives + 当前文件共同构成逻辑事实流 | 这是修问题 1/2 的前提；若不算，rotate 仍会清派生。属语义决策，写进 `ObservationLog` 后是 seam 的核心不变量 |
| A3 | retention 是否默认自动删归档 | **不自动删**：`rotate` 默认只归档不按天删（`retentionDays` 显式传才删） | **这是对现状的行为变更**：今天 `retention.ts:24` 默认 30 天删、CLI 也默认传 `30`（`bin:192`）。A2 之下归档是事实，删掉一段 = 事实流缩短 = 下次重投影丢掉那段推出的派生、proposal 引用的 cluster 可能消失，且删除不可恢复。默认关，等真正的 retention 策略（先压缩成派生快照再删）立项再开 |
| A4 | cursor 写入者数量 | **单一写入者**（只有 `refreshDerived`/`writeCursor`） | 纯实现收敛，可逆。列出仅因它改了 repair 的行为契约 |
| A5 | bundle 是否换用 `ObservationLog` | **换**：bundle 与 service 构造同一个类 | 不换则问题 2 在 bundle 热路径未修。属实现接线，可逆 |

**A4、A5 属实现范畴，随 PR 落地即可，不单独等确认。** 需要成员拍板的是 **A1（布局搬不搬家）** 和 **A2/A3（archive 语义 + retention 默认）**——它们决定线上数据的口径，进 Spec 前需确认。两个问题都带了默认答案，成员可只回「默认」。若采纳默认，本设计不动任何线上数据、完全可逆，可直接进 Spec。
