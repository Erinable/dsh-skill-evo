# Skill 进化研究来源索引

> 本文件记录本轮调研实际使用的公开来源。结论以来源原文为准；预印本的结果应视为研究信号，不等同于已完成的同行评审共识。

## 论文与基准

| 来源 | 年份 | 关注点 | 链接 |
|---|---:|---|---|
| Automated Skill Discovery for Language Agents through Exploration and Iterative Feedback（EXIF） | 2025 | 探索代理生成可行、环境 grounded 的技能数据，并通过迭代反馈继续探索 | https://arxiv.org/abs/2506.04287 |
| AlignEvoSkill: Towards Knowledge-Aware and Task-Aligned Agent Skill Evolution | 2025/2026 revision | 从失败轨迹抽取任务相关知识标签，检索互补技能，并联合筛选知识覆盖与任务对齐 | https://arxiv.org/abs/2506.23149 |
| ToolSandbox: A Stateful, Conversational, Interactive Evaluation Benchmark for LLM Tool Use Capabilities | 2025 | 有状态工具执行、对话式 on-policy 评测、中间里程碑和最终结果评测 | https://aclanthology.org/2025.findings-naacl.65/ |
| SkillLearnBench: Benchmarking Continual Learning Methods for Agent Skill Generation on Real-World Tasks | 2026 | 面向真实任务的持续学习与 Skill 生成评测基准 | https://arxiv.org/html/2604.20087v1 |

## 官方文档与工程生态

| 来源 | 关注点 | 链接 |
|---|---|---|
| Anthropic Agent Skills 文档 | 文件系统 Skill、渐进式披露、metadata/instructions/resources 分层 | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview |
| Anthropic Agent Skills 工程文章 | Skill 作为可复用程序性知识的产品化实践与开放标准方向 | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills |
| anthropics/skills | 官方公开 Skill 仓库与可复用资源样例 | https://github.com/anthropics/skills |
| qianlima-lab/awesome-lifelong-LLM-agent | 长期学习 LLM Agent 的综述、论文和资源集合 | https://github.com/qianlima-lab/awesome-lifelong-LLM-agent |
| apple/ToolSandbox | ToolSandbox 基准代码与数据实现 | https://github.com/apple/ToolSandbox |
| sierra-research/tau-bench | 面向真实业务域工具调用和策略遵循的 benchmark | https://github.com/sierra-research/tau-bench |


## 补充研究来源

| 来源 | 年份 | 关注点 | 链接 |
|---|---:|---|---|
| Voyager | 2023 | 探索、代码生成、执行验证与可检索技能库 | https://arxiv.org/abs/2305.16291 |
| Toolformer | 2023 | 从 API 调用结果筛选工具调用并用于训练 | https://arxiv.org/abs/2302.04761 |
| ToolLLM / ToolBench | 2023–2024 | 大规模工具 schema、调用轨迹与评测 | https://arxiv.org/abs/2307.16789 |
| Gorilla | 2023 | 面向海量 API 的检索增强工具调用 | https://arxiv.org/abs/2305.15334 |
| Reflexion | 2023 | 失败反馈转自然语言经验并写入 episodic memory | https://arxiv.org/abs/2303.11366 |
| CRITIC | 2023 | 用外部工具核验和修订模型输出 | https://arxiv.org/abs/2305.11738 |
| Self-Refine | 2023 | 生成、反馈、迭代改写 | https://arxiv.org/abs/2303.17651 |
| ADAS | 2024 | 自动提出、组合和评测 agent modules | https://arxiv.org/abs/2408.08435 |
| Trial and Error | 2024 | 从失败轨迹总结经验并优化后续探索 | https://arxiv.org/abs/2403.02502 |
| Agent-Pro | 2024 | 策略级反思和跨实例优化 | https://aclanthology.org/2024.acl-long.292.pdf |
| Skill Set Optimization | 2024 | 把可迁移技能集合当作行为模块优化 | https://proceedings.mlr.press/v235/nottingham24a.html |
| Contextual Experience Replay | 2025 | 按任务上下文检索和重放历史经验 | https://aclanthology.org/2025.acl-long.694.pdf |
| SAMULE | 2025 | 结果、步骤、策略多层反思 | https://aclanthology.org/2025.emnlp-main.839.pdf |
| AgentBench | 2023 | 多环境 Agent 规划、推理和工具交互评测 | https://arxiv.org/abs/2308.03688 |
| WebArena | 2023/2024 | 真实风格网站长程任务与可验证目标 | https://arxiv.org/abs/2307.13854 |
| τ-bench | 2024/2025 | 用户、业务规则与工具的交互式评测 | https://arxiv.org/abs/2406.12045 |
| OSWorld | 2024 | 真实计算机环境 GUI 任务评测 | https://arxiv.org/abs/2404.07972 |
| AgentDojo | 2024 | Prompt injection 攻击与防御评测 | https://arxiv.org/html/2406.13352 |
| InjecAgent | 2024 | 工具集成 Agent 的间接注入基准 | https://arxiv.org/html/2403.02691 |
| Agent Security Bench | 2024 | Agent 攻击面与防御的统一评测 | https://arxiv.org/html/2410.02644 |
| SafeToolBench | 2025 | 工具使用安全评测 | https://aclanthology.org/2025.findings-emnlp.958.pdf |
| Library Drift | 2026 预印本 | 自演化技能库的静默漂移、诊断和修复 | https://arxiv.org/html/2605.19576v1 |
| Agent Skills 开放标准 | 2025/2026 | Skill 包格式、渐进式披露和评测指导 | https://agentskills.io/specification |
| Anthropic Skill Creator | 2025/2026 | Skill create/eval/improve/benchmark 与版本 API | https://github.com/anthropics/skills/blob/HEAD/skills/skill-creator/SKILL.md |
| DSPy GEPA | 2025 | 反馈驱动的指令/程序候选搜索、谱系和 Pareto 优化 | https://dspy.ai/current/diving-deeper/gepa-in-depth/ |
| LangSmith Evaluation | 2025/2026 | 线上 trace、离线/在线评测与回归数据集 | https://docs.langchain.com/langsmith/evaluation |


