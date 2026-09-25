# Skill 进化研究现状（第一轮）

> 调研日期：2026-06-01
>
> 范围：面向 LLM Agent 的外部、可组合、可版本化程序性知识（skill）如何被发现、生成、修订、评测和发布。这里不把“模型参数继续训练”与“Skill 文件/工作流演化”混为一谈。

## 结论先行

当前研究已经从“让 Agent 记住经验”推进到“自动发现可复用技能”和“用失败轨迹指导技能修订”，但还没有形成一个被广泛接受的生产级闭环标准。研究成果主要集中在三层：

1. **技能获取**：通过探索、反思、试错和轨迹压缩，把一次或多次任务经验提炼为可复用程序。
2. **技能选择与对齐**：根据任务相关知识、技能覆盖度和任务对齐度，从技能库检索或组合候选。
3. **运行时评测**：在有状态工具环境、真实网站或桌面环境中验证工具调用、策略遵循和最终任务结果。

对 DSH 最关键的判断是：MVP 设计中的“失败案例 → 候选修改 → 三类回归 → 原子发布/回滚”方向是合理的，但还需要补上四个研究层能力：技能边界和触发条件、任务相关知识覆盖、长期遗忘/冲突管理，以及独立于生成器的行为级评测。

## 1. 概念边界

“Skill”在现有文献中不是单一对象，至少有四种形态：

| 形态 | 典型内容 | 进化动作 | 与 DSH 的关系 |
|---|---|---|---|
| 程序性提示 | Markdown、规则、步骤、注意事项 | 增删改文本、合并去重 | 当前 `SKILL.md` 的主体 |
| 轨迹抽象 | 从成功/失败轨迹提取的策略、子目标、经验 | 摘要、泛化、反事实修订 | 需要作为 candidate 的来源 |
| 可执行技能 | 代码、宏、工具调用序列或环境操作 | 代码合成、修复、回归测试 | 需要更强沙箱和权限隔离 |
| 记忆/知识条目 | 事实、偏好、任务知识、检索片段 | 写入、检索、遗忘、冲突消解 | 不应全部塞进 `SKILL.md` |

Anthropic 的 Agent Skills 文档把 Skill 定义为包含 instructions、metadata 和可选 resources 的文件系统资源，并强调按需加载的 progressive disclosure。这支持 DSH 将 Skill 视为可发现、可加载的外部工件；但产品文档描述的是运行时架构，不足以证明自动进化有效。

## 2. 技能发现与自动生成

### EXIF：探索优先的技能发现

