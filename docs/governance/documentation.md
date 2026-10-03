本文是 SKIL-76 的文档治理方案：哪些 `docs/design/*.md` 里的决策迁成 ADR、`CONTEXT.md` 收什么、`specs/` 与 `docs/design/` 怎么分工去重，以及采纳后的执行拆分。**只出方案，不迁移**：本 PR 不改 `docs/design/`、`specs/`、`skills/` 下任何文件。基线 `origin/main` @ `22ae904`（行号在 `f7acabe` 起草，之后合入的提交只改了 `lifecycle.ts` 与 README，已复核）。

## 0. 读了什么、现状

- `skills/domain-modeling/{SKILL.md,ADR-FORMAT.md,CONTEXT-FORMAT.md}`：ADR 三条件（难以逆转、没上下文会意外、有真实取舍）；`CONTEXT.md` 只是术语表，「totally devoid of implementation details」（`SKILL.md:64`）。
- `docs/agents/domain.md:15` 与 `AGENTS.md:64`：本仓库约定单 context，`CONTEXT.md` 与 `docs/adr/` 都「尚不存在」。
- 四份设计稿（全文）：`docs/design/evolution-state-root.md`、`maintenance-use-cases-proposal-ledger.md`、`unified-lock-protocol.md`、`skil-36-seams.md`。
- 四份 spec 的 `design.md`（全文），`requirements.md` / `tasks.md` 看结构。
- 代码：`packages/skill-evolution/src/{types,proposal,state-root,locking,operations,portfolio,projection,lifecycle}.ts`，`packages/dsh-bundle/index.js`。
- 术语出处：`docs/architecture-design-zh.md`、`docs/skill-evolution-mechanism-zh.md`。
- 流程：`skills/orchestrate/SKILL.md`、`skills/delivery-contract/SKILL.md`、`skills/to-spec/SKILL.md`，以及 Architect / Spec Writer 的 agent instructions（`multica agent list`，不在仓库里）。
- 成员确认记录：SKIL-39 与 SKIL-38 上 ack7 回复「默认」（2026-09-26）；SKIL-43、SKIL-46 票面写明「成员没有推翻 / 没有另外表态，合并即接受默认」。

四份设计对应的实现票（SKIL-45…SKIL-70）全部 `done`，所以迁移对象都是**已落地**的决策，不是提案。

现状的三个问题：

1. **决策有两个「权威」来源**。`specs/skil-46-unified-lock-protocol/design.md:3` 写着设计稿的 interface、判定表和测试矩阵「are normative」，同时 spec 自己又抄了一遍 interface（`:16-65` 对照设计稿 `:204-259`）。`specs/maintenance-use-cases-proposal-ledger/design.md:11-21` 把设计稿 §5 的 D1–D9 重抄成表。`specs/evolution-state-root/design.md:13-47` 重抄了设计稿 `:119-157` 的接口草图，还加了字段。三处都已经不一致。
2. **决策的「为什么」只在长稿里**。例如「archive 为什么算事实」「held 锁为什么永不超时回收」都埋在 260–460 行的设计稿中段，旁边是复现脚本输出和已完成的迁移步骤。
3. **术语没有落点**。同一概念多种叫法（observation / event、promote / 采用、state root / root / stateDir），同一个词多重含义（`draft`、`observed`、`stable` 同时是 proposal 状态、生命周期状态或发布范围）。

## 1. ADR 迁移清单

编号按「演化状态 → proposal → 锁 → agent 工作流」排。来源行号指 `docs/design/` 里的文件。「确认」一列：**明确** = 成员在 issue 上回复过；**默认接受** = 成员没表态，PR 合并即视为接受（见决策点 Q3）。

### 1.1 建议迁为 ADR

