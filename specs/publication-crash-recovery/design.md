# Publication 崩溃恢复设计

本 spec 将 SKIL-122 Stage 1 的背景设计落实为可实施契约。持久协议、位置、锁、前滚与隔离决定见 ADR-0032；台账格式与幂等决定见 ADR-0021，不在这里重定。ADR-0032 在本 PR 标为 accepted：成员确认：SKIL-124（PR #80 由成员合并）。按 SKIL-139 的指示视同确认，采用默认答案，成员可推翻。`docs/design/` 仅作历史背景。

## 1. 架构与数据流

最高测试入口为公开 maintenance operations（`promoteProposal`、`rollbackSkill`、`reviewProposal`）与 `EvolutionService.healthReport/repair`；直接 service.promote 用同一数据验证错误码。测试采用默认答案，成员可推翻。纯校验的表驱动测试为补充，文件层用公开 SkillVersionStore 验证无 record 的协议。

| Module | 职责与依赖 |
|---|---|
| `state-root.ts` | layout 新增 `publicationsDir`、`publicationJournalPath(skillName)`、`publicationQuarantineDir`，分别派生于 stateDir/publications、其 `<skill>.json`、其 quarantine；原九个 stores 不变 |
| `errors.ts` | 持有 OperationError/OperationErrorCode（新增 publication-pending、publication-conflict）；operations 和 index 保持原有导出位置兼容 |
| `promotion-check.ts` | 纯 resolve/check，共用现有 document/change validator、Proposal root 解析及错误类型；不读磁盘、不依赖 service/operations |
| `publication.ts` | journal I/O、验证、`completePublication`、隔离、`inspectPublications(layout)`、`recoverPublications(layout, deps)`；通过依赖对象使用文件步骤、ObservationLog、台账步骤、decisions |
| `lifecycle.ts` | 文件不变量、字节比较与原子替换、invalidate；公开 promote/rollback 委托 journal 协议（无 record），不导入 service 或业务台账 |
| `service.ts` | 注入依赖、发布锁、提交前读取/校验、回滚对象、reject 守卫、health/repair 接线；service → publication → 文件/记录依赖，无反向 service 依赖 |
| `operations.ts` | 选项/文件读取、CLI 结果映射；dry-run 调公共纯校验，真 Promote 委托 service 共享发布入口 |

避免 `publication ↔ lifecycle` 循环：publication 用注入的文件步骤接口；lifecycle 可委托 publication，但 publication 不在运行时导入 SkillVersionStore。service 已持锁时调用 unlocked 文件步骤，不再嵌套公开 versions.promote/rollback 取同一发布锁。台账绝不导入 publication，守卫由 service 编排。

## 2. Journal 持久形态

```ts
interface PublicationJournal {
  readonly v: 1
  readonly operation: 'promote' | 'rollback'
  readonly skillName: string
  readonly scope: PublicationScope
  readonly proposalId?: string
  readonly from: { readonly version: string; readonly contentHash: string }
  readonly to: { readonly version: string; readonly contentHash: string }
  readonly startedAt: string
  readonly record?: {
    readonly fromRecordId?: string
    readonly targetProposalId?: string
    readonly reason: string
    readonly actor: string
    readonly policyVersion?: string
    readonly evidenceIds: readonly string[]
  }
}
```

Promote 必有 proposalId（root）；service Promote 必有 record/fromRecordId。Rollback 的 proposalId/fromRecordId 可缺省，record 仍存在以写 Skill 级事实。直接 SkillVersionStore 无 record。scope 为 explicit-only 时文件发布与 invalidate 步骤为空，只使用候选文件并做 service 记录，不生成版本快照、不替换 live。

journal 使用原子临时文件 + rename。校验 v、operation、scope、skillName、版本号、hash/时间/record 类型及派生路径边界；沿用现有 skillName/version 语法，任何路径不得越过 layout 对应根目录。未知 v、不合法新 journal 均为不可完成。raw 保留读取到的原始 UTF-8 文本，不能 parse 再 stringify。升级策略见 ADR-0032。

