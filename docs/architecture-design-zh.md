# DSH Skill Evolution 落地架构

> 设计版本：2026-09-25
>
> 本文把 [Skill Evolution 机制设计](./skill-evolution-mechanism-zh.md) 落成 DSH 的工程架构。目标是定义可实现的包边界、事实事件、持久化记录、候选生命周期和运行时生效规则。本文暂不实现代码，也不把外部安全问题作为设计前提。

## 1. 架构决策

### 1.1 Evolution 是独立能力，不扩张 Skill Registry

现有 `dsh-skill` 负责：

- 注册和合并 Skill provider；
- 按 `cwd` 和 `scope` 发现可见 Skill；
- 按 provider rank 解析同名候选；
- 加载 Skill 正文；
- 在 provider 变化时失效 catalog 缓存。

`dsh-skill-evolution` 负责：

- 记录 Skill 的可见、加载和运行时关联事实；
- 保存 Experience、诊断、候选和决策历史；
- 组织局部验证或人工审阅；
- 管理候选状态和版本关系；
- 在明确的采用动作发生后通知已有 filesystem provider 刷新后续发现。

Evolution 不把质量分、成功率或生命周期状态加入 `SkillRegistry` 的解析决策。Registry 的 rank 仍然只是同名来源优先级，不能被复用为 Skill 质量分、灰度比例或 canary 路由。

### 1.2 事实事件和派生判断分开

系统分两类数据：

```text
事实：catalog 中出现了 Skill、skill tool 被调用、文件读取完成、工具返回了结果。
派生：Skill 可能被采用、用户纠正与某步骤相关、候选解决了某问题。
```

事实事件 append-only 保存，不覆盖历史。派生判断必须带来源事件 ID、判断者、时间和置信状态，允许后续被修正。禁止把模型生成的归因写回事实事件。

### 1.3 默认异步，绝不阻塞当前任务

当前会话只产生运行时观察，不同步执行聚类、改写或发布。Evolution worker 在会话结束后或独立维护命令中运行：

```text
agent request
  └─ synchronous: normal skill discovery/loading/execution
      └─ append observation events

maintenance worker
  └─ derive experiences
      └─ cluster and diagnose
          └─ create proposal
              └─ optional local verification/review
                  └─ explicit adoption
```

一次会话中新版本不会替换模型已经看到的旧 Skill 正文。采用版本只影响后续明确的加载边界。

### 1.4 先记录和人工确认，再自动生成

第一阶段不自动编辑生产 Skill。系统先证明能够回答：

```text
哪个 Skill 对哪个 session 可见？
哪个 Skill 实际被加载？
加载的是哪个文件内容？
后续发生了哪些相关事件？
哪些反馈可以定位到 Skill？
```

只有当这条观察链稳定后，才启用 proposal 生成。Proposal 生成、验证、采用必须是三个不同动作。

## 2. 组件和责任

```text
┌──────────────────────────────────────────────────────┐
│ DSH Runtime                                          │
│ dsh-skill registry / filesystem provider / tool-skill│
└───────────────┬──────────────────────────────────────┘
                │ observation adapter
┌───────────────▼──────────────────────────────────────┐
│ dsh-skill-evolution                                  │
│ Observation Collector → Event Store                  │
│ Evidence Projector → Experience Store                │
│ Diagnosis/Proposal API → Decision Store              │
│ Adoption Coordinator                                  │
└───────────────┬──────────────────────────────────────┘
                │ maintenance commands/workflow
┌───────────────▼──────────────────────────────────────┐
│ Evolution Worker                                      │
│ cluster → diagnose → propose → verify → review       │
└───────────────┬──────────────────────────────────────┘
                │ explicit filesystem/version update
┌───────────────▼──────────────────────────────────────┐
│ Skill roots and future discovery                      │
│ stable / observed / dormant / retired                │
└──────────────────────────────────────────────────────┘
```

### 2.1 Observation Collector

职责：监听已有运行时扩展点，把已经发生的事实转换为统一事件。

不负责：判断 Skill 是否有用、调用模型做归因、修改 Skill 文件。

它需要观察的逻辑事件如下：

