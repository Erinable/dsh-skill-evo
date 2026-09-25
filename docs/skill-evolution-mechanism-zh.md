# Skill Evolution 机制设计：从交互经验到可维护程序性知识

> 设计版本：2026-09-25
>
> 本文基于 Voyager、Reflexion、CRITIC、EXIF、AlignEvoSkill、AutoSkill、SkillHone、SkillEvo、MASkills、Library Drift 和 SkillsBench 等工作，重新思考适合 DSH 的完整 Skill evolution 机制。目标是形成能够在开放任务流中持续工作的系统，而不是在固定题库上反复改写提示词。

## 1. 先定义问题：Skill evolution 到底在进化什么

一个 Agent 的行为由多个因素共同决定：

```text
任务与用户意图
+ 当前上下文和历史记忆
+ 被检索并加载的 Skill
+ 模型自身能力
+ 工具与环境状态
+ 运行时编排和执行结果
```

因此，一次任务成功或失败不能直接说明 Skill 好或坏。Skill evolution 要解决的不是：

> “怎样让模型从失败中总结一段更长的文字？”

而是：

> “怎样从多次交互中识别可迁移的程序性规律，把它编译成适用范围明确的 Skill，并通过后续任务判断这条规律是否真的改善了行为？”

这里的核心对象是 **可复用、可触发、可执行、可解释、可维护的程序性知识**。它必须同时回答：

- 什么任务下适用？
- 需要什么前置条件？
- 应该按什么顺序做什么？
- 哪些判断决定分支？
- 如何知道当前步骤已经完成？
- 失败时如何恢复或停止？
- 什么情况下不要使用它？

缺少这些信息的内容，更接近事实记忆、一次性上下文或失败笔记，不应直接成为 Skill。

## 2. 从论文中提炼出的六个基本事实

### 2.1 经验可以改善后续行为，但经验本身不是 Skill

Reflexion 把奖励和测试反馈转成语言反思，Voyager 把成功的代码操作保存为可检索技能，AutoSkill 把重复的用户要求抽取为显式 Skill。这些工作共同说明，交互经验可以成为长期能力的来源。

但一次经验通常只描述：

```text
在某个任务、某个状态、某个模型和某组工具下，发生了什么。
```

Skill 需要进一步抽象：

```text
在什么条件下，哪些步骤通常有效，如何判断适用，如何处理例外。
```

所以系统必须保留两种不同对象：

- **Experience**：不可随意泛化的事件记录，保留上下文和证据；
- **Skill**：从多个 Experience 中抽象出来的、可独立加载的程序性知识。

Skill 不能替代 Experience。没有原始经验，未来无法重新判断一条规则是否过时或过度泛化。

### 2.2 失败不是统一信号，必须先做归因

CRITIC 说明外部检查比纯内省更可靠，Trial and Error、Agent-Pro 和 SkillEvo 都说明失败可以用来改进策略，但失败的原因可能不同：

- Skill 没有被 catalog 描述正确，导致漏触发；
- Skill 进入 catalog，但模型没有加载；
- Skill 被加载，但正文缺少关键步骤；
- Skill 步骤正确，但模型没有遵循；
- 工具、权限、依赖或环境状态导致失败；
- 用户目标在执行过程中发生改变；
- 评测或用户反馈本身不完整。

只有“可以由 Skill 内容、Skill 描述、Skill 边界或 Skill 组合修复”的失败，才应进入 Skill evolution。其余失败需要留在诊断系统中，不能污染 Skill。

### 2.3 Skill 的价值是条件性的，不是全局属性

SkillsBench 显示，同一个 Skill 在不同任务和领域上的收益差异很大，部分任务甚至出现负收益；AutoSkill 和 Contextual Experience Replay 也说明经验必须依赖上下文。Skill 不是一个永远为正的插件，而是一个条件策略：

```text
如果 context 满足 preconditions，
并且任务属于 applicability，
则按 procedure 执行；
否则 ignore 或转交其他 Skill。
```

因此 Skill 的评估单位不能只是 Skill 名称，还必须包含：任务簇、触发条件、上下文、工具组合和版本。

### 2.4 多轮交互提供比单轮评分更好的演化梯度

SkillEvo 指出，单轮问答只能暴露第一层缺陷，后续追问会继续暴露隐藏的知识缺口。对 DSH 来说，这不意味着必须构造用户模拟器，而是要观察真实会话的后续行为：用户是否继续纠正、要求重做、补充前置条件或改变问题。

真正有价值的反馈往往不是“最终失败”，而是：

```text
哪一步引发了纠正？
哪个前置条件没有被识别？
用户补充了什么信息？
工具结果在哪一步偏离预期？
后续任务是否重复出现同一问题？
```