| SWE-bench | 2023/2024 | 真实仓库 issue、patch 和测试驱动的软件工程评测 | https://arxiv.org/abs/2310.06770 |
| ReST meets ReAct | 2023 | rollout、筛选和自训练改进多步 Agent | https://arxiv.org/abs/2312.10003 |
| Watch Every Step! | 2024 | 逐步骤过程反馈和轨迹修正 | https://aclanthology.org/2024.emnlp-main.93.pdf |
| AgentDojo | 2024 | 动态状态环境中的间接 prompt injection 评测 | https://arxiv.org/html/2406.13352v3 |
| InjecAgent | 2024 | 工具集成 Agent 的间接注入基准 | https://arxiv.org/html/2403.02691 |
| OWASP LLM01:2025 | 2025 | Prompt injection 风险与间接注入测试指南 | https://genai.owasp.org/llmrisk/llm01-prompt-injection/ |
| OpenAI Operator System Card | 2025 | 浏览器/电脑 Agent 的 prompt injection 和动作风险 | https://openai.com/index/operator-system-card/ |
| Anthropic computer-use best practices | 2024 | 电脑操作 Agent 的 VM 隔离、数据和动作风险 | https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-best-practices/README.md |

| AutoSkill: Experience-Driven Lifelong Learning via Skill Self-Evolution | 2026 | 从交互经验抽取、维护、检索和版本化 Skill | https://arxiv.org/abs/2603.01145 |
| SkillsBench | 2026 | 比较无 Skill、人工整理 Skill 和自生成 Skill 的任务效果 | https://arxiv.org/abs/2602.12670v1 |
| SkillHone: A Harness for Continual Agent Skill Evolution Through Persistent Decision History | 2026 | 持久化诊断、候选修改、评测证据和决策历史 | https://arxiv.org/abs/2606.08671 |
| SkillEvo: Self-Renewing Evolution Gradients from Multi-Turn Interaction Feedback | 2026 预印本 | 用多轮交互反馈持续暴露问题并约束 Skill 演化 | https://arxiv.org/html/2608.13120 |
| OpenSkill: Open-World Self-Evolution for LLM Agents | 2026 | 在缺少目标监督时，从外部知识和自建验证锚点引导 Skill 自演化 | https://arxiv.org/abs/2606.06741 |

## SDD 与多 Agent 协作

> 本组来源支撑 [docs/sdd-practice-zh.md](../docs/sdd-practice-zh.md)。注意「性质」一栏：只有 Spec Kit Agents 做了实证评估，其余多 Agent 花名册均来自未验证的框架项目，不构成业界最佳实践。

