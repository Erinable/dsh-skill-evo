# 仓库文档审计与治理方案

> 审计日期：2026-09-26
>
> 审计基线：`origin/main` @ `c7512d2`（`docs: 固化 SDD 调研结论`）
>
> 本阶段不修改、不移动、不删除任何现有文件。本文是唯一新增文件。
>
> 阅读约定：沿用 `docs/sdd-practice-zh.md` 的标注方式。**有证据**= 可由 `packages/` 下代码、`git` 记录或文档原文直接核对；**推测**= 本文的推导与判断。判断文档是否过时以代码为准，不以文档自述为准。

## 0. 审计方法与一处基线修正

核对手段：逐节读完 7 份在审文档，再用 `grep` 在 `packages/*/src/*.ts`、`packages/skill-evolution/bin/dsh-skill-evolution.mjs` 中核对文档提到的每一个类型名、方法名、路径和命令名是否存在。

**基线修正（有证据）**：任务描述给出的行数清单与 `origin/main` 实际不符两处。`research/sources.md` 实际 99 行（任务描述正确），但本任务工作树的初始 baseline 提交 `a2824d0` 落后 `origin/main` 一个提交（`c7512d2`），缺 `docs/sdd-practice-zh.md`。本文已切到 `origin/main` 后重新审计，审计范围因此比任务描述多一份文档：`docs/sdd-practice-zh.md`（217 行）。README 在 `origin/main` 上是 42 行而非 40 行，`## 当前状态` 为 12 条、`## 目录` 为 4 条。

审计对象共 7 份（不含 `AGENTS.md` 与三个包 README 的只读参照）：

| 文档 | 行数 | 自述性质 |
|---|---:|---|
| `README.md` | 42 | 项目入口 |
| `skill-进化设计-MVP.md` | 394 | 「状态：设计基线」 |
| `docs/skill-evolution-mechanism-zh.md` | 563 | 「设计版本：2026-09-25」 |
| `docs/architecture-design-zh.md` | 606 | 「设计版本：2026-09-25」 |
| `docs/research-landscape-zh.md` | 381 | 「修订日期：2026-09-25」 |
| `docs/sdd-practice-zh.md` | 217 | 「调研日期：2026-09-26」 |
| `research/sources.md` | 99 | 来源索引 |

## 1. 逐份文档：读者、用途、结论

### 1.1 `README.md` — 保留并重写

- **谁会来读**：第一次进入仓库的人（人或 agent），想知道这是什么项目、怎么跑起来。
- **为解决什么问题**：定位与导航。
- **读完应得到什么**：项目目标、包结构、构建/测试命令、该去读哪份文档。

**结论：保留，重写。** 现状它只完成了「定位」，没完成「怎么跑」与「包之间什么关系」。详见第 4 节。

### 1.2 `skill-进化设计-MVP.md` — 归档（保留原文，改性质标注）

- **谁会来读**：想知道这个项目最初怎么设想这套闭环的人。
- **为解决什么问题**：它是第一版设计，定义了「记录 → 候选 → 评测 → 发布/回滚」四件事和第一版数据模型。
- **读完应得到什么**：现状读完会得到一份**与代码不符的**数据模型和目录结构。

**结论：归档为历史设计基线。** 它自称「设计基线」，但第 3、4、6、8、9 节已被实现推翻（第 3 节清单）。**推测**：它仍有不可替代的价值——第 1 节「非目标」、第 7 节「安全和质量边界」、第 10 节「成功标准」是三份文档里唯一把 MVP 验收写成可检查条目的地方，且第 10 节的 7 条与代码实现基本吻合。因此不建议删除或合并，建议保留原文并在开头加一行性质标注。

### 1.3 `docs/skill-evolution-mechanism-zh.md` — 保留为机制/研究基线

- **谁会来读**：要理解「为什么这样设计」而不是「怎么实现」的人。
- **为解决什么问题**：把 11 篇工作的机制提炼成 DSH 语境下的设计约束（六个基本事实、五个平面、两个闭环、三种证据状态）。
- **读完应得到什么**：一套判据——什么该进 Skill、什么不该进、什么证据能支持什么措辞。