| ADR | 标题 | 来源 | 为什么满足三条件 | 确认 |
|---|---|---|---|---|
| 0001 | 演化状态集中在 `<root>/.skill-evolution/`，observation log 可以放在状态目录之外 | `evolution-state-root.md:17`（§1.1 错位）、`:265`（A1） | 搬家要迁移线上数据、回滚要反向搬；`docs/architecture-design-zh.md` §4.3 原先画的是每个 Skill 旁边放 `evolution/`，读者会以为代码没按设计实现；bundle 的 `~/.dsh/skill-evolution/events.jsonl` 在状态目录外，这件事不看上下文会被当成 bug「修掉」 | 明确（SKIL-38，A1） |
| 0002 | 归档段是权威 observation 事实；retention 缺省不删归档 | `:174-179`（问题 B，B-2 被否）、`:266-267`（A2、A3） | 决定线上数据口径，删掉的归档恢复不了；「rotate 之后 readAll 还带着归档」和一般日志轮转的直觉相反；B-2（增量 cursor）是真实备选，被否是因为它削弱了「派生可由事实完整重建」这条不变量 | 明确（SKIL-38，A2/A3） |
| 0003 | 跨归档去重放在 observation log 类本身，service 和 bundle 构造同一个类 | `:81`（§1.5 bundle 旁路）、`:164-172`（A-3 被否）、`:211`、`:269`（A5） | 放在 service 里「看起来更干净」，但 bundle 的热写路径绕过 service，去重会失效；这是后人最可能「重构」回去的地方。设计稿把 A5 标为可逆（`:269-271`），代码层面确实可逆；列为 ADR 是因为逆转的代价不可见：去重一旦移出这个类，bundle 热路径会静默写出重复 observation，而重复写进 append-only 事实流就删不掉了。按三条件这一条最勉强，Q1 单列 | A5 默认接受（设计稿自认属实现，`:271`） |
| 0004 | proposal 状态机只有一张转移表，service 守卫都从表推出 | `maintenance-use-cases-proposal-ledger.md:103-112`（§2.4，B「双份 + 一致性测试」被否）、`:233`（D9） | 后果出人意料：`accepted→rejected`、`draft→rejected/deferred` 从此合法；以后要改策略，改的是表而不是再加一份守卫。`docs/architecture-design-zh.md:340-344` 已写了结论，但没写为什么和被否的选项 | 默认接受（SKIL-43） |
| 0005 | proposal 台账的记录身份：record id 带 `:status` 后缀、只按精确 root 或 record id 查、每次转移只写一条确定性 decision | `:88-101`（§2.3）、`:225`（D1）、`:226`（D2）、`:228`（D4） | 持久化格式，历史 `proposals.jsonl` / `decisions.jsonl` 依赖它；「id 为什么带后缀」「为什么不支持前缀查找」都会让读者意外；D2 是行为变更（裸前缀从返回最后一条变为报 `ambiguous`） | 默认接受（SKIL-43） |
| 0006 | 维护用例住在 core，CLI 与 bundle 是薄 adapter；evaluation artifact 由 core 写盘 | `:49-69`（§2.1，B facade、C dispatcher 被否）、`:71-86`（§2.2，B「adapter 写」被否）、`:231`（D7） | 边界决策；「core 摸文件系统」看着像违反分层，实际是为了让「必须落 evaluation 文件」这条不变量不能在两个 adapter 间漂移 | 默认接受（SKIL-43） |
| 0007 | 锁只承诺同主机、本地文件系统；`held` 与 `foreign` 锁永不自动回收 | `unified-lock-protocol.md:124-144`（§2.3 判定表）、`:353`（§3.5 否掉租约 + 心跳）、`:385`（D3）、`:386`（D4） | 这是代码里看不出来的约束；D3 收窄了原 issue 的「超时能回收」，后人会想加回超时；将来要支持网络文件系统就得换判活方式，是整体迁移 | D3 默认接受（SKIL-46），D4 设计稿自定 |
| 0008 | 锁文件用 tmp + `link()` 原子创建，owner 记录 v1，靠 `uptimeMs` 判断重启 | `:88-115`（§2.2，B `open('wx')`、C `mkdir` 被否）、`:139`（为什么不用墙上时钟）、`:379`（F1） | 锁文件格式要和旧版进程双向兼容，改起来贵；「为什么不直接 `open('wx')`」「为什么不比 `createdAt`」都会让读者意外；C 被否是因为旧版进程会拿到 `EISDIR` | 设计稿自定（F1），合并即接受 |
| 0009 | agent 工作流拆成 tracker / runtime / instance 三条 seam，依赖方向固定为 skill → runtime → tracker、skill → instance | `skil-36-seams.md:31-51`（§3）、`:221`（D-3） | 方向一旦反过来，换 adapter 和改 skill 会互相牵动；7-B、7-C 是真实备选 | 明确（SKIL-39，D-3） |
| 0010 | tracker adapter 的 10 个 `##` 标题是引用契约 | `:177-194`、`:219`（D-1） | skill 按标题名引用，改名要改所有引用，装到别的仓库的旧副本也不会跟着改 | 明确（SKIL-39，D-1） |
| 0011 | setup 模板与 `docs/agents/` 安装副本逐字节相同；实例事实只放 `docs/agents/instance.md` | `:112-124`（6-B、6-C 被否）、`:220`（D-2）、`:224`（D-6） | 这是 setup 的输出契约；「为什么不在副本末尾加一节覆盖」看起来更省事，被否的理由（没法用一条 `diff` 验证）不写下来就会被再提一次 | 明确（SKIL-39，D-2/D-6） |
| 0012 | 提问对象解析：触发评论作者是 member 时用作者；否则用拍板人 = 工作区 owner，按 `user_id` 解析；都不从 issue 的 `creator_id` / `assignee_id` 取 | `:84-91`、`:222`（D-4） | 这是 wakeup 能不能触发的唯一依据；从 creator / assignee 取看起来最自然，但那两个字段常常是 agent，wakeup 会静默永不触发 | 明确（SKIL-39，D-4） |
| 0013 | 权威规则放在仓库文档里，不做成 skill；前提是引用它的 run 都检出了本仓库 | `:171-175`（7-D 被否）、`:223`（D-5） | 前提一旦不成立就要整体改成 skill 化；「skill 从 skill 库加载、不依赖检出」是一个有力的反方论点，被否的理由需要留下来 | 明确（SKIL-39，D-5） |