### 2.5 长期进化的主要风险是库的退化，而不是修改次数不足

Library Drift 说明 Skill 过度积累会造成检索稀释、重复技能和无效注入；MASkills 将 refinement、induction、consolidation 和 pruning 作为并列操作。长期系统必须允许：

```text
新增、修改、合并、拆分、降权、暂停、归档、恢复、淘汰
```

“Skill 数量增长”不是学习目标。目标是让有效的程序性知识更容易被正确发现和执行。

### 2.6 最终制品之外必须保留决策历史

SkillHone 的关键贡献不是某种特殊的编辑 prompt，而是持久化：

```text
诊断 → 候选修改 → 使用的证据 → 接受/拒绝 → 后续结果
```

如果只保存最新的 `SKILL.md`，未来的演化代理无法知道：

- 为什么加入这条规则；
- 哪些案例支持它；
- 哪个候选曾经失败；
- 哪个范围曾经被证明不适用；
- 某次回退是因为内容问题还是任务分布变化。

决策历史是 Skill 的长期维护记忆。

## 3. 完整机制的总体结构

适合 DSH 的系统应分为五个平面：

```text
┌──────────────────────────────────────────────┐
│ 运行平面 Runtime                             │
│ catalog → load → execute → observe           │
└──────────────────────┬───────────────────────┘
                       │ events
┌──────────────────────▼───────────────────────┐
│ 证据平面 Evidence                             │
│ trajectory fragments → outcomes → attribution │
└──────────────────────┬───────────────────────┘
                       │ cases
┌──────────────────────▼───────────────────────┐
│ 编译平面 Compiler                             │
│ cluster → diagnose → propose → compare        │
└──────────────────────┬───────────────────────┘
                       │ decisions
┌──────────────────────▼───────────────────────┐
│ 版本平面 Lifecycle                            │
│ draft → observed → canary → stable → retired  │
└──────────────────────┬───────────────────────┘
                       │ history
┌──────────────────────▼───────────────────────┐
│ 记忆平面 Decision History                     │
│ reasons, evidence, rejected patches, outcomes │
└──────────────────────────────────────────────┘
```

这五个平面不应全部塞进 `SkillProvider`：

- Runtime 由 DSH 现有 Skill registry、filesystem provider、catalog loader 承担；
- Evidence 订阅 session、agent、tool、filesystem 事件；
- Compiler 通过 workflow/subagent 运行；
- Lifecycle 维护候选、版本和发布指针；
- Decision History 使用 JSONL 或 SQLite 持久化。

## 3.1 DSH 适配时必须保留的现实约束

论文中的闭环通常拥有 oracle、可重置环境、稳定任务分布和密集反馈。DSH 的真实会话不一定具备这些条件，因此以下判断不能被系统偷偷假设：

- 原始用户任务和工具状态通常不可重放；practice case 只能作为可选验证来源，不能成为所有候选的必经门槛；
- 用户后续反馈可能延迟、缺失或改变目标；没有反馈只能标记为 unknown，不能转成成功；
- 任务前后使用不同模型、工具版本或项目状态时，结果不能直接做因果比较；
- 多个 Skill 同时出现时，不能把整项任务的结果平均分配给所有 Skill；
- DSH registry 的 `rank` 只负责同名候选来源的解析优先级，不表示 Skill 质量，也不提供 canary 分流；
- filesystem provider 的 `invalidate` 只会让后续 catalog/discovery 重新观察文件，当前会话已经加载到模型上下文中的旧正文不会被替换；新版本必须明确从哪个加载时点生效。

因此，本机制允许三种证据状态：

```text
observed-support     观察到支持性证据，但没有反事实对照
locally-verified     有局部测试、用户明确纠正或可重复检查支持
comparatively-shown  在条件接近的旧版/候选版对照中观察到差异
```

只有最后一种才适合使用“相对改善”这样的因果措辞；前两种应保留证据来源和不确定性。


`SKILL.md` 仍然是可移植的载体，但 evolution 层需要一个比正文更结构化的旁车元数据。推荐把 Skill 表示成：

```ts
interface SkillArtifact {
  identity: {
    name: string
    version: string
    parentVersion?: string
    contentHash: string
  }
  routing: {
    description: string
    whenToUse?: string
    taskPatterns: string[]
    prerequisites: string[]
    exclusions: string[]
  }
  procedure: {
    steps: string[]
    decisionPoints: string[]
    completionSignals: string[]
    recoveryPatterns: string[]
  }
  dependencies: {
    tools: string[]
    resources: string[]
    relatedSkills: string[]
  }
  evidence: {
    supportingCaseIds: string[]
    contradictingCaseIds: string[]
    lastObservedAt?: string
  }
  lifecycle: {
    state: 'draft' | 'observed' | 'canary' | 'stable' | 'dormant' | 'retired'
    owner: 'human' | 'evolution-agent' | 'mixed'
  }
}
```

