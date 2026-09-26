# 设计：提问契约单一来源、实例事实剥离、tracker/运行时 seam（SKIL-36 S1）

基线 `origin/main` @ `c168579`。上游证据、行号、before/after 图见 SKIL-34 评论附件 `architecture-review-20260926.html`。本文只出设计，不改实现。用词按 `codebase-design`：module / interface / depth / seam / adapter / leverage / locality。

## 1. 现状：读了什么

- 提问契约两份：`skills/delivery-contract/SKILL.md:49-60`（「提问」一节）、`skills/grilling/SKILL.md:52-75`（issue-async 每轮 wakeup），被 `skills/orchestrate/SKILL.md:41,60` 引用。
- 实例事实散布：`skills/delivery-contract/SKILL.md:11,56`、`skills/orchestrate/SKILL.md:8,28,69,114` 六处硬编码成员 id `cb288268-…`（`grep` 复核为这 6 行）。
- tracker 文档双份且逐字节相同：`docs/agents/issue-tracker.md` 与 `skills/setup-matt-pocock-skills/issue-tracker-multica.md`（`diff` 输出 `IDENTICAL`，各 159 行）。
- 四个 tracker adapter：`skills/setup-matt-pocock-skills/issue-tracker-{github,gitlab,local,multica}.md`。二级标题数（`grep -c '^## '`）分别是 5 / 5 / 4 / 11。四家都齐备的是 `Conventions`、`publish`、`fetch`、`Wayfinding operations` 四节；`Pull requests as a triage surface` 只有 github、multica 有（gitlab 写成 `Merge requests as…`，local 无）；Multica 独有 6 节：`Labels`、`Status vs. label`、`report the path`、`Subagents`、`Mentions`、`Concurrent writes`。
- 标签两处：`docs/agents/triage-labels.md`（实例，含 `## Multica labels`）、`skills/setup-matt-pocock-skills/triage-labels.md`（模板，通用）。
- 运行时判定消费者：`grep -rln MULTICA_TASK_ID skills` 命中 7 个 skill——research、handoff、prototype、to-questionnaire、improve-codebase-architecture、grilling、setup-matt-pocock-skills（另有 issue-tracker-multica.md:5 是散文提及，非判定）。
- `MULTICA_TASK_ID` 的语义写错了：`issue-tracker-multica.md:5` 说它是「current issue's UUID」。本 run 实测 `MULTICA_TASK_ID=01a0ddcc-e547-…`，而 issue id 是 `01a0ddcc-e52d-…`，它是 task（run）id。7 个 skill 只用它判断「是否存在」，所以没出过事，但任何人拿它当 issue id 调 `multica issue get` 都会错。这条定义也该归 runtime seam 来写。
- 引用方向：`docs/agents/issue-tracker.md:151` 要求 `wayfinder` 跳过它自己的第 5 步（adapter 反向依赖某个 skill 的步骤编号）。
- 命令外泄：`skills/prototype/SKILL.md:28`、`skills/grilling/SKILL.md:61` 在 skill 正文里直接写 `multica` 命令。
- 平台事实（复核）：`multica workspace member list` 只有一名成员，`role: owner`，name `ack7`，user_id `cb288268-…`；本 issue `creator_id`/`assignee_id` 都是 agent（Mika、Architect），证实 grilling 从这两个字段取 member id 会拿到 agent。
- 可达性（复核 `multica agent get`）：skill 从工作区 skill 库加载，`docs/agents/*` 只在检出仓库的 run 里可读。Mika 的 system instructions 规定聊天回合「Never check out a repository」，而 orchestrate「入口」一节正是聊天回合，里面用到成员 id（`orchestrate:28`）。另外 Mika 只装了 `ask-matt`、`orchestrate`，**没装 `delivery-contract`**，但 `orchestrate:41,60` 要它按 delivery-contract 的「提问」执行——现有引用本就够不着。Triager 的 instructions 直接读仓库 `docs/agents/triage-labels.md`，所以 Triager 在 issue run 里有仓库。
- 一次性 run 的 runtime brief（本 run 的 CLAUDE.md「Background Task Safety」「Output」两节）已独立写明「不 background-and-yield」「本地路径不是交付物」。所以就算 run 里没有仓库文档，这两条后果仍有兜底。
- 无 `CONTEXT.md`、无 `docs/adr/`；架构红线（`AGENTS.md:14`）是「core 包不依赖 DSH 内部」，与本设计所在的 skill/文档层无关，但本设计自设一条同类红线（见 §7）。

