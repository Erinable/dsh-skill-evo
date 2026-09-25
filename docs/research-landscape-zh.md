# 适合 DSH 的 Skill 进化：面向真实使用的研究判断

> 修订日期：2026-09-25
>
> 本文修订上一版研究结论。DSH 的日常使用面对开放任务、任务分布变化、反馈稀疏和模型行为随机性，因此不把固定 benchmark 当作在线评测体系，也暂时不讨论外部安全问题。研究重点是：如何从真实 DSH 会话中识别可归因的 Skill 问题，形成可复用的改进，且不让 Skill 库在长期使用中失控。

## 核心判断

适合 DSH 的 Skill evolution 不是“每次失败后自动改写 `SKILL.md`”，也不是“为所有 Skill 建一套固定测试集”。它更像一个由真实使用驱动的维护循环：

```text
真实会话
  ↓
观察 Skill 是否被发现、加载、遵循和完成任务
  ↓
收集用户纠正、工具结果、测试结果和任务后续信号
  ↓
判断问题是否真的属于 Skill
  ↓
把重复出现的局部问题整理成实践案例
  ↓
生成小范围候选修改或新增 Skill
  ↓
用相关历史案例和新近任务做相对比较
  ↓
保留决策历史，按需发布、合并、暂停或回退
```

这里的“评测”是动态形成的实践证据，不是一个预先声称覆盖所有任务的固定分数体系。固定案例仍然有用，但只能作为某个 Skill 的局部回归记忆，不能代表 DSH 的全部质量。

DSH 最适合研究的对象也不是模型参数，而是 **运行时可加载的外部程序性知识**：Skill 的描述和触发边界、正文中的步骤和判断、引用的资源、与其他 Skill 的关系，以及这些内容在真实任务中的实际作用。

## 为什么上一版的固定评测思路不适合 DSH

上一版把 SWE-bench、ToolSandbox、OSWorld 等研究 benchmark 当成了 DSH 的候选评测体系，这个推导过远。

DSH 的实际任务有几个特点：

- 用户任务通常没有预先定义的标准答案；
- 一次会话可能同时加载多个 Skill，Skill 只是影响因素之一；
- 任务成功经常由工具状态、仓库状态、模型能力和用户临时要求共同决定；
- 用户反馈可能只表现为一句纠正、一次重新提问或继续修改，而不是明确的 pass/fail；
- Skill 的价值可能要在几周后的相似任务中才显现；
- Skill 触发失败、Skill 内容错误和模型没有遵循 Skill 是三种不同问题；
- 任务分布会变化，固定案例很快会变成历史样本，而不是当前现实的完整代表。

因此，DSH 需要记录和比较局部证据，而不是假设存在一个可长期稳定的总分。研究 benchmark 可以用于离线方法比较，不能直接定义 DSH 的产品质量。

## 2026 年研究带来的新方向

### AutoSkill：把重复交互变成可复用行为