每条 ADR 按 `ADR-FORMAT.md` 写：1–3 句正文，加 `status` frontmatter，被否选项值得记的写 `Considered Options`，末尾一行链回设计稿的对应章节。ADR 里不抄复现输出、判定表细节、测试矩阵。

### 1.2 留在原处、不迁 ADR 的

| 来源 | 内容 | 为什么不是 ADR |
|---|---|---|
| `evolution-state-root.md:183-187`、`:268`（C-1 / A4） | cursor 只有一个写入者 | 设计稿自己标为可逆的实现收敛（`:271`）。「只删 `:149` 会丢派生记录」这类陷阱属于实现契约，已写进 `specs/evolution-state-root/design.md:70` |
| `evolution-state-root.md:241-251`（§6） | 5 个 module 的迁移步骤 | 已完成的一次性计划 |
| `maintenance-use-cases-proposal-ledger.md:114-122`、`:229`（D5） | 引号感知的 tokenizer | 修 bug，容易回退，没有真实取舍 |
| 同上 `:227`（D3）、`:230`（D6） | evaluation 默认路径；candidate 目录键 | D3 被 ADR-0001 的布局吸收；D6 是**未决**的遗留问题（`state-root.ts:72` 仍用 `proposalId` 作为目录键），应该建 issue 跟踪，不该写成 ADR |
| 同上 `:232`（D8） | core 导出只做加法 | 显而易见，没有备选 |
| `unified-lock-protocol.md:60-86`（§2.1） | 作用域式 `withLock` 还是句柄式 | 可逆（`:83` 自述） |
| 同上 `:151-178`（回收守卫三层协议） | 守卫、目录锁、正确性论证 | 全在 `locking.ts` 内部，F5 自述文件名可以改；正确性论证是实现文档，留在设计稿，`locking.ts` 注释指向它就够了 |
| 同上 `:383`、`:384`（D1、D2） | `unknownGraceMs` = 10 分钟；删除旧导出 | D1 是可调默认值；D2 已执行完，没什么需要以后的人理解 |
| 同上 `:380`（F2） | 锁文件位置不变 | 被 ADR-0001 的布局吸收 |
| 四份稿的 §1 现状 / 复现、选项表、测试矩阵 | 证据与分析 | 历史证据，留在设计稿；issue 和 PR 都链接着这些章节 |

### 1.3 `docs/design` 之外的候选（见 Q2）

下面三条比上面的都更基础，只是不在 `docs/design/` 里。建议一起迁，编号接在后面：

| ADR | 标题 | 来源 |
|---|---|---|
| 0014 | core 包不依赖 DSH 内部，DSH 集成只放 adapter / bundle | `AGENTS.md:14`；`maintenance-use-cases-proposal-ledger.md:231`（D7）与 `unified-lock-protocol.md:381`（F3）都拿它做红线 |
| 0015 | Evolution 是独立能力，不把质量分、灰度或生命周期写进 Skill Registry 的 provider rank | `docs/architecture-design-zh.md:9-27`、`:624`（不变量 8） |
| 0016 | 事实 append-only，派生判断必须引用 observation id、允许修正，禁止把归因写回事实 | `docs/architecture-design-zh.md:29-38`、`:617-618`（不变量 1、2） |

## 2. `CONTEXT.md` 草案

### 2.1 单 context，不需要 `CONTEXT-MAP.md`

领域只有一个：DSH Skill 演化（`packages/` 三个包共用同一套词）。`dsh-adapter` 和 `dsh-bundle` 是 adapter，不是另一个 context，它们用的就是 core 的词（Observation、Proposal 等）。

