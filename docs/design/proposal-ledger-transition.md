> 状态：SKIL-123 设计提案（父 issue SKIL-121，来源：架构扫描第 3 期 SKIL-109 编号 3）。决策见 ADR-0021（`accepted`，成员确认：SKIL-123），它取代 ADR-0005。
> 本文合并后冻结，不随代码更新；与现状不一致时以代码、ADR 和 spec 为准。

本文要解决两件事：一次 Proposal 转移收成 core 里的一个操作，写不进去就报错；Ledger record 的 id 能区分同一状态的多次进入。基线是 `origin/main` @ `2a442af`。本文只出设计，不写实现代码。

## 1. 现状

### 1.1 读了什么

- `packages/skill-evolution/src/`：`service.ts`、`proposal.ts`、`records.ts`、`jsonl.ts`、`operations.ts`（全文），`metrics.ts:55-96`、`lifecycle.ts:64-76`、`locking.ts:81-95`、`types.ts:145-169,259-275`、`index.ts`。
- 调用方：`packages/dsh-bundle/index.js:4,222,227,252`、`packages/skill-evolution/bin/dsh-skill-evolution.mjs:31-54`。
- 测试：`tests/proposal-ledger.spec.ts:45-98`、`tests/evolution.spec.ts:405-555`、`tests/operations.spec.ts:30-125`、`tests/cli.spec.mjs:78-113`、`packages/dsh-adapter/tests/adapter.spec.ts:170-186`、`packages/dsh-bundle/tests/bundle.spec.mjs:324,378-407`。
- 文档：`CONTEXT.md`（Proposal 与台账一节）、ADR-0004、0005、0016、0020，`docs/design/maintenance-use-cases-proposal-ledger.md` §2.3、§3.4、§5，`docs/prototypes/proposal-transition-feel.md`「与 ADR-0005 冲突」一节，`specs/maintenance-use-cases-proposal-ledger/`。
- 基线：`npm test`（`packages/skill-evolution`）输出 `Test Files  12 passed (12)`、`Tests  134 passed (134)`。

### 1.2 一次转移散在调用方手里

每个 service 方法各自做三件事：`assertCanTransition`，拼 `ledgerRecordId(root, status)` 再 `proposals.append`，最后 `recordDecision`。`JsonlRecordStore.append` 遇到已有 id 返回 `false`（`records.ts:18`），8 个调用点都不看返回值。于是：

- 记录没写进去，decision 却写进去了。decision id 带 `updatedAt`（`service.ts:371`），每次都是新 id。
- 转移的合法性只按调用方手里那份对象判断，不看台账里的最新状态。调用方拿着旧对象也能「转移」成功。
- service 方法返回的对象 id 是输入 id，不是新写的 record id（`service.ts:240-244` 返回的 `accepted.id` 仍是 `root:evaluated`），`operations.ts:154` 只好自己再拼一遍 record id。

### 1.3 复现（`2a442af`，build 之后用一次性脚本跑，脚本已删除）

脚本：stage → evaluate → reject → 手工追加 `root:observed` → 再 evaluate，然后读台账。

```
append root:observed -> true
status after 2nd evaluate: observed
ledger ids: p1 p1:evaluating p1:evaluated p1:rejected p1:observed
evaluated records: 1
evaluation artifacts: 2
decisions toStatus=evaluated: 2
```

第二次评测的 artifact 和 decision 都写进去了，Ledger record 被判重丢掉，Proposal 停在 `observed`。与 SKIL-95 Reviewer 的实测一致。第二次 `rejected`、`deferred`、`observed` 同样会丢。

### 1.4 8 个 `proposals.append` 调用点

| # | 位置 | 转移 | decision |
|---|---|---|---|
| 1 | `service.ts:182`（`stageProposal`） | draft → proposed，id = root | `:183` |
| 2 | `service.ts:197`（`evaluate`） | proposed → evaluating | `:198` |
| 3 | `service.ts:233`（`evaluate`） | evaluating / replayed / observed → evaluated，带 `comparisonCaseIds` | `:234` |
| 4 | `service.ts:242`（`acceptProposal`） | → accepted | `:243` |
| 5 | `service.ts:277`（`promote`） | accepted → promoted | `:278` |
| 6 | `service.ts:338`（`rollback`） | promoted → rolled-back | `:339` |
| 7 | `service.ts:347`（`rejectProposal`） | → rejected | `:348` |
| 8 | `service.ts:356`（`deferProposal`） | → deferred | `:357` |