**结论：保留。** 它是三份里唯一回答「为什么」的，第 1、2、3.1、6、9、11、12 节没有替代品。

**已知缺陷（有证据）**：`grep "^## "` 的输出里**没有 `## 4.`**——第 4 节标题整体缺失。第 195 行起的 `SkillArtifact` 与「三种边界」内容直接挂在第 3.1 节末尾，读者会误以为它属于 §3.1。另外 `## 3.1` 用了与 `## 3` 同级的二级标题，层级不对。第 4、5、10 节与另两份重叠（第 2 节矩阵）。

### 1.4 `docs/architecture-design-zh.md` — 保留为架构基线，需勘误

- **谁会来读**：要实现或修改 `packages/` 的人。
- **为解决什么问题**：包边界、事实事件、持久化记录、候选生命周期、运行时生效语义。
- **读完应得到什么**：可实现的接口与不变量。

**结论：保留，但 §7.2、§8、§12 已被实现推翻，§3.3/§4.1 的一部分从未实现。** 第 10 节「关键不变量」12 条是全仓库最有价值的单节——**推测**：它是唯一能当验收清单直接用的内容，且 12 条中 11 条在代码中成立（第 3 节核对结果）。

### 1.5 `docs/research-landscape-zh.md` — 保留为研究判断

- **谁会来读**：想知道「为什么不用固定 benchmark」以及外部研究现状的人。
- **为解决什么问题**：记录一次研究方向的修订（从固定评测转向真实使用驱动），并给出反馈信号分级。
- **读完应得到什么**：四类反馈信号的分级、进化操作的优先级排序。

**结论：保留。** 「为什么上一版的固定评测思路不适合 DSH」一节是 README 第三条研究原则的唯一论证来源，删掉它这条原则就没有依据了。

**已知缺陷（有证据）**：第 351 行起有一处**孤立列表**——8 条否定式清单（「每次失败都自动追加一段经验到 `SKILL.md`」等）没有小节标题，从上一节「进化操作的优先级」的结论段直接掉下来，读者无法知道这个列表在说什么。**推测**：这是编辑遗漏，原本应有一个「不应该做的事」之类的标题。与 mechanism 缺 `## 4.` 是同一类缺陷。

### 1.6 `docs/sdd-practice-zh.md` — 保留，无需改动

- **谁会来读**：写 requirements / design 的人，以及要判断本项目流程设计是否有依据的人。
- **为解决什么问题**：SDD 管线的外部依据、角色分工的证据强度、DSH 运行时机制细节。
- **读完应得到什么**：管线形状、哪些结论有实证、哪些只是框架设计。

**结论：保留。** 它是唯一严格区分「有证据 / 推测 / 已知偏差」的文档，且与另三份设计文档无重叠。第 6 节的 DSH catalog 机制细节（digest 驱动完整替换、KV cache 影响、`disable-model-invocation` 中间态）是三份设计文档都缺的运行时约束。

### 1.7 `research/sources.md` — 保留，需修格式

**结论：保留。** 但有三处结构缺陷（有证据）：

1. 第 57–65 行有一段表格行（SWE-bench、ReST meets ReAct 等 8 条）**脱离了表头**，紧跟在上一个表格的空行之后，Markdown 会渲染成一个没有表头的新表或纯文本。
2. 第 66–71 行（AutoSkill、SkillsBench、SkillHone、SkillEvo、OpenSkill 共 5 条）同样脱离表头。
3. AgentDojo 与 InjecAgent **各出现两次**（第 47/48 行与第 61/62 行），AgentDojo 两次链接还不同（`2406.13352` 与 `2406.13352v3`）。

## 2. 重叠矩阵

逐节比对结果。「一致性」栏中「冲突」= 两份对同一件事给出互不兼容的说法。