agent 工作流的词（tracker / runtime / instance seam、stage、one-shot run、拍板人）是另一套词汇，但它们已经有权威落点 `docs/agents/*`（ADR-0009），而且消费者是 skill，不是产品代码。所以**不**为它们单开第二个 context，也不写进 `CONTEXT.md`（Q4）。

### 2.2 草案

出处写在每条后面的括号里，执行时删掉括号。标 ⚠ 的是术语冲突，默认处理见 Q5。

```md
# DSH Skill Evolution

从 Skill 的运行时事实中积累证据，诊断失败，提出、评估并显式发布 Skill 的修改；运行闭环只记录事实，维护闭环在事后做判断和发布。

## 事实

**Observation**:
运行时发生的一条不可变事实，例如 Skill 可见、加载、工具返回、用户跟进、任务结束。
_Avoid_: event, 事件
（types.ts:23 RuntimeObservation；architecture §3.2）⚠1

**Observation log**:
一个 Skill root 的全部 Observation 按写入顺序构成的逻辑事实流，由当前文件和它的全部 Archive segment 组成。
_Avoid_: event store, events 文件
（state-root.ts:103 ObservationLog；ADR-0002）

**Archive segment**:
轮转后移出当前文件、仍属于 Observation log 的只读段。
_Avoid_: 备份, 历史日志
（evolution-state-root.md §2；state-root.ts:202）

**Rotation**:
把当前文件整体变成一个 Archive segment，Observation log 的内容不变。
_Avoid_: truncate, 清理
（ADR-0002）

**Retention**:
显式删除过期 Archive segment，因此会缩短 Observation log。
_Avoid_: rotation（两者不是一回事）
（retention.ts:4；ADR-0002）

**Fact record**:
只追加、不修改的权威记录；Observation、Ledger record、Decision record 都属于这一类。
_Avoid_: raw data
（state-root.ts:51-55 role 'fact'；architecture §1.2）

**Derived record**:
可以从 Observation log 完整重建的判断：Experience、Failure case、Failure cluster、Diagnosis。
_Avoid_: cache, 结论
（state-root.ts role 'derived'；architecture §1.2）

**Projection**:
从 Observation log 确定性地重建全部 Derived record 的过程。
_Avoid_: sync, 刷新
（evolution-state-root.md §1.2；service.ts:385 refreshDerived）

**Exposure view**:
一个 Skill 在一次 session 里「可见 → 请求加载 → 加载成功/失败」的三段证据；它不是成功率。
_Avoid_: usage rate, 成功率
（projection.ts:4；architecture §6.1）

## 经验与诊断

**Experience**:
从 Observation 压缩出来的局部经验片段，保留上下文和证据 Observation 的 id；它不是 Skill。
_Avoid_: lesson, memory, 经验总结
（types.ts:83；mechanism §2.1、§5.2）

**Attribution**:
把一个结果归到某类原因（routing、content、tool 等）的判断；属于派生，可以修正。
_Avoid_: blame
（types.ts:73；architecture §6.2）

**Failure case**:
一次能定位到某个 Skill 的失败，引用证据 Observation。
_Avoid_: error, incident
（types.ts:99 SkillFailureCase）

**Failure cluster**:
同一个 Skill 下签名相同的 Failure case 的集合。
_Avoid_: group, bucket
（types.ts:112）

**Diagnosis**:
对一个 Failure cluster 的根因假设，附建议的 proposal operation。
_Avoid_: analysis
（types.ts:133）

## Proposal 与台账

**Proposal**:
针对一个 Skill 的一次候选修改，绑定 Base，沿 Transition table 走完生命周期。
_Avoid_: candidate, change request, PR
（types.ts:149）⚠6

**Candidate content**:
Proposal 携带的候选 Skill 正文；隔离存放，Promote 之前不可见。
_Avoid_: draft
（lifecycle.ts:25、:66）⚠6

**Base**:
Proposal 所针对的那一版 Skill 内容；Skill 当前内容已不是 Base 时，Proposal 过期（stale）。
_Avoid_: parent version, original
（types.ts:49 AdoptionBase；architecture 不变量 5）

**Proposal root**:
一个 Proposal 在所有状态记录之间共享的逻辑身份。
_Avoid_: proposal id 前缀
（proposal.ts:66 proposalRootId；ADR-0005）

**Ledger record**:
Proposal 在某个状态下追加的一条记录，身份由 Proposal root、该状态和进入该状态的次数组成；第一次进入省略次数后缀。
_Avoid_: proposal version
（proposal.ts:58 LedgerRecordStatus；ADR-0021）

**Proposal ledger**:
全部 Ledger record 构成的 append-only 历史；Proposal 的最新状态从它推出。
_Avoid_: proposal 表
（maintenance-use-cases-proposal-ledger.md §3.1）

**Transition table**:
Proposal 状态之间唯一合法的转移集合。
_Avoid_: guard list
（proposal.ts:24；ADR-0004）

**Decision record**:
对 Proposal 或 Skill 生命周期所做的一次决定的持久记录，rejected、deferred、rolled-back 也要保留。
_Avoid_: audit log
（types.ts:261；architecture 不变量 9）

## 评估与发布

**Evaluation**:
在一组 Evaluation case 上对 Base 与 Candidate content 的反事实比较；它不是总分。
_Avoid_: score, benchmark
（types.ts:194；mechanism §6；architecture §11）

**Evaluation case**:
参与比较的一个用例，分为 original-failure、historical-success、boundary 三类。
_Avoid_: test
（types.ts:171）

**Evaluation artifact**:
一次 Evaluation 的持久结果，只对它所评估的那个 Proposal、Base 和 Candidate content 有效；是 Promote 的前置证据。
_Avoid_: report
（types.ts:219；ADR-0006）

**Gate**:
评估策略给出的通过门槛；没过 Gate 的 Proposal 不能 Promote。
_Avoid_: threshold score
（types.ts:208 passedGate、:234 EvaluationPolicy）

**Accept**:
决策者同意采用一个 Proposal；它不表示已经发布，也不表示已经证明有收益。
_Avoid_: approve, merge
（architecture:341）

**Promote**:
把一个已 Accept 的 Proposal 的 Candidate content 发布为 Skill 的新版本，并指定 Publication scope。
_Avoid_: adopt, 采用, deploy
（lifecycle.ts:76；operations.ts:158）⚠2

**Rollback**:
把 Skill 的当前版本恢复到先前一个已发布版本。
_Avoid_: revert
（lifecycle.ts:154；operations.ts:169）⚠3

**Publication scope**:
Promote 之后新版本在哪个范围生效：explicit-only、project、user、stable。
_Avoid_: target, channel, 灰度
（types.ts:301；architecture §4.2）⚠4

**Next load**:
新版本只在下一次加载边界生效，已经加载进模型的正文不会被热替换。
_Avoid_: hot reload
（types.ts AdoptionCandidate.effectiveAt；architecture:369、不变量 7）

**Skill version**:
一个 Skill 已发布的正文快照；current 指向其中之一。
（lifecycle.ts:26 SkillVersionStore；architecture §4.3）

## 库与范围

**Skill root**:
一组 Skill 所在的目录，也是它们演化状态的归属单位。
_Avoid_: state root, workspace
（state-root.ts:48 resolveLayout 的 root）⚠5

**State directory**:
Skill root 下保存演化状态的目录。
_Avoid_: state root, 状态根目录
（state-root.ts:28 stateDir）⚠5

**Portfolio**:
一个 Skill root 下全部 Skill 作为整体的维护视图：重叠、上下文成本、休眠与退役候选。
_Avoid_: catalog, registry
（portfolio.ts:19；mechanism §8、Phase 5）

**Lifecycle state**:
Skill 在 Portfolio 里所处的阶段：draft、observed、canary、stable、dormant、retired。
_Avoid_: status（留给 Proposal）
（types.ts:277 ArtifactLifecycleState；mechanism §8.4）⚠4

**Provider rank**:
DSH 在同名 Skill 的多个来源之间做选择的优先级；它不承担质量、灰度或生命周期判断。
_Avoid_: quality score, priority
（architecture §1.1、不变量 8；ADR-0015）

**Runtime loop**:
会话内同步发生、只追加 Observation、从不阻塞当前任务的那一侧。
（mechanism §9；architecture §1.3、不变量 10）

**Maintenance loop**:
事后运行的那一侧：Projection、诊断、Proposal、Evaluation、Promote。
_Avoid_: background job
（mechanism §9；architecture §7.1）

**Maintenance operation**:
由人或 worker 显式触发的一次维护动作（propose、evaluate、review、promote、rollback）。
_Avoid_: command（command 只指 CLI / slash 命令这层 adapter）
（operations.ts；architecture §2.5）
```