Promote 前已持久化 `candidateDir(root)/SKILL.md` 与 `proposal.json`（现有 writeCandidate 行为），hash 必须等于 journal.to；proposal.json 提供 manifest 的 parentVersion、generatedBy 等确定元数据，使无台账的直接 store 调用也可由 repair 收尾。Rollback 必须从完整 `versions/<to>` 读取正文和原 manifest、验证正文 hash 与 journal.to，一旦新 journal 写成，不再依赖调用方手中对象。

新 Promote manifest 的 createdAt/updatedAt 与派生事实时间取 startedAt，其他字段遵循现有 manifestFor；Rollback 保留目标快照原有 createdAt 等元数据，更新 live 的 updatedAt 为 startedAt（不重写历史目标快照）。旧版本快照保留原 live manifest 元数据。不存在原 manifest 的旧版本不建有版本号的快照；unversioned 从读取结果记录 hash。数据格式决定见 ADR-0032，这些字段生成规则保持现有公开文件形态。

## 3. 收尾顺序与幂等

`completePublication(journal, deps)` 要求调用者已持该 Skill 发布锁；deps 为内部注入参数，唯一收尾算法不按入口复制。journal.from/to 及 record 元数据是固定输入，不能重新生成时间或重新推断 source。每个文件逐字节比较，不同才原子替换。invalidate 可重复，失败不能删 journal；外部 hook 应接受至少一次调用，不能承诺 exactly-once 外部副作用。

| 步骤 | Promote | Rollback |
|---|---|---|
| 1 | 旧快照：from 有版本号且缺半时，仅在 live hash = from.hash 时补齐；已有快照 hash 不符拒绝 | 按目标完整快照写 live SKILL.md → manifest.json → current.json |
| 2 | 目标 versions/<to>/SKILL.md → manifest.json | invalidate |
| 3 | live SKILL.md → manifest.json → current.json | append rollback Observation |
| 4 | invalidate | append Skill rollback decision |
| 5 | append adoption Observation | 有 fromRecordId 时转移至 rolled-back、补 transition decision |
| 6 | 转移 fromRecordId 至 promoted、补 transition decision | 删除 journal |
| 7 | 删除 journal | — |

Promote Observation id `adoption:<root>`，occurredAt = startedAt，payload 保持 proposalId/scope/effectiveAt: next-load。Rollback Observation id `rollback:<skill>:<to>:<ms(startedAt)>`，Skill decision id `decision:rollback:<skill>:<to>:<ms(startedAt)>`；fromVersion/fromContentHash 来自 journal.from，sourceProposalId 来自 proposalId（存在才填）、targetProposalId 来自 record.targetProposalId，toContentHash 来自 journal.to；decision 的 actor/reason/evidence 来自 record。append false 表示已存在，不再重复产生事实。

临时台账步骤（SKIL-121 未合并）：promoted、rolled-back 对每个 root 各只能进入一次，按确定 `<root>:<status>` 判重；transitions 使用 startedAt 作为 updatedAt，transition decision 保持现有 id 形态但固定时间，createdAt 也用 startedAt。检查既有目标记录属于本次转移；仅当出发记录已被同一次目标记录取代时视为完成，否则永久冲突。缺 decision 时补写，不被 `invalid-transition` 早退。SKIL-121 合并后的步骤由 Task 4 替换为 ADR-0021 transition，发布模块不拼编号、用 journal.fromRecordId 精确定位输入。

接口补全问题 Q3（business judgment）：已合并的 `specs/proposal-ledger-transition/design.md` 的 TransitionInput 尚无固定时间字段，而 ADR-0032 要求所有时间取 startedAt。推荐 Task 4 为 TransitionInput 添加可选 `occurredAt: string`，发布收尾传 startedAt；新台账 updatedAt 与其 decision.createdAt 使用该值，未提供时保留台账原来的时钟行为。replay 使用已持久化记录的 updatedAt 补 decision，不以本次时钟重建；不改写已有事实。采用默认答案，成员可推翻。这是满足 ADR-0032 的加性时间输入，不更改 ADR-0021 的编号、判重或转移合法性；Task 4 负责最小接线与测试，不重做 SKIL-121。

