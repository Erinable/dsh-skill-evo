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

- “Skill evolution”在不同工作中可能指：技能发现、技能文本/程序合成、从失败轨迹修订技能、长期记忆积累，或模型参数层面的持续学习。本项目优先研究可版本化的外部程序性知识。
- 官方产品文档适合说明运行时架构和工程约束，论文与 benchmark 适合支撑算法和评测结论；两类证据不能互相替代。