| 逻辑事件 | 事实内容 | 典型来源 |
|---|---|---|
| `catalog-visible` | 当前 agent/scope 可见的 Skill 摘要、provider、来源和 catalog revision | Skill catalog 消费者或显式 snapshot |
| `skill-load-requested` | 请求加载的 Skill 名称、调用方和会话 | `skill` tool / user invocation |
| `skill-loaded` | 实际加载成功的版本快照、内容 hash、path/provider | Skill loader 返回值和文件快照 |
| `skill-load-failed` | 名称、失败阶段和错误摘要 | loader/tool 失败 |
| `agent-step` | 当前步骤的 session、agent、消息和关联 Skill load IDs | agent/session 事件适配器 |
| `tool-result` | 工具调用摘要、结果状态、关联步骤 | tool/session 事件适配器 |
| `user-follow-up` | 后续纠正、重试、追加约束或目标变化 | 用户消息与 session 适配器 |
| `task-finished` | 任务结束、取消、继续或未知状态 | session lifecycle 适配器 |
| `skill-file-observed` | Skill 文件发生变化及内容 hash | filesystem provider 观察路径 |
| `adoption-applied` | 明确采用哪个版本、作用域和生效边界 | Evolution adoption API |

这些是架构中的逻辑事件名，不要求第一版修改 DSH 核心事件协议。适配器可以从现有 session/tool 事件和 `ctx.skills` 的读结果派生；如果某个事实无法可靠获得，就写入 `unknown`，不能猜测。

### 2.2 Event Store

第一版使用独立 JSONL 文件，不写入已发布 Session JSONL。原因：

- Evolution 事件会持续追加，生命周期不同于会话日志；
- 研究字段会迭代，不应让每次实验都改变 Session 格式；
- 派生判断和人工标注不应污染原始会话事实；
- 可以按项目目录、用户目录或显式配置选择存储位置。

建议路径：

```text
<dsh-evolution-home>/
├── events/2026-09.jsonl
├── projections/experiences.jsonl
├── decisions/decisions.jsonl
├── proposals/<proposal-id>/
│   ├── proposal.json
│   ├── patch.diff
│   └── evidence.jsonl
└── indexes/state.json
```

JSONL 是事实传输和审计格式；SQLite 可以在事件量和查询复杂度达到需要时作为派生索引，不取代 JSONL 原始记录。第一版不引入向量数据库，不把 embedding 检索作为架构前提。

### 2.3 Evidence Projector

职责：从原始事件构造 Experience 和 Practice Case 的派生视图。

它不修改原始事件，只允许：

- 合并同一 session 的相关事件；
- 截取与 Skill 相关的局部窗口；
- 计算 catalog → load → follow-up 的暴露链；
- 记录用户反馈和工具结果的引用；
- 标注 `unknown`、`not-attributable` 或待人工确认。

### 2.4 Diagnosis/Proposal API

职责：提供给人工界面、workflow 或 subagent 的显式操作：

```ts
interface SkillEvolutionService {
  appendObservation(event: RuntimeObservation): Promise<void>
  listObservations(query?: ObservationQuery): Promise<RuntimeObservation[]>
  projectExperience(input: ExperienceProjectionInput): Promise<Experience>
  diagnose(input: DiagnosisInput): Promise<SkillDiagnosis>
  createProposal(input: ProposalInput): Promise<SkillProposal>
  recordComparison(input: ProposalComparison): Promise<void>
  decideProposal(input: ProposalDecision): Promise<void>
  adopt(input: AdoptionRequest): Promise<AdoptionResult>
  listHistory(query?: HistoryQuery): Promise<DecisionRecord[]>
}
```

这些方法分别代表记录、推导、诊断、生成、比较、决策和采用，不提供一个 `evolve()` 方法把所有步骤隐式串起来。

### 2.5 Maintenance operations and adapter boundary

维护行为由 `dsh-skill-evolution` core 的 operations seam 提供：
`proposeSkillChange`、`evaluateProposal`、`reviewProposal`、
`promoteProposal` 和 `rollbackSkill` 接收已经解析的选项并返回结构化结果。
CLI 和 DSH bundle 都只是 adapter：负责解析命令参数、创建当前 root 的
`EvolutionService`、调用同一个 operation，以及渲染成功或带类型错误的结果。
core 不反向依赖 DSH 或 bundle，因而 proposal 查找、状态转换、评估 artifact
校验和发布前检查不会在两个入口中分叉。