## 2. 诊断：一个根因，三种表现

三项问题都是**同一份规则被复制到多处、各自漂移**，根因是三条 seam 没有各自的权威落点，彼此串味：

- **tracker seam**（issue 存在哪、用什么命令）：github / gitlab / local / multica。真 seam，但四家只在 4 节上齐备（Conventions / publish / fetch / Wayfinding），skill 引用的 `Concurrent writes`、`report the path` 等都只有 Multica 有。
- **runtime seam**（本 run 是否活过本回合）：交互会话 vs 一次性 run（`MULTICA_TASK_ID`）。这条 seam 没有落点，判定被抄进 7 个 skill，还被塞进 multica adapter。
- **instance facts**（本工作区的具体事实）：成员、agent 拓扑、标签现状、路由。没有落点，硬编码进 skill，还渗进通用模板。

「提问并等待」（问题 2）是骑在 tracker seam 上的一个复合操作，被复制两份；「report the path / 收敛 subagent」（问题 7 的一半）本属 runtime seam，却被写进 tracker adapter。把三条 seam 各归其位后，三项问题都收敛成「一处定义、别处引用」。

## 3. 目标 seam 模型

三条 seam，各有一个权威 module，skill 只按名字引用、不复制：

| seam | 权威落点 | 被什么变化拉扯 | 变化频率 |
|---|---|---|---|
| tracker | 四个 `issue-tracker-*.md` 模板（adapter），接口对齐；setup 原样拷一份为 `docs/agents/issue-tracker.md` | 换 tracker（接第二种）、tracker 命令改版、wakeup 语义变 | 低 |
| runtime | 新模板 `skills/setup-matt-pocock-skills/runtime.md`，setup 原样拷为 `docs/agents/runtime.md`（唯一定义） | 接第二种运行时（换环境变量）、收敛/交付规则再调 | 低 |
| instance | 新 `docs/agents/instance.md`（本工作区事实，只在本仓库，不进模板） | 第二名成员、agent 增减、标签变动、路由调整 | 中 |

依赖方向（本设计的红线，§7 D-3）：

```
skill ──▶ runtime ──(按节名)──▶ tracker
  │                               ▲
  ├───────────────────────────────┘
  └──▶ instance
tracker、instance 不依赖任何东西：不点名 skill 的步骤编号，不点名 agent。
```

这直接修掉现状里 `issue-tracker.md:151` 的反向依赖（adapter 点名 wayfinder 第 5 步、research agent）。

`git log` 的改动热度印证落点选择：delivery-contract 改 6 次、grilling 5 次、orchestrate 5 次、issue-tracker-multica 5 次——都是被上面这些 seam 的规则反复牵动。把规则收进单一 module 后，同一次规则变更从「改 N 个文件」变成「改 1 个」（locality），且能用 `grep`/`diff` 机械验证只剩一处（见 §8）。

## 4. 问题 2 设计：ask-and-wait 单一来源

### 现状与缺陷

`delivery-contract` 与 `grilling` 各写一份「提问 → 按负责人决定是否注册 wakeup → 注册只认成员的 wakeup → 结束 run」。两份已漂移：delivery-contract 硬编码成员 id 且不带 `--parent`/`--instruction`；grilling 带这两个 flag，但让你「从触发评论作者，或 issue 的 `creator_id`/`assignee_id`」取 member UUID。后一条分支只在「负责人不是自己」时走，此时 assignee/creator 往往是 agent（已复核 SKIL-39 两字段皆 agent），于是 `--filter-actor-type member --filter-actor-id <agent-id>` 的 wakeup **永不触发**——一条静默失败路径。

这是一个 depth 该属于 tracker adapter 的操作：wakeup 是 Multica 独有机制，「问人并等回复」在 github/local 上根本没有等价物。把它放进 skill，等于让每个 skill 各自实现一遍一个 tracker 专属操作。

### 选项