相关的非 append 位置：`recordDecision`（`service.ts:361-385`）、`operations.ts:154`（自己拼 record id）、`proposal.ts:66-77`（id 语法）。`rollback` 里 `service.ts:326` 那条 skill 级 `decision:rollback:*` 不是 Ledger 转移，不在本文范围（归 SKIL-122）。

## 2. 设计问题与选项

### 2.1 一次转移放在哪个 module、interface 什么形状

**A. 新 module `ledger.ts`：`ProposalLedger`，一个写方法**

```ts
class ProposalLedger {
  constructor(proposals: JsonlRecordStore<SkillProposal>, decisions: JsonlRecordStore<DecisionRecord>, actor: string)
  transition(from: SkillProposal, to: ProposalStatus, input: TransitionInput): Promise<LedgerTransition>
  latest(reference: string): Promise<SkillProposal>        // 同 findProposalById：root 或任一 record id → 该 Proposal 最新记录
  record(recordId: string): Promise<SkillProposal>         // 精确 record id → 那一条记录
  history(root: string): Promise<readonly SkillProposal[]> // 按写入顺序
}
interface TransitionInput {
  readonly action?: DecisionAction          // 默认等于 to；rollback 传 'rollback'
  readonly reason: string
  readonly evidenceIds?: readonly string[]
  readonly policyVersion?: string
  readonly comparisonCaseIds?: readonly string[] // 只有 → evaluated 用
}
interface LedgerTransition {
  readonly record: SkillProposal   // 台账里真实存在的那一条，id 是真实 record id
  readonly decisionId: string
  readonly replayed: boolean       // true：这次转移之前已经写过，本次没有新写 Ledger record
}
```

`transition` 内部依次做：

1. 在 `proposals.jsonl.lock` 下读台账（一次锁内完成 2–4）。
2. **重跑判断**：台账里已有 `previousRecordId === from.id` 且 `status === to` 的记录 → 这次转移写过了，取那一条，`replayed: true`，跳到 5。
3. **校验**：`assertCanTransition(from.status, to)`（ADR-0004，唯一一次）。该 root 在台账里已有记录时，`from.id` 必须等于最新那条的 id，否则抛 `conflict`；只有该 root 在台账里还没有记录时才不查这一条（见 2.4）。`from.status` 是什么都不豁免：拿着同 id 的 `draft` 对象对已有记录的 root 转移，同样抛 `conflict`。
4. **写记录**：按 ADR-0021 算出 id（2.2），`previousRecordId = from.id`，追加。
5. **写 decision**：锁外追加 `decision:ledger:<recordId>`，带 `recordId`、`fromStatus`、`toStatus`。`append` 返回 `false` 只说明这条 decision 已经在了（id 由 record id 决定），视为成功。

取舍：

- 复杂度：多一个 module、一个类。service 的 8 处各少 3 行，`recordDecision` 删掉。
- 可测性：只要两个 `JsonlRecordStore`，不需要 Skill 目录、评测或 `SkillVersionStore`，回流、重跑、并发、写失败都能直接测。
- 可逆性：module 内部怎么实现随时能改；对外只有 `transition` 一个写入口。
- 迁移成本：8 个调用点机械替换，外加 service 方法改为返回 `record`（2.5）。

**B. `EvolutionService` 上的私有方法 `applyTransition`**

同样的 5 步，放在 service 里。改动最小，但只能透过整个 service 测；service 已经 430 行，台账规则继续和评测、发布、投影混在一处。SKIL-122 的 promote / rollback 恢复也要调同一个操作，放私有方法里它们只能再绕一层。

**C. 只改 `JsonlRecordStore.append`：判重时抛错**

最小改动，能让「静默丢」变成「报错」，但回流仍然写不进去（id 还是撞），只是从静默变成必然失败。`decisions.append` 的幂等依赖 `false`（`evolution.spec.ts:553`），`ObservationLog` 另有去重语义，这个改法影响面超出台账。只作为配套，不作为方案。

**推荐 A。** 采用默认答案，成员可推翻。