| 内容 | MVP | mechanism | architecture | research-landscape | 一致性 |
|---|---|---|---|---|---|
| Evolution 不扩张 Skill Registry | §2 | §3 | §1.1 | 「DSH 的真实进化对象」 | 一致（4 份重复） |
| 运行时观察不阻塞任务 | §5.1 | §9 | §1.3 | 「运行节奏」 | 一致（4 份重复） |
| Experience ≠ Skill，需先归因 | — | §2.1/§2.2 | §1.2 | 「Skill 归因比任务评分更重要」 | 一致（3 份重复） |
| **分阶段实施计划** | §8（4 phase） | §10（5 phase） | §9（5 phase） | 「对 DSH 架构的具体建议」（4 阶段） | **冲突：4 份路线图并存** |
| **候选/版本状态机** | §3（4 态+2） | §3 版本平面（5 态） | §4.1（11 态） | — | **冲突：3 套互不兼容** |
| **推荐代码包拆分** | §9（3 包） | — | §8（4 包）/§12 | — | **冲突，且都已被实现推翻** |
| **Service 接口** | §6 第二阶段（6 方法） | — | §2.4（9 方法） | — | **冲突：命名体系不同** |
| **Skill 目录结构** | §3 | — | §4.3 + §2.2 | — | **冲突：3 套布局** |
| **Experience 数据结构** | — | §5.2 | §3.3 | — | **冲突：字段集不同** |
| 决策历史必须持久化 | — | §2.6 | §3.4 | 「6. 形成决策历史」 | 一致（3 份重复） |
| 评测不是总分/需反事实 | §5.4 | §6 | — | 「不需要固定评测体系」 | 大体一致，案例分类冲突（见第 3 节 T12） |
| Skill 库合并/拆分/退出 | §8 Phase 4 | §8 | §9 Phase 5 | 「8. 合并、拆分和退出」 | 一致（4 份重复） |
| 防止自我验证（生成≠评审） | §7 | §11（CRITIC 行） | — | — | 一致 |
| 三段/四段暴露漏斗 | — | §5.1（4 状态） | §6.1（4 段） | 「反证和缺失反馈」 | 一致 |

**关于「分阶段实施」的直接证据**：四份文档各有一份路线图，阶段数与内容划分都不同。MVP §8 是 Phase 1 可观测性 / 2 候选生成 / 3 评测和晋升 / 4 路由优化；architecture §9 是 Phase 1 观察底座 / 2 Experience 和人工归因 / 3 局部候选 / 4 显式采用 / 5 长期维护；mechanism §10 是 Phase 1 事件和证据 / 2 可选的局部实践案例 / 3 候选比较和局部采用 / 4 真实使用观察 / 5 Skill portfolio 管理；research-landscape「对 DSH 架构的具体建议」是四阶段（观察层 / 人工确认问题簇 / 候选回放与决策历史 / 观察式发布）。**推测**：四份路线图全部已被实现走完或绕过（第 3 节），所以这处冲突的现实代价已经不是「按哪份做」，而是「读者不知道现在在第几阶段」。

## 3. 过时内容清单：文档表述 vs 代码实际

判据为代码。核对命令为在 `packages/` 下 `grep` 类型名、方法名、路径与命令名。