**选项 2-A（推荐）：作为 tracker adapter 的一节 `## Ask a person and wait`。**
Multica adapter 写全：负责人分支判断、member 解析方式、完整 `wakeup create` 命令、`--parent`/`--instruction` 语义。github/gitlab/local 该节写 `n/a`（一次性 run 无异步回捞机制，只能交互会话内等）。delivery-contract 和 grilling 删掉各自的实现，改成「按 tracker 文档的 `Ask a person and wait` 一节执行」。
- 复杂度：低。一处深实现，两处退化成引用。
- 可测性：`grep -rl 'wakeup create' skills docs` 应只命中 adapter 一个文件。
- 可逆性：高，纯文档重排。
- 迁移成本：改 adapter ×1 + delivery-contract + grilling，删两份重复。

**选项 2-B：抽成独立 `docs/agents/ask-and-wait.md`，与 tracker 平级。**
- 复杂度：多一个文件；但该操作 90% 是 tracker 命令（comment add + wakeup），脱离 tracker 后反而要在两处间跳转。
- 可测性：同 2-A。
- 迁移成本：略高，且和 runtime/instance 的落点不成体系。
- 判断：这操作的变化和 tracker 命令强绑定（wakeup flag 变、comment 语义变），放 tracker adapter 内 locality 更好。**不推荐**。

**选项 2-C：权威定义留在 `delivery-contract` skill，grilling 引用它。**
- 优点：skill 从工作区 skill 库加载，不依赖仓库检出。
- 缺陷：grilling 是通用 skill，引用一个工作区专属 skill 就把实例依赖带进了通用层。而且够不着的问题反而更多：Triager 装了 grilling、没装 delivery-contract；Mika 两个都没装（§1 可达性）。**不推荐**。

推荐 2-A。可达性前提：所有执行 ask-and-wait 的 run 都检出了本仓库。现状满足：Triager、Cartographer、各执行 agent 的 issue run 都读仓库；Mika 唯一不检出仓库的场景是聊天回合，而那里不提问（§5 把它唯一用到成员 id 的一步移走）。这个前提列为 §7 D-5。

### member 解析（修 bug 的关键）

权威节里 member id **不从 `creator_id` / `assignee_id` 取**，这两个字段可能是 agent。取法：

1. 触发本 run 的评论作者是 member（`author_type == member`）时，用它的 `author_id`。这是在问回复者本人，最精确。
2. 否则用「拍板人」：`multica workspace member list --output json`，取 `role == owner` 那条的 `user_id`。注意取 `user_id`，不是 `id`：`id` 是 membership id，wakeup filter 认的是 user id（复核输出里两者不同）。

「拍板人 = 工作区 owner」是一条实例策略，写在 `instance.md`（§5），adapter 只写「按实例文件的拍板人规则解析」和上面的查询命令。问题 2 先于问题 6 交付时，这条规则先临时写在 adapter 里，问题 6 再把策略那半句移到 `instance.md`。

### `Ask a person and wait` 的 interface（给 Spec Writer）

- **输入**：`issue`（要提问的 issue id）、`body`（已写好的问题正文文件）、`thread`（可选，回复所在的 `--parent`）、`next`（可选，下一次 run 的一句话指令）。
- **行为**：① `comment add --content-file` 发问题（有 `thread` 时带 `--parent`）；② 读 `issue` 的 `assignee_id`：是自己就不注册；否则按上面的规则解析 member，注册 `--kind event --event comment.created --mode once --filter-actor-type member --filter-actor-id <user_id>`，有 `thread`/`next` 时带 `--parent` / `--instruction`；③ 结束本 run，不轮询。
- **不负责**：问题的格式（编号、默认答案或推荐答案，由调用方 skill 定）、issue 状态（delivery-contract 置 `blocked`，grilling 不改）。机制和策略分开，两个调用方才都能用。
- **完成判据**：评论已发出；负责人不是自己时，`wakeup list <issue>` 里有这条，且它的 actor id 是 member 的 user id；负责人是自己时 `wakeup list` 里没有新增项。
- **非 Multica adapter**：github / gitlab / local 这一节写明「交互会话：在会话里问、在会话里等。一次性 run：本 tracker 没有回捞机制，n/a」。

## 5. 问题 6 设计：实例事实剥离

### 现状与缺陷

