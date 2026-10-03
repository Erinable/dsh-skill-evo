# Builder 任务（依赖顺序）

每个 Task 原样拆成一张 Builder 票，内含范围和验收；Spec Writer 不创建实现票。设计稿 §5 的边界保留为 Task 1=T1、Task 2=T2、Task 3a/3b/3c=T3、Task 4=T4。第一条为公开 dry-run/service 晋升校验的最薄端到端 tracer bullet。Task 1、2 可独立进行；3a 依赖两者；3b、3c 接在 3a 后，3c 使用 3b 的报告；只有 Task 4 等待 SKIL-121 实现。

每张票交付时都运行 core `npm --prefix packages/skill-evolution run build` 和 `npm --prefix packages/skill-evolution test`，保留实际输出。触及公开调用的 Task 1、3a、3c、4 还运行 `npm --prefix packages/dsh-adapter run build`、`npm --prefix packages/dsh-adapter test`、`npm --prefix packages/dsh-bundle test`。已有复现以 it.fails 预期失败，不能通过删用例达到全绿；实现使某条变好时，负责 task 同时把该条改为普通 it，未轮到的用例保留预期失败。最高公开测试入口与 publicationState 比较范围见 requirements.md。

## Task 1: 贯通公开入口的一份晋升校验（T1）

- **Depends on:** none；无需 SKIL-121 实现。
- **Requirements:** R-6、R-14；C1–C3、L3 的 artifact 消息兼容部分。
- **范围:** 新增 errors.ts、promotion-check.ts；保持 OperationError 原导出；合并 artifact resolver 和纯 check；operations dry-run/真 Promote、service.promote/verifyEvaluation 复用；lifecycle 的业务重复检查移除/复用文件 validator，保留文件 CAS 和快照冲突不变量。此阶段可保留既有发布写入，Task 3a 再统一锁内编排。
- **验收:** 打开现有 `dry-run rejects a base version that real promotion rejects`（C1）和 `service.promote and promoteProposal reject the same inconsistent artifact with the same code`（C2）。C1 增加真 Promote 的 `code: stale-base` 以及两入口发布字节/事实无变化断言，C2 断言同 code。新增 C3 表驱动覆盖 design.md §4 每行（含 artifact/result 两边 policy/hash/gate、空 caseIds、unversioned 例外、文档与变更校验），每行明确 code 并有通过控制组；分别验证 supplied artifact/result、evaluation 文件、最新未过期 artifact、伪造证据与缺失持久证据。evolution.spec.ts 两个 artifact 错误子串仍通过，附 code 断言；跨公开 service/operations 调用得到一致结果、dry-run 不写文件/不取发布锁。
- **交付边界:** 不改 journal/record id；删除校验重复实现，不能只加第三份规则。中间态崩溃用例仍由后续 task 修复。

## Task 2: 文件发布 journal 的闭环（T2）

- **Depends on:** none；无需 Task 1 或 SKIL-121 实现，合并两任务时保留 Task 1 的校验入口。
- **Requirements:** R-1、R-2、R-3（无 record 分支）、R-4（文件层）、R-8（文件不可完成）、R-10（readCurrent/healthIssues）、R-13（文件兼容）、R-14。
- **范围:** layout 的 publications/quarantine 路径；publication.ts journal I/O/验证与唯一 complete 的文件步骤；lifecycle 公开 promote/rollback 使用无 record journal，文件 helper 通过注入避免循环和重复锁；从 readCurrent/readCurrentUnlocked/healthIssues 去掉发布锁和恢复。实现旧 journal 的可信文件恢复供写入口调用、保留不可信旧 journal。service 带 record 的收尾在 3a 接入，repair 接线在 3c。
- **验收:** 使用公开 SkillVersionStore 的临时目录测试 P0–P1f、R0–R1c 的文件部分，每点注入后通过下一次同参数 store 操作收尾，比较成功一次全部 Skill 文件及活动 journal（不包含 service JSONL）；P0/R0 在写之前保持发布状态。file-only journal 无 record、不会向 observations/proposals/decisions 新增记录；partial 旧快照补齐且完整已一致文件不重写；explicit-only 不写 live/versions、不 invalidate。journal 字段类型、路径越界、未知 v、候选/目标 hash 不符均有失败检查，活动 journal 不在 stores。独立 readCurrent/healthIssues 在 P1c 和 held 发布锁下返回实际 live且不更改文件/锁，不运行 recovery。旧 journal 完整目录可经下一次 store.promote 前滚，不完整目录按旧规则清除；五种不可信旧文件原样保留、不挡 store 发布。
- **现有测试迁移:** evolution.spec.ts 空目录、死锁+完整 journal、SIGKILL 的读时恢复断言改为下一次公开 store.promote/rollback（或新增 file-only 收尾测试）触发恢复，再断言 journal/死锁清除；保留不可信 journal 的 readCurrent 不删断言。service.repair 场景留给 3c 新增，不能中间引用尚未存在的 report。完整 H2 的 service.healthReport 用例由 3b 打开，完整 P/R 事实矩阵由 3a/3c 打开。

