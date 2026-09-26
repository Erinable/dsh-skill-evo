# SDD 实践调研：管线、角色分工与落到本项目的方式

> 调研日期：2026-09-26
>
> 本文固化一轮关于 spec 驱动开发（SDD）的外部调研结论，供本项目写 requirements 和 design 时引用。所有来源见 [research/sources.md](../research/sources.md) 的「SDD 与多 Agent 协作」小节。
>
> 阅读约定：本文用「有证据」标记来自官方文档或带实证评估的论文的结论，用「推测」标记本项目自己的推导。两者不混写。未验证的框架项目一律标注为框架设计，不作为业界最佳实践。

## 1. SDD 不是一件事

Fowler 站上 Böckeler 的对比文章（2025-10）指出，SDD 这个词当时仍在流变，被不同工具赋予不同含义。她把落地程度分成三层：

| 层级 | 含义 | 代表 |
|---|---|---|
| spec-first | 先写好 spec，再用它驱动当次 AI 协作；任务完成后 spec 不一定继续维护 | Kiro、Spec Kit（按她当时的观察） |
| spec-anchored | 任务完成后 spec 继续保留，用于该功能后续的演化和维护 | Tessl（明确追求） |
| spec-as-source | spec 是唯一被人编辑的源文件，代码由它生成，人不碰代码 | Tessl（在探索） |

**有证据**：她的判断是，所有 SDD 方法都至少是 spec-first，但不都追求 spec-anchored 或 spec-as-source，而且多数工具对「spec 长期怎么维护」留白。

她同时区分了 spec 与 memory bank：memory bank（规则文件、产品与代码库的高层描述）对所有会话都相关；spec 只与创建或修改那一块功能的任务相关。**推测**：这个区分对本项目直接可用——`AGENTS.md` 和 README 研究原则属于 memory bank 性质，单个 Skill 的演化提案属于 spec 性质。

**已知偏差**：该文写于 2025-10，明确自称是"我认为它们如何工作"的快照，并提醒工具演化很快。核对官方文档时确实发现已经不成立的细节，见下节。

## 2. 标准管线

业界已收敛出的链路是：Constitution → Specify → Clarify → Plan/Design → Tasks → Implement → Validate/Converge。两个主要实现：

### Kiro 三件套

**有证据**（官方文档）：

- 每个 spec 产出三个文件：`requirements.md`（或 bugfix spec 的 `bugfix.md`）、`design.md`、`tasks.md`，存在 `.kiro/specs/<name>/` 下。
- `requirements.md` 用 EARS 语法：`WHEN <条件/事件> THE SYSTEM SHALL <预期行为>`。官方给出的收益是清晰性、可测试性、可追溯性和完整性。
- spec 设计为纳入版本控制、随代码提交，以此在团队间共享。
- 有两种工作流变体：Requirements-First（行为已知、架构可塑）和 Design-First（架构已定、有严格非功能约束）。文档明确说 spec 创建后不能切换变体。
- Bugfix spec 显式记录「不变行为」：`WHEN <条件> THEN the system SHALL CONTINUE TO <既有行为>`，用来防回归。
- 还有两道可选质量动作：Analyze Requirements（在 design 前查逻辑矛盾、含糊、冲突约束和缺口）和 Quick Spec（跳过阶段间审批闸，一次生成三件套）。

**推测**：Bugfix spec 的「不变行为」写法对本项目的 Skill 候选修改直接可借。Skill 演化的核心风险正是"修好一个触发场景、弄坏另一个"，而 `SHALL CONTINUE TO` 是把这种约束写成可检查条目的现成句式。

### GitHub Spec Kit

**有证据**（官方 quickstart，核对于 2026-09）：

- 短路径：`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement` → `/speckit-converge`。
- 完整路径在其间插入三道质量闸：`/speckit-clarify`（在 plan 前把含糊点问清并写回 spec）、`/speckit-checklist`（生成「需求的单元测试」式清单，由审阅者拥有）、`/speckit-analyze`（只读，跨 `spec.md`/`plan.md`/`tasks.md` 报冲突、缺口和含糊）。
- `/speckit-constitution` 每个项目跑一次，建立后续每一步都要对照的原则。
- `/speckit-converge` 拿代码库对照 spec、plan 和 tasks；发现缺口就往 `tasks.md` 追加新任务，循环到报 Converged。
- `/speckit-implement` 把 checklist 的勾选状态当作闸：有未勾选项时会先询问，且它自己不改任何 checklist 文件。

