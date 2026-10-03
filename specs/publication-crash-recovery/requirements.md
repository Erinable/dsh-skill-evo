# Publication 崩溃恢复：可验证需求

SKIL-139 / SKIL-122 Stage 2。背景为 `docs/design/publication-crash-recovery.md`；持久协议见 ADR-0032，台账契约见 ADR-0021，转移合法性见 ADR-0004，锁回收见 ADR-0007，JSONL 修复见 ADR-0020。设计稿是背景，不是规范源。本三件套约束实现，以下验收编号保留上游 §4 的名称。

## 需求

### R-1 提交点与输入

WHEN 新 Promote 或 Rollback 开始提交 THE SYSTEM SHALL 持有该 Skill 的发布锁，先完成适用校验、将正文持久化到候选目录或确认完整目标快照，再原子写入 `publications/<skill>.json`；journal SHALL 保存 design.md §2 的确定输入且不含正文，写成之前不得更改发布文件或发布事实，写成之后 SHALL 只前滚。

### R-2 文件收尾

WHEN 收尾一个可信 journal THE SYSTEM SHALL 从持久正文验证 hash，按 design.md §3 的固定顺序补齐快照和 live 文件，仅在字节不同的时候写文件，所有新生成时间 SHALL 取 journal 的 `startedAt`；旧快照缺半时 SHALL 仅在 live hash 仍等于 `from.contentHash` 时补齐。

### R-3 事实收尾与删除

WHEN journal 带 `record` THE SYSTEM SHALL 按固定顺序用确定 id 追加 Observation、适用的 Skill 级 Decision record、Ledger record 及其 transition decision，已有 id SHALL 不重复追加，已写台账但缺 decision SHALL 补齐；只有所有步骤成功之后 SHALL 删除 journal。WHEN journal 不带 `record` THE SYSTEM SHALL 只做文件和 invalidate 步骤，不写事实记录。

### R-4 恢复入口与锁顺序

WHEN Promote、Rollback、reject 或 repair 遇到该 Skill 的 journal THE SYSTEM SHALL 在该 Skill 的发布锁内先执行同一个 `completePublication` 再继续自身操作，且从写 journal 到删除 journal 全程持锁；嵌套取锁 SHALL 仅按「发布锁 → store 锁」顺序。

### R-5 重跑与空操作

WHEN 完成旧 journal 后该 Proposal 最新为 `promoted` 且 current 版本和 hash 等于其候选 THE SYSTEM SHALL 在 artifact 解析/过期校验之前返回成功（operations 返回 `promoted: true`）且不写任何发布文件或事实。WHEN Rollback 的目标版本和 hash 已是 current THE SYSTEM SHALL 成功返回且不写文件、记录或改变 Proposal status。

WHEN 同参数重跑 `explicit-only` Promote 且该 root 最新为 promoted、其持久 adoption 的 scope/version/hash 匹配该候选 THE SYSTEM SHALL 同样直接成功且不写文件或事实，不以 live 已被替换为条件。

### R-6 唯一晋升校验

WHEN dry-run、operations 真 Promote 或 `service.promote` 校验未发布的 Proposal THE SYSTEM SHALL 使用同一 `resolvePromotionArtifact` 与纯函数 `checkPromotion`，按最新台账、持久 artifact、current、当前 policy 和 now 检查 design.md §4 的全部条件并抛相同 `OperationError.code`；dry-run SHALL 不取发布锁、不写文件，真 Promote SHALL 在锁内完成读取、校验和提交。

### R-7 台账守卫

WHEN 从 `accepted` 或 `promoted` 出发做台账转移 THE SYSTEM SHALL 在所属 Skill 的发布锁内先收尾，再按 root 重读最新台账验证合法性；reject SHALL 最多等锁 5s，超时报告已有的发布进行中错误。WHEN root 尚无台账记录 THE SYSTEM SHALL 沿用传入对象；守卫 SHALL 位于 service，台账不得依赖 publication。

### R-8 可重试与不可完成