重跑：先收尾旧 journal，再按最新台账与 current 版本/hash 判断已经发布成功，命中时跳过 artifact（即使过期）、不做任何写入；Rollback 完成旧 journal 后 current 版本/hash 等于目标即返回。显式选项校验仍在入口进行。没有 journal 的非 dry-run 才进入正常校验和新提交。

explicit-only 的同参数重跑改以最新 promoted 加持久 `adoption:<root>` 为凭据：payload.scope 为 explicit-only，skill.version/contentHash 匹配该候选即可，不检查 live 等于候选。不同 scope 不当作同次成功；沿正常校验拒绝非法状态。无 record 的 store explicit-only 没有事实或 live 完成标记，只承诺活动 journal 的文件空步骤可收尾，不扩大 R-5 的 service 重跑保证。

## 4. 唯一晋升校验

```ts
interface PromotionCheckInput {
  readonly proposal: SkillProposal
  readonly artifact: EvaluationArtifact
  readonly current: CurrentSkill | undefined
  readonly policyVersion: string
  readonly now: number
}
function checkPromotion(input: PromotionCheckInput): void
function resolvePromotionArtifact(
  evaluations: readonly EvaluationArtifact[],
  proposal: SkillProposal,
  supplied?: SkillEvalResult | EvaluationArtifact,
): EvaluationArtifact
```

resolver 支持 evaluation 文件解析后的 artifact/result、调用方对象、该 root 最新未过期的持久 artifact。id 精确查找；未给对象时按持久写入顺序选最后一个未过期匹配 artifact。supplied result 必有 artifactId，与持久 result 按现有 sameResultEvidence 的六项逐项比；supplied artifact 按现有 sameArtifactEvidence 的十五项逐项比（顺序敏感 caseIds）。持久证据不得以 supplied 内容替代。resolver 的内部时钟可注入以稳定过期测试，不另公开 API。保留 `requires a persisted evaluation artifact`、`supplied evaluation does not match` 消息子串。

| 校验顺序 | 条件 | 错误码 |
|---|---|---|
| resolver | 缺 artifactId、id 查无持久 artifact、无未过期 artifact | evaluation-missing |
| resolver | supplied shape 不完整或证据与持久版本不一致 | evaluation-mismatch |
| check 1 | 最新 Proposal 不是 accepted | invalid-transition（SKIL-121 stale ref conflict 由入口映射） |
| check 2 | artifact.proposalId/candidateId/result.candidateId 任一不等 root | evaluation-mismatch |
| check 3 | current 缺失或 current/expectedBase/artifact Base hash 不一致 | stale-base |
| check 3 | current version 非 unversioned 且不等 proposal.baseVersion | stale-base |
| check 4 | artifact/result candidate hash 任一不等候选 hash | evaluation-mismatch |
| check 5 | artifact/result policy 任一不等当前 policy | evaluation-mismatch |
| check 6 | artifact.expiresAt <= now | evaluation-mismatch |
| check 7 | proposal.comparisonCaseIds 不等 artifact.caseIds（包括空数组） | evaluation-mismatch |
| check 8 | artifact 或 result 的 passedGate 为 false | gate-failed |
| check 9 | validateSkillDocument 或 validateSkillCandidate 不通过 | evaluation-mismatch |

校验取现有两边并集，resolver 保持已有证据字段核对；新增表驱动测试每次只破坏一项，确认对应 code，不改变 policy/Gate 的本身规则。

service 内部共享 `publishPromotion({ proposalRef, supplied?, scope, reason }): Promise<{ replayed: boolean }>`：定位 Skill → 发布锁 → 收尾 → 重取 root 最新记录 → 已发布成功判断 → resolver → readCurrent → check → writeCandidate → journal → complete。内部方法可经一个 service 委托方法供 operations 使用，属于可逆接线选择；现有 `service.promote(proposal, evaluation, scope, reason): Promise<void>` 签名保持不变。operations 真 Promote 在 scope 检查与 evaluation 文件解析后委托同一入口，不保留锁外状态检查/precheck（否则 P4 仍被阻断）。dry-run 则取最新台账 → resolver → readCurrent → check，返回现有 preview，不取锁、不恢复。