[Automated Skill Discovery for Language Agents through Exploration and Iterative Feedback](https://arxiv.org/abs/2506.04287)（2025）提出 EXIF。探索代理 Alice 先与环境交互，生成可行且 grounded 的技能数据，再训练/指导目标代理 Bob；Alice 根据 Bob 的表现识别改进点，反馈到下一轮探索。论文在 WebShop 和 Crafter 上报告了无需人工干预的技能发现和迭代能力提升，并观察到 Alice 与 Bob 使用同一模型也能形成自我演化效果。

对 DSH 的启示：失败轨迹不能直接等价为 Skill 文本修改。更稳健的链路是“失败诊断 → 需要补足的行为/知识 → 新案例或候选 Skill → 环境执行验证”。DSH 当前 Designer 输入失败案例的设计可以吸收这一点，增加“可行性证据”和“新增训练/评测案例”。

### AlignEvoSkill：知识覆盖与任务对齐

[AlignEvoSkill](https://arxiv.org/abs/2506.23149)（2025，页面显示 2026 修订版）指出，已有技能进化方法可能生成知识不完整或与目标任务无关的 Skill。其方法从失败轨迹识别任务相关知识标签，检索互补的已有技能，生成候选，再用知识覆盖和任务对齐联合筛选；论文在三个 benchmark、四个 LLM backbone 上报告相对非进化基线 34.7% 的提升。

对 DSH 的启示：当前 MVP 主要以失败案例和成功率做门禁，应该新增两个显式字段：`knowledgeGaps` 和 `taskAlignmentEvidence`。候选 Skill 不能只回答“是否修复了当前失败”，还要回答“覆盖了哪些缺口、是否扩大到无关任务”。

### 从长期学习研究得到的共同模式

[awesome-lifelong-LLM-agent](https://github.com/qianlima-lab/awesome-lifelong-LLM-agent) 汇总的长期学习研究显示，经验积累通常包含：轨迹记录、经验压缩、经验检索、反思修订、技能库管理和遗忘/冲突处理。当前研究仍缺少统一的“技能版本仓库”抽象，大多以实验框架内的 memory 或 prompt library 存储。

## 3. 反思、试错和经验回放

这一类工作提供了 Skill 进化的机制来源，但不一定等价于 Skill 工程：

- **Reflexion**：用语言反馈把失败转成可供后续尝试使用的 verbal reinforcement，说明失败总结可以改善后续行为，但反馈条目是否可泛化、何时失效，需要独立验证。
- **Self-Refine / CRITIC**：让模型生成、批评、修订，说明生成器和评审器分离有价值；但“看起来更好”不等于真实环境成功，因此 DSH 应保留执行型 Evaluator。
- **Voyager**：在 Minecraft 中积累可执行技能库，并按任务检索技能，说明技能库可以成为长期能力增长的中间层；其环境封闭、奖励明确，迁移到开放软件工程任务仍有差距。
- **Toolformer / ToolLLM / Gorilla / ToolBench**：说明工具选择、参数生成和工具知识本身可以通过数据和训练改善；这些工作更偏模型能力或工具调用，不直接解决 `SKILL.md` 的版本治理。
- **ADAS、Agent-Pro、Skill Set Optimization、Trial-and-Error、Contextual Experience Replay、ReasoningBank、SAMULE**：共同趋势是从轨迹中提炼策略模块、上下文经验或可复用程序，并通过后续任务验证收益。它们提示 DSH 需要记录 skill 触发上下文、执行轨迹和失败类型，而不是只记录一次最终成功/失败。

这类工作的共同限制是：经验往往在实验内存中存在，缺少长期版本、回滚、兼容性和权限治理；同时，生成器可能把偶然相关性写进经验。DSH 的 manifest、候选目录和 promote/reject/rollback 是工程化补位。

## 4. 评测现状

### ToolSandbox：有状态和中间里程碑

[ToolSandbox](https://aclanthology.org/2025.findings-naacl.65/)（Findings of NAACL 2025）把评测从无状态、单轮 API 调用扩展到有状态工具执行、隐式状态依赖、用户模拟器和 on-policy 对话，并在中间和最终里程碑进行动态评测。论文指出，状态依赖、规范化和信息不足等任务即使对强模型也有挑战。

对 DSH 的启示：Skill evaluator 不能只比较最终文本或单个断言。至少应记录工具调用序列、状态变化、中间里程碑、最终结果和策略违规；对于带副作用的工具，应使用可重置环境。

### 其他常用基准的定位

- **ToolBench / ToolLLM**：大规模工具调用和 API 选择/参数生成，适合测试工具知识和调用正确性。
- **AgentBench**：多环境 Agent 能力评估，适合跨环境比较，但不专门解决 Skill 版本演化。
- **WebArena**：真实网站环境中的长期任务，适合测试流程性技能和网页交互迁移。
- **τ-bench**：业务域工具、策略遵循和用户交互，适合检查 Skill 是否遵守组织规则和业务政策。
- **OSWorld**：桌面环境中的真实操作，适合测试可执行流程和状态恢复。

这些 benchmark 共同支持 DSH 的“三类回归案例”设计，但需要把案例元数据细化为任务域、状态依赖、工具权限、成功判据和风险等级。

## 5. 安全与失败模式

Skill 进化带来的风险比静态提示更复杂：

1. **错误泛化**：为解决一个任务加入的规则，扩大了误触发范围。
2. **权限漂移**：候选 Skill 引导模型调用更高权限工具、扩大文件或网络访问范围。
3. **提示注入持久化**：轨迹中的恶意网页、文档或工具返回值被写入长期 Skill，后续任务重复触发。
4. **评测污染**：生成器看到评测案例或答案，造成自我验证和门禁绕过。
5. **版本冲突**：多个 Skill 对同一工具、策略或领域规则给出互相矛盾的指令。
6. **遗忘与膨胀**：持续追加经验使 Skill 过长，触发成本上升并降低规则可执行性。

因此，MVP 中“候选目录隔离、Evaluator 与 Designer 分离、禁止自动修改工具权限、保留版本并可回滚”的边界应保留。还应增加：来源内容的可信等级、敏感操作的人工门禁、Skill 触发率和误触发率、候选与评测集的隔离，以及过期/冲突规则的处理。

## 6. 对现有 MVP 设计的具体修订建议

### 保留的核心设计

- Provider 负责发现和加载，Evolution Service 负责质量与生命周期。
- 失败案例、候选 patch、评测结果和发布事件全部结构化持久化。
- 原失败、历史成功、边界案例三类回归。
- 候选 Skill 不覆盖生产版本，发布动作原子化，旧版本可回滚。

### 建议新增的数据字段

```ts
interface SkillEvolutionEvidence {
  sourceType: 'trajectory' | 'test' | 'user' | 'review' | 'external'
  sourceId: string
  trust: 'low' | 'medium' | 'high'
  taskDomain?: string
  stateDependencies?: string[]
  toolEffects?: 'none' | 'reversible' | 'external-side-effect'
}

interface SkillCandidateChange {
  // 现有字段保留
  knowledgeGaps: string[]
  taskAlignmentEvidence: string[]
  triggerChanges: string[]
  permissionChanges: string[]
  riskAssessment: string[]
}
```

### 建议新增的评测指标

| 指标 | 目的 |
|---|---|
| 原失败修复率 | 验证候选是否解决触发进化的问题 |
| 历史成功保持率 | 检测回归 |
| 边界误触发率 | 检测 Skill 适用范围是否扩大 |
| 工具调用正确率 | 检测工具选择、参数和调用顺序 |
| 状态恢复率 | 检测有状态环境中的中断恢复 |
| 知识覆盖率 | 检测候选是否覆盖声明的缺口 |
| 任务对齐度 | 检测是否加入无关规则 |
| 权限漂移 | 检测工具、文件、网络权限变化 |
| token/延迟成本 | 检测 Skill 变长带来的运行时成本 |

## 7. 工程生态对照

| 项目/协议 | 生成/演化 | 版本/发布 | 评测与反馈 | 适合借鉴的部分 |
|---|---|---|---|---|
| Agent Skills 开放标准 | 规范 Skill 目录、`SKILL.md`、scripts/references/assets 和渐进式披露；不规定自动生成 | 有 metadata，但没有统一的 Skill 版本/注册发布协议 | 提供评测指导，反馈闭环由客户端或外部系统实现 | 可作为跨客户端的制品格式和内容边界 |
| Anthropic Agent Skills + Skill Creator/API | Skill Creator 覆盖 create/eval/improve/benchmark | 提供 Skill Management CRUD 和版本 API | 当前最接近显式的 create → eval → improve → benchmark → version 生命周期 | 借鉴生命周期接口和版本模型，同时保留 DSH 自己的证据与发布门禁 |
| DSPy GEPA | 反馈驱动优化 textual instruction/program，维护候选谱系和 Pareto 候选 | 可保存/加载程序并保留 lineage，但不是独立 Skill registry | metric 返回分数与自然语言 feedback，低分轨迹进入反思和候选重评估 | 借鉴候选谱系、自然语言反馈、Pareto 保留和 audit trail |
| Voyager | 自动生成可执行代码 Skill，验证后写入 skill library | 有技能库积累，缺少生产级版本、回滚和权限治理 | 环境执行反馈驱动代码修订和技能复用 | 借鉴“探索 → 执行验证 → 写入库 → 迁移”的研究闭环 |
| LangGraph + LangSmith | 编排与观测基础设施，Skill 生成需应用层实现 | checkpointer、prompt/run 管理和数据集可支持版本化 | 线上 trace、人工反馈、在线/离线 evaluator、回归数据集较完整 | 借鉴真实轨迹转回归集、线上评测和持久化状态 |
| SWE-agent | YAML 配置、prompt、demonstration trajectory 可改变 Agent 行为 | Git/config 可追踪，缺少通用 Skill registry | SWE-bench、轨迹 JSON、工具/测试反馈 | 借鉴工程任务轨迹、可复现 benchmark 和测试验证 |
| MCP | 不生成 Skill，提供 tools/resources/prompts 的互操作底座 | 协议和服务器有版本/注册机制，非 Skill 生命周期 | 不规定质量评测和反馈回写 | 把工具 schema、版本漂移和权限边界纳入 Skill 依赖记录 |

综合判断：Anthropic 的生命周期抽象、DSPy GEPA 的反馈优化、Voyager 的执行验证、LangSmith 的 trace/eval 基础设施和 Agent Skills 的可移植制品格式可以组合成 DSH 的参考架构；MCP 更适合作为工具能力底座，而不是 Skill 进化层。

## 7. 评测与安全深化

### 从终局成功转向可回放的状态评测

[SWE-bench](https://arxiv.org/abs/2310.06770) 说明真实仓库中的修改必须通过测试和 patch 验证，不能只由 LLM judge 判断最终文本。[τ-bench](https://arxiv.org/abs/2406.12045) 进一步用 `pass^k` 衡量多次独立运行的可靠性；这意味着 Skill 评测至少要同时报告单次成功率、重复运行稳定性、状态/文件结果和策略遵循。

[ToolSandbox](https://arxiv.org/html/2408.04682v2) 提供了更具体的评测设计：有状态工具、隐式状态依赖、用户模拟器、milestone DAG 和 minefield。对 DSH 而言，正确轨迹不应被固定成唯一的 tool-call 序列；评测应允许多条合法路径，同时明确哪些高风险动作绝不能发生。

[OSWorld](https://arxiv.org/html/2404.07972) 则说明文件、浏览器和 GUI Skill 应在隔离 VM 或可重置快照中测试，并使用任务专属 execution-based evaluator。由此建议 DSH 的 `SkillEvalResult` 增加：中间 milestone、禁行动命中、状态 diff、成本/回合数、重复 rollout 方差和环境版本。

### 安全评测必须进入发布门禁

[AgentDojo](https://arxiv.org/html/2406.13352v3) 和 [InjecAgent](https://arxiv.org/html/2403.02691) 表明，网页、文档、邮件和工具返回值中的间接 prompt injection 可以劫持工具调用；技能进化管线如果把这些内容直接写入长期 Skill，就会把一次攻击持久化。安全设计应遵守以下信任层级：系统/开发者规则高于用户目标，高于已审核 Skill 指令，高于外部资料和工具输出。外部内容默认是数据，不能改变权限、系统策略或永久记忆。

发布门禁应同时要求：

- 工具、文件、网络和凭证权限不得由候选 Skill 自行扩张；
- 候选包通过 schema 校验、静态扫描、来源/签名检查和沙箱试运行；
- 在 benign utility 和 injection regression 两套集合上都不退化；
- 高影响动作使用 allowlist、二次确认、确定性状态检查和可回滚快照；
- evaluator 与被测 Agent 的上下文隔离，安全判定不能交给可能被注入的同一个模型。

建议统一记录一条可重放轨迹：`task/user_goal`、`skill_version`、`model`、`tool_schema`、`observation`、`action/tool_call`、`tool_result`、`state_diff`、`milestone/minefield`、`cost/latency`、`termination`、`utility/security_outcome` 和 `failure_taxonomy`。所有轨迹、Skill diff、evaluator 和环境版本都应可 hash 和追溯。

## 8. 当前研究空白

1. **没有统一的 Skill 表示和生命周期标准**：Markdown Skill、代码技能、memory entry 和 policy module 常被混用。
2. **缺少长期版本演化 benchmark**：多数实验比较一次性生成前后性能，较少测量多轮演化中的遗忘、冲突、膨胀和回滚。
3. **从失败到规则的因果链不清晰**：失败轨迹可能由模型、工具、环境状态或任务理解造成，不能简单归因给 Skill。
4. **评测器可靠性不足**：LLM-as-a-judge 容易与生成器共享偏差，真实执行和结构化检查仍需占主导。
5. **安全研究与能力研究割裂**：Skill injection、工具权限和持久化记忆污染需要纳入同一条演化流水线。
6. **生产成本很少被报告**：候选数量、评测调用、延迟、存储增长和人工审查负担经常被忽略。

## 9. 建议的研究路线

### R0：可观测性和数据协议

实现 `SkillUsageRecord`、`SkillFailureCase`、`SkillCandidateChange`、`SkillEvalResult`，并从 DSH 现有 session/tool 事件重建一次完整轨迹。先保证每条规则都能回溯到证据。

### R1：离线候选评测

不接自动发布。用人工构造的 API debugging 或 repository maintenance 任务，比较静态 Skill、失败摘要、候选 patch 在三类回归集上的表现，建立成本和质量基线。

### R2：知识缺口与触发边界

在失败聚类后抽取知识缺口、任务对齐证据和触发条件变化，验证加入这些字段是否减少无关 Skill 和误触发。

### R3：在线但受控的闭环

允许自动生成 candidate，仍要求门禁和人工审核才能 promote。加入小流量 shadow evaluation、版本回滚和 catalog invalidate，观测真实会话中的收益、回归和成本。

### R4：长期演化实验

运行多轮任务流，专门测量 Skill 膨胀、冲突、遗忘、版本选择和失败复发。把结果沉淀成 DSH Skill Evolution Benchmark。

## 10. 第一轮结论

研究现状支持把 Skill 当作 Agent 的外部程序性基础设施来管理，也支持从探索和失败轨迹中自动生成候选能力；但现有工作大多证明“某种经验积累方法能提高特定 benchmark 表现”，还没有证明“任意生产 Skill 可以安全地自我修改”。

因此，`dsh-skill-evo` 的研究价值不在于再做一个自动写提示词的 Designer，而在于把以下问题做成可复现实验：什么证据足以触发演化、候选如何证明解决了失败、怎样检测边界回归、如何限制权限漂移，以及长期多轮演化后系统是否仍然可解释、可回滚、可维护。