- `docs/agents/issue-tracker.md` 与模板 `issue-tracker-multica.md` 逐字节相同，靠手工维护副本（0881e31 同一处改动两边各加 8 行）。
- 模板里带本仓库实例事实：`issue-tracker-multica.md:48`「This mapping is fixed for this repo」、SKIL 编号示例、`:151` research/wayfinder 的 agent 路由——装到别的仓库会一并带过去。
- 成员 id 硬编码 6 处；「工作区唯一成员」假设写在两个 skill 里。
- 标签规则矛盾：`triage-labels.md:28`「工作区已有这些 `wayfinder:*` 标签」（断言已存在）vs `issue-tracker-multica.md:42`「新工作区 `label list` 返回 `[]`，首次使用时创建」（断言不要假设存在）。

### 选项

**选项 6-A（推荐）：独立实例文件 `docs/agents/instance.md`，模板与安装副本逐字节相同。**
模板 `issue-tracker-multica.md` 去掉全部实例事实，变成纯通用；`docs/agents/issue-tracker.md` 是它的原样拷贝。新建 `docs/agents/instance.md`，只在本仓库，不进 setup 模板。
- 复杂度：多一个文件，每类事实只写一次。
- 可测性：`diff` 模板与安装副本应无输出；`grep -rn cb288268 skills docs` 应只命中 `instance.md`。
- 可逆性：高。
- 迁移成本：6 处 id 改成引用；模板里的实例句子搬进 instance.md；标签矛盾裁定一条（见下）。

**选项 6-B：安装副本 = 模板 + 文末「本仓库覆盖」一节。**
- 优点：少一个文件，读 tracker 文档时实例事实就在旁边。
- 缺陷：模板和安装副本不再相同，「无漂移」没法用一条 `diff` 验，只能 `diff` 去掉最后一节后的前缀，脚本更脆。成员 id 这类不属于 tracker 的事实（orchestrate 订阅用）也被塞进 tracker 文档，seam 串味。**不推荐**。

**选项 6-C：带占位符的参数化模板**（`<MEMBER_ID>` 由 setup 填充）。
- 缺陷：skill 还是没法按名字引用，delivery-contract/orchestrate 只能把填好的值再抄一遍，没做到单一来源。**不推荐**。

### `instance.md` 的 interface

按节组织，节名就是引用名，skill 写「见 `docs/agents/instance.md` 的 `<节名>`」：

| 节 | 内容 | 迁入来源 |
|---|---|---|
| `## Decision maker` | 拍板人规则：「工作区 owner（当前唯一成员 ack7）」。解析命令引 tracker adapter（`workspace member list` → `role == owner` 的 `user_id`）；可附当前 user_id 作核对值，注明「以查询结果为准」 | `delivery-contract:11`、`orchestrate:8` |
| `## Subscribers` | 新建父/子 issue 时订阅谁：拍板人 | `orchestrate:28,69,114` |
| `## Labels in this workspace` | 当前已建标签快照（5 个 triage + 5 个 `wayfinder:*`），注明「快照，可能过期，以 `label list` 为准」 | `triage-labels.md:17-34` |
| `## Agent routing` | 通用 skill 在本团队的接线：`wayfinder:research` 票指派给 Scout，map owner 跳过 wayfinder 的「Fire the research subagents」步 | `issue-tracker-multica.md:151` |

**边界**：orchestrate 的路由表和 stage 模板是本团队编排本身，本来就是实例层 skill，不搬；搬的只是**通用模板和通用 skill 里**的实例事实，以及 orchestrate/delivery-contract 里的**原始 id**。agent id 仍按现有规则现查（`multica agent list`），不写进 instance.md。

### 可达性处理：orchestrate 聊天回合

`orchestrate:28`（入口第 2 步 `subscriber add`）在聊天回合执行，Mika 在聊天回合不检出仓库，读不到 instance.md。两个办法：

- **6-R1（推荐）**：把 `subscriber add <parent>` 挪到父 issue 的第一次 run（「路由并建 Stage 1」开头），那里有仓库。代价：成员订阅晚一个 run，父 issue 从新建到订阅之间约几十秒，成员不会漏掉什么，因为 Stage 1 还没建。入口一节就不再依赖任何实例事实。
- **6-R2**：入口一节直接用 tracker 查询（`workspace member list` 取 owner）。不依赖仓库，但「订阅 owner」这条策略又在 skill 里写了一份。

### 标签矛盾的裁定