| # | 文档位置 | 文档表述 | 代码实际 | 判定 |
|---:|---|---|---|---|
| T1 | MVP §9 | 建议实现 `packages/skill/evolution/`，含 `failure-cluster.ts`、`candidate.ts`、`promotion.ts` | 实际为 `packages/skill-evolution/`；`failure-cluster.ts`、`candidate.ts`、`promotion.ts` 均不存在（对应能力落在 `experience.ts`、`proposal.ts`、`lifecycle.ts`）；另有 `packages/skill/tool-evolution/`、`packages/skill/evolution-workflow/` 从未创建 | **已被否决** |
| T2 | architecture §8 | 建议拆 `packages/skill/evolution/`（含 `diagnosis.ts`）、`evolution-filesystem/`、`evolution-workflow/`、`tool-evolution/` 四包 | 实际三包：`skill-evolution`、`dsh-adapter`、`dsh-bundle`。`diagnosis.ts` 不存在（归因在 `experience.ts`）；`evolution-filesystem` 能力并入 `lifecycle.ts`；`evolution-workflow` 并入 `workflow.ts`；`tool-evolution` 未实现，改由 bundle 的 `/skill-evolution` slash command 承担 | **已被否决** |
| T3 | architecture §12 | 「推荐第一批代码任务」6 项，第 6 项为「暂不接入自动 proposal 和生产采用」 | 27 个 `src/*.ts`、3398 行；proposal、evaluate、accept/reject/defer、promote、rollback、portfolio 全部已实现 | **已完成并越过** |
| T4 | MVP §9 | 「第一批只实现 types、store、evaluator 和 promotion，先不做自动 Designer」 | Designer 仍是注入回调（`workflow.ts` 的 Designer 类型），未内置模型生成——**这一条仍然成立** | **已实现（约束被遵守）** |
| T5 | architecture §3.3 + mechanism §3.1 | `evidenceState: 'observed-support' \| 'locally-verified' \| 'comparatively-shown'`，且只有第三种才允许用因果措辞 | 三个字面量在 `packages/` 下**零命中**。`Experience` 无 `evidenceState` 字段 | **未实现** |
| T6 | architecture §2.4 | `SkillEvolutionService` 9 方法：`appendObservation`、`listObservations`、`projectExperience`、`diagnose`、`createProposal`、`recordComparison`、`decideProposal`、`adopt`、`listHistory` | 实际 `EvolutionService`：`recordObservation`、`recordFeedback`、`listFailures`、`metrics`、`health`、`healthReport`、`repair`、`proposeChange`、`stageProposal`、`evaluate`、`acceptProposal`、`promote`、`verifyEvaluation`、`rollback`、`rejectProposal`、`deferProposal`、`refreshDerived`。`appendObservation`、`projectExperience`、`recordComparison`、`decideProposal`、`listHistory` 零命中 | **已被否决（改用 MVP 命名体系）** |
| T7 | MVP §6 第二阶段 | `SkillEvolutionService` 6 方法：`recordUsage`、`listFailures`、`proposeChange`、`evaluate`、`promote`、`rollback` | 除 `recordUsage`（改名 `recordObservation`）外全部存在 | **已实现** |
| T8 | MVP §4 | `SkillUsageRecord`、`SkillCandidateChange` | 两者零命中。取代者为 `RuntimeObservation`（architecture §3.2 定义，代码逐字段一致）与 `SkillProposal` | **已被否决** |
| T9 | architecture §3.3 | `Experience` 含 `skillRefs`、`sessionIds`、`observationIds`、`evidenceState`、`confidence: 'low'\|'medium'\|'high'`、`reviewedAt` | 代码 `Experience` 用 mechanism §5.2 的字段集：`taskCluster`、`contextSummary`、`relevantSkillVersions`、`observedPattern`、`evidenceEventIds`、`confidence: number` | **mechanism 版本胜出；architecture §3.3 未实现** |
| T10 | architecture §3.4 | `DecisionRecord` 含 `diagnosis`、`hypothesis`、`rejectedAlternatives`、`decision`、`decidedBy`、`resultRef` | 代码 `DecisionRecord` 为 `action`、`reason`、`actor`、`fromStatus`、`toStatus`、`baseContentHash`、`candidateContentHash`、`policyVersion`。上述 6 个字段无一保留 | **已被重写** |
| T11 | mechanism §4 | `SkillArtifact`（identity / routing / procedure / dependencies / evidence / lifecycle 六块） | 零命中。代码 `SkillManifest` 只有 name、version、parentVersion、contentHash、status、scope、createdBy、时间戳；routing / procedure / dependencies / evidence 四块全无 | **未实现** |
| T12 | research-landscape「动态实践集」 | 实践集三来源：最近案例 / 稳定案例 / 触发案例 | 代码 `EvaluationCategory = 'original-failure' \| 'historical-success' \| 'boundary'`，即 MVP §5.4 的三分类 | **MVP 版本胜出；research-landscape 分类未实现** |
| T13 | research-landscape「推荐数据模型」 | `SkillImpactRecord`、`SkillUseObservation`、`SkillPracticeCase`、`SkillEvolutionDecision` | 四者全部零命中 | **未实现** |
| T14 | mechanism §5.1 | `SkillRuntimeEvent`（含 `stage: 'catalogue'\|'load'\|...`） | 零命中。取代者 `RuntimeObservation` 的 10 个 `kind` | **已被否决** |
| T15 | MVP §3「版本状态」 | `draft → candidate → evaluated → promoted / rejected`，`promoted → deprecated` | 代码 `ProposalStatus` 12 态，无 `candidate`、无 `deprecated`；另有独立的 `ArtifactLifecycleState`（6 态） | **部分实现，状态名不符** |
| T16 | architecture §4.1 | Proposal 状态含 `diagnosed`、`locally-checked`、`needs-observation`、`adopted`、`superseded` | 代码 12 态中这 5 个全部不存在；代码有 `evaluating`、`evaluated`、`replayed`、`promoted`、`rolled-back` | **已被重写** |
| T17 | mechanism §3 版本平面 | `draft → observed → canary → stable → retired` | 代码 `ArtifactLifecycleState` 六态含 `dormant`，与此吻合。但 `lifecycle.ts` 的 `manifestFor` 只写入 `'observed'` 与 `'stable'`；`canary` 仅能经 `portfolio.ts` 的 `transitionPortfolio` 到达 | **部分实现：canary 不在发布路径上** |
| T18 | architecture §7.2 | 9 条维护命令，前缀 `dsh skill-evo`：`observe`、`inspect`、`project`、`diagnose`、`propose`、`check`、`decide`、`adopt`、`history` | 实际 CLI 前缀 `dsh-skill-evolution`，15 条命令：`observe`、`failures`、`metrics`、`health`、`feedback`、`propose`、`evaluate`、`accept`、`reject`、`defer`、`promote`、`rollback`、`repair`、`worker`、`rotate`。文档 9 条里只有 `observe`、`propose` 保留 | **已被重写** |
| T19 | architecture §4.3 | 每个 Skill 目录下 `evolution/`（`identity.json`、`decisions.jsonl`、`experiences.jsonl`、`proposals/`），`versions/<content-hash>/` | 代码：演化状态集中在仓库级 `.skill-evolution/`（`decisions.jsonl`、`experiences.jsonl`、`candidates/<proposal-id>/`）；Skill 目录下是 `SKILL.md`、`manifest.json`、`current.json`、`versions/<语义版本>/`。无 per-skill `evolution/` 子目录；`identity.json` 改名 `current.json`；版本目录键是语义版本不是 content hash | **已被重写** |
| T20 | architecture §2.2 | 建议路径 `events/2026-09.jsonl`、`projections/experiences.jsonl`、`decisions/decisions.jsonl`、`indexes/state.json` | 代码扁平放在 `.skill-evolution/` 下，无按月分片、无 `indexes/` | **已被重写** |
| T21 | MVP §3 | Skill 目录含 `eval/`（`case-001.json`、`run.sh`）与 `changelog.md` | 两者零命中，评测案例由 CLI `--cases cases.json` 外部传入 | **已被否决** |
| T22 | architecture §2.2 + MVP §6 | 「SQLite 可以在需要时作为派生索引」 | 只有 JSONL。SQLite 未实现 | **未实现（仍是开放选项，非否决）** |
| T23 | architecture §4.2 | `AdoptionRequest` 含 `reason` 字段；scope 列表含 `retired` | 代码 `AdoptionCandidate` 无 `reason`；`retired` 属 `ArtifactLifecycleState` 而非 scope | **部分实现** |
| T24 | MVP §5.2 | 「相同 Skill、相似失败描述至少出现 2 次才进入自动 Designer」「高严重度失败可单独进入人工审查」 | `workflow.ts:43` 与 `proposal.ts:82`：`occurrenceCount >= 2 \|\| severity === 'high'`，逐条吻合 | **已实现** |
| T25 | architecture §11「第一版不做什么」 | 「不删除原始事件、旧版本或拒绝记录」 | `retention.ts` 的 `rotateJsonl` 会 `unlink` 超过 `retentionDays`（默认 30 天）的归档文件 | **冲突：见下** |