### 2.3 术语冲突（⚠ 编号，默认处理见 Q5）

1. **observation vs event**：代码里是 `JsonlEventStore`（`store.ts:17`），bundle 的文件叫 `events.jsonl`（`index.js:123`）。
2. **promote vs adopt / 采用**：`docs/architecture-design-zh.md` 大量用「采用」和 `AdoptionRequest`，类型名里有 `AdoptionBase`、`AdoptionCandidate`，观察类型里有 `adoption-applied`；动作和 CLI 叫 `promote`。
3. **rollback / rolled-back / reverted**：`ProposalStatus` 里的 `reverted` 在转移表中既没有入边也没有出边（`proposal.ts:24-37`），只有 metrics 在兼容地数它（`metrics.ts:63`）。
4. **同一个词多重含义**：`draft`、`observed` 同时是 ProposalStatus 和 Lifecycle state；`stable` 同时是 Lifecycle state 和 Publication scope。
5. **state root**：设计稿叫「演化状态根目录」，代码里分成 `root`（Skill root）和 `stateDir`（`.skill-evolution`）。issue 标题里的「state root」两者都可能指。
6. **candidate vs proposal**：代码里 `candidate` 指候选正文或候选目录（`candidates/<proposalId>`），设计稿有时拿它指整个 Proposal。