**注意两处与 Fowler 文章不一致的地方**（官方文档更新）：

1. Fowler 观察到 spec-kit 为每个 spec 创建分支，并据此推断它把 spec 看作"变更请求生命周期内"的产物而非功能生命周期的。现在官方文档明确说：活跃 feature 由 `.specify/feature.json` 记录的目录决定，**不依赖 Git**，`git checkout` 本身不切换 feature；分支只是可选的 git extension。
2. `/speckit-converge` 这一步在 Fowler 的描述里没有，是后来加的收敛闸。

**推测**：第 1 点的意义是，spec-kit 的 spec 现在不再与分支绑死，spec-anchored 的结构障碍已被移除。但这只是可能性变化，没有证据说实际用法已变成 spec-anchored。

### 共同形状

**推测**：两者对齐后可以看出管线的稳定骨架是「一个持久的项目级 constitution」+「每个功能一组阶段化 artifact」+「阶段间的审阅闸」。差异主要在闸的数量和是否强制。

## 3. 多 Agent 角色花名册对照

这一节的「性质」一栏是本节最重要的信息，不要在引用时丢掉。

| 项目 | 角色 | 性质 |
|---|---|---|
| Spec Kit Agents（arXiv 2604.05278） | Orchestrator 状态机 + PM + Developer | **仅 3 个，有实证评估** |
| claude-agentic-specs | Supervisor, Planner, Architect, Backend, Frontend, Data, DevOps, Security | 框架项目，未验证 |
| dev-squad | PM, Solution Architect, Product Owner, Lead Dev, QA, Security, AWS Specialist（+HR Manager 动态招聘/解聘） | 框架项目，未验证 |
| coordinated-agent-team | Orchestrator, SpecAgent, Architect, Planner, Coder, Reviewer, QA, Security, Integrator, Docs, Designer, Researcher | 框架项目，未验证 |

关于 coordinated-agent-team 的角色数：编号是 00–11 共 12 个槽位，但仓库 README 自述为「11 agents」。这个不一致不影响结论（都属于"十来个角色的大花名册"），本文按 12 个槽位列出。

### 唯一有实证评估的那一条

**有证据**（arXiv 2604.05278 摘要，2026-04-07 提交）：

Spec Kit Agents 的出发点是 agent 在大型、演化中的代码库里"context blind"，导致幻觉 API 和架构违规。它的做法是在 SDD 管线上加**阶段级的 context-grounding hooks**：

- 只读的 probing hooks，把 Specify / Plan / Tasks / Implement 每个阶段锚定在仓库证据上；
- validation hooks，拿中间 artifact 对照环境做校验。

评估规模：5 个仓库、32 个 feature、128 次运行。结果：

- LLM-as-judge 的 1–5 分复合质量分提升 **+0.15**（满分的 +3.0%），Wilcoxon 符号秩检验 p < 0.05；
- 仓库级测试兼容性保持在 **99.7–100%**；
- 在 SWE-bench Lite 上，augmentation hooks 相对 baseline 提升 **1.7%**，达到 **58.2% Pass@1**。

### 关键判断

**推测**（本项目的推导，不是论文的主张）：唯一做了实证评估的配置角色最少（PM + Developer 两个角色加一个 orchestrator 状态机），而十来个角色的大花名册全部来自未验证的框架项目。论文归因的增益来源是 context grounding hooks，不是角色数量。因此杠杆在 artifact 契约和校验闸，不在人头数。

需要诚实标注这个推导的边界：论文没有做「3 角色 vs 12 角色」的对照实验，所以"角色多没用"不是被证伪的，只是**没有任何一方给出正面证据**。它成立的部分是：加 hooks 有统计显著的小幅增益（+3.0% 满分占比，效应量不大），而增加角色数没有任何实证支撑。

### 团队尺度的概念框架