### 3.1 architecture §10「关键不变量」核对

**有证据**：12 条不变量中 11 条在代码中可找到对应实现或约束（不变量 1/2/5/6 由 `StaleAdoptionBaseError`、`expectedBase`、append-only `JsonlEventStore`、`validateAdoptionBase` 承担；8 条不变量属于「不做某事」，代码中确实没有相反实现）。

**唯一冲突（T25）**：不变量清单与 §11 都要求不删除原始事件，但 `retention.ts` 实现了带保留窗口的归档删除。**推测**：这不一定是错误——`README.md` 第 17 行自述「JSONL 长期运行边界均可配置或审计」，说明这是后来有意加入的运维能力。但文档侧从未记录这次决策的理由，这正是 mechanism §2.6 说的「只保存最终制品、不保存决策历史」的问题在本仓库自身的复现。**建议由成员判定**：是修文档（承认长期运行需要保留窗口）还是修代码（默认 `retentionDays: Infinity`）。

## 4. README 目标结构提案

现状问题（有证据）：README 42 行中 `## 当前状态` 12 条实质是变更日志（第 9 行「已建立 Git 仓库」已无信息量），且 `## 当前状态`（12 条含 7 个链接）与 `## 目录`（4 条链接）构成两份重复索引，5 个链接目标重复。缺失：安装、构建、测试、运行命令（只在 `AGENTS.md`）；三个包的架构概览与相互关系。