这不是要求把所有字段写进 Skill 正文。正文负责模型可读的程序性知识；旁车元数据负责演化系统查询、归因和生命周期管理。

Skill 还需要表达三种边界：

- **适用边界**：什么任务和上下文适用；
- **不适用边界**：看起来相似但不应使用的任务；
- **完成边界**：什么时候步骤已经完成，什么时候应该停止或交还给用户。

没有边界的 Skill 会不断扩大触发范围，最后变成泛化的提示词集合。

## 5. 经验如何变成 Skill：一个受约束的编译过程

### 5.1 采集原始事件

每个 DSH 会话应产生事件，但事件只描述事实，不直接给奖励：

```ts
interface SkillRuntimeEvent {
  id: string
  sessionId: string
  taskId?: string
  taskContext: string
  skillName?: string
  skillVersion?: string
  stage: 'catalogue' | 'load' | 'step' | 'tool' | 'follow-up' | 'finish'
  payload: Record<string, unknown>
  timestamp: string
}
```

特别要区分四个状态：

```text
catalogued: Skill 出现在可见 catalog
loaded:     模型实际读取正文
used:       后续行为引用了 Skill 中的步骤
helped:     有证据表明行为因此得到改善
```

前两个是 DSH 运行时事实，后两个需要归因，不能从日志字段直接推断。

### 5.2 从事件压缩成 Experience

完整轨迹过大、噪声太多，不能直接放入 Skill。Experience 应是一个带证据的局部片段：

```ts
interface Experience {
  id: string
  taskCluster: string
  contextSummary: string
  relevantSkillVersions: string[]
  observedPattern: string
  evidenceEventIds: string[]
  outcome: 'helpful' | 'harmful' | 'neutral' | 'unknown'
  attribution: 'routing' | 'content' | 'composition' | 'model' | 'tool' | 'task-change' | 'unknown'
  confidence: number
  createdAt: string
}
```

Experience 的目标是表达“发生了什么以及为什么可能重要”，而不是总结一段漂亮的经验。

### 5.3 形成问题簇

问题簇按以下维度聚合：

```text
Skill identity/version
× task cluster
× failure pattern
× affected step
× tool/context conditions
```

语义相似不足以直接合并。两个失败都提到“没有完成”，可能一个是 Skill 没有识别前置条件，另一个是工具不可用。问题簇应同时使用事件位置、工具结果、用户后续行为和任务上下文。

### 5.4 做可修复性判断

每个问题簇先输出一个诊断：

```ts
interface SkillDiagnosis {
  clusterId: string
  rootCause: 'routing' | 'content' | 'boundary' | 'reference' | 'composition' | 'not-skill' | 'uncertain'
  hypothesis: string
  supportingExperiences: string[]
  counterEvidence: string[]
  proposedOperation: 'edit-metadata' | 'patch-content' | 'split' | 'merge' | 'retire' | 'observe-only'
  confidence: 'low' | 'medium' | 'high'
}
```

`not-skill` 和 `uncertain` 是必要状态。没有它们，系统会把所有失败都强制转换成 Skill 修改。

### 5.5 生成候选，而不是直接修改

候选是一个有边界的变更对象：

```ts
interface SkillProposal {
  id: string
  skillName: string
  baseVersion: string
  intent: string
  diff: string
  changedSurfaces: Array<'description' | 'trigger' | 'procedure' | 'reference' | 'composition'>
  addressedExperienceIds: string[]
  expectedChange: string
  knownRisks: string[]
  comparisonCases: string[]
  status: 'draft' | 'replayed' | 'observed' | 'accepted' | 'rejected'
}
```

生成器必须遵循“最小充分修改”：只修改能解释问题的部分；不把完整轨迹复制进正文；不顺便重写无关章节；不把一次性用户偏好升级为全局规则。

## 6. 如何评估候选：不是总分，而是反事实比较

候选评估的核心问题不是“新版本得了多少分”，而是：

> 在证据允许的范围内，如果仍使用旧版本，结果是否有理由不同？候选版本具体改变了哪一部分行为？

真实 DSH 任务不可重放时，不应伪造反事实。此时优先采用用户明确的局部纠正、工具返回的局部事实、可检查的产物差异或后续相似任务中的支持性证据；只有环境、工具和输入足够稳定且重放成本合理时，才运行旧版/候选版/无 Skill 的局部对照。