WHEN 收尾遭遇 I/O、store 锁或 invalidate 的可重试错误 THE SYSTEM SHALL 按 design.md §6 的入口表保留或隔离 journal 并报告结果。WHEN 收尾遭遇台账永久冲突、正文缺失/hash 不符或新 journal 非法 THE SYSTEM SHALL 先持久化带原始 journal 原文的隔离文件，再删除活动 journal、保持已前滚文件，并按入口表报告 `publication-conflict`、继续操作或 `quarantined`；隔离持久化失败 SHALL 保留活动 journal 并报错。

### R-9 回滚对象

WHEN Rollback 写入新 journal THE SYSTEM SHALL 在锁内、收尾或隔离旧 journal 之后，按 design.md §5 推断一次 source/target Proposal 并持久化；无唯一 source SHALL 仅写文件和 Skill 级记录，不转移任何 Proposal，重跑/repair SHALL 不从改变后的 live 再推断对象。

### R-10 纯读

WHEN `readCurrent`、`healthIssues`、`healthReport`、metrics 或 dry-run 读取发布状态 THE SYSTEM SHALL 不收尾、不回收发布锁、不修改发布文件或 journal；发布锁为 `held` 时 SHALL 照常读取 live，每个文件按原子替换后的实际内容返回，正文与 manifest hash 不符时按正文计算 hash，不为取得一致组合而取发布锁。

### R-11 health

WHEN `healthReport()` 运行 THE SYSTEM SHALL 保留 `jsonl`、`skillIssues`，新增 design.md §7 的 `publications` 和 `quarantinedPublications`，以只读扫描新/旧 journal 和隔离文件、`inspectLock` 标注状态；坏 journal SHALL 返回带 `error` 的条目而不使整份报告抛错，空集合 SHALL 为 `[]`，隔离文件未被成员删除期间 SHALL 持续报告。

### R-12 repair

WHEN `service.repair()` 运行 THE SYSTEM SHALL 依次回收可回收锁、修复 `layout.stores` 及 Observation Archive segment 的 JSONL、在不持 store 锁时逐个 Skill 尝试发布锁（`waitMs: 0`）收尾、检查 manifest、强制刷新 Projection；报告 SHALL 保留原字段并新增 `publications`。WHEN 锁为 `held` 或 `foreign` THE SYSTEM SHALL 不回收或更改该 Skill 发布，报告 `skipped-locked`；单 Skill 收尾失败 SHALL 记录 `failed`/`quarantined` 并继续下一 Skill。

### R-13 旧 journal

WHEN repair 或下一次写入口发现旧 `<skill>/.publish.json` THE SYSTEM SHALL 只兼容读取而不生成新旧格式 journal，按 design.md §8 的规则恢复文件与可确定的事实并报告 `legacy: true`；非法版本/路径越界 SHALL 保留旧文件原字节、repair 报 `failed`，且不得阻挡后续 Promote/Rollback。

### R-14 位置、模块与兼容接口

WHEN 构建发布模块或报告接口 THE SYSTEM SHALL 从 layout 派生 publications 与 quarantine 路径，不将 journal 放入 `layout.stores`；`publication.ts` SHALL 集中 journal I/O、收尾、检查与 repair，文件步骤不依赖 service。既有 service/SkillVersionStore/operations 公开签名和 CLI/bundle JSON 输出 SHALL 保持兼容，`OperationError` 从 `errors.ts` 由 operations 再导出。

### R-15 台账实现切换

WHEN SKIL-121 的 ADR-0021 实现尚未合并 THE SYSTEM SHALL 用 `<root>:promoted`/`<root>:rolled-back` 和固定 `startedAt` 的临时幂等台账步骤。WHEN 该实现合并且本 spec 的切换 task 执行 THE SYSTEM SHALL 改用 `ProposalLedger.transition` 的 `previousRecordId + targetStatus` 幂等与确定 decision id，保持 journal 格式和本文件全部验收不变，不在本工作内实现编号规则。

## 验收口径