`service.verifyEvaluation` 使用 resolver。lifecycle 删除 publication 路径中的业务重复检查，只保留名称/路径、版本目录内容冲突、历史快照 hash 等文件不变量；直接公开 store 入口仍保留 expectedBase 的文件 CAS 保护，document/change 检查复用同一底层 validator，不复制业务 artifact/台账规则。

## 5. 守卫与回滚对象

从 accepted/promoted 出发的三条边：accepted → promoted、promoted → rolled-back、accepted → rejected。前三个维护入口全部在 Skill 发布锁内先收尾、重读最新台账。reject 等锁最多 5s；调用方旧对象不能跳过重读，root 没有台账才用传入对象。stage/evaluate/accept/defer 不扩大到发布锁；后续新增 accepted/promoted 出发边也须遵守守卫。转移合法性见 ADR-0004，守卫不下沉进台账。

Task 4 后，reject 的调用方 accepted 引用在收尾后已被 promoted 取代时，service 映射为 typed conflict，不把重读的 promoted 当作本次新来源再调用 transition（那会得到 invalid-transition）。台账本身的合法性检查顺序保持 SKIL-135 契约不变；Task 3a 的临时步骤仍返回 invalid-transition。

Rollback 在收尾/隔离后、写 journal 前只推断一次：

1. 本次隔离过旧 journal：取其 proposalId，仅当对应最新记录仍 promoted 时作为 source；否则无 source，结束判断，不能再按 live 猜另一个 Proposal。
2. 没有本次隔离：计算 live SKILL.md 实际 hash；在该 Skill 最新为 promoted 的 Proposal 中匹配候选 hash。恰一条就是 source；多条时按 live manifest version = proposedVersion 筛，仍不唯一则无 source。
3. source 存在才存 proposalId 和最新 fromRecordId。无 source 时不写 sourceProposalId、不转移任何 Proposal。
4. target 是该 Skill 最新 promoted、proposedVersion = 目标、候选 hash = 目标完整快照 hash 的唯一 root；不唯一则省略，只用于 payload、不触发转移。

正文与 manifest 不一致时以正文为准，from.version 仍记录实际 live manifest version、from.hash 记录实际正文 hash。无 source 不影响回滚文件与 Skill 级事实。隔离后 accepted Proposal 可再次 Promote（G4）；已有 adoption id 不重复写，保留隔离那次事实。此业务判断沿用上游默认答案，采用默认答案，成员可推翻。

## 6. 错误处理与隔离

可重试：I/O、store 锁、invalidate。不可完成：台账 conflict/invalid-transition、输入正文缺失/hash 不符、新 journal 解析/v/版本/路径非法。`completePublication` 返回或抛可区分的失败给入口，不由错误字符串猜类别。

| 入口 | 可重试 | 不可完成 |
|---|---|---|
| 本次操作已提交 | 原错误抛出，保留 journal | 隔离后抛 publication-conflict |
| 下一次 Promote | publication-pending，带路径和 cause，不启动新发布 | 隔离后基于实际 live 校验并正常执行 |
| 下一次 Rollback | 隔离后正常回滚 | 隔离后正常回滚 |
| reject | publication-pending，不做 reject 写入 | 隔离后正常重读/校验/转移 |
| repair | failed，保留 journal，继续下一 Skill | quarantined，继续下一 Skill |

“不写”指不启动新操作/台账转移；收尾此前已成功的前滚步骤保持。G4 注入发生在任何新收尾字节之前，故该用例要求整个 publicationState 不变。

隔离路径 `publications/quarantine/<skill>-<ms>-<pid>-<uuid>.json`，内容 `{ v: 1, skillName, quarantinedAt, by, error, raw }`，by 为 promote/rollback/reject/repair。必须先原子持久化隔离文件，再删活动 journal；失败保留 journal，不继续新操作。代码不删隔离文件、不回退 live、不补造缺失事实。G5 用 journal 已移除后的再次 repair 验证没有重复隔离。