## Task 3a: service 收尾、幂等重跑与台账守卫（T3 第一部分）

- **Depends on:** Task 1、Task 2；无需 SKIL-121 实现。
- **Requirements:** R-1–R-9、R-14、R-15（临时步骤）；P0–P4、R0–R5 的重跑路径、H3/H4、G1、G2–G4/G6 的操作路径。
- **范围:** 共享 publishPromotion、operations 真 Promote 委托且去掉提前状态拒绝；service Promote/Rollback 在整段发布锁内写 record journal、收尾所有事实并最后删 journal；reject 从 accepted/promoted 出发先收尾重读（最多等 5s）。实现 source/target 一次推断和持久化、固定 startedAt ids、已成功无写重跑、retry/permanent 分类与入口隔离表。无 ledger.ts 时临时按确定 id/startedAt 补 decision；不实施 ADR-0021 编号或 previousRecordId transition。
- **验收:** 现有 promoteRows 全部 rerun（P0、P1a 原普通 it 保持），rollbackRows 全部 rerun 改普通 it；新增 R0 rerun 和 H3（包含 artifact 过期后的重跑）、打开 H4 `a second rollback to the version that is already current writes nothing`、G1 `rejecting ... finishes the promote first, then refuses`，后者在临时实现下断言 invalid-transition。比较全文件及三份 JSONL，一次成功的 observation/decision/ledger 数量不增加，P4/R5 缺 decision 恰好补一次，不产生错误 source。并发 accepted→reject 只能在发布完成后校验失败；持锁超时不新增 reject 记录。
- **失败验收:** 新增 G2 的另一 Proposal Promote 和直接 Rollback 两分支、G3 直接 Rollback 分支、G4 Promote pending 与 Rollback 隔离/再 Promote 分支；本 task 先以磁盘隔离文件/raw/Proposal 状态验证，health 的字段断言由 3b、repair 的分支由 3c 补齐。另为正常无 journal 的混合 live（新版正文/旧 manifest）及 hash 匹配多 Proposal 歧义加公开 rollback 测试，不误转移 manifest 指向的 Proposal；target 唯一才填。注入本次已提交的永久错误断言 publication-conflict、retry 原错且 journal 留存；隔离文件写失败时 journal 留存，Rollback 不继续破坏 live。完整 G6 的 repair 场景由 3c 承担。
- **explicit-only 验收:** service 的 Observation/Ledger/decision 前故障经重跑补齐，live/versions 字节不变且 invalidate 调用数为零；完成后的同参数重跑按 adoption scope/version/hash 识别成功，artifact 过期也无写入。

## Task 3b: 发布 health 与纯读报告（T3 第二部分）

- **Depends on:** Task 3a；无需 SKIL-121 实现。
- **Requirements:** R-10、R-11、R-14；H2、H5、G2–G4 的隔离报告部分。
- **范围:** inspectPublications 只读扫描新/旧/隔离文件，healthReport 添加两数组、保留原字段；新 journal 损坏分支按 design.md Q1 无 operation、空 from/to/error，隔离 raw 中无法解析的元数据省略；stage files/records、legacy/lock 标注。CLI/bundle 无需重写动作，验证现有 JSON 透传包含新字段。
- **验收:** 打开 `health reads a half-written promote without changing any file`（H2）和 `H5 health and readCurrent answer while a live process holds the publication lock`。P3 的 health 内容按 H1 校验（完成 repair 后为空由 3c 打开整条原测试）；空目录两数组 []。坏新 JSON、未知 v、非法路径均带 error 且整份 health 返回，原字节不变；旧 .publish.json 同时报 legacy、保留原 skillIssues 条目一个版本。files/records、held/foreign/dead 锁状态可区分且不回收锁。G2–G4 操作隔离之后 health 恰好一条，重复 health 字节/文件数不变。metrics、dry-run 的发布状态不变，held 锁下 dry-run 不报 publication busy（只允许实际校验错误）；CLI health JSON 和 bundle health 透传字段有集成断言。

## Task 3c: repair 收尾、兼容与全验收收口（T3 第三部分）