| 来源 | 年份 | 关注点 | 性质 | 链接 |
|---|---:|---|---|---|
| Understanding Spec-Driven-Development: Kiro, spec-kit, and Tessl（Böckeler, Thoughtworks） | 2025-10 | SDD 定义流变，spec-first / spec-anchored / spec-as-source 三层，spec 与 memory bank 的区分 | 实践观察，作者自称快照、工具可能已变 | https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html |
| Kiro Specs 官方文档 | 2026 | `requirements.md` / `design.md` / `tasks.md` 三件套，EARS 语法，Requirements-First 与 Design-First，依赖图生成 wave，Bugfix spec 的 `SHALL CONTINUE TO` | 官方文档 | https://kiro.dev/docs/specs.md |
| Kiro Feature Specs | 2026 | 两种工作流变体的选择条件，EARS 的四项收益，Analyze Requirements | 官方文档 | https://kiro.dev/docs/specs/feature-specs.md |
| Kiro Specs Best Practices | 2026 | 并行 wave、Sync Files、Quick Spec 与标准流程的取舍、防回归写法 | 官方文档 | https://kiro.dev/docs/specs/best-practices.md |
| GitHub Spec Kit Quickstart | 2026 | Constitution → Specify → Clarify → Plan → Checklist → Tasks → Analyze → Implement → Converge；活跃 feature 由 `.specify/feature.json` 决定而非 Git 分支 | 官方文档 | https://github.github.io/spec-kit/quickstart.html |
| Spec Kit Agents: Context-Grounded Agentic Workflows | 2026-04 | Orchestrator 状态机 + PM + Developer 三角色；只读 probing hooks 与 validation hooks；128 runs / 32 features / 5 repos；judged quality +0.15（满分 +3.0%，Wilcoxon p<0.05）；repo 级测试兼容 99.7–100%；SWE-bench Lite 58.2% Pass@1（+1.7%） | **唯一有实证评估的多 Agent SDD 配置** | https://arxiv.org/abs/2604.05278 |
| Spec-Driven Development for Agentic Software Engineering: Harnessing Human-Agent Teamwork | 2026-08 | 生产力悖论；spec 作为人机契约基底；technical harness 与 methodological harness 区分；五种人机交互模式；accountability / verifiability / transferability | 概念分析，主要基于灰色文献；作者自述为迈向共识的第一步而非已验证理论 | https://arxiv.org/abs/2609.00252 |
| q3ok/coordinated-agent-team | 2026 | 12 个编号角色槽位（00–11，README 自述 11 agents）：Orchestrator, SpecAgent, Architect, Planner, Coder, Reviewer, QA, Security, Integrator, Docs, Designer, Researcher；artifact 契约与状态机 | 框架项目，未验证 | https://github.com/q3ok/coordinated-agent-team |
| antonioreuter/dev-squad | 2026 | PM, Solution Architect, Product Owner, Lead Dev, QA, Security, AWS Specialist；HR Manager 做动态招聘/解聘与 talent pool | 框架项目，未验证 | https://github.com/antonioreuter/dev-squad |
| dariopalladino/claude-agentic-specs | 2026 | Supervisor, Planner, Architect, Backend, Frontend, Data, DevOps, Security；`.spec/` 分层与 PROPOSED_CHANGES / HANDOFF 沙箱流程 | 框架项目，未验证 | https://github.com/dariopalladino/claude-agentic-specs |

## DSH 技能运行时机制

| 来源 | 关注点 | 性质 | 链接 |
|---|---|---|---|
| `@deepseek-ai/dsh-tool-skill` README | 面向模型的 catalog 与 `skill` 加载工具；catalog 为 digest 驱动的完整替换投射；`catalogDescriptionMaxLength` 默认 500；两条加载路径共用 `renderSkillContent`；三种确定错误文本；`disable-model-invocation` 只能由 `/name` 进入；token 与 KV cache 影响 | 官方包文档 | https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md |
| DeepSeekDSH 社区插件指南（Skills） | `dsh-skill-filesystem` 负责发现、`dsh-tool-skill` 负责 catalog 与加载；Standard preset 已挂载两者；Cordis composition 配置示例 | 独立社区指南，核对于 2026-09-11、源版本 0.1.5-rc.2 | https://deepseekdsh.com/plugins/skills |
| YTyangtao666/dsh-skills-bridge | 把 `~/.claude/skills` 与 `~/.agents/skills` 挂成一等 SkillProvider（`claude-bridge`）；frontmatter 映射表；冲突 rank（bridge 250，project-local 100/200 胜出，user-level 400/500 让位）；扁平 frontmatter 限制与 `fs.watch` 注意事项 | 第三方实现，可参考的最小 SkillProvider 范式 | https://github.com/YTyangtao666/dsh-skills-bridge |

- “Skill evolution”在不同工作中可能指：技能发现、技能文本/程序合成、从失败轨迹修订技能、长期记忆积累，或模型参数层面的持续学习。本项目优先研究可版本化的外部程序性知识。
- 官方产品文档适合说明运行时架构和工程约束，论文与 benchmark 适合支撑算法和评测结论；两类证据不能互相替代。
