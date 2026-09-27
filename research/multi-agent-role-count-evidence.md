# 编码任务中 multi-agent 角色数量与角色划分的一手证据（2025 下半年至 2026-09）

> SKIL-94 调研产物，查证日期 2026-09-27。标记约定：**来源明说**＝原文直接这么写；**推断**＝来源暗示、本文推导；**查不到**＝找过但没有一手依据。只调研，不改 `docs/`。

## 结论

1. **有新的一手实证，而且是对照实验。** 2025-12 以来至少有三项研究在编码任务上直接变动了 agent/子 agent 数量：BOAD 的 top-K 子 agent 消融、Scaling Agent Systems 的架构与 agent 数对照、单 agent 执行多 agent 工作流的对照。结果方向一致：**人头数增加不会单调带来收益，超过很少的数目后在编码任务上持平或变差**。（来源明说，见 §1）
2. **「推测」段落的方向被加强，但有两处需要改。**
   - 「没有任何一方给出正面证据」「角色多没用不是被证伪的」已经过时：现在有对照实验显示，编码任务上加子 agent 在 2 个之后下降（BOAD），强模型在 SWE-bench Verified 上所有 multi-agent 架构都略低于单 agent（Scaling Agent Systems）。（来源明说）
   - 「杠杆不在角色」说得太满：同一批证据显示**角色怎么划分**（选哪些子 agent、按依赖内聚切分还是按文件切分、谁拥有哪些文件）对结果有明显影响。杠杆不在角色**数量**，但角色**划分**本身是杠杆之一。（来源明说 + 推断，见 §2）
3. **「校验闸是杠杆」有新的一手支撑**：在角色数基本不变时，开关一个校验环节就能让结果大幅移动（MAST 对 ChatDev 加目标校验 +15.6%；角色流水线去掉评估环节后编译率低于单 LLM）。（来源明说，见 §3）
4. **「artifact 契约是杠杆」仍然只是推断。** 查到的研究没有单独消融契约本身；CodeTeam 把机器可检查契约作为设计核心，但消融里没有「去掉契约」这一项。（查不到直接对照）
5. **仍然查不到**：在 SWE-bench / Terminal-Bench 级任务上、保持校验闸不变、只删 Tester / Reviewer / Architect 等功能角色的对照实验。

## 建议的修改（列出，不在本票执行）

`docs/sdd-practice-zh.md:93` 的「推测」段落建议改为：

> **推测**（本项目的推导，综合下列一手证据）：Spec Kit Agents 的增益归因于 context-grounding hooks，不是角色数量。2025-12 以后的对照实验进一步显示，在编码任务上增加 agent 数量不会单调带来收益：BOAD 在 SWE-bench Live 上子 agent 数 2 个最好、3–5 个下降；Scaling Agent Systems 在 SWE-bench Verified 上所有 multi-agent 架构都略低于强模型单 agent；同一工作流改由单 agent 执行，函数级编码结果持平或略好。同时，在角色数不变时加上或去掉一个校验环节，结果移动幅度远大于此。因此杠杆在校验闸和角色**划分方式**（按依赖内聚切分、明确文件所有权、只保留确有帮助的子 agent），不在角色数量。artifact 契约是否独立构成杠杆，目前没有单独的对照实验。

`docs/sdd-practice-zh.md:95` 的边界说明建议改为：

> 边界：直接变动 agent 数量的对照实验都基于预印本，样本量有限（Scaling Agent Systems 的 SWE-bench 子集 n=20）；函数级编码（HumanEval / MBPP）上有 multi-agent 高于单 agent 的结果，但多在置信区间内。还没有在仓库级任务上、保持校验闸不变、只删功能角色的实验，所以「大花名册一定更差」同样没有被证实。

另有两处连带修改：

- `docs/sdd-practice-zh.md:76` 小节标题「唯一有实证评估的那一条」：对**多 agent SDD 配置**仍然成立，对**多 agent 编码**已不成立。建议改为「唯一有实证评估的多 agent SDD 配置」，并新增一小节引用本文 §1–§3。
- `research/sources.md:75`、`:84` 的「只有 Spec Kit Agents 做了实证评估」同理，需要限定到 SDD 配置，并补录本文来源。
## §1 角色 / agent 数量：直接对照