## 7. Health 与 repair 接口

以下为有效 journal 的接口，全部 readonly：

```ts
interface UnfinishedPublication {
  readonly skillName: string
  readonly operation: 'promote' | 'rollback'
  readonly proposalId?: string
  readonly fromVersion: string
  readonly toVersion: string
  readonly startedAt?: string
  readonly journalPath: string
  readonly stage: 'files' | 'records'
  readonly legacy: boolean
  readonly lock: LockState['kind']
  readonly error?: string
}
interface QuarantinedPublication {
  readonly skillName: string
  readonly path: string
  readonly quarantinedAt: string
  readonly by: 'promote' | 'rollback' | 'reject' | 'repair'
  readonly error: string
  readonly operation?: 'promote' | 'rollback'
  readonly proposalId?: string
  readonly toVersion?: string
}
interface PublicationRepair {
  readonly skillName: string
  readonly operation: 'promote' | 'rollback'
  readonly proposalId?: string
  readonly toVersion: string
  readonly outcome: 'completed' | 'skipped-locked' | 'failed' | 'quarantined'
  readonly legacy: boolean
  readonly error?: string
  readonly quarantinePath?: string
}
```

healthReport 保留 jsonl/skillIssues，新增 `publications`、`quarantinedPublications`；EvolutionRepairReport 新增 `publications`。healthy 空集合输出 []。新增字段自动经 CLI/bundle 现有原样 JSON 输出，保留原调用签名。

inspect 只扫描活动 `publications/*.json`、各 Skill 的旧 .publish.json、quarantine，并用 inspectLock，不取发布锁、不回收锁。live 版本/hash 都等于 to 时 stage = records，否则 files；explicit-only 文件步骤为空，因此 stage = records。坏 journal 的 fromVersion/toVersion 为空串、error 为解析/校验原因，不使整个报告失败。quarantine 的可解析 raw 可提供 operation/proposalId/toVersion；这些元数据不可解析时省略，仍报告文件。

接口补全问题 Q1（business judgment）：上游接口把 operation 写成必填，但无法解析的 raw 不可能知道操作。推荐在坏 journal 报告分支允许 `operation?: undefined`（有效报告仍保留上表必填类型），用判别联合表达，不伪造 promote；PublicationRepair 的坏 journal 分支同理，toVersion 为空串、error 必填。采用默认答案，成员可推翻。这是报告字段扩展，不改变持久 journal 格式。Task 3c 验收必须覆盖不可解析 JSON 的这两个报告分支。

repair 顺序固定：sweep 可回收锁（ADR-0007）→ 按 layout.stores 修 JSONL 与 Observation Archive segment（ADR-0020）→ 释放所有 store 锁后逐 Skill 发布锁 waitMs:0 收尾 → inspectManifests → force Projection。journal 不属于 store。当前 repairEvolutionRoot 把 sweep/JSONL/manifest 包在一起，service 集成时拆成内部阶段，以保证 manifest 检查在收尾之后；独立 repairEvolutionRoot 原签名/现有语义不变，不给无依赖调用虚构事实收尾。锁失败 reported skipped-locked；单 Skill 失败不影响其他 Skill；Projection 成功后原 projectionCursorRebuilt 标记仍为 true。

纯读 readCurrent/healthIssues 去掉 withMutationLock 和 recoverPublication。取回的每个 live 文件完整，但组合可为新正文/旧 manifest；hash 重算维持现有规则。propose/evaluate 也不收尾；新 Promote 的锁内 check 校验实际 Base，读产生的旧 Base 不可发布。store 自身读取锁沿用，不在本票扩展其初始化/读取行为；本 spec 的纯读无写断言针对已存在的发布状态、Skill 文件与 journal。

## 8. 旧 journal 兼容

仅只读识别 `<skill>/.publish.json` 的 `{proposalId, version, contentHash}`。repair/下一次写入口持发布锁按旧规则：版本目录不完整则删除该目录和旧 journal，不能从不完整快照推定已发布；完整且 hash 相符则前滚 live。非法版本或路径越界原样保留、repair failed，不挡新 Promote/Rollback。不得通过 readCurrent 隐式兼容收尾。