[AutoSkill](https://arxiv.org/abs/2603.01145)（2026）把用户反复表达的偏好和要求转化为可编辑、可检索、可版本化的 Skill，并将 Skill 抽取、维护、检索和复用放在同一个生命周期中。它的价值不在于某个固定 benchmark，而在于明确了“交互经验 → 显式行为知识”的转换。

对 DSH 的启示是：只有当某种要求在多个会话或多个任务中表现出稳定性时，才适合提升为 Skill。单次用户要求更像当前任务上下文，不能自动升级成长期规则。

### SkillHone：持久化决策历史比最终制品更重要

[SkillHone](https://arxiv.org/abs/2606.08671)（2026）指出，持续演化不能只保存最新 Skill 文件，还要保存诊断、候选修改、使用过的证据、被拒绝的方案和最终结果。它把后续改进能否理解过去的决策，作为 Skill 长期维护能力的一部分。

这非常适合 DSH。一次失败之后，未来的维护者需要知道：当时 Skill 是否真的加载、模型做了什么、用户纠正了什么、尝试过哪些修改、为什么接受或拒绝。Git diff 本身不包含这些原因。

### SkillEvo：反馈需要来自多轮交互，而不是一次问答分数

[SkillEvo](https://arxiv.org/html/2608.13120)（2026 预印本）强调多轮交互可以逐层暴露单轮问答看不到的问题，并把用户模拟/后续追问从单纯评测终点变成持续反馈来源。它还区分知识缺口、能力限制和评测噪声，避免把所有失败都写回 Skill。

DSH 不需要照搬它的用户模拟体系，但应借鉴两个判断：

1. 任务后续行为比一次最终评分更有信息量；
2. 进化前必须先判断失败能否由 Skill 修复。

### MASkills 和 Library Drift：Skill 库需要归因、合并和退出

[MASkills](https://arxiv.org/abs/2609.02094)（2026）把 Skill 优化拆成 refinement、induction、consolidation 和 pruning，并尝试做 Skill 条件下的 credit assignment。[Library Drift](https://arxiv.org/html/2605.19576v1) 则指出，无限制积累会造成检索稀释和技能库漂移；需要根据实际结果判断某个 Skill 带来帮助、伤害或没有影响。

对 DSH 而言，最重要的不是照搬“固定容量上限”，而是避免把“创建过”误认为“有效”。一个长期没有被加载的 Skill、被加载但没有改变行为的 Skill、反复导致用户纠正的 Skill，都应有不同的生命周期状态。

### SkillsBench：固定 benchmark 的正确用法

[SkillsBench](https://arxiv.org/abs/2602.12670v1)（2026）显示，人工整理的 Skill 平均能带来收益，但不同领域差异很大，也有任务出现负收益；自生成 Skill 平均没有收益，聚焦的少量模块优于全面文档。

这并不意味着 DSH 应在线运行 SkillsBench，而是说明三件事：Skill 的效果高度依赖任务分布；Skill 越长不一定越好；“自动生成了一个看起来合理的 Skill”不是有效性的证据。DSH 应优先做小而具体的 Skill，并观察它在真实任务中的使用和后续影响。

## DSH 的真实进化对象

从 DSH 现有实现看，Skill 有几个清晰的运行时阶段：

1. filesystem provider 从 project、user、custom 等根目录发现 Skill；
2. registry 合并候选并按 scope、rank 和 provider 解析可见 Skill；
3. tool-skill 把摘要写入会话 catalog；
4. 模型通过 `skill` tool 加载正文，或由用户显式调用；
5. provider watcher 发现文件变化并调用 `invalidate`，catalog 在后续步骤刷新。

因此，DSH 的 Skill evolution 不应首先改造 registry。更适合的边界是增加一个独立的演化层，观察这些已经存在的事件：

- Skill 是否出现在当前 session 的 catalog；
- 模型是否调用了该 Skill；
- 实际加载的是哪个 provider、路径和正文版本；
- 加载后发生了哪些工具调用和文件/仓库变化；
- 用户是否继续纠正、重做、撤销或追加要求；
- 任务之后是否产生测试通过、命令成功、代码 diff 或其他可观察结果；
- Skill 文件是否被修改、catalog 是否 invalidate 和刷新。

Registry 继续回答“当前有哪些 Skill、应该加载哪个版本”；Evolution 层回答“这个 Skill 在哪些任务中产生了什么证据、下一次是否值得修改”。

## 适合 DSH 的反馈信号

DSH 不应把所有信号压成一个 `successRate`。建议把反馈分成四类，并保留原始证据：

### 强反馈

可以较有把握地说明行为问题的信号：

- 用户明确说“这一步错了”“应当先做 X”；
- 用户在同一任务中反复纠正同一条规则；
- 工具或命令返回失败，且失败步骤与 Skill 明确要求有关；
- 测试、lint、类型检查或结构化校验失败；
- 用户撤销了 Skill 引导的修改并给出原因；
- 同一类任务中出现相同的可定位遗漏。

### 中等反馈

可以用于积累案例，但不足以单独触发自动修改：

- 用户重新描述了相同要求；
- 模型加载了 Skill 但没有使用关键步骤；
- 用户在结果后继续补充大量手工操作；
- 任务完成了，但成本、步骤数或返工明显增加；
- Skill 被频繁加载，却没有观察到行为差异。

### 弱反馈

只用于检索和分析：

- 模型是否调用了 Skill；
- Skill 被调用的次数；
- 会话持续时间和工具调用数量；
- 用户是否很快结束会话；
- 单次模型自评或单次 LLM judge 分数。

### 反证和缺失反馈

“没有用户抱怨”不能等价于成功。“Skill 没有被调用”也不能等价于无用，因为可能是 catalog 描述、触发词或模型选择出了问题。DSH 应显式记录 `unknown`、`not-observed` 和 `not-attributable`，不要把缺失信号转成正面奖励。

## Skill 归因比任务评分更重要

真实 DSH 任务中，最难的问题不是算分，而是判断 Skill 是否应该承担责任。建议为每次使用记录一个归因结果：

```ts
interface SkillImpactRecord {
  sessionId: string
  taskId?: string
  skillName: string
  skillVersion?: string
  visibility: 'catalogued' | 'loaded' | 'user-invoked'
  impact: 'helped' | 'hurt' | 'neutral' | 'not-attributable' | 'unknown'
  evidence: Array<{
    kind: 'user-correction' | 'tool-result' | 'test-result' | 'follow-up' | 'manual-review'
    summary: string
    sourceId?: string
  }>
  affectedStep?: string
  confidence: 'low' | 'medium' | 'high'
  createdAt: string
}
```

这里的 `impact` 不是模型自己随便填写的标签，而是基于事件和后续行为形成的暂时判断。一个任务失败，可能是：

- Skill 没有被发现；
- Skill 被发现但没有加载；
- Skill 被加载但触发描述不匹配；
- Skill 内容遗漏了步骤；
- 模型没有遵循已有步骤；
- 工具或环境本身失败；
- 用户临时改变了目标。

只有前四类中的部分情况适合进入 Skill 修改；模型能力和外部环境问题应留在诊断记录中。

## DSH 不需要固定评测体系，而需要动态实践集

建议把“评测集”改成三个来源组成的实践集：

### 最近案例

保留最近一段时间真实使用中出现的、与当前 Skill 相关的任务片段。它反映当前任务分布，但容易受短期热点影响。

### 稳定案例

从历史上反复出现、已经确认具有代表性的任务中保留少量案例。它们不是完整 benchmark，而是 Skill 的长期记忆。

### 触发案例

每次确认某个 Skill 问题后，把原始任务压缩成最小可重放案例。候选修改必须先在这些案例上说明自己解决了什么。

这三类案例都应带时间、Skill 版本、任务上下文和证据来源。实践集不是一次性冻结的：新案例进入，过时案例降权，长期无关案例可以归档，失败案例可重新打开。

评测结果也不应只有 pass/fail，至少包括：

- 是否改善触发案例；
- 是否影响最近案例；
- 是否改变 Skill 触发频率；
- 是否引入明显的步骤或 token 成本；
- 是否让用户纠正减少、增加或没有变化；
- 证据是否足以支持这次修改。

这些结果用于候选比较和人工审阅，而不是组成一个永远固定的总分。

## 推荐的进化循环

### 1. 记录，不立即进化

每次会话只记录事实：Skill 的可见性、加载、版本、工具事件、用户后续行为和可观察结果。默认不修改 Skill。

### 2. 建立问题簇

把相似的用户纠正、工具失败和后续返工聚在一起。单个模糊反馈只形成待观察问题；重复出现或证据很强的问题才进入候选生成。

### 3. 先做归因

Evolution Designer 需要输出：问题是否属于 Skill、对应的是触发描述、正文步骤、参考资料还是 Skill 拆分问题。如果归因不确定，保留诊断，不生成自动 patch。

### 4. 生成最小变化

候选修改优先是局部补充、删减、重排或拆分。禁止把完整轨迹倾倒进 `SKILL.md`。候选应说明：解决哪些案例、依赖哪些证据、预期改变什么行为、可能影响哪些已有用法。

### 5. 做相对回放

不要求候选通过一个固定世界的全部测试。只做与本次修改有关的实践集回放：触发案例、相邻历史案例、最近案例和人工挑选的反例。比较新旧版本差异，并保留原始结果。

### 6. 形成决策历史

每次候选都记录 `diagnosis → patch → evidence → decision`。被拒绝的 patch 也要记录，否则下一轮会重复走同一条路。

### 7. 小范围发布和观察

对于证据有限的候选，先进入显式加载或低优先级的观察状态；只有在后续真实任务中再次得到支持，才提升为默认 Skill。DSH 已有 provider rank、scope 和 catalog invalidate，可以承载这种分层发布，而不必把所有候选都放入默认 catalog。

### 8. 合并、拆分和退出

Skill 长期无加载、无明显影响、与另一个 Skill 高度重叠或持续导致纠正时，应进入 `dormant`、`merged` 或 `retired` 状态。Skill evolution 的结果不只是 Skill 越来越多，也包括变短、合并和退出。

## 推荐数据模型

```ts
interface SkillUseObservation {
  id: string
  sessionId: string
  taskId?: string
  skillName: string
  skillVersion?: string
  catalogued: boolean
  loaded: boolean
  invokedBy: 'model' | 'user' | 'none'
  taskContext: string
  toolEventIds: string[]
  followUpEventIds: string[]
  outcome: 'completed' | 'corrected' | 'abandoned' | 'unknown'
  createdAt: string
}

interface SkillPracticeCase {
  id: string
  skillName: string
  sourceObservationIds: string[]
  taskPattern: string
  initialContext: string
  expectedEvidence: string[]
  status: 'active' | 'watching' | 'archived'
  lastObservedAt: string
}

interface SkillEvolutionDecision {
  id: string
  skillName: string
  baseVersion: string
  diagnosis: string
  attribution: 'trigger' | 'content' | 'reference' | 'composition' | 'not-skill' | 'uncertain'
  addressedCaseIds: string[]
  patch: string
  evidenceIds: string[]
  decision: 'accepted' | 'rejected' | 'deferred' | 'needs-observation'
  outcomeSummary?: string
  createdAt: string
}
```

与上一版相比，关键变化是：

- 不把 `successRate` 作为核心字段；
- 把 catalogued、loaded、invoked 分开；
- 把任务结果和 Skill 归因分开；
- 把实践案例视为动态资产；
- 把 rejected 和 deferred 决策持久化；
- 把“是否值得继续观察”作为正式状态。

## 对 DSH 架构的具体建议

### 第一阶段：只做观察层

新增独立的 `dsh-skill-evolution` 插件，订阅现有 session、tool、filesystem 和 agent 事件，先生成 JSONL 观察记录。不要修改 agent loop，也不要让它自动编辑生产 Skill。

这一阶段的验收不是“自动改进成功率”，而是能回答：

- 某个 Skill 什么时候进入 catalog；
- 模型什么时候真正加载它；
- 加载后执行了哪些相关动作；
- 用户后续是否纠正或继续追问；
- 这个观察是否足以形成一个实践案例。

### 第二阶段：人工确认的问题簇

提供按 Skill、版本、任务模式、影响归因和时间查询的视图。人工确认问题簇后，再调用 Designer 生成 candidate。这样可以先验证归因和数据模型，避免一开始就把模型生成错误固化进 Skill。

### 第三阶段：候选回放与决策历史

实现 practice case 的最小回放协议，保存新旧 Skill 的行为证据和决策历史。回放器可以执行命令、测试或重放工具交互，但它服务于当前候选的相对比较，不承担覆盖所有 DSH 任务的职责。

### 第四阶段：观察式发布

候选先以不改变默认行为的方式加载或由用户显式调用，收集真实使用证据。经过多个相关案例支持后，再更新生产路径并触发 filesystem provider 的 invalidate。回滚使用版本指针或恢复上一份内容，不删除决策历史。

## 运行节奏：进化不是每次会话里的副作用

DSH 的在线请求路径应只负责记录观察，不应在用户任务中同步改写稳定 Skill。适合的节奏是：

| 节奏 | 允许动作 | 目的 |
|---|---|---|
| 实时/日内 | 记录 catalog 命中、加载、使用、后续反馈；生成待观察问题 | 不改变当前任务的行为 |
| 每日或每两日 | 合并问题簇，生成 proposal，做 schema、依赖和相关实践集回放 | 批量减少噪声和重复修改 |
| 每周 | 对少量候选做按任务簇的 shadow/canary，保留旧版本对照 | 观察真实分布中的相对收益 |
| 每月或季度 | 合并、拆分、暂停、归档 Skill；检查目录、版本和维护成本 | 管理 Skill 组合而不是只增加 Skill 数量 |

这里的 shadow/canary 不需要引入一个统一总分。候选版本只需在与其修改意图相关的任务簇上，与旧版本比较，并满足最小实际改进幅度；如果样本不足，就保持 `needs-observation`，不要强行发布。

建议按时间窗口和任务簇切分证据：最近案例反映当前分布，稳定案例保留长期行为，触发案例解释本次修改。报告时保留“不可判定”桶，并区分 exposure：未进入 catalog、进入但未加载、加载但未执行、执行后未产生影响，这些不能混成 Skill 内容失败。

## 进化操作的优先级

按对真实系统的可解释性和可回退性排序，优先做：

1. 修正 `description`、`whenToUse`、标签、适用范围和依赖关系；
2. 补充前置条件、失败处理、输出格式和少量示例；
3. 合并重复内容，减少过长 Skill 和无效引用；
4. 在长期证据支持后拆分 Skill，或把一个 Skill 的部分内容移到引用资源；
5. 最后才做跨 Skill 组合、路由策略和自动淘汰。

这一区分很重要：如果 Skill 从未被加载，先修 catalog 描述；如果加载后用户仍然反复纠正步骤，才考虑正文；如果多个 Skill 同时被加载且影响无法区分，先改善边界和组合关系，不能直接改写所有参与过的 Skill。


- 每次失败都自动追加一段经验到 `SKILL.md`；
- 用一次任务成功直接奖励所有参与过的 Skill；
- 用单一总分决定 Skill 是否发布；
- 把固定 benchmark 的成绩当成真实用户收益；
- 只保存最新 Skill，不保存被拒绝的修改和证据；
- 把长期偏好、一次性任务上下文、事实记忆和操作流程全部混成一个 Skill；
- 用 Skill 的加载次数代替 Skill 的实际影响；
- 让 Designer 同时负责归因、生成、评测和发布决策。

## 当前最值得研究的问题

DSH 的研究重点应从“能不能自动写出更好的 Skill”转成以下问题：

1. 在没有明确评分的真实会话中，哪些行为信号足以说明 Skill 有问题？
2. 如何区分触发失败、Skill 内容失败、模型未遵循和环境失败？
3. 多个 Skill 同时加载时，如何做局部归因？
4. 什么时候一次反馈已经足够，什么时候必须等待重复案例？
5. 如何从真实任务提取最小实践案例，而不是保存完整轨迹？
6. 如何让实践集随任务分布变化而更新、降权和归档？
7. Skill 变长、变多之后，何时应拆分、合并或退出？
8. 如何让后续 Designer 理解以前为什么接受或拒绝某个修改？
9. Skill evolution 如何帮助 catalog 的触发描述，而不只修改正文？
10. 用户偏好、团队规范和领域流程应如何分层，避免不同来源互相覆盖？

## 结论

适合 DSH 的 Skill 进化是 **真实会话驱动、证据逐步积累、问题先归因、候选小步修改、动态实践集回放、决策历史持久化、观察式发布** 的维护系统。

它的基本单位不是一个 benchmark 分数，而是一条可追溯的实践证据：某个 Skill 在某类任务中被发现、被加载、影响了什么行为、用户或工具给出了什么后续信号，以及这个信号是否足以支持修改。

DSH 当前的 Skill registry、filesystem provider、catalog loader 和 invalidate 机制已经提供了运行时底座。下一步最合理的工作不是先造 Designer，而是先把“可见 → 加载 → 使用 → 后续反馈 → 归因 → 实践案例”这条观察链记录完整。只有这条链成立，后面的自动进化才有研究意义。