提案（章节级）：

| 章节 | 为谁而写 | 放什么 |
|---|---|---|
| 标题 + 一句话定位 | 所有人 | 现状第 3–5 行，保留 |
| `## 这个仓库有什么` | 第一次进来的人 | 三个包一句话各一行 + 一张依赖方向图（`dsh-bundle → dsh-adapter → skill-evolution`，箭头方向即架构红线方向） |
| `## 快速开始` | 要跑起来的人 | 从 `AGENTS.md` 引用（不复制）构建与测试命令；至少给一条能验证环境可用的命令 |
| `## 研究问题` | 研究者、写 spec 的人 | 现状 4 条，保留原样 |
| `## 研究原则` | 所有人，且是 constitution 一部分 | 现状 5 条，保留原样，一字不改 |
| `## 文档地图` | 要找依据的人 | 合并现状 `## 当前状态` 与 `## 目录`，每份文档一行「性质 + 一句话用途」，标出哪份是历史归档 |
| `## 当前进度` | 成员、接手的 agent | 一行「实现进度处于哪个阶段」+ 指向 issue，不再逐条堆变更日志 |

**推测**：`## 快速开始` 用引用而非复制是关键。`AGENTS.md` 是 constitution，命令一旦两处并存就会漂移——本次审计发现 `AGENTS.md` 第 10 行的 CLI 命令清单已经漏掉了 `failures`、`metrics`、`health`、`feedback`、`reject`、`defer`、`worker` 共 7 条（有证据：对比 `bin/dsh-skill-evolution.mjs` 第 27–41 行），这就是同一信息两处维护的代价已经发生的证明。

## 5. 命名与放置约定提案

### 5.1 先修正一处前提

任务描述称 `skill-进化设计-MVP.md` 「违反 `AGENTS.md` 的 kebab-case 约定」。**有证据：这个说法不准确。** `AGENTS.md` 第 32 行原文是「descriptive kebab-case package or skill names」——约束对象是包名与 Skill 名，不含文档文件名。仓库目前**没有**成文的文档命名约定。

因此这不是「违规」而是「无约定」。但**推测**：它确实是全仓库唯一的中英混排文件名，且 `-zh` 后缀在 `docs/` 下 4 份文档上一致出现，说明事实约定已经形成，只是没写下来，也没回头应用到这一个文件。

另有一处代价必须先说明（有证据）：`AGENTS.md` 第 11 行**逐字引用了** `skill-进化设计-MVP.md` 这个文件名。任何改名都必须同时改 `AGENTS.md`，而 `AGENTS.md` 是 constitution，属于必须升级给成员的改动。

### 5.2 约定提案（三选项）

**选项 A：全 ASCII kebab-case + `-zh` 后缀**

规则：文档文件名只用 `[a-z0-9-]`，中文文档统一 `-zh` 后缀，根目录只留 `README.md` 与 `AGENTS.md`，其余进 `docs/`。

需改动：`skill-进化设计-MVP.md` → `docs/skill-evolution-mvp-zh.md`。