### 2.4 不进 `CONTEXT.md` 的内容

- **文件与格式**：`.skill-evolution/` 的目录结构、JSONL、文件名、归档命名、record id 的具体拼法。目录结构写在 `docs/architecture-design-zh.md` §4.3；格式写在 spec 和 ADR。
- **实现机制**：projection cursor、fingerprint、`StoreDescriptor`、锁协议（token、`uptimeMs`、reclaim guard、sweep）、错误码、CLI flag、tokenizer。它们是实现细节，最多留在 spec 或 ADR 里。
- **通用编程概念**：adapter、seam、module、lock、retry。
- **agent 工作流词汇**：tracker / runtime / instance、stage、one-shot run、拍板人，这些归 `docs/agents/*`。
- **论文和调研概念**：留在 `research/` 与 `docs/research-landscape-zh.md`，没有进入代码的不收。

## 3. `specs/` 与 `docs/design/` 的分工与去重

### 3.1 各自的职责

| 文档 | 回答什么 | 谁写 | 生命周期 |
|---|---|---|---|
| `docs/adr/NNNN-*.md` | 定了什么、为什么、否掉了什么 | Architect（见 3.4） | 长期有效；改主意时写新 ADR，旧的标 `superseded by` |
| `CONTEXT.md` | 词是什么意思 | 谁定下术语谁写 | 长期有效，随用随改 |
| `docs/design/<slug>.md` | 现状证据、选项分析、推荐：一份**提案** | Architect | 合并后冻结，不再跟着代码更新 |
| `specs/<slug>/` | 这次改动要实现什么（EARS 需求）、实现契约（接口、数据流、错误处理、测试策略）、任务 | Spec Writer | 任务全部完成后冻结，作为变更记录 |
| `docs/architecture-design-zh.md`、各包 README | 系统**现在**是什么样 | 实现票顺带更新 | 长期有效，跟代码同步 |

### 3.2 只允许出现在一处的内容

| 内容 | 唯一位置 | 其他地方怎么写 |
|---|---|---|
| 决策、理由、被否选项 | ADR | 写「见 ADR-0004」，不复述决策表 |
| 术语定义 | `CONTEXT.md` | 直接使用这个词，不再定义一遍 |
| 复现、证据、选项比较 | `docs/design/` | spec 需要时写「背景见 `docs/design/x.md` §1」 |
| 公开接口签名、行为契约 | spec 的 `design.md`，之后以代码为准 | 设计稿里的是**草图**，标明「以 spec 为准」 |
| 验收标准、任务 | `tasks.md` | — |
| agent 工作流规则 | `docs/agents/*`、`skills/*` | 按 ADR-0009 的依赖方向引用 |

### 3.3 引用方向

```text
spec ──▶ ADR、CONTEXT.md
spec ──▶ docs/design（只作背景，不作规范）
ADR  ──▶ docs/design（链回被否选项的原文）
docs/design、ADR ──✕──▶ spec（spec 是一次性变更记录，长期文档不依赖它）
```

据此要改的现有措辞：`specs/skil-46-unified-lock-protocol/design.md:3` 称设计稿「normative」，`specs/skil-36-seams/design.md:3` 写「implements the merged design」且 `:9` 复述 D-1…D-6。这些都改成引用 ADR。

### 3.4 已合并设计稿的去向

建议**原地保留，文件头加一个状态块**，不移进 `archive/`，也不删减：