只保留一条规则：「标签是工作区对象，按名解析；找不到就创建；不硬编码 UUID」，放在 tracker adapter 的 `## Labels`（模板，通用）。`instance.md` 只放「本工作区现在有哪些」的快照，写明「快照，以 `label list` 为准」，和「找不到就创建」不冲突。`docs/agents/triage-labels.md` 删掉 `## Multica labels` 一节，回到和模板 `triage-labels.md` 逐字节相同。Triager 的 instructions 里指向 `triage-labels.md` 查 label id 的那句要随之改指 tracker adapter 的 `## Labels`（agent 配置，不在仓库里，见 §9）。

## 6. 问题 7 设计：tracker interface 补齐 + runtime seam 抽出

### 现状与缺陷

multica adapter 长出 6 个别家没有的节，其中两类本不属 tracker seam：`report the path`（交付决策）、`Subagents: fan out then converge`（收敛规则）属 runtime seam；`MULTICA_TASK_ID` 判定被 7 个 skill 各抄一份。to-tickets/triage/wayfinder/handoff/research 直接引用只有 Multica 才有的节，换 adapter 即悬空。

### 选项

**选项 7-A（推荐）：三文件分离——补齐 tracker interface + 抽出 runtime.md。**
见 §3 模型。runtime seam 独立成 `docs/agents/runtime.md`；tracker adapter 接口对齐（每节都在，不适用写 `n/a`）；交付的**决策**归 runtime、**机制**（怎么 attach）归 tracker adapter 的 `## Deliver an artifact`。
- 复杂度：中。改动面大但每处机械。
- 可测性：见 §8 的 grep/diff 清单。
- 可逆性：高（文档重排）。
- 迁移成本：改 4 个 adapter + 6 个消费 skill + 建 2 个文件。

**选项 7-B：runtime 规则塞进每个 tracker adapter 的一节。**
- 缺陷：runtime 与 tracker 无关，四个 adapter 会各带一份相同的 runtime 节——把 7 份重复挪成 4 份重复，还绑错 seam。删除测试：删掉 tracker seam，runtime 规则不该消失（与 tracker 无关），故不属这里。**不推荐**。

**选项 7-C：合并成单个 `docs/agents/agents.md`。**
- 缺陷：三种变化频率挤一个文件，并发写易冲突，换 tracker 时无法只选一个 adapter。违反 locality。**不推荐**。

**选项 7-D：runtime 做成一个 model-invoked skill（如 `run-boundary`），不做成文档。**
- 优点：skill 从工作区 skill 库加载，不依赖仓库检出。`writing-for-agents/SKILL-MECHANICS.md:9` 也认可「全是 reference 的 model-invoked skill 可以做共享 reference 的家」。
- 缺陷：每个用到它的 agent 都要单独装（现在 6 个消费 skill 分布在 Scout、Cartographer、Architect、Prototyper、Triager 等身上），漏装一个就又悬空。description 会常驻每个 agent 的上下文。现有 skill 已经约定「按 tracker doc 的某节」引用 `docs/agents/*`，换成 skill 会多出第二种引用方式。**不推荐**；如果以后出现「无仓库的一次性 run 也要用这些 skill」，再重新考虑。

推荐 7-A。无仓库时的兜底：Multica 的 runtime brief 已经独立规定「不 background-and-yield」「本地路径不是交付物」（§1），所以 `docs/agents/runtime.md` 不在时，后果仍受 brief 约束。runtime.md 缺失的处理沿用 `code-review:13` 的现有惯例：「缺 `docs/agents/*` 就让用户跑 `/setup-matt-pocock-skills`」，每个 skill 不再各写一份兜底判定。

### tracker interface：每个 adapter 必须有的节

每个 `issue-tracker-*.md` 都要按下面的顺序出现这些 `##` 标题，一字不差；不适用的节正文写 `n/a` 加一句原因。adapter 内部可以有自己的 `###` 小节（如 Multica 的「Long bodies always go through a file」「Never merge stderr」），但 skill 只能引用 `##` 这一层，`###` 是 adapter 私有实现。