总判据：每个崩溃点分别用同参数重跑一次、或只调用 `service.repair()`；结果与独立目录里成功执行一次的 `publicationState` 相等。比较全部 Skill 文件（时间戳归一化后逐字节）、`.skill-evolution/publications/`、proposals/decisions/observations 的全部 JSONL 记录及每个 root 最新状态。原复现 helper 会排除原子写临时文件；候选目录不是发布状态，P0 写候选不改变这一比较。P0、R0 的 repair 例外是与操作前相等。除不可完成（G2–G6）外，不允许通过忽略缺失记录或放宽判重封口。无写入断言另外比较相关文件原字节和写入计数，不能靠归一化隐藏重写。

### Promote（每行重跑、repair 各一条）

| ID | 注入点/状态 | 收敛要求 | Requirements |
|---|---|---|---|
| P0 | journal 写成之前，仅候选已写 | 重跑正常执行；repair 不发布，等于操作前 | R-1、R-4 |
| P1a | `versions/<to>/SKILL.md` 之前，空版本目录 | 快照 → live → 记录全部补齐 | R-2、R-3 |
| P1b | live `SKILL.md` 之前，目标快照完整 | 已一致的版本文件不重写，从 live 继续 | R-2、R-3 |
| P1c | live `manifest.json` 之前，正文新版 | 从 manifest 补齐，不报 stale-base | R-2、R-4、R-5 |
| P1d | `current.json` 之前，live 两文件新版 | 从 current 补齐 | R-2、R-3 |
| P1e | invalidate 抛错 | 重试 invalidate 后补事实 | R-2、R-3、R-8 |
| P1f | 有 1.0.0 manifest，旧快照缺 manifest | live 仍为 from，补旧快照后继续 | R-2 |
| P2 | Observation 之前 | 补 `adoption:<root>`、台账及 decision | R-3 |
| P3 | Ledger record 之前，Observation 已写 | Observation 去重，补台账及 decision | R-3 |
| P4 | transition decision 之前，台账已 promoted | 台账识别已写，补 decision，返回成功 | R-3、R-5 |

- **H1（R-11、R-12）**：P3 后 `publications` 恰好一条，含 `{ skillName, operation: 'promote', proposalId, fromVersion: 'unversioned', toVersion: '1.1.0' }`；repair 一条 `completed`，之后 health 为 `[]`、Proposal 为 `promoted`。
- **H2（R-10）**：P1c 后 health 前后的 `publicationState` 完全相同。
- **H3（R-5）**：成功 Promote 后重跑返回 `promoted: true`，无任何写入；另覆盖 journal 收尾后 artifact 已过期仍返回成功。
- **H5（R-10、R-11）**：存活进程持发布锁且有 P3 journal，health 不抛错、条目 `lock === 'held'`；readCurrent 返回实际 live，不报 already in progress；两者不改变状态。

### Rollback（先发布 1.0.0、1.1.0，再回滚至 1.0.0；每行两条）

| ID | 注入点/状态 | 收敛要求 | Requirements |
|---|---|---|---|
| R0 | 新 journal 之前 | 重跑正常执行；repair 等于操作前 | R-1 |
| R1a | live manifest 之前，正文已回滚 | 补 manifest/current/记录；from 仍为 1.1.0，hash 正确 | R-2、R-3、R-9 |
| R1b | current 之前，manifest 已回滚 | source 仍为 journal 内的 proposal-two，不重新推断 | R-2、R-9 |
| R1c | invalidate 抛错 | 重试 invalidate，补记录 | R-2、R-8 |
| R2 | Observation 之前 | id 时间取 startedAt | R-3 |
| R3 | Skill rollback decision 之前 | Observation 不重复，补 decision | R-3 |
| R4 | Ledger record 之前 | 前两条事实不重复，补台账 | R-3 |
| R5 | transition decision 之前 | 识别台账已写，补 decision | R-3 |

- **H4（R-5）**：回滚到已是 current 且 hash 相同的版本，无任何写入，不改变 Proposal status；所有收尾后的同参数重跑均命中 H4。

### 守卫、失败与回滚对象