**有证据**（arXiv 2609.00252，2026-08-31 提交）：这篇论文为 SDD 在 agentic software engineering（ASE）中的团队尺度纪律建立概念与方法论基础。它报告业界的一个「生产力悖论」：个体生产力上升的同时，团队吞吐、审阅容量和稳定性下降，因为团队尺度的工程纪律被忽视。它的产出包括：

- 一个社会技术模型，spec 作为人与 agent 之间的**契约基底**；
- 对 harness 的操作性刻画，区分 **technical harness**（围绕 agent 的技术机制）与 **methodological harness**（围绕团队的方法论机制）；
- 五种人机交互模式的类型学。

结论句是：SDD 以 spec 为中心的形式重建了 vibe coding 消解掉的三项契约——**accountability、verifiability、transferability**。

**证据强度必须标注**：这篇论文自己说明，方法是概念分析，主要基于灰色文献（愿景与路线图论文、从业者报告、演讲、工具），因为同行评审证据和共享的学术-产业词汇尚未建立。作者明确定位它为"迈向共识的第一步，而非已验证的理论"。所以它的价值是提供词汇和框架，不是提供证据。

## 4. wave ↔ stage 同构

**有证据**（Kiro 官方文档）：Kiro 在执行 `tasks.md` 时构建任务依赖图，把独立任务分组成 wave：

- Wave 1 是所有无依赖的任务，并发执行；
- Wave 2 是所有依赖已被 Wave 1 满足的任务，并发执行；
- Wave N 依此类推。

官方原话是 waves 串行执行，wave 内任务并发执行，且无需配置。

**推测**：这与 Multica 的 `--stage N` 栅栏是同一形状（stage 内并行、stage 间由 leader 放行）。因此 SDD 的任务分解可以直接落成 Multica 的 stage 结构，不需要中间层。差别在于 Kiro 的依赖图是自动推断的，Multica 的 stage 是显式声明的——这是人工与自动的差别，不是模型的差别。

## 5. 本项目已有的 constitution

**推测**：本项目不需要从零写 constitution。以下两份加起来即构成 spec-kit 意义上的 constitution：

- `AGENTS.md` 的项目结构、构建/测试命令、TypeScript 风格约定、测试指引和提交规范；
- README 的五条研究原则。

其中一条在本项目语境下有 constitution 级的约束力，值得单列：**固定 benchmark 只作为离线参考，不把它当作 DSH 在线质量真相**。它与 `docs/research-landscape-zh.md` 中「为什么上一版的固定评测思路不适合 DSH」一节是同一条线，任何后续 requirements 和 design 都必须与它一致。

## 6. 相关外部实现

### DSH 官方技能能力

**有证据**（`@deepseek-ai/dsh-tool-skill` 官方 README 与 DeepSeekDSH 社区指南，后者核对于 2026-09-11、源版本 0.1.5-rc.2）：

DSH 的技能能力由两个插件组成，职责分层：

- `@deepseek-ai/dsh-skill-filesystem`：从配置的本地文件系统根发现 Skill。
- `@deepseek-ai/dsh-tool-skill`：面向模型的 Skill 目录（catalog）与 `skill` 加载工具。它需要 `ctx.agents`、`ctx.tools` 和 `ctx.skills`。

社区指南强调 provider 层可以变化而不改动面向模型的 `skill` 工具，且 Standard preset 已经挂载了文件系统发现与该工具，不要重复安装。配置通过 Cordis composition 声明。

对本项目最有价值的几条机制细节（均来自官方 README）：

- **catalog 是一个持久投射**。在首次请求前，若存在 model-invocable Skill 且 `skill` 工具可见，agent 会收到一条 durable 的 user-role 消息，列出每个 Skill 的名字和被截断的描述（`catalogDescriptionMaxLength` 默认 500，最小 3）。
- **catalog 更新是完整替换，append-only**。成员、描述或可见性变化会追加一份完整替换 catalog；删掉全部 Skill 会追加一份空 catalog，显式作废旧名字。差异判定用的是对已发布条目算的 digest，不是渲染后的文字。
- **两条加载路径共用一个渲染**。`skill` 工具的返回和用户 `/name` 显式调用的注入都走 `dsh-skill` 共享的 `renderSkillContent`，模型看到同一种形状。catalog 文案里带了反重复加载规则。
- **错误是三种确定文本**：`Error: invalid skill name "..."`、skill unknown or no longer available、skill not available for model invocation。
- **`disable-model-invocation` 的 Skill 只能由 `/name` 手势进入**，catalog 和 `skill` 工具从不暴露它。
- **KV cache 行为有明确说明**：初始 durable catalog 追加在既有可复用前缀之后；后续变化都是 append-only 历史，早先的可复用 token 不受影响，但新实例或 digest 变化的 resume 可能影响从新 catalog 位置起的缓存复用。重复输入成本随 Skill 数量和 `catalogDescriptionMaxLength` 增长。

