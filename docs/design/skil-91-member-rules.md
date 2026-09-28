> 状态：SKIL-91 的成员规则与同步方案。平台 skill 副本由「Skill 同步」autopilot 按 `docs/governance/documentation.md` 自动同步；该 autopilot 失败时才使用其中的手动备用步骤。

何时读：修改成员订阅、提问对象、回复归属、无回复升级，或排查仓库 skill 与平台副本漂移时。实例事实以 `docs/agents/instance.md` 为准，通用 tracker 机制以 `docs/agents/issue-tracker.md` 为准。

## 规则摘要

- **订阅**：父 issue 在描述中记录 `需求提出人 user_id`；每个 child 继承该行。提出人按有效记录行、显式 `unresolved` 回退 Decision maker、触发评论 member 作者、`creator_type == member` 时的 `creator_id`、Decision maker 的顺序解析。需求提出人与 Decision maker 都订阅父 issue 和每张子 issue；按 `user_id` 去重。没有可解析的需求提出人时只订阅 Decision maker。
- **提问**：业务判断直接采用推荐答案并记录「采用默认答案，成员可推翻」；不可逆决策、权限或花费问 Decision maker。提出人就是 Decision maker 时只问这一人。一个受保护问题只指定一个目标。
- **回复归属**：只有被问目标的 member 回复算回答。其他成员的回复保留为上下文，不触发目标过滤的 wakeup，也不改变等待计时。
- **无回复**：业务判断不会等待；不可逆、权限或花费问题 2 天提醒目标，4 天再次提醒并在目标不是 Decision maker 时转给 Decision maker，7 天置 `backlog` 等 Decision maker 安排。完整操作见 `skills/orchestrate/PATROL.md` 与 `skills/delivery-contract/SKILL.md`。

这些规则写入 ADR-0017（订阅/提问/回复）、ADR-0018（受保护问题无回复升级）和 ADR-0019（默认业务判断与文档 PR 合并）；ADR-0017 只取代 ADR-0012 的目标选择顺序，ADR-0012 的已验证 `user_id` 身份约束继续有效。

## 成员位置盘点

盘点依据：仓库 `rg -rn 'cb288268|member|成员|subscriber|订阅' skills docs/agents specs`，以及平台 `multica skill get <id> --with-content --output json` 和 `multica agent list --output json`。`user_id` 是成员身份的统一来源；membership id、agent id、issue `creator_id` / `assignee_id` 都不是成员身份，只有 `creator_type == member` 时的 `creator_id` 是本票明确记录的例外。

| 位置 | 当前性质 | 成员事实/硬编码 | SKIL-91 处理 |
|---|---|---|---|
| `docs/agents/instance.md:5-20` | 生效的实例事实 | 只有这里保留当前 owner 的 `user_id`；Decision maker 与 Subscribers 规则在这里落地 | 保留 owner 查询规则；新增需求提出人 + Decision maker 的去重订阅集合 |
| `docs/agents/issue-tracker.md:59-70` | 生效的 Multica adapter | 原来只有 author/owner 两分支，没有多成员目标和回复归属 | 改为目标解析、目标过滤 wakeup、非目标回复不唤醒，并与 setup 模板逐字节同步 |
| `skills/setup-matt-pocock-skills/issue-tracker-multica.md:59-70` | 可安装模板 | 与 `docs/agents/issue-tracker.md` 是同一份 tracker 契约 | 与安装副本同步修改；`cmp` 作为验收 |
| `skills/orchestrate/SKILL.md:32-51,72-76,119-122` | 生效的仓库 skill | 已引用 `instance.md`，但订阅示例仍以 Decision maker 单数描述 | 改为遍历 `Subscribers` 集合；不写具体成员 ID |
| `skills/orchestrate/PATROL.md:1-58` | 生效的仓库 skill | 原第 4 查只把未回复列入摘要，没有提醒、转交或默认处理 | 写入 2 / 4 / 7 天升级表，目标由提问评论记录 |
| `skills/delivery-contract/SKILL.md:74-79` | 生效的仓库 skill | 提问只要求默认答案，未规定目标类别和无回复处理 | 写入目标、类别、时间戳、目标过滤和升级表引用 |
| `docs/design/skil-36-seams.md`、`docs/governance/documentation.md` | 历史记录/治理记录 | 记录过旧 owner 硬编码、ADR-0011/0012/0013 的背景；不是运行时入口 | 保留历史证据；规则以本票新增 ADR 和 `docs/agents/*` 为准 |
| `specs/skil-36-seams/tasks.md` | 历史任务记录 | 含旧成员 ID 命中，是已完成任务的证据，不是运行时规则 | 保留，不作为身份来源；统一来源仍是 `docs/agents/instance.md` |
| 平台 `orchestrate` skill（2026-09-26T11:14:41Z） | 当前生效的安装副本 | `SKILL.md` 的订阅/提问/交接命令仍直接写旧 owner `user_id`；`PATROL.md` 仍是旧四查 | 本 PR 不直接改平台；合并后由「Skill 同步」autopilot 同步，失败时按治理文档的 `refresh` 或 `update` + `files upsert` 备用步骤，再用 `skill get` 复核 |
| 平台 `delivery-contract` skill（2026-09-26T10:22:18Z） | 当前生效的安装副本 | `SKILL.md` 的成员标识和 wakeup 命令仍直接写旧 owner `user_id` | 本 PR 不直接改平台；合并后由「Skill 同步」autopilot 从仓库内容同步，失败时使用治理文档的手动备用步骤 |
| 11 个 agent instructions（Mika、Scout、Cartographer、Architect、Spec Writer、Builder、Reviewer、Sleuth、Triager、Prototyper、Scribe） | 平台 agent 配置 | 未发现成员 `user_id` 硬编码；大多只引用 `delivery-contract` 或 tracker adapter | 不直接改平台 agent；只在本 PR 记录需要变更的原文 → 新文预览 |

仓库验收命令 `grep -rn 'cb288268' skills docs/agents` 应只命中 `docs/agents/instance.md`。平台副本中的旧值不计入仓库 grep；「Skill 同步」autopilot 负责仓库合并后的副本更新，不同步平台智能体指令、不删除 skill，也不给新导入的 skill 绑定智能体。

## Agent instructions 预览（不直接修改平台）

Triager 的 `ready-for-human` 动作需要与新的订阅集合一致：

| Agent | 原文 | 拟改新文 |
|---|---|---|
| Triager | 把成员加为订阅者 | 把 `docs/agents/instance.md` 的 Subscribers 集合（需求提出人 + Decision maker，按 user_id 去重）加为订阅者。 |

其余 10 个 agent instruction 只写“成员”或调用通用 adapter，没有身份硬编码，不需要为本票改文案。平台 agent 更新须在成员确认这份预览后由 Mika 执行。