- **Depends on:** Task 3a、Task 3b；无需 SKIL-121 实现。
- **Requirements:** R-1–R-14、R-15（临时步骤）；全 P/R repair 路径、H1、G2–G6、L1–L3。
- **范围:** service.repair 接 recoverPublications，先全部 JSONL 再发布再 manifest 再 force Projection；拆现有 repairEvolutionRoot 内部阶段，保留其独立签名/语义和原报告字段。逐 Skill waitMs:0、skipped-locked/failed/quarantined/completed；旧 journal 精确匹配 accepted 后补事实、mtime 固定输入直到删文件，非法旧 journal 原样 failed。追加 report 接口并通过 CLI/bundle 现有输出。
- **验收:** promoteRows/rollbackRows 的全部 repair 分支改普通 it，新增 R0 repair（等于操作前），打开 H1 `health reports the unfinished promote and repair reports completing it`。新增 G2 三分支中的 repair、G3 repair、G4 failed→completed 二次 repair、G5 无重复隔离、完整 G6 场景；Task 3a/3b 已有操作/health 断言合并成 requirements.md 的完整 G2–G6。新增 L1（旧完整 journal+accepted+过期 artifact补齐事实且 legacy true，另在 Ledger append 后 decision 失败，再 repair 补唯一 decision）、L2（五种不可信旧 journal repair failed 原字节不变、不挡新操作），L3 对应 evolution.spec.ts 保留读无写、repair 恢复死锁/SIGKILL/旧目录断言。held/foreign 锁下 skipped-locked、不回收；一个 Skill retry 失败另一 Skill completed；损坏新 journal repair quarantined（operation 省略、toVersion 空串/error 必填）；JSONL 残行先隔离再追加、Projection 包含补写 Observation，manifest 报告按收尾后的状态生成。独立 repairEvolutionRoot 的现有测试/签名保持通过。
- **回归清理:** 此 task 后 `publication-crash-recovery.spec.ts` 全部用普通 it，删 pending/convergesToday/recovery 的 expected-fail 分派及 EXPECT_PUBLICATION_RECOVERY 开关；没有 it.fails/skip/todo 遮蔽已交付验收。保留 fault 注入、归一化和独立成功参考；不能仅删预期失败用例。P1e 标签从旧 unlink 路径改为新 journal 步骤描述。core build/test、adapter build/test、bundle test 全部通过；汇报实际通过数，不沿用上游旧数字。
- **explicit-only 验收:** 对 Task 3a 的三个事实故障只运行 repair，事实等于成功一次且 live/versions 不变、invalidate 为零；之后同参数重跑无写入。

## Task 4: 切换到 ADR-0021 台账实现（T4）

- **Depends on:** Task 3c；**Blocked by:** SKIL-121 实现合并（其 spec 为 SKIL-135，仅 spec 合并不能满足依赖）。Task 1–3c 不等待此阻塞。
- **Requirements:** R-3、R-7、R-15；全 P/R/H/G/C/L 矩阵保持。
- **范围:** completePublication 注入的临时台账步骤改为 ProposalLedger.transition，精确 journal.fromRecordId、previousRecordId+目标状态幂等，decision 由该 API 生成/补齐；按 design.md Q3 添加可选 TransitionInput.occurredAt，仅接线固定时间生成，新 transition 的 updatedAt/decision.createdAt 取 startedAt，replay 补 decision 使用持久化 updatedAt。移除临时 record/decision 拼接，不修改 journal v:1、不实施或重写 ADR-0021 编号器。G1 切换后只断言 conflict，publication conflict 分类映射台账的真实错误类型。publicationState helper 的 root 解析改用 ADR-0021 精确 root 函数以支持带编号记录，不能用旧正则截编号。
- **验收:** 全部普通 P/R/H/G/C/L 用例仍通过，P4/R5 台账已有且 decision 缺失时 transition 返回原记录并补唯一 `decision:ledger:<recordId>`；新 journal 和旧 journal L1 的 updatedAt/decision.createdAt 均逐字等于固定 startedAt，变更时钟再 repair 不改变已有记录；未提供 occurredAt 的原台账测试保持通过。journal.fromRecordId 不是最新但已经同次转移时幂等成功，确实被另一转移取代时 conflict→隔离，G1 保持拒绝且无 reject 写入。既有 `<root>:<status>` 老记录仍可由恢复读取，不改写历史 Fact record；有 SKIL-121 编号记录的根解析/精确定位 fixture 通过。升级前临时 transition decision 按 ADR-0021 的旧 decision 兼容规则保留，不迁移旧事实；进行中的 v:1 journal 在切换后可完成。运行全部五项包命令并附输出。

## 回归责任索引

| 用例/改动 | 打开或新增的 Task |
|---|---|
| C1/C2 原 pending，C3 新表、artifact 消息 | 1 |
| P0–P1f/R0–R1c 文件层（新增独立普通测试）、旧读时恢复迁移 | 2 |
| 全 P/R rerun 原 recovery→it、R0 rerun/H3 新增、H4/G1 原 pending→it | 3a |
| H2/H5 原 pending→it；H1 health 部分、G2–G4 health 扩充 | 3b |
| 全 P/R repair 原 recovery→it、R0 repair 新增、H1 原 pending→it | 3c |
| G2–G4 操作分支；其 repair 分支与 G5/G6 完整场景 | 3a；3c |
| L1–L3 新增/迁移、删除所有预期失败分派 | 3c（文件兼容底层由 2） |
| previousRecordId 集成、G1 conflict、root 解析编号支持 | 4（等 SKIL-121 实现） |