**推测**：最后一条对本项目的版本发布模型是硬约束。每次 Skill 描述变化都会追加一份完整替换 catalog，所以"频繁微调描述"不是零成本的：它既增加 retained token，也在 catalog 位置之后打断缓存复用。这支持 `docs/research-landscape-zh.md` 已有的"记录，不立即进化"和"小范围发布"节奏——把多个描述改动合批发布，比逐条即时发布更省。这条推论需要实测验证，目前只是从文档化的机制推出的。

### dsh-skills-bridge：一份最小 SkillProvider 范式

**有证据**（仓库 README，`YTyangtao666/dsh-skills-bridge`）：

它把 `~/.claude/skills` 和 `~/.agents/skills` 挂成 DSH 的一等 `SkillProvider`（provider 名 `claude-bridge`），零 npm 运行时依赖，只用 `node:fs`。值得记的三点：

- **frontmatter 映射表**：`name`/`description` 语义相同；`when_to_use` / `when-to-use` → `whenToUse`；`disable-model-invocation` → `invocation.modelInvocable: false`；`user-invocable` → `invocation.userInvocable`；`allowed-tools`、`license` 和自定义键保留在 `metadata` 里，从不丢弃。
- **冲突优先级**：bridge Skill 注册在 rank `250`。project-local DSH Skill（100/200）在同名冲突时仍然胜出；user-level 默认值（400/500）让位给 bridge。
- **声明的限制**：只支持扁平 frontmatter，深层嵌套 YAML 跳过并告警（与原生 provider 行为一致）；Skill 正文逐字透传，正文里引用的工具名（如 Claude Code 的 `Read`/`Bash`）由模型自己适配；watcher 基于 `fs.watch`，网络文件系统上应设 `watch: false`。

**推测**：rank 数值这套分层是本项目发布模型可以直接对齐的现成坐标系。如果演化产出的 Skill 版本需要"影子发布"（新版本可被加载但不覆盖现有版本），一个比 project-local 低、比 user-level 高的 rank 区间就是它的位置。这是从 README 的数值分层推出的可行性，README 本身没有讨论影子发布。

## 7. 回扣四个研究问题

### 问题 1：Skill / tool-use policy / memory / workflow 如何区分

**推测**（结合 Fowler 的 spec vs memory bank 区分与 DSH 的机制）：SDD 的这组词汇给本项目一个更清楚的切分：

- **memory bank / constitution**：跨所有会话都相关的长期规则（本项目里是 `AGENTS.md` + README 原则）。
- **Skill**：任务类别相关的可加载程序性知识，由 provider 发现、由 catalog 暴露、由 `skill` 工具加载。DSH 已经把它做成了有明确生命周期的一等对象。
- **spec**：只与"改这一块"相关的阶段化 artifact。在本项目里，一次 Skill 演化提案本身就是一个 spec。
- **workflow**：把 spec 阶段串起来的执行结构（Kiro 的 wave、Multica 的 stage）。

值得注意的是：DSH 的 catalog 机制让 Skill 的"被发现"和"被加载"是两件可分别观测的事（catalog 里列出 ≠ `skill` 工具被调用）。这对归因有直接价值，与 `docs/research-landscape-zh.md` 里"Skill 触发失败、Skill 内容错误和模型没有遵循 Skill 是三种不同问题"的区分吻合。

### 问题 2：从轨迹与失败反馈中发现和修订 Skill

**有证据**：Spec Kit Agents 论文给出的、有统计显著性的机制是 context grounding——只读的发现钩子 + 在推理步骤前后对中间 artifact 做结构/引用/仓库兼容性校验。