**BOAD**（arXiv 2512.23631v2，2025-12-29 提交，预印本）。在 SWE 任务上用 bandit 搜索子 agent 组合，Seed-OSS-36B。
- 来源明说：按 helpfulness 取 top-K 子 agent，K=1…5，在 SWE-bench Live 上分别是 16.3 / **20.0** / 16.3 / 16.7 / 13.7（Table 3）。原文：「performance peaks with exactly two sub-agents … larger teams of three (49/300), four (50/300), or five (41/300) reduce performance due to communication and coordination overhead」。
- 来源明说：SWE-bench Verified 上，单 agent（SWE-agent）49.8，加人工设计的 4 子 agent（localizer / reproducer / editor / tester）降到 47.4，BOAD 找到的 2 子 agent 为 53.2（Table 1）。
- 来源明说：同样取 top-2，按 helpfulness 选 20.0，按成功率选 15.3。数量相同，**选哪几个角色**不同，结果差 4.7 个点。

**Towards a Science of Scaling Agent Systems**（arXiv 2512.08296v3，2025-12-09 提交，2026-04-08 修订，预印本）。260 个配置、6 个基准、5 种架构，工具、提示和算力都统一。
- 来源明说：6 个基准里有 SWE-bench Verified 和 Terminal-Bench。原文：「SWE-bench Verified shows slight degradation across all MAS architectures (from -15% to -2%), consistent with high single-agent baselines (>45%) … Terminal-Bench shows mixed results: Independent achieves marginal gains (+2%) while Centralized degrades (-19%)」。
- 来源明说：Table 16（n=20）中，claude-sonnet-4-5 单 agent 75%，multi-agent 为 55–70%；gpt-5-nano 单 agent 5%，multi-agent 为 25–35%。**弱模型从 multi-agent 获益，强模型反而受损。**置信区间很宽。
- 来源明说：摘要写「architecture-task alignment, not number of agents, determines collaborative success」。agent 数扫描（1/3/5/7/9）的结果作者自称「preliminary」。
- 来源明说：没有集中校验时，错误放大 17.2×；centralized 为 4.4×。但回归里错误放大的主效应不显著（p=0.658）。
- 查不到：「功能分工的角色 vs 同质角色」的对照。论文里所有 agent 只在规模和 role prompt 上不同。

**Rethinking the Value of Multi-Agent Workflow**（arXiv 2601.12307v1，2026-01-18 提交，预印本）。
- 来源明说：AFlow / OneFlow 设计出的工作流改由单 agent 多轮执行，在 HumanEval / MBPP 上与多 agent 版本持平或略高（例如 AFlow HumanEval 90.1 vs 91.1）。原文：「in homogeneous settings, a single model can faithfully simulate agent roles via multi-turn conversations」。
- 推断：决定结果的是工作流结构，实例化几个 agent 并不重要。限于函数级编码、同质模型。

**反向信号：BenchAgent / Do More Agents Help?**（arXiv 2606.05670，2026-06-04 提交，预印本）。
- 来源明说：10 个基准平均，6 个 MAS 中至多 1 个超过同条件的单 agent，其余落后 2.56–11.29 分。
- 来源明说：但编码子集方向相反。HumanEval 上单 agent 84.73，6 个 MAS 中 4 个更高（最高 93.89），另有 81.68 和 61.83；MBPP 上 6 个 MAS 全部高于单 agent 68.32（72.72–75.95）。作者把 Wilson 半宽内的差异定为 descriptive。
- 推断：函数级编码上 debate / ensemble 式拓扑可能有小幅增益。这与 §1 其余结论的冲突可能来自任务粒度（函数级 vs 仓库级）和模型强弱，但没有来源直接验证这一解释。

## §2 角色划分：同样数量，不同分法

**Co-Coder / When Parallelism Pays Off**（arXiv 2606.00953v1，2026-05-31 提交，预印本）。仓库级生成，所有方法都用 gpt-5-mini。
- 来源明说：按依赖内聚切分的 Co-Coder 在 DevEval / CodeProjectEval 上平均通过率 68.1% / 34.1%。顺序单 agent 为 56.8% / 20.1%，Claude Code Agent Teams 为 54.1% / 16.3%。原文：Agent Teams「falling below even the sequential baseline on CodeProjectEval (16.3% vs. 20.1%)」。
- 来源明说：按文件切分的并行做法「wall-clock latency grows with the agent count rather than shrinking」，在 CodeProjectEval 上 API 成本增加 60%。
- 查不到：扫描 agent 数 K 的实验。K 由分图算法按仓库决定，不是自变量。