每个状态变化只通过 `PROPOSAL_TRANSITIONS` 这一张 authoritative transition
table 校验，并写入一个确定性的
`decision:transition:<root>:<to>:<updatedAt>` 记录。metrics 从这些
transition decisions 统计 promoted、rejected 和 rolled-back；历史 action
records 仍可读取。

### 2.6 Adoption Coordinator

职责：执行显式采用动作，验证采用范围和版本关系，写入 `adoption-applied`，然后请求已有 provider 对后续发现重新观察。

它不直接把候选注册成高优先级 provider，也不修改当前模型上下文。采用至少需要：

- proposal 状态为 `accepted`；
- base version 仍然是当前采用目标的祖先或明确处理冲突；
- Skill 文件/目录结构检查通过；
- 作用域明确，并且只能是 `explicit-only`、`project`、`user` 或 `stable`；
- 写入新版本快照并保留父版本；
- 记录实际生效时间点和下一次加载边界。

## 3. 事实数据模型

### 3.1 SkillRef

运行时和存储层都使用不可变引用，不使用只有名称的字符串作为版本证据：

```ts
interface SkillRef {
  name: string
  provider: string
  source: string
  path?: string
  version?: string
  contentHash?: string
  resourceHash?: string
}
```

现有 filesystem Skill 没有 manifest version 时，第一版使用文件内容 hash 加载时间构成事实快照；不要把 hash 伪装成语义版本。未来 manifest 提供 version 后，二者同时记录。

### 3.2 RuntimeObservation

```ts
interface RuntimeObservation {
  id: string
  schemaVersion: 1
  kind:
    | 'catalog-visible'
    | 'skill-load-requested'
    | 'skill-loaded'
    | 'skill-load-failed'
    | 'agent-step'
    | 'tool-result'
    | 'user-follow-up'
    | 'task-finished'
    | 'skill-file-observed'
    | 'adoption-applied'
  occurredAt: string
  sessionId?: string
  taskId?: string
  agentId?: string
  scope?: string
  cwd?: string
  skill?: SkillRef
  correlationIds: string[]
  payload: Record<string, unknown>
  source: 'runtime' | 'filesystem' | 'user' | 'maintenance'
}
```

`payload` 只允许保存与演化有关的摘要和引用。原始完整消息、敏感内容和大工具结果由既有 session/工具存储负责；Evolution 事件保存 source ID、摘要、hash 和必要的局部片段，避免复制整条会话。

### 3.3 Experience

```ts
interface Experience {
  id: string
  schemaVersion: 1
  skillRefs: SkillRef[]
  taskCluster?: string
  sessionIds: string[]
  observationIds: string[]
  pattern: string
  outcome: 'helpful' | 'harmful' | 'neutral' | 'unknown'
  attribution:
    | 'routing'
    | 'content'
    | 'boundary'
    | 'composition'
    | 'model-following'
    | 'tool-or-environment'
    | 'task-change'
    | 'not-attributable'
    | 'uncertain'
  evidenceState: 'observed-support' | 'locally-verified' | 'comparatively-shown'
  confidence: 'low' | 'medium' | 'high'
  createdAt: string
  reviewedAt?: string
}
```

多个 Experience 不能仅凭 embedding 相似自动合并。合并必须保留原始 Experience IDs，并记录聚类方法和人工修订。

### 3.4 DecisionRecord

```ts
interface DecisionRecord {
  id: string
  proposalId?: string
  skillName: string
  baseRef?: SkillRef
  diagnosis?: string
  hypothesis?: string
  evidenceIds: string[]
  rejectedAlternatives?: string[]
  decision: 'accepted' | 'rejected' | 'deferred' | 'needs-observation'
  decidedBy: 'human' | 'workflow' | 'evolution-agent'
  decidedAt: string
  resultRef?: string
}
```

DecisionRecord 是长期维护的核心，不允许只保存最终 patch。被拒绝和暂缓的 proposal 也必须写入。

## 4. 候选和版本生命周期

### 4.1 Proposal 状态