| # | `##` 标题 | 回答什么 | 现状 → 处置 |
|---|---|---|---|
| 1 | `Conventions` | 增删改查、评论、状态、指派的命令 | 四家都有 |
| 2 | `Triage state` | 五个 triage 角色怎么记录（标签 / 标签 + 状态 / `Status:` 行），标签怎么解析和创建 | Multica 的 `Labels` + `Status vs. label` 合并进来；github/gitlab 从 Conventions 抽出；local 从 Conventions 的 `Status:` 那行抽出 |
| 3 | `Pull requests as a triage surface` | PR/MR 是否算请求入口 | github、multica 已有；gitlab 的 `Merge requests as…` 改成统一标题，正文写 MR；local 写 n/a |
| 4 | `When a skill says "publish to the issue tracker"` | 发布 | 四家都有 |
| 5 | `When a skill says "fetch the relevant ticket"` | 读取 | 四家都有 |
| 6 | `Deliver an artifact` | 文件怎么交给读者（附件、PR、inline）——**机制** | 由 Multica 的 `report the path` 拆出：「该不该报路径」的决策移到 runtime.md，这里只留「怎么附」。github：`gh` 评论不能带附件，写「提交进仓库或 inline」；local：写文件到 `.scratch/` 即交付 |
| 7 | `Concurrent writes` | 认领怎么表示、哪些写入在并发下安全 | Multica 已有；github：assign 即认领、评论可追加；local：`Status: claimed`、单人使用写 n/a 也可 |
| 8 | `Mentions` | 评论里的哪些写法有副作用 | Multica 已有；github/gitlab：`@user` 会通知；local：n/a |
| 9 | `Ask a person and wait` | 问人、等回复、回来继续 | 新增，见 §4 |
| 10 | `Wayfinding operations` | map、子票、阻塞、frontier | 四家都有；Multica 的 `:151` agent 路由移到 instance.md |

从 Multica adapter 移出、不再是 tracker 节的：`Subagents: fan out, then converge inside the turn` → runtime.md；`report the path` 的决策部分 → runtime.md。

### runtime.md 的 interface

| `##` 节 | 内容 |
|---|---|
| `Which mode am I in` | 唯一判定：`MULTICA_TASK_ID` 在环境里（或 runtime brief 说本回合退出即任务终止）→ **one-shot run**；否则 → **interactive session**。写明 `MULTICA_TASK_ID` 是 task（run）id，不是 issue id |
| `Subagents: fan out, converge before the turn ends` | 从 Multica adapter 原样搬来：并行派发、退出前收齐、禁 background-and-yield、禁 poll/sleep；放不进本回合的就做成后续 issue 或 wakeup |
| `Delivering a file` | 决策：interactive → 路径就是交付；one-shot → 路径不是交付，改按 tracker 的 `Deliver an artifact` 交付。原 `report the path` 的三分支（进仓库 / 附件 / inline）放这里 |

消费 skill 的写法统一为：「按 `docs/agents/runtime.md` 的 `Which mode am I in` 判定；one-shot 时按 `Delivering a file` 交付。」然后只写本 skill 自己特有的那部分后果（如 handoff 在交互会话写进 OS 临时目录、prototype 在交互会话推 throwaway 分支）。

### 7-A 内的具体处置

- **6 个判定 skill**（research、handoff、prototype、to-questionnaire、improve-codebase-architecture、grilling）删掉各自的 `MULTICA_TASK_ID` 推导，改为引用 runtime.md 的节名。`setup-matt-pocock-skills` 用 `MULTICA_TASK_ID` 是为了**选 tracker**，用途不同，保留；它还要把 runtime 模板一起装进 `docs/agents/`。
- **引用改名**：to-tickets:66、triage:77、wayfinder:127 的「Concurrent writes」保持（节名不变）；research:30、handoff:12、improve-codebase-architecture:41、to-questionnaire:18、ask-matt:75 的「tracker doc's "report the path"」改指 runtime.md `Delivering a file`；research、grilling:77、wayfinder 的「fan-out-and-converge」改指 runtime.md；grilling:54 的「file-backed bodies」改指 tracker 的 `Conventions`。
- **命令外泄**：`prototype:28` 的 `multica issue comment add --attachment` 移进 tracker 的 `Deliver an artifact`；`grilling:61` 的 wakeup 命令在问题 2 已移走。
- **反向依赖**：`issue-tracker-multica.md:151` 移到 instance.md `Agent routing`（问题 6 已处理）。

## 7. 不可逆决策