**CodeTeam**（arXiv 2606.22082，2026-06-20 提交，预印本）。Architect / CTO / Developer / QA 流水线，CTO 产出「machine-checkable contract that specifies file ownership, public interfaces, and dependency constraints」。
- 来源明说（摘要）：把 Architect 指导的 developer 数量与文件所有权分配换成固定 4 人轮转（w/o dynamic allocation）后，SketchBLEU 下降，该项贡献 9.9%（相对值）。
- 推断：数量和所有权是一起变的，这项消融无法把两者分开。它支持「分工方式有影响」，不能单独归因给数量。

## §3 校验闸：角色数不变时开关一个环节

- **MAST / Why Do Multi-Agent LLM Systems Fail?**（arXiv 2503.13657，v1 2025-03-17，v3 2025-10-26；v1 早于窗口，此处引用 v3 全文）。来源明说：「adding a high-level task objective verification step to ChatDev yields a +15.6% improvement in task success on ProgramDev」。
- **An Evaluation of Role-Based Multi-Agent Code Generation on Repository-Scale Problems**（arXiv 2607.04212，2026-07-05 提交，已被 IEEE Software 专刊接收）。12 个 Java 仓库，GPT-5。来源明说（Table 2 Overall）：编译率单 LLM 31%，角色流水线跳过评估环节（Agentic-seq）22%，评估环节循环到无问题为止（Agentic-refl）40%；Scenario Intent 分别为 61% / 55% / 78%。两种 agentic 变体的平均 agent 数接近（约 6–8）。
- 推断：多角色流水线**不带校验环节**时，编译率比单 LLM 还低；加上校验环节后反超。注意 Agentic-refl 基于 ChatDev 2.0 实现，校验环节与框架差异混在一起。

## §4 官方工程博客与文档（无对照数据）

- **Cognition「Multi-Agents: What's Actually Working」**（2026-04-22）。来源明说：「multiple agents contribute intelligence to a task while writes stay single-threaded」；Devin Review 平均每个 PR 找出 2 个 bug，约 58% 为严重。推断：与「校验闸是杠杆」方向一致，但没有对照组，只能算厂商经验。
- **Claude Code Agent Teams 文档**（页面无日期）。来源明说：「Three focused teammates often outperform five scattered ones」，功能「experimental and disabled by default」。这是指导性写法，页面上没有数据。
- 排除：Anthropic「How we built our multi-agent research system」（2025-06-13，早于窗口，且任务是研究不是编码）；Cognition「Don't Build Multi-Agents」（2025-06-12，早于窗口，无数据）；OpenAI Codex subagents 文档（抓取返回 403，查不到）；CloudMAS 的 Tester 消融数字（只找到搜索引擎摘要，没有原文，按查不到处理）。

## 证据强度说明

- 除 2607.04212 已被 IEEE Software 接收外，§1–§3 的来源都是 arXiv 预印本。
- 编码任务上的样本普遍偏小（Scaling Agent Systems 的 SWE-bench 为 n=20，Co-Coder 为 28 个任务）。

## 来源

以下链接均于 2026-09-27 查证。arXiv 日期取自 abs 页的 submission history。

- BOAD, arXiv 2512.23631v2 — https://arxiv.org/abs/2512.23631 ；全文 https://arxiv.org/html/2512.23631v2
- Towards a Science of Scaling Agent Systems, arXiv 2512.08296v3 — https://arxiv.org/abs/2512.08296 ；全文 https://arxiv.org/html/2512.08296v3 （Google Research 博客 https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ 抓取失败，未引用其内容）
- Rethinking the Value of Multi-Agent Workflow, arXiv 2601.12307v1 — https://arxiv.org/abs/2601.12307
- Do More Agents Help? (BenchAgent), arXiv 2606.05670 — https://arxiv.org/abs/2606.05670
- When Parallelism Pays Off (Co-Coder), arXiv 2606.00953v1 — https://arxiv.org/abs/2606.00953
- CodeTeam, arXiv 2606.22082 — https://arxiv.org/abs/2606.22082
- Why Do Multi-Agent LLM Systems Fail? (MAST), arXiv 2503.13657v3 — https://arxiv.org/abs/2503.13657
- An Evaluation of Role-Based Multi-Agent Code Generation on Repository-Scale Problems, arXiv 2607.04212 — https://arxiv.org/abs/2607.04212
- Cognition, Multi-Agents: What's Actually Working (2026-04-22) — https://cognition.com/blog/multi-agents-working
- Claude Code Agent Teams 文档 — https://code.claude.com/docs/en/agent-teams
- 已排除：https://www.anthropic.com/engineering/multi-agent-research-system ；https://cognition.com/blog/dont-build-multi-agents