```text
draft
  → proposed | replayed | observed | rejected | deferred
proposed
  → evaluating | rejected | deferred
evaluating
  → evaluated | rejected | deferred
evaluated
  → accepted | rejected | deferred
replayed
  → observed | evaluated | accepted | rejected | deferred
observed
  → evaluated | accepted | rejected | deferred
accepted
  → promoted | rejected
promoted
  → rolled-back
rejected
  → observed
deferred
  → observed | rejected
```

上表就是唯一的状态机定义；实现中的 `canTransition`、`assertCanTransition`
和 `transitionProposal` 都从这张表派生。`accepted` 表示决策者同意采用，
不表示线上已经证明收益；`promoted` 表示版本已经发布，`rolled-back` 表示
已恢复到先前版本。每次成功转换写入一个确定性的 transition decision，
重复写入同一记录不会制造第二条 decision。

### 4.2 版本和作用域

第一版不依赖新的 registry rank 实现灰度。推荐采用以下显式作用域：

```text
explicit-only  只能由人工/维护命令显式加载
project         当前项目后续加载生效
user            当前用户范围后续加载生效
stable          进入默认发现路径
```

候选采用必须写明：

```ts
interface AdoptionRequest {
  proposalId: string
  target: 'explicit-only' | 'project' | 'user' | 'stable'
  effectiveAt: 'next-load' | string
  expectedBase: SkillRef
  reason: string
}
```

`next-load` 是第一版默认值。当前 session 已加载的 Skill 不被热替换；后续 session 或新的显式 load 才能看到更新。

### 4.3 文件布局

保持普通 Skill 目录可用，Evolution 状态集中在 root 下的 `.skill-evolution/`：

```text
.dsh/skills/api-debugging/
├── SKILL.md                 # 当前默认正文
├── manifest.json            # 可选的人工维护元数据
└── versions/
    ├── <content-hash>/SKILL.md
    └── <content-hash>/manifest.json

<root>/.skill-evolution/
├── observations.jsonl       # 原始事实；archive/ 下的分段同样属于事实
├── archive/                 # observations.jsonl 的归档分段
├── proposals.jsonl
├── decisions.jsonl
├── feedback.jsonl
├── evaluations.jsonl
├── experiences.jsonl         # 派生视图
├── failures.jsonl
├── clusters.jsonl
├── diagnoses.jsonl
├── proposals/<id>/           # 隔离候选与报告
├── evaluations/              # 评估 artifact
├── candidates/<id>/           # 待发布 Skill 候选
├── locks/                    # JSONL 与发布锁
└── projection-cursor.json
```

Observation store 可以通过显式 `--store` 或 adapter 配置放在用户级 DSH home，archive 始终紧邻对应 store；集中目录只描述默认布局。生成候选时写入隔离目录，采用时才复制或切换到正式路径。retention 默认关闭，只有显式提供保留天数时才删除旧 archive；被删除的 archive 不再参与 repair 或 cursor 重建，无法恢复其中的事实。

## 5. 运行时生效语义

### 5.1 一次请求内

```text
request begins
  → catalog snapshot is observed
  → model calls skill loader
  → loader returns immutable content snapshot
  → later file changes do not mutate this loaded content
  → request ends with observations
```

加载返回值应携带 `SkillRef` 或等价的 content hash，便于后续把工具结果和用户反馈绑定到实际正文版本。

### 5.2 文件变化

filesystem provider 的 watcher 或 first-party mutation path 触发 invalidate 后：

1. registry 丢弃或刷新后续发现缓存；
2. 下一次 catalog snapshot 重新读取 Skill；
3. 新的 `skill` tool 调用加载新内容；
4. 当前模型已看到的旧 `<skill_content>` 不被替换；
5. Evolution 记录 `skill-file-observed` 和后续新版本的 `skill-loaded`。

### 5.3 并发编辑

采用前必须比较 `expectedBase.contentHash` 与当前文件快照：

- 相同：可以应用候选；
- 不同且候选修改区域不重叠：进入显式 merge/review；
- 不同且无法判断：拒绝自动采用，生成冲突记录。

不得静默覆盖用户刚刚编辑的 Skill。

## 6. 观察链和归因流程

### 6.1 三段暴露漏斗