配套的 store 接口：`transition` 要在一次锁内「读 → 算 id → 写」，现有 `append` 自己拿锁、只能按现成的 id 判重，做不到。在 `records.ts` 加一个方法：

```ts
appendComputed(build: (records: readonly T[]) => T): Promise<T>
```

持 `<path>.lock`，读全部完整帧（ADR-0020：残行不计入），调 `build` 得到新记录；新记录的 id 已存在就抛 `DuplicateRecordError`，否则 `appendFrames` 后返回。锁、分帧、隔离都留在 `records.ts`，`ledger.ts` 不直接碰文件。

### 2.2 record id 规则（数据格式，ADR-0021）

| 选项 | 第 1 次 evaluated | 第 2 次 | 旧数据 | 重跑幂等 |
|---|---|---|---|---|
| **A. 第 n 次进入加 `:<n>`，n ≥ 2** | `root:evaluated` | `root:evaluated:2` | 旧 id 就是「第 1 次」，直接合法 | 靠 `previousRecordId` 判断，确定 |
| B. 每次都带编号，从 `:1` 起 | `root:evaluated:1` | `root:evaluated:2` | 同一条记录两种拼法，查询要兼容 | 同 A |
| C. root 内全局序号 `root:<seq>:<status>` | `root:3:evaluated` | `root:6:evaluated` | 只能按文件顺序推序号来兼容读，或迁移 | 同 A |
| D. transition uuid / `updatedAt` 后缀 | `root:evaluated:<uuid>` | 同形 | 旧 id 另一种形 | 不确定，重跑会写第二条 |

A 的计算规则：n = 该 root 已有的 `status === to` 的记录数 + 1；n = 1 时不加后缀；算出的 id 已被占用（只可能来自历史脏数据）时 n 继续加 1。编号语法 `[2-9]` 或 `[1-9][0-9]+`。`proposed` 记录的 id 仍是 root 本身；`proposed` 只能从 `draft` 进一次。

`proposalRootId` 的解析改为：末段是编号且前一段是状态后缀，就把两段一起去掉；末段是状态后缀，去掉一段；重复直到都不是。`proposal:abc:2` 这种 root（`2` 前面不是状态）不受影响。

**采用 A。** 不可逆，成员已确认（SKIL-123）。

### 2.3 磁盘上的旧记录（数据格式，ADR-0021）

- **兼容读（推荐）**：在 2.2 A 下，ADR-0005 写出的每个 id 都是合法的「第 1 次」，读路径不用分支。缺 `previousRecordId` 的旧记录只影响一件事：对旧记录做重跑判断时找不到匹配，走正常校验，这和今天的行为一样。
- **一次性迁移**：把旧文件改写成新格式。要 `replaceAll` 改写 Fact record，违反 ADR-0016；在 A 下旧 id 本来就合法，迁移没有收益。选 C 或 D 才需要迁移。

以前因为判重丢掉的记录补不回来：那次转移的 decision 已经写了，旧数据里可能有「有 decision、无 Ledger record」的 root。不自动回填。metrics 按 root 去重计数（`metrics.ts:79-87`），数字不受影响。

**采用兼容读。** 不可逆，成员已确认（SKIL-123）。

### 2.4 失败语义

| 情形 | 结果 | 台账 | decision |
|---|---|---|---|
| 转移表不允许 | 抛 `ProposalLedgerError('invalid-transition')` | 不写 | 不写 |
| `from` 不是该 root 的最新记录（别人先转移了、调用方拿着旧对象） | 抛 `ProposalLedgerError('conflict')` | 不写 | 不写 |
| 同一次转移重跑（`previousRecordId` + 目标状态已存在） | 返回已有记录，`replayed: true` | 不写 | 缺就补写 |
| 算出的 id 已存在（跳号后仍撞，属于 bug） | 抛 `DuplicateRecordError` | 不写 | 不写 |
| 锁拿不到、I/O 失败（`LockBusyError`、`ENOSPC`、`EISDIR`…） | 原样抛出 | 未写或未确认写入 | 不写 |
| Ledger record 写成功，decision 写失败 | decision 的错误原样抛出 | 已写 | 缺，重跑同一次转移会补上 |

「落盘」在这里与 ADR-0020 同义：`appendFrames` 返回即视为写入，不额外 `fsync`。操作系统崩溃层面的持久性不在本文范围。