文件收尾成功后若能精确查到对应 accepted root 且候选 hash 相符，补 W2–W4；否则仅做文件步骤并报告 legacy: true。补写固定输入：startedAt 为旧文件 mtime；fromRecordId 为最新 accepted；policy/evidence 为同候选 hash 最新持久 artifact（允许过期），没有 artifact 则 policy 缺省、evidence []；reason = recovered legacy publication，actor = service operator（缺省 maintainer）。文件 mtime 在完整收尾前不能改变。

旧 journal 也必须覆盖台账已写、decision 未写的重试：若最新为 promoted，只有其候选 hash/目标版本匹配且 updatedAt 等于旧 journal mtime 的 startedAt，才识别为本次已写转移。临时记录从该 root 历史定位唯一 accepted 来源；ADR-0021 记录从 previousRecordId 精确取 accepted 来源。恢复同一 fromRecordId 并补缺 decision 后才删旧 journal；其他 promoted 或无法确定来源的记录只走文件兼容分支，不推造转移。L1 在 Ledger append 后注入 decision 失败，下一次 repair 必须补一次 decision，不能因最新已非 accepted 而跳过。

接口补全问题 Q2（business judgment）：旧 journal 没有 fromVersion/fromHash；推荐从仍匹配的 accepted Proposal 的 Base/expectedBase 取；缺 Proposal 时 health fromVersion = 空串，仅做文件收尾。新记录只在来源确定时补写。采用默认答案，成员可推翻。临时/正式台账的补 decision 都须以旧 journal 尚存时的 mtime 为固定输入，最后才删旧 journal，避免删完后遗漏事实无法恢复。

## 9. 测试策略、取代关系与当前假设

验收细节以 requirements.md 的 P/R/H/G/C/L 表为准，task 所有权见 tasks.md。fault injection 保持最高公开入口，用独立临时目录成功一次作参照，比较真实文件与全部事实；增加写入计数验证 no-op，不能只比较归一化结果。持锁测试用存活 PID/foreign hostname，断言读取可用、repair skip、字节不变；分类错误分别测试 retry/quarantine、继续其他 Skill。

**取代关系**：本 spec 与 ADR-0032 明确取代 `specs/skil-46-unified-lock-protocol/tasks.md` P1/P1b 中“下一次 readCurrent 回收死锁并前滚”的验收；旧 spec 冻结不改。ADR-0007 的回收规则不变，只把入口移至写路径/repair。旧 ADR-0005 的编号规则已由 ADR-0021 取代，不把临时台账步骤当新决定。

| 现有测试 | 新验收/所有者 |
|---|---|
| evolution.spec.ts 空版本目录（基线 193–211） | 读不恢复；下一次 store.promote 或 repair 删除不完整旧快照，Task 2 |
| 不可信旧 journal（213–234） | 原读断言保留，新增 repair 保留+failed，Task 2/3c |
| 死锁+完整旧 journal（300–320） | 读返回 live、锁不变；repair/下一次 Promote 回收并前滚，Task 2/3c |
| SIGKILL（322–344） | 从读后断言改为 repair 后 journal/死锁清除、current 为 1.0.0，Task 2/3c |
| artifact 消息（568–569） | 子串保留，增加错误 code，Task 1 |

当前假设：SKIL-121 的实现未合并，src 无 ledger.ts；Task 1–3c 无外部阻塞，Task 4 才依赖该实现。若它先合并，直接复用其 transition，禁止另写重复编号器；Task 4 仍负责本 spec 全矩阵的集成确认。单主机本地文件系统、原有 scope/next-load 语义不变；不承诺多 Skill 原子性、对外 hook exactly-once 或混跑旧版进程的协议守卫。上述适用边界之外的数据冲突会隔离并可 Rollback。

Q1、Q2、Q3 是可逆报告、兼容与加性输入细节默认，不存在等待确认的受保护决定；其余持久格式与依赖方向决定见 ADR-0032、ADR-0021。本 spec 不把 Stage 1 已确认决定重新提问。