- **G1（R-4、R-7）**：P1c 后经 `reviewProposal` reject 同一 Proposal，先收尾再拒绝，状态等于一次成功 Promote；只接受 `invalid-transition`（切换前）或 `conflict`（切换后），断言 code。
- **G2（R-8、R-9、R-11、R-12）**：有 1.0.0 完整快照，P1c 后绕过协议直接追加 rejected。分别验证 repair 隔离（live 1.1.0、台账 rejected、活动 journal 消失、隔离文件恰好一份、raw 与原 journal 逐字节相同、health 隔离恰好一条）；下一次 Promote 另一个以 1.1.0 为 Base 的 Proposal 隔离后正常发布；直接 Rollback 至 1.0.0 隔离后成功、不转移 rejected Proposal。
- **G3（R-8）**：与 G2 相同的完整旧快照场景，P1c 后删除候选正文；单独测试直接 Rollback 成功、repair 报 `quarantined`。
- **G4（R-8、R-9）**：完整旧快照场景，P3 后 proposals 的下一次 append 只抛一次错误。分别验证下一次 Promote 报 `publication-pending`、状态不变；下一次 Rollback 隔离后成功，原 Proposal 仍 accepted、health 隔离一条，之后原 Proposal 再 Promote 成功；repair 报 `failed`、保留 journal，去掉注入再 repair 报 `completed`、等于成功一次。
- **G5（R-8、R-12）**：G2 repair 后再 repair 不报告该 Skill，隔离文件字节不变且仍只有一份。
- **G6（R-9）**：先发布 proposal-one 1.0.0、proposal-two 1.1.0；accept proposal-crash（Base 1.1.0、目标 1.2.0），P1c 后删候选，repair 隔离，live 正文 1.2.0、manifest 1.1.0。随后无活动 journal 的 Rollback 至 1.0.0，one/two 仍 promoted、crash 仍 accepted，无 rolled-back 记录；新 Observation 无 sourceProposalId、targetProposalId 为 one，health 隔离仍一条。

### 校验与兼容

- **C1（R-6）**：Base version 不匹配，dry-run 与真 Promote 都报 `stale-base`、不写文件或事实。
- **C2（R-6）**：持久 artifact 的 result policy 不匹配，operations dry-run 与 service.promote 都报 `evaluation-mismatch`。
- **C3（R-6）**：design.md §4 的状态、artifact 来源/证据、归属、Base hash/version、候选 hash、policy、过期、caseIds、gate、文档/变更校验每行有表驱动测试及明确期望 code；包含空 caseIds 比对和成功控制组。
- **L1（R-3、R-13）**：仅旧 journal、完整目标版本目录、台账 accepted，repair 前滚文件、补 Observation/台账/decision，报告 `legacy: true`；另在台账 append 后让 decision 失败，下一次 repair 识别同次 promoted 并补唯一 decision，最后删除旧 journal。
- **L2（R-13）**：`evolution.spec.ts` 的五种不可信旧 journal 经 repair 后字节原样、报告 `failed`。
- **L3（R-14）**：design.md §9 指定的读时恢复旧测试迁移后通过，core、adapter、bundle 测试全绿。

新增防护验收：repair 在 held/foreign 锁下不改 journal 并报 skipped-locked；单 Skill 失败不阻断另一 Skill；坏新 journal 被 health 报 error、repair 隔离；隔离写失败时原 journal 留存；explicit-only 不发布 live/versions；直接 SkillVersionStore 无 `record` 不生成事实。归属 R-1–R-4、R-8、R-10–R-14。

explicit-only service Promote 在 Observation/Ledger/decision 前分别注入失败，重跑与 repair 均只补事实、不写 live/versions、不 invalidate；成功后的同参数重跑即使 artifact 过期也无写入（R-3、R-5）。

## 范围外

本票只写 spec 和确认已有 ADR，不实现代码、不建 Builder 票。台账转移本身及 record id 规则归 SKIL-121 / SKIL-135；架构扫描 SKIL-109 第 5–7 项、多 Skill 原子发布、真实 user/stable 生效面及删除旧兼容/隔离文件均不在范围内。