写入顺序选「先 Ledger record、后 decision」。反过来的顺序正是今天的坏状态（decision 说转了、台账没转）。先写记录时，崩溃留下的是「状态已转、缺一条审计」，调用方拿原来的 `from` 重试就会命中重跑判断并补上 decision。两次写入不嵌套加锁，避免引入锁顺序问题。「有 Ledger record、无 decision」由 `health` 报告、`repair` 补齐，归 SKIL-122 的恢复协议统一处理，本票只保证重跑能补。

「该 root 在台账里还没有记录时不查 `from` 是否最新」：现有测试和 adapter 会在内存里 `transitionProposal` 出一个对象直接交给 service（`evolution.spec.ts:414-428,438-441`），这些 root 从未 stage。台账里没有它们时没有「最新」可比。豁免只看台账里有没有该 root，不看 `from.status`：root 已有记录时，哪怕 `from` 是 `draft`（转移表允许 `draft → rejected / deferred / observed / replayed`），也必须等于最新记录，否则一个同 id 的 draft 就能把已 `promoted` 的 root 改成 `rejected`。采用默认答案，成员可推翻；以后要收紧成「必须先 stage」，只改这一处判断。

`operations.ts` 的 `OperationErrorCode` 加 `conflict`，`resolveProposal` 的映射（`operations.ts:178`）照常把 `ProposalLedgerError` 转成 `OperationError`。`DuplicateRecordError` 不映射，按内部错误冒泡。

### 2.5 与 decision 单写幂等（SKIL-51）的关系

SKIL-51 保证了「每次转移只写一条确定性 decision」，靠的是 `decision:transition:<root>:<to>:<updatedAt>`。它的前提是同一 `(root, to)` 只会出现一次；回流打破了这个前提，而且同一毫秒内两次进入同一状态仍会撞 id。

新规则把 decision 绑定到 Ledger record：`decision:ledger:<recordId>`，`DecisionRecord` 加可选字段 `recordId`。一条 Ledger record 恰好一条 decision，重跑同一次转移得到同一个 decision id，`append` 返回 `false` 就是幂等生效。SKIL-51 的两条验收（每条边一条 decision、重复 append 不增加）继续成立，只是 id 前缀从 `decision:transition:` 换成 `decision:ledger:`。旧 decision 不改写，metrics 按 `toStatus` + root 计数，新旧两种 id 都能数。

### 2.6 查询

| 调用 | 回流后（`root:evaluated`、`root:rejected`、`root:observed`、`root:evaluated:2`） |
|---|---|
| `ledger.latest('root')` | `root:evaluated:2`，status `evaluated` |
| `ledger.latest('root:evaluated')` | 同上。沿用 `findProposalById` 的语义：任一 record id 都解析到该 Proposal 的最新记录（`proposal.ts:90-92`） |
| `ledger.record('root:evaluated')` | 第一次 evaluated 那条 |
| `ledger.record('root:evaluated:2')` | 第二次那条，`previousRecordId === 'root:observed'` |
| `ledger.record('root:evaluated:1')` | `not-found`（非法编号） |
| `ledger.history('root')` | 5 条，按写入顺序 |

`findProposalById` 保持原语义，新增 `findLedgerRecord(records, id)` 精确查一条。两者都不做裸前缀匹配（ADR-0005 这一条保留进 ADR-0021）。

### 2.7 service 方法的返回值（公开接口，可逆）

8 个调用点改完后，`stageProposal`、`acceptProposal`、`rejectProposal`、`deferProposal` 返回 `transition(...).record`，也就是台账里真实的那一条，id 是真实 record id。`evaluate` 返回值不变（`SkillEvalResult`）。`reviewProposal` 直接用返回记录的 id，删掉 `operations.ts:154` 的拼接。

这是公开接口的行为变化：以前 `acceptProposal` 返回的 id 是输入 id。消费方只有本仓库的 CLI、bundle、adapter 和测试，`@dsh-skill-evo/core` 没有对外发布，改回去成本低，按可逆处理。采用默认答案，成员可推翻。

`service.proposals` 仍保留为读入口（bundle、测试在读），`service.ledger` 是唯一写入口。加一条测试守卫：`src/` 下除 `ledger.ts` 外不出现 `proposals.append` / `proposals.appendComputed`。