这里全是 Markdown，git 能回滚。「不可逆」指的是：定下之后，消费方（skill 文本、agent instructions、已装到别的仓库的模板）会按它写，以后再改就要全量迁移。

| # | 决策 | 推荐 | 为什么难改 | 状态 |
|---|---|---|---|---|
| D-1 | tracker interface 的 10 个 `##` 标题（§6 表），标题即引用名 | 按 §6 | skill 按标题引用，改名就要改所有引用；装到别的仓库的旧副本不会跟着改 | 已确认（ack7 回复「默认」，2026-09-26）|
| D-2 | 实例事实放独立文件 `docs/agents/instance.md`，不进 setup 模板；模板与 `docs/agents/issue-tracker.md` 逐字节相同 | 6-A | 这是 setup 的输出契约：别的仓库装出来的文件布局由它决定 | 已确认（ack7 回复「默认」，2026-09-26）|
| D-3 | 依赖方向：skill → runtime → tracker，skill → instance；tracker 与 instance 不点名任何 skill 或 agent | 按 §3 | 方向一旦反过来（adapter 点名 skill 步骤），换 adapter 或改 skill 都会互相牵动 | 已确认（ack7 回复「默认」，2026-09-26）|
| D-4 | 拍板人 = 工作区 owner，按 `workspace member list` 的 `role == owner` 取 `user_id`；触发评论作者是 member 时优先用作者 | 按 §4 | 这是 wakeup 能否触发的唯一依据；第二名成员加入后，是「谁问谁答」还是「永远问 owner」要另定 | 已确认（ack7 回复「默认」，2026-09-26）|
| D-5 | 可达性前提：执行 ask-and-wait、引用 `docs/agents/*` 的 run 都检出了本仓库；orchestrate 入口的订阅挪到父 issue 第一次 run（6-R1） | 2-A + 6-R1 | 权威定义放在仓库文档而不是 skill，是这个前提下的选择；前提不成立时要改成 7-D（skill 化），是整体迁移 | 已确认（ack7 回复「默认」，2026-09-26）|
| D-6 | runtime 是新 seam，落为 setup 模板 `runtime.md` + 安装副本 `docs/agents/runtime.md` | 7-A | 同 D-2，影响 setup 输出契约 | 已确认（ack7 回复「默认」，2026-09-26）|

依本 agent 的职责，不可逆决策要请成员拍板；问题和默认答案在本 issue 的交接评论里。成员回「默认」即全部按上表推荐执行。ack7 已于 2026-09-26 回复「默认」，D-1…D-6 全部确认，Spec Writer 可按 §6/§8 直接拆 `tasks.md`。

## 8. 实现顺序与模块边界（给 Spec Writer 拆 `tasks.md`）

按 2 → 6 → 7。每步都能单独合并，合并后仓库处于一致状态。

### 第 1 步：问题 2 —— ask-and-wait 单一来源（S）

改动模块：
- `skills/setup-matt-pocock-skills/issue-tracker-multica.md` + `docs/agents/issue-tracker.md`：新增 `## Ask a person and wait`（§4 interface，member 解析规则先临时写在这里）。两文件保持逐字节相同。
- 另外三个 adapter：新增同名节，正文 n/a（§4 末尾）。
- `skills/delivery-contract/SKILL.md`：「提问」一节只留调用方策略（一次问完、编号 + 默认答案、置 `blocked`、结束 run），机制改为「按 tracker 文档的 `Ask a person and wait` 执行」。删 `:11` 的成员 id 行、`:53-57` 的分支与命令。
- `skills/grilling/SKILL.md`：issue-async 第 2 步只写「按 tracker 文档的 `Ask a person and wait` 执行，`thread` 传触发线程，`next` 传本轮指令」。删 `:55-69`。

验证：
- `grep -rl 'wakeup create' skills docs/agents` 只命中两份 multica tracker 文档（模板 + 安装副本）
- `grep -rn 'creator_id\|assignee_id' skills/grilling` 无输出
- `diff skills/setup-matt-pocock-skills/issue-tracker-multica.md docs/agents/issue-tracker.md` 无输出

### 第 2 步：问题 6 —— 实例事实剥离（S）