理想情况下，每个候选都需要三组证据：

```text
触发案例：候选声称要修复的问题
相邻案例：任务相似但未触发问题的案例
反例案例：候选不应改变行为的案例
```

对开放任务，无法总是得到完整反事实，因此使用多种证据组合：

- 同一任务的旧版/候选版重放；
- 同类任务的时间切分比较；
- 用户纠正和返工是否减少；
- 可观察产物是否更符合要求；
- 工具调用步骤是否减少或更稳定；
- 人工对候选差异做成对判断；
- 后续任务是否出现同一问题复发。

结果需要拆开记录：

```ts
interface ProposalComparison {
  proposalId: string
  caseId: string
  exposure: 'old' | 'candidate' | 'not-run'
  observedOutcome: 'improved' | 'regressed' | 'unchanged' | 'unknown'
  evidence: string[]
  confidence: 'low' | 'medium' | 'high'
}
```

不要把所有证据提前压成一个 reward。Evolution Service 可以根据当前决策需要计算摘要，但原始比较必须保留。

## 7. 运行时 Skill 选择也属于 evolution

许多研究只优化 Skill 正文，但 DSH 的实际收益首先取决于能否正确发现和加载。Skill evolution 至少包含三个可分别诊断的函数：

```text
Discovery(task, catalog)  → candidate skills
Loading(candidate)        → skill content
Execution(task, content)  → behavior/outcome
```

对应的失败类型不同：

| 现象 | 更可能的进化对象 |
|---|---|
| 任务适合 Skill，但 catalog 没有它 | description、whenToUse、provider 可见性 |
| catalog 有 Skill，但模型没有加载 | 触发描述、catalog 文案、模型路由 |
| Skill 被加载，但步骤被忽略 | 正文结构、步骤顺序、示例、完成信号 |
| 多个 Skill 同时加载造成混乱 | 适用边界、互斥关系、组合策略 |
| Skill 正确但任务仍失败 | 模型能力、工具、环境或任务变化 |

因此，Skill 的 `impact` 不能只记录“成功/失败”，应至少记录：

```text
missed-discovery
loaded-not-followed
procedure-gap
wrong-scope
composition-conflict
non-skill-failure
unknown
```

## 8. Skill 库如何长期演化

### 8.1 增长：只有重复且可迁移的模式才创建 Skill

一个候选模式进入 Skill 库至少需要满足：

- 在多个相似任务中出现；
- 具有明确的触发条件；
- 能描述出可复用步骤或决策规则；
- 与现有 Skill 的边界可区分；
- 有至少一种可观察的完成信号。

单次经验应停留在 Experience 或 practice case。

### 8.2 合并：合并的是行为边界，不只是相似文本

两个 Skill 文本相似，不代表应该合并；两个 Skill 文本不同，也可能共享同一程序骨架。合并前要比较：

- 触发条件是否相同；
- 前置条件是否兼容；
- 步骤是否互相补充；
- 失败恢复是否冲突；
- 未来任务是否通常一起出现。

合并后的 Skill 必须保留来源 Skill 和决策历史，不能只生成一份新文本。

### 8.3 拆分：当一个 Skill 的内部路由开始承担多个任务簇

拆分信号包括：

- 不同任务簇需要不同前置条件；
- Skill 被加载但只有部分章节被使用；
- 修改一个任务簇时经常破坏另一个任务簇；
- catalog 描述无法同时准确表达多个适用范围；
- Skill 正文已经需要大量“如果不是某类任务则跳过”。

拆分的目标是提升发现和局部修改能力，而不是增加 Skill 数量。

### 8.4 退出：用结果和证据管理生命周期

Skill 可以进入 dormant 或 retired 的原因包括：

- 长期没有被加载；
- 被加载但在相关任务中没有可观察影响；
- 反复与用户后续纠正同时出现；
- 内容已经被另一个 Skill 覆盖；
- 依赖的工具或工作流不再存在；
- 它的适用范围无法清楚表达。

低频 Skill 不应因为没有足够样本就直接删除。低频更适合 `dormant`，保留以便显式调用和未来重新观察。

## 9. 两个闭环，而不是一个闭环

完整系统需要两个相互连接但不能混淆的循环。

### 运行闭环

```text
任务 → catalog → load → execute → user/tool outcome
```

它追求当前任务的完成和可观察反馈。

### 维护闭环

```text
observations → experiences → clusters → diagnosis
→ proposal → comparison → decision history → next observation
```

它追求长期 Skill 质量和可维护性。