- 代价：一次 `git mv`；改 `AGENTS.md` 第 11 行（constitution，需成员批准）；改 `README.md` 两处链接；`git log --follow` 之外的历史检索会变难。
- 风险：低。**推测**：跨平台与工具链上 ASCII 文件名更安全（`grep`、URL 编码、部分 CI），且与现有 4 份 `docs/*-zh.md` 一致。

**选项 B：只定约定，不改既有文件**

规则同 A，但明确「既有文件豁免，新增文件遵守」。

- 代价：零。
- 风险：约定与现实长期不符，下一个 agent 仍要判断「这个文件为什么不一样」。**推测**：这正是本次审计要解决的那类问题的成因。

**选项 C：不定 ASCII 约束，只定位置与后缀**

规则：允许中文文件名，只要求 `-zh` 后缀与「设计文档进 `docs/`」。

需改动：`skill-进化设计-MVP.md` → `docs/skill-进化设计-MVP-zh.md`（或只移动不改名）。

- 代价：仍需改 `AGENTS.md` 与 README 链接。
- 风险：中。中文文件名在部分工具链上的问题不会消失（本次审计中 `wc -l` 就输出了 `skill-????-MVP.md`，有证据）。

**取舍**：**推测**：A 的一次性代价最高但终局最干净；B 代价为零但把问题留给下一个人；C 是折中但保留了已经暴露过的工具链风险。本文不选，交成员决定。

## 6. 三份设计文档的权威归属：三个选项

任务要求给出多个选项及取舍，不给单一答案。三份文档的权威归属由成员决定。

**选项 1：architecture 为唯一实现权威，MVP 归档，mechanism 降为研究依据**

- 做法：`docs/architecture-design-zh.md` 加勘误节（按第 3 节 T5/T16/T18/T19/T20/T23 逐条改），MVP 加历史标注，mechanism 头部声明「不作为实现依据」。
- 代价：改 3 份文档的头部 + architecture 6 处勘误。约 1 天。
- 风险：mechanism 的第 1/2/3.1 节是 architecture 全部设计决策的论证来源，降级后 architecture 的「为什么」会悬空。**推测**：需要在 architecture 里补反向引用，否则下一轮修订会重新论证一遍。
- 历史决策损失：无（三份都保留）。

**选项 2：三份合并成一份「设计基线」，原文归档到 `docs/archive/`**

- 做法：新写一份统一设计，把三份的不重复内容并进去，原三份移入 `docs/archive/` 只读。
- 代价：最高。第 2 节矩阵里 5 处「冲突」每一处都要做一次实质裁决，且裁决依据必须回到代码。约 3–5 天。
- 风险：**高**。合并必然要裁掉一批内容，而三份文档里最有价值的部分恰好是各自独有的（MVP §7/§10、mechanism §1/§2、architecture §10）。
- **历史决策损失：这是唯一会真正丢失历史决策记录的选项。** 三份文档记录的是三次不同时点的设计判断；合并成一份「当前正确的设计」后，「为什么从 MVP 的 `candidate` 状态机换成现在 12 态」这类信息只剩 `git log`，而 `git log` 不含理由——mechanism §2.6 恰好论证了这正是不可接受的损失。**推测**：除非成员明确接受这个代价，不建议选。

**选项 3：不动三份，只加一份导航层（本文即其雏形）**

- 做法：三份原文一字不改，靠 README 的文档地图 + 本审计文档说明「哪份对哪部分有权威、哪些已过时」。
- 代价：最低。只改 README。
- 风险：读者必须读两份才知道一份是否可信。**推测**：四份路线图并存的问题没有被解决，只是被标注了。
- 历史决策损失：无。

**本文立场（推测）**：选项 1 与 3 的差别只在「勘误写在原文里还是写在导航层」。选项 1 的好处是读者读 architecture 时就知道 §18 过时；选项 3 的好处是原文保持时点完整性。二者可组合：原文加一行「本节已过时，见 `docs/doc-audit-zh.md` T18」的指针，既不改写原始判断，也不让读者踩空。

## 7. 每条建议的代价与风险汇总