**推测**：把这个搬到 Skill 演化上，对应的是：候选修改生成前先跑只读的仓库证据收集（这条 Skill 实际被加载过几次、在哪些任务里、之后发生了什么），候选生成后跑结构校验（frontmatter 是否仍可被 provider 正确解析、描述长度是否仍在 `catalogDescriptionMaxLength` 内、引用的资源路径是否存在）。后一类校验在本项目里是廉价且确定的，应该优先做。

### 问题 3：评测真实增益与回归风险

**推测**：Kiro Bugfix spec 的 `SHALL CONTINUE TO` 句式是把回归风险写成可检查条目的现成形式。本项目的候选修改可以要求同时写出两组条目：这次要改的行为，和必须保持不变的行为。

同时必须重申 constitution 约束：Spec Kit Agents 的 SWE-bench Lite 数字（58.2% Pass@1）是离线方法比较的参考，不能当作 DSH 在线质量真相。它能说明的只是"context grounding 这类机制在固定基准上有小幅正效应"。

另外，那篇论文的效应量本身值得记住：+0.15/5 分、满分占比 +3.0%、SWE-bench Lite +1.7%。**推测**：这个量级提示本项目不要为单次演化设定过高的预期增益阈值，否则真实的小幅改进会被噪声淹没而判为无效。

### 问题 4：落到 DSH 的 Provider / catalog / workflow / 版本发布模型

这是本轮调研对本项目最直接的贡献，分四层：

**Provider 层**（有证据）：dsh-skills-bridge 是一份可参考的最小 SkillProvider 实现范式——扁平 frontmatter 映射、`metadata` 兜底保留未知键、rank 数值决定同名冲突、可选 `fs.watch` 热重载、零运行时依赖。演化产出的 Skill 版本要进入 DSH，走的就是这条路。

**catalog 层**（有证据 + 推测）：catalog 是 digest 驱动的完整替换投射，描述截断长度可配。**推测**：这意味着 catalog 是一个可观测的发布面——每次追加的完整替换 catalog 本身就是一条"某个 Skill 的暴露状态在此刻变成了这样"的事实记录，可以作为观察层的输入，不需要额外埋点。同时它也是成本面，支持合批发布。

**workflow 层**（推测）：SDD 的阶段链可以直接落成 Multica stage。对本项目而言，一次 Skill 演化的完整链路是：观察（Stage 1）→ 归因与 requirements（Stage 2）→ 候选与 design（Stage 3）→ 评测（Stage 4）→ 发布决策（Stage 5）。stage 内并行、stage 间由 leader 放行，与 Kiro 的 wave 同形。

**版本发布模型**（推测）：三条约束合起来给出发布模型的形状——

1. rank 分层（来自 bridge）给出"新版本可加载但不覆盖"的位置；
2. catalog 的完整替换语义与 KV cache 影响（来自官方 README）要求发布合批、不要逐条即时推送描述改动；
3. `disable-model-invocation` 只能由 `/name` 进入（来自官方 README）给出一个天然的灰度开关：候选版本先发成 user-invocable 但 model-non-invocable，只能被人显式调用，观察一段时间后再放给模型自动发现。

第 3 条是本文认为最值得写进 design 的一条推论：DSH 已有的机制里恰好存在一个「人可用、模型不可见」的中间态，它不需要本项目新造任何发布开关。但它是否真的适合做灰度，需要在实现阶段验证——特别是这个中间态下能否收集到足够的观察信号。

## 8. 未解决的问题

1. Spec Kit Agents 的 hooks 是否能在 Skill 演化（而非代码生成）场景保持正效应，无证据，需自行实验。
2. 没有任何一方给出「角色数量」与产出质量的对照证据，本文的"杠杆不在人头数"是推导而非结论。
3. catalog 合批发布相对逐条发布的实际成本差，只有机制文档支撑，没有实测数字。
4. `disable-model-invocation` 中间态下能否收集到足够观察信号，未知。
5. arXiv 2609.00252 的 technical/methodological harness 区分是否对本项目有操作性价值，尚未展开；它本身也只是概念框架而非验证过的理论。