运行闭环中的每次失败都不应直接进入维护闭环；必须经过压缩和归因。维护闭环产生的 candidate 也不应直接改变运行闭环；必须经过观察式发布或明确接受。

## 10. DSH 的最小实现路线

### Phase 1：事件和证据

实现四类持久记录：

- `SkillRuntimeEvent`：catalog、load、tool、follow-up、finish；
- `Experience`：带证据的局部行为模式；
- `SkillDiagnosis`：Skill 归因和可修复性判断；
- `DecisionHistory`：候选、证据、接受/拒绝和后续结果。

这一阶段不自动修改 Skill，只验证能否从一次真实会话重建：

```text
哪个 Skill 可见 → 是否加载 → 发生了什么 → 后续反馈是什么 → 能否归因
```

### Phase 2：可选的局部实践案例

从确认过的问题簇生成 practice case，但只在原始输入、工具和状态足够稳定时尝试重放。不可重放的真实任务仍可作为经验和人工审阅材料；不能因为没有 replay 就丢弃明确的用户纠正，也不能把合成 probe 的结果写成真实收益。按时间窗口区分 recent、stable 和 triggering cases，但这些案例是辅助证据，不是统一的在线 benchmark。

### Phase 3：候选比较和局部采用

实现旧版/候选版的相对回放；若无法回放，则使用局部检查、用户明确修复要求或后续相似任务的支持性证据。候选默认进入 `observed` 或 `needs-observation`，不覆盖 stable 版本。版本采用范围必须明确为当前项目、当前用户、显式调用或后续新会话；catalog 刷新不会替换当前上下文中已经加载的正文。

### Phase 4：真实使用观察

对候选进行显式加载或小范围 canary，记录 exposure、影响和后续用户反馈。候选经过多个相关任务支持后，才进入 stable。证据不足则保持 `needs-observation`。

### Phase 5：Skill portfolio 管理

加入 Skill 的合并、拆分、dormant、retired 和恢复流程。维护 catalog 描述、Skill 关系和决策历史，观察目录规模、加载成本和重复程度。

## 11. 哪些论文方法应如何使用

| 论文/方向 | 应吸收的机制 | 不应直接照搬的部分 |
|---|---|---|
| Voyager | 可执行技能、成功后库化、检索复用 | 把一次环境成功当成通用 Skill |
| Reflexion | 失败到语言经验的轻量转换 | 把模型自评直接写入永久 Skill |
| CRITIC | 外部检查和可验证反馈 | 让同一个生成器兼任唯一评审 |
| EXIF | 探索、反馈、技能发现的闭环 | 把封闭环境任务直接当作开放 DSH 任务 |
| AlignEvoSkill | 知识缺口和任务对齐联合考虑 | 只用知识覆盖分数决定发布 |
| AutoSkill | 交互经验到显式 Skill 的生命周期 | 把一次用户偏好自动升级为长期规则 |
| SkillHone | 持久化诊断、证据和拒绝记录 | 假设所有 DSH 任务都有可隐藏的验证集 |
| SkillEvo | 多轮反馈、问题分层、归因 | 用模拟用户代替真实使用反馈 |
| MASkills | refinement、induction、consolidation、pruning | 用统一 scalar credit 给多个 Skill 分配功劳 |
| Library Drift | 贡献诊断、退出和有限活跃集合 | 把固定容量直接作为 DSH 的万能策略 |
| SkillsBench | 任务分布差异、Skill 负收益、聚焦模块 | 把 benchmark 平均增益当成线上收益 |

## 12. 最终定义

对 DSH 而言，Skill evolution 可以定义为：

> 在不修改基础模型参数的前提下，从真实 Agent 交互中积累带上下文的 Experience，经过可修复性归因和跨案例抽象，生成边界明确的程序性 Skill；再根据可获得的局部验证、可选的实践案例、旧版对照和真实使用反馈，不断修订其触发条件、步骤、依赖、组合关系和生命周期，同时保留完整的决策历史。

这个定义包含五个不可删掉的条件：

1. **交互来源**：Skill 必须能从实际任务中获得新的证据；
2. **可迁移抽象**：Experience 只有在多个任务中显示稳定规律，才升级为 Skill；
3. **可修复归因**：只有属于 Skill 的问题，才进入 Skill 修改；
4. **相对验证**：候选必须与旧版本和相关实践案例比较；
5. **生命周期治理**：Skill 可以被修改、合并、拆分、暂停和退出，且保留原因。

最重要的研究问题不是“能否自动生成更多 Skill”，而是：

> 在开放、稀疏、延迟和带偏的真实反馈下，如何可靠地把一次性交互经验编译成可复用、可归因、可维护的程序性知识。