系统至少生成以下派生视图：

```text
visible_count
  → load_requested_count
    → load_succeeded_count
      → related_follow_up_count
```

这只是暴露漏斗，不是成功率。它不能证明 Skill 被模型遵循，也不能证明 Skill 产生了收益。

### 6.2 局部归因

归因 worker 为一个反馈片段寻找最小关联范围：

1. 找到最近的 Skill load 和对应 content hash；
2. 找到之后的相关 agent step/tool result；
3. 对照用户纠正或产物变化；
4. 判断问题更像 routing、content、boundary、composition、model-following、tool/environment 或 task-change；
5. 证据不足时写 `uncertain`。

一个任务中多个 Skill 同时出现时，记录集合关联：

```text
skillRefs = [skill-a@hash-a, skill-b@hash-b]
relation = overlapping | complementary | conflicting | unknown
```

不要把一个任务结果均摊给所有 Skill。

### 6.3 明确用户教导

用户明确要求未来始终采用某种项目规则、输出格式或操作流程时，可以形成高价值 Experience；但仍需确定作用域：

```text
current-turn < current-task < project < user < global
```

没有明确范围时，默认只作用于当前任务或当前项目候选，不升级为用户/全局 Skill。

## 7. Worker 和命令接口

### 7.1 Worker 分层

```text
collector       运行时写入事实事件
projector       事件 → Experience / exposure views
clusterer       Experience → problem clusters
 diagnostician  cluster → attribution and repairability
proposer        diagnosis → candidate patch
checker         candidate → local evidence
reviewer        evidence → decision proposal
adopter         accepted proposal → scoped version update
curator         periodic merge/split/dormant/retired review
```

这些可以先作为一个 workflow 中的阶段，不要求拆成八个常驻服务或八个 Agent。模块化的目的是隔离输入输出和决策责任。

### 7.2 推荐维护命令

第一版只需要内部或开发者命令，不放进普通模型工具 catalog：

```text
dsh-skill-evolution observe --root <project>
dsh-skill-evolution propose --root <project> --skill <name> --base-file SKILL.md --candidate-file candidate.md --proposed-version 1.1.0 --intent "Add timeout diagnosis"
dsh-skill-evolution evaluate --root <project> --proposal <id> --cases cases.json
dsh-skill-evolution accept --root <project> --proposal <id> --reason "Reviewed evaluation"
dsh-skill-evolution promote --root <project> --proposal <id> --scope project --dry-run
dsh-skill-evolution promote --root <project> --proposal <id> --scope project
dsh-skill-evolution rollback --root <project> --skill <name> --version 1.0.0
```

`evaluate` 默认把 artifact 写到
`.skill-evolution/evaluations/<proposal-root>.json`；`promote` 不指定
`--evaluation` 时选择该 root 的最新未过期 artifact。可用 scope 只有
`explicit-only`、`project`、`user` 和 `stable`。DSH bundle 以同样的参数
映射调用上述 core operations，例如先 `propose`、`evaluate`、`accept`，再
执行一次 `promote --dry-run`，最后执行真实 `promote`。

命令的每一步都应产生 DecisionRecord 或操作日志。不能提供一个无审计的 `--auto-evolve` 直接覆盖生产 Skill。

## 8. 推荐代码包拆分

遵循 DSH capability seam 的 Service Definition / Provider / Consumer 结构，建议最终拆分为：

```text
packages/skill/evolution/
├── src/types.ts             # 只有公共类型
├── src/events.ts            # 事件构造和 schema
├── src/store.ts             # JSONL append/read，后续可加 SQLite index
├── src/projection.ts        # 事件到 Experience 和 exposure view
├── src/diagnosis.ts         # 归因和问题簇接口
├── src/proposal.ts          # 候选 patch 和状态转换
├── src/adoption.ts          # expectedBase、scope、生效边界
└── src/index.ts             # Service Definition / plugin wiring

packages/skill/evolution-filesystem/
└── src/index.ts             # evolution store 和版本目录 provider

packages/skill/evolution-workflow/
└── src/index.ts             # projector/cluster/proposal/check workflow

packages/skill/tool-evolution/
└── src/index.ts             # 仅维护者显式调用，不默认进入模型 catalog
```