改动模块：
- 新建 `docs/agents/instance.md`（§5 interface 四节）。把第 1 步临时放在 adapter 里的「拍板人 = owner」策略移进来，adapter 只留查询命令。
- `issue-tracker-multica.md` + 安装副本：删 `:48`「fixed for this repo」、`:151` agent 路由；SKIL 编号示例改成中性写法（如 `ABC-10`）。
- `docs/agents/triage-labels.md`：删 `## Multica labels`，回到与模板相同。
- `skills/orchestrate/SKILL.md`：`:8` 改为引用 instance.md `Decision maker`；`:28` 的订阅挪到「路由并建 Stage 1」开头（6-R1）；`:69,114` 改为「订阅 instance.md `Subscribers` 里的人」。
- `skills/delivery-contract/SKILL.md`：若第 1 步后还有「工作区唯一成员」字样，改为引用 instance.md。
- `AGENTS.md` 的 `## Agent skills`：加一行指向 `docs/agents/instance.md`。

验证：
- `grep -rn 'cb288268' skills docs` 只命中 `docs/agents/instance.md`
- `diff docs/agents/triage-labels.md skills/setup-matt-pocock-skills/triage-labels.md` 无输出
- tracker 模板与安装副本 `diff` 无输出
- `grep -n 'this repo' skills/setup-matt-pocock-skills/issue-tracker-multica.md` 只剩通用语义的句子（逐条人工看）

### 第 3 步：问题 7 —— tracker interface 补齐 + runtime seam（M，可拆 3a/3b 两张票）

**3a：runtime seam**
- 新建 `skills/setup-matt-pocock-skills/runtime.md` + 安装副本 `docs/agents/runtime.md`（§6 interface 三节）。
- 从 multica adapter 删掉 `Subagents…` 一节和 `report the path` 的决策部分（机制部分留给 3b 的 `Deliver an artifact`）。
- 6 个判定 skill 与 ask-matt:75 改引用（§6「具体处置」）。
- `setup-matt-pocock-skills/SKILL.md`：第 3、4 步的文件清单加上 `runtime.md`；`AGENTS.md` 的 `## Agent skills` 加 `### Runtime` 一行。
- 修 `:5` 的 `MULTICA_TASK_ID` 语义（改由 runtime.md 定义为 task id，tracker 文档不再提它）。

**3b：tracker interface 补齐**
- 四个 adapter 按 §6 表补齐 10 个 `##` 节、统一标题、按表顺序排列。
- `prototype:28` 的命令移进 `Deliver an artifact`；grilling:54 的引用改指 `Conventions`。
- setup `SKILL.md` 里「Multica template carries its own triage role → status/label mapping」的说法改为指向统一的 `Triage state` 节。

验证：
- `grep -rln 'MULTICA_TASK_ID' skills docs/agents` 只命中 runtime.md（模板 + 副本）和 `setup-matt-pocock-skills/SKILL.md`
- 对四个 adapter 各跑 `grep '^## ' <file>`，输出与 §6 表的 10 行逐行相同
- `grep -rnE 'multica (issue|label|attachment)' skills --include=SKILL.md` 只剩 orchestrate、delivery-contract（实例层 skill，允许）
- 所有 `docs/agents/*` 安装副本与模板 `diff` 无输出（instance.md 除外，它没有模板）

### 依赖关系

第 1 步不依赖其他步。第 2 步依赖第 1 步（要从 adapter 里把策略移出去）。3a 依赖第 2 步（multica adapter 已经干净，才好拆）。3b 依赖 3a（`report the path` 先拆成决策 + 机制两半）。四张票串行，放在四个 stage，或者一个 stage 里用 `Blocked by:`。

## 9. 不在本设计范围

- **agent instructions 里的引用**：Triager 的 instructions 让它去 `docs/agents/triage-labels.md` 查 label id（第 2 步之后应改指 tracker 的 `Triage state`）；Mika 没装 `delivery-contract`，orchestrate:41,60 却让它按 delivery-contract 的「提问」执行（第 1 步之后应改指 tracker 的 `Ask a person and wait`）。这两处在 agent 配置里、不在仓库里，实现时要有人同步改，建议在第 2 步的票里点名。
- 已经装到别的仓库的旧模板副本：不迁移，下次跑 `/setup-matt-pocock-skills` 时自然更新。
- 扫描报告里的其他条目（1、3、4、5、8、9、10）：代码侧，不在本票。