| 建议 | 代价 | 风险 | 是否丢失历史决策 |
|---|---|---|---|
| 重写 README（第 4 节） | 低（1 份文件） | 低 | 会丢失 `## 当前状态` 的 12 条时间线。**缓解**：这 12 条信息全部可从 `git log` 与三个包 README 重建，且第 9 行「已建立 Git 仓库」已无信息量 |
| 修 `sources.md` 三处格式（第 1.7 节） | 低 | 低 | 否。去重时建议保留 AgentDojo 的 `v3` 链接并在注中记另一个链接 |
| 补 research-landscape 孤立列表标题（第 1.5 节） | 低 | 低 | 否 |
| 补 mechanism 缺失的 `## 4.` 标题并修 `## 3.1` 层级（第 1.3 节） | 低 | 低 | 否。**注意**：补标题会改变后续章节的引用编号语义——本文及 architecture 头部都按「§4」指代 `SkillArtifact` 那一节，补后一致，补前悬空 |
| MVP 加历史归档标注 | 低 | 低 | 否（不改正文） |
| architecture 加 6 处勘误指针 | 中 | 低 | 否（加指针而非改写原判断） |
| 合并三份设计文档（选项 2） | 高 | 高 | **是** |
| 改名 `skill-进化设计-MVP.md` | 中（连带改 `AGENTS.md`） | 低，但需成员批准 constitution 改动 | 否 |
| 补 `AGENTS.md` 第 10 行漏掉的 7 条 CLI 命令 | 低 | 低，但属 constitution 改动，需升级 | 否 |
| 统一四份路线图为一份进度表 | 中 | 中。**推测**：四份路线图的阶段划分本身是四次设计判断，压成一份进度表会丢掉「为什么这样分阶段」 | 部分。建议进度表只说「现在在哪」，不重写各文档的阶段划分 |
| 解决 T25（retention 与不变量冲突） | 低（文档侧）或中（代码侧） | 中。这是文档与代码的实质冲突，不是表述问题 | 否，但必须补一条决策记录说明选了哪边及理由 |
| 实现 T5（`evidenceState` 三态） | 高（跨 `types.ts`、`experience.ts`、`evaluator.ts`） | 中。**推测**：这是两份文档共同强调的防过度归因机制，代码零实现意味着当前系统无法在结构上阻止「用 observed-support 的证据说出因果结论」 | 否 |

## 8. 给下一阶段的输入

1. 四份路线图并存已被证据确认，且四份全部已被实现走完或绕过；Stage 2 写 requirements 时不应引用其中任何一份作为当前阶段依据。
2. `docs/architecture-design-zh.md` §10 的 12 条不变量是全仓库唯一可直接当验收清单用的内容，11/12 在代码中成立；建议作为 requirements 的 EARS 条目来源。
3. T5（`evidenceState` 三态未实现）与 T25（retention 删除与「不删除原始事件」冲突）是两处需要成员裁决的实质问题，不是文档表述问题。
4. 三份设计文档的权威归属有三个选项（第 6 节），其中选项 2（合并）是唯一会丢失历史决策记录的；建议成员显式选择。
5. `AGENTS.md` 有两处需要 constitution 级改动才能推进的依赖：第 11 行逐字引用 MVP 文件名（阻塞改名），第 10 行 CLI 清单漏 7 条命令。

## 9. 未解决 / 假设

1. **假设**：本审计以 `origin/main` @ `c7512d2` 为基线。若 Stage 2 开始前 `main` 有新提交，T 系列结论需重新核对。
2. **未解决**：T25 的取舍需成员判定（改文档还是改代码）。本文不代为决定。
3. **未解决**：三份设计文档的权威归属需成员判定（第 6 节三选项）。
4. **未解决**：文档命名约定需成员判定（第 5.2 节三选项），且选 A 或 C 都会触发 `AGENTS.md` 改动。
5. **未验证**：本文没有运行构建或测试。所有代码侧结论来自静态读取与 `grep`，判据是「符号是否存在、路径是否一致」，不涉及运行时行为。T17（canary 不在发布路径上）是读 `lifecycle.ts` 的 `manifestFor` 得出的，未用测试验证。
6. **未审计**：`CLAUDE.md`（24466 字节）是平台注入的运行时文件，不在任务给出的审计范围内，本文未审。