```md
> 状态：已实现（SKIL-38 → SKIL-61…69）。决策见 ADR-0001、0002、0003；实现契约见 `specs/evolution-state-root/`。
> 本文是历史提案，不随代码更新；与现状不一致时以代码、ADR 和 spec 为准。
```

理由：issue 评论、PR 描述、spec 都按路径和章节号链接着这些稿，挪位置会让链接全部失效；证据和复现也没有别的地方放。去重靠「以谁为准」来解决，不靠删文字。

四份 spec 的 `design.md`：把复述的决策表换成 ADR 引用（`specs/maintenance-use-cases-proposal-ledger/design.md:11-21`、`specs/skil-46-unified-lock-protocol/design.md:5-14`、`specs/evolution-state-root/design.md:5`、`specs/skil-36-seams/design.md:9`）。接口与数据流保留，它们本来就属于 spec。

### 3.5 流程的最小改动

| 位置 | 改动 | 在不在仓库里 |
|---|---|---|
| Architect instructions「设计模式」第 3、6 步 | 不可逆决策在设计 PR 里同时写成 `docs/adr/NNNN-*.md`，`status: proposed`；成员确认后在**同一个 PR** 改成 `accepted` 再合并。设计稿的「不可逆决策」一节只列 ADR 编号和一句话，不再单独维护一张大表 | 否，Mika 预览、成员确认后用 `multica agent update` 改 |
| Spec Writer instructions「`design.md`」条 | 决策写「见 ADR-NNNN」，不复述、不称设计稿为 normative；spec 里出现新术语时，在同一个 PR 更新 `CONTEXT.md` | 否，同上 |
| `skills/orchestrate/SKILL.md:83` | `child.md` 的「上游产物」加一项：相关 ADR 编号 | 是 |
| `skills/delivery-contract/SKILL.md` 「评审契约」 | 加一条：PR 引入的不可逆决策有没有对应 ADR；与已有 ADR 冲突时，有没有按 `docs/agents/domain.md` 的「Flag ADR conflicts」显式标出来 | 是 |
| `docs/agents/domain.md:15` | 删掉「Neither exists yet」 | 是 |

`to-spec`、`domain-modeling`、`grilling` 这些通用 skill 不改：它们已经在读 `CONTEXT.md` 和 ADR（`to-spec/SKILL.md:12`、`grilling/SKILL.md:30`），文件一旦存在就会自动生效。

ADR 编号冲突（两个设计 PR 并行，都取了下一个号）：先合并的保留编号，后合并的 PR 在合并前改号，Reviewer 检查（Q8）。

## 4. 执行拆分

按 `orchestrate` 路由表「skill 或文档修改 → Scribe」，分两个 stage：

| Stage | 票 | 内容 | 依赖 |
|---|---|---|---|
| 1 | A：建 ADR | 按 §1.1（加上 Q2 采纳后的 §1.3）新建 `docs/adr/0001…`，每条带 `status`、确认来源和回链；给 D6（candidate 目录键）另开一张跟踪 issue | — |
| 1 | B：建 `CONTEXT.md` | 按 §2.2 草案和 Q5 的裁定写根目录 `CONTEXT.md`，删掉出处括号 | 与 A 并行（B 里的 ADR 编号引用以 §1 表为准） |
| 2 | C：去重 | 四份设计稿加状态块；四份 spec `design.md` 的决策表换成 ADR 引用、删掉「normative」措辞；`docs/architecture-design-zh.md` §1、§4.1、§10 加 ADR 引用；`docs/agents/domain.md:15` | A、B 合并后 |
| 2 | D：流程 | `orchestrate:83`、`delivery-contract` 评审契约；Architect / Spec Writer instructions 由 Mika 出预览、成员确认后更新 | A 合并后；与 C 并行（改的文件不重叠） |

验收可以机械检查：`ls docs/adr | wc -l` 等于采纳的条数；`grep -n 'normative' specs/*/design.md` 无输出（`requirements.md` 里的 normative 说的是默认值属于 spec 本身，例如 `specs/skil-46-unified-lock-protocol/requirements.md:59` 的 R14、`specs/skil-36-seams/requirements.md:3`，保留）；`grep -c '^> 状态：' docs/design/*.md` 每个文件都是 1；`CONTEXT.md` 里没有 `.jsonl`、`.lock`、`cursor` 字样。

## 5. 需要成员拍板的决策点

**已确认**：ack7 于 2026-09-27 在 SKIL-76 回复「默认」，Q1–Q10 全部按默认答案执行。