### 2.8 这条 seam 将来会被什么拉扯

- **Promote / Rollback 恢复（SKIL-122）**：最后一步是台账转移，重跑时靠 `previousRecordId` 判断「这一步写过没有」。恢复协议若要 journal，也挂在 `transition` 前后，不进调用方。
- **转移表变化**（原型结论要去掉 `replayed → accepted`、`observed → accepted`，新增「重新观察」动作）：只改 `PROPOSAL_TRANSITIONS` 和 operations 里的一个新动作，`transition` 不动。
- **台账换存储或加索引**：`ProposalLedger` 只依赖 `JsonlRecordStore` 的 `readAll` / `appendComputed` / `append`，换实现不影响调用方。
- **审计字段增加**（操作者、来源会话）：加在 `TransitionInput`，8 个调用点不必各改一遍。

## 3. 推荐方案小结

新增 `ledger.ts` 的 `ProposalLedger.transition`，一次完成「查重跑 → 按转移表和最新记录校验 → 写 Ledger record → 写 decision」，任何没写成的情况都抛错。record id 第 1 次进入某状态是 `<root>:<status>`，第 n 次是 `<root>:<status>:<n>`；新记录带 `previousRecordId`；decision id 为 `decision:ledger:<recordId>`。旧数据兼容读，不迁移。

### 与已有 ADR 的关系（Flag ADR conflicts）

- _与 ADR-0005 冲突（Ledger record id 是 `root:status`，同一状态只能写一次），值得重开，因为回流是转移表里合法的边，现有 id 让它必然丢记录。_ ADR-0021 取代 ADR-0005，保留其中「只按精确 root 或 record id 查」「每次转移一条确定性 decision」两条。
- ADR-0004：不冲突。转移表仍是唯一来源，`transition` 是它唯一的执行点。
- ADR-0016：不冲突。只追加；这是选择兼容读、拒绝迁移的直接原因。
- ADR-0020：不冲突。`appendComputed` 复用 `readFrames` / `appendFrames`，残行不计入编号，写前先隔离。

## 4. Builder task 边界与迁移顺序

T1、T2 可并行；T3 依赖两者；T4 依赖 T3。每个 task 单独合并后 `npm --prefix packages/skill-evolution test` 都要绿。

**T1 · id 语法（`proposal.ts`）**
- `ledgerRecordId(root, status, occurrence = 1)`；`proposalRootId` 识别 `:<status>:<n>`；新增 `findLedgerRecord`；`stageProposal` 前校验 `proposalRootId(root) === root`。
- 验证：旧后缀全部照旧解析；`root:evaluated:2` → `root`；`proposal:abc:2` → 原样；`root:evaluated:1`、`root:evaluated:02` 不是合法 record id；`findLedgerRecord` 精确命中每一条。
- 只加能力，不改写入，单独合并对现有数据无影响。

**T2 · `JsonlRecordStore.appendComputed`（`records.ts`）**
- 一次锁内读完整帧 → `build` → 撞 id 抛 `DuplicateRecordError` → `appendFrames`。
- 验证：两个独立实例对同一文件并发 `appendComputed`（`build` 按已有条数编号），结果编号连续、无重复；文件带残行时残行被隔离且不计入 `build` 看到的记录；撞 id 时抛错且文件不变。

**T3 · `ProposalLedger`（新 `ledger.ts`，`types.ts`，`index.ts` 导出）**
- `SkillProposal.previousRecordId?`、`DecisionRecord.recordId?`；`ProposalLedgerErrorCode` 加 `conflict`；实现 2.1 的 5 步和 2.4 的失败表。
- 验证见 §4.1 的 V1–V6。