第一批不要实现完整自动 Designer。只实现 `types`、`events`、`store`、`projection` 和 `adoption`，让真实事件链先跑通。

## 9. 分阶段实施和验收

### Phase 1：观察底座

实现：

- `RuntimeObservation` JSONL schema；
- SkillRef 的 content hash；
- catalog/load/file observation 适配；
- 按 session、task、Skill 和时间查询；
- append-only 写入和幂等 event ID。

验收：从一次真实会话重建 catalog 可见、Skill load 请求、实际正文版本和后续工具/用户事件；无法得到的字段明确为 unknown。

### Phase 2：Experience 和人工归因

实现：

- Experience projection；
- exposure funnel；
- `not-attributable` 和 `uncertain`；
- 人工确认问题簇；
- DecisionRecord。

验收：可以区分“没发现”“没加载”“加载后没遵循”“内容遗漏”和“非 Skill 问题”，且不需要自动修改文件。

### Phase 3：局部候选

实现：

- proposal 目录和 parent hash；
- 最小 diff 生成；
- 可选的局部命令/测试/人工检查；
- accepted/rejected/deferred 状态；
- 冲突检测。

验收：候选不会覆盖生产 Skill；同一 proposal 可以追溯到 diagnosis、Experience 和原始事件。

### Phase 4：显式采用

实现：

- `explicit-only` 和 `project` scope；
- expectedBase 检查；
- next-load 生效语义；
- adoption event 和 provider invalidate；
- 版本恢复。

验收：采用后新加载能看到候选，当前已加载内容不变，冲突不会静默覆盖人工编辑。

### Phase 5：长期维护

实现：

- 合并、拆分、dormant、retired、restore；
- 重叠描述和引用分析；
- 维护成本和上下文成本观察；
- 基于真实使用证据的 curator workflow。

验收：Skill 库可以减少重复和无效内容，且每次整理都有决策历史，不以 Skill 数量增长为成功标准。

## 10. 关键不变量

1. Evolution 不能修改已产生的原始 observation。
2. 派生归因必须引用 observation ID，并允许后续修正。
3. 没有 Skill load 事实时，不能声称 Skill 内容导致了结果。
4. 没有可比条件时，不能声称候选带来因果收益。
5. proposal 必须绑定明确 base content hash。
6. 采用不能静默覆盖并发编辑。
7. 当前模型已经加载的 Skill 内容不会被 invalidate 热替换。
8. registry rank 不承担质量、灰度或生命周期决策。
9. rejected、deferred 和 reverted 都必须保留在 Decision History。
10. 运行时观察不得阻塞当前用户任务。
11. 一次任务的结果不能默认均摊给同时出现的多个 Skill。
12. 低调用率只能产生观察信号，不能单独触发删除。

## 11. 第一版不做什么

- 不修改模型权重；
- 不自动覆盖 stable Skill；
- 不改变 agent loop 主流程；
- 不把 Evolution 状态加入 registry provider rank；
- 不要求所有任务都有固定测试集或可重放环境；
- 不把每次失败自动变成 Experience；
- 不提供单一总分作为 Skill 质量真相；
- 不在普通模型 catalog 中暴露维护命令；
- 不引入向量数据库、复杂因果模型或强制 canary 基础设施；
- 不删除原始事件、旧版本或拒绝记录。

## 12. 推荐第一批代码任务

1. 在 `packages/skill/evolution/src/types.ts` 定义 `SkillRef`、`RuntimeObservation`、`Experience` 和 `DecisionRecord`。
2. 在 `packages/skill/evolution/src/events.ts` 实现事件 ID、schema version 和 content hash 绑定。
3. 在 `packages/skill/evolution/src/store.ts` 实现 append-only JSONL store，支持按 session/Skill/time 查询。
4. 在 `packages/skill/evolution/src/projection.ts` 实现 catalog → load → follow-up 的 exposure view。
5. 在 DSH 组合测试中验证一次真实 Skill 加载能产生完整 observation 链。
6. 暂不接入自动 proposal 和生产采用；先用测试 fixture 或维护命令人工创建 Experience。

完成这六项后，才有足够事实基础决定下一步应优化事件适配、归因质量、候选生成还是版本采用。