| # | 问题 | 默认答案 |
|---|---|---|
| Q1 | §1.1 的 13 条 ADR 是否全部迁移？ADR-0003 按「难以逆转」一条最勉强（理由见表内），单独问：留还是降为 spec 里的实现契约？ | 全部迁移，0003 保留 |
| Q2 | §1.3 的三条（core 不依赖 DSH、不扩张 Registry、事实与派生分离）是否也写成 ADR 0014–0016？ | 写，放在票 A 里 |
| Q3 | 你没有明确回复过的决策（台账 D1–D9 → ADR 0004–0006；锁 D3、F1 → ADR 0007–0008；state-root A5 → ADR 0003），ADR 状态写成什么？ | `accepted`，正文注明「设计 PR 合并即接受默认答案」 |
| Q4 | 单 context，agent 工作流词汇留在 `docs/agents/*`、不进 `CONTEXT.md`？ | 是，不建 `CONTEXT-MAP.md` |
| Q5 | §2.3 的术语冲突怎么定？ | ① 用 Observation，代码和文件名不改名（数据路径要兼容）；② 动作叫 Promote，Adoption 只留在现有类型名里，新文档不再用「采用」指发布；③ 只定义 Rollback，`reverted` 在 `CONTEXT.md` 里标成遗留状态，另开票决定删不删；④ 用「Proposal status / Lifecycle state / Publication scope」加限定词区分，不改代码；⑤ 用 Skill root 和 State directory，弃用「state root / 状态根目录」；⑥ Proposal 指整件事，Candidate content 只指候选正文 |
| Q6 | 已合并的设计稿怎么处理？ | 原地保留，加状态块，不移动也不删减 |
| Q7 | 谁写 ADR？ | Architect 在设计 PR 里写成 `proposed`，你确认后在同一个 PR 改成 `accepted` |
| Q8 | 并行 PR 的 ADR 编号冲突怎么办？ | 后合并的 PR 改号，Reviewer 检查 |
| Q9 | spec 任务做完之后还维护吗？ | 不维护，冻结为变更记录；现状以代码、ADR、`CONTEXT.md` 和架构文档为准 |
| Q10 | 是否按 §3.5 修改 Architect / Spec Writer 的 agent instructions？ | 改。Mika 在票 D 里先贴改动预览，你确认后再更新 |

## 6. SKIL-91 成员规则与平台 skill 同步

`docs/design/skil-91-member-rules.md` 是成员位置盘点和规则入口；不可逆选择记录在 ADR-0017、ADR-0018。平台安装副本仍是独立的运行时缓存，按 ADR-0013 的仓库权威原则由「Skill 同步」autopilot 自动同步，记录票为 SKIL-112。它在 GitHub push 到 `main` 的 webhook 触发，另由每天 08:53 Asia/Shanghai 的兜底运行；模式是 `run_only`，执行者是 Mika。它保留现有 skill id 和 agent 绑定，处理仓库 skill 内容及附属文件的变更。

「Skill 同步」不负责同步平台智能体指令；这仍由 Mika 按 PR 描述里的「Platform agent instruction sync after merge」手动完成。它不删除 skill（`main` 上的删除只报告），也不给新导入的 skill 绑定智能体。Mika 在 SKIL-112 上只在有改动、失败或需要成员决定时留言；无改动不留言。webhook 投递丢失时，最迟由次日 08:53 的兜底运行补上；两次 refresh 后仍不一致时，在 SKIL-112 上 @ 成员。

以下手动命令只在 autopilot 失败时作为备用办法，不能替代自动同步：

1. 在包含已合并 `main` 的检出目录运行 `multica skill list --output json`，按 `config.origin.path` 找到 `skills/orchestrate` 和 `skills/delivery-contract` 对应的 skill id。
2. 首选保留现有 id 和 agent 绑定的整包同步：`multica skill refresh <orchestrate-id>`、`multica skill refresh <delivery-contract-id>`。
3. 若只需定点同步或 `refresh` 不可用，分别执行 `multica skill update <id> --content-file skills/<name>/SKILL.md`；含附属文件的 orchestrate 再执行 `multica skill files upsert <id> --path PATROL.md --content-file skills/orchestrate/PATROL.md`。不要用 `skill import` 新建第二份同名 skill。
4. 用 `multica skill get <id> --with-content --output json` 复核：`.content` 与仓库 `SKILL.md` 相同，orchestrate 的 `PATROL.md` 也相同；平台副本不再含旧 owner 硬编码。
5. 成员确认 `docs/design/skil-91-member-rules.md` 的 Triager 原文 → 新文预览后，由 Mika 用 `multica agent update` 应用 agent instruction；本票不直接改平台 agent。