**T4 · 调用点改走 `ProposalLedger`（`service.ts`、`operations.ts`、`CONTEXT.md`）**
- §1.4 的 8 处全部换成 `this.ledger.transition(...)`，删 `recordDecision`；service 方法返回真实记录；`operations.ts:154` 用返回 id；`OperationErrorCode` 加 `conflict`；加 `proposals.append` 守卫测试。
- `stageProposal` 保留 `service.ts:175-179` 的提前返回：台账里已有同 id 记录时比对内容，一致就返回已有记录，不调 `transition`。旧数据里的 `proposed` 记录没有 `previousRecordId`，重跑判断认不出它；删掉这段，重复 stage 旧 root 会撞上 `DuplicateRecordError`。
- `evaluate` 的第二次转移（→ evaluated）必须以第一次转移返回的记录为 `from`，不能再用内存里的 `evaluating` 对象（它的 id 是输入 id，会触发 `conflict`）。同理，adapter 测试 `adapter.spec.ts:183-184` 把 `acceptProposal` 的返回值直接交给 `promote`，依赖 2.7 的返回值改动。
- `CONTEXT.md` 和 `docs/governance/documentation.md:185-187` 的 **Ledger record** 词条都改为「身份由 Proposal root、该状态和第几次进入组成」，后者的引用从 ADR-0005 改为 ADR-0021。
- 需要同步的测试断言：`evolution.spec.ts:548-555`（decision id 前缀），`evolution.spec.ts:414-428`（返回值 id 变为真实 record id，断言 status 不受影响）；`adapter.spec.ts:182-184`、`bundle.spec.mjs:324` 按 `${id}:evaluated` 查第一次评测，值不变，不用改。
- 验证：V7、V8，以及 core / bundle / adapter 三个包的测试全绿。

### 4.1 验证方式

- **V1 回流**：stage → evaluate → reject → `transition(rejected, 'observed')` → evaluate。断言台账里 `status === 'evaluated'` 的记录有 2 条，id 为 `root:evaluated`、`root:evaluated:2`；`ledger.latest('root')` 与 `findProposalById(records, 'root')` 都返回 `root:evaluated:2`；`ledger.record('root:evaluated')` 返回第一次那条，`ledger.record('root:evaluated:2').previousRecordId === 'root:observed'`；`toStatus === 'evaluated'` 的 decision 恰好 2 条，`recordId` 分别对应两条记录。
- **V2 第二次拒绝**：V1 之后再 reject，得到 `root:rejected:2`，decision 为 `decision:ledger:root:rejected:2`。
- **V3 重跑**：同一个 `from` 连续调两次 `transition(from, 'accepted')`，第二次 `replayed: true`，台账和 decision 条数都不变。
- **V4 冲突**：拿已经被转移过的旧对象再转移，抛 `conflict`，台账和 decision 都不变。另一个用例：root 已 stage 且已转移之后，用同 id 的 `draft` 对象调 `rejectProposal`，同样抛 `conflict`，台账和 decision 条数都不变。
- **V5 写失败**：把 `proposals.jsonl` 换成同名目录（或让 `appendFrames` 抛错的 store 替身），`service.acceptProposal` 以 rejects 结束、错误原样透出；decision 条数不变。再构造「id 已占用」的 `appendComputed`，调用方拿到 `DuplicateRecordError`。
- **V6 补 decision**：让 decision store 第一次 append 抛错，`transition` 抛错且 Ledger record 已写；用同一个 `from` 重试，`replayed: true`，decision 补上且只有 1 条。
- **V7 旧数据兼容**：用 `origin/main` 写出的台账夹具（`root`、`root:evaluating`、`root:evaluated`、`root:rejected`、`root:observed`，无 `previousRecordId`，decision 为 `decision:transition:*`）继续 evaluate，得到 `root:evaluated:2`；metrics 的 promoted / rejected / rolledBack 计数与改动前一致。
- **V8 守卫**：`src/` 下除 `ledger.ts` 外 grep 不到 `proposals.append`。

### 4.2 兼容性风险（Spec Writer 需在对应 task 标注）

- 部署期间旧版进程不认识 `:<n>`，会把 `root:evaluated:2` 当成新 root，metrics 的 `total` 多数一条，CLI 按 root 查会查到旧状态；旧版进程也仍会静默丢掉重复进入。CLI、bundle、adapter 需要同一批升级。
- 以 `<status>` 或 `<status>:<n>` 结尾的自定义 root 在 T1 之后 stage 会被拒绝。今天这种 root 已经会被截短解析，只是以前没有报错。

## 5. 不可逆决策

- **ADR-0021**：Ledger record id 按第几次进入编号（第 1 次无后缀、第 n 次 `:<n>`），新记录带 `previousRecordId`，decision id 为 `decision:ledger:<recordId>`；旧数据兼容读，不迁移。取代 ADR-0005。成员确认：SKIL-123。
