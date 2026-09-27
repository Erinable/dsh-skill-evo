# 提案状态机转换的手感

这是一份原型结论，不是产品代码。可双击打开的 HTML 不进仓库。原始证据是 [SKIL-95](mention://issue/01a0e26c-5f93-78e6-8ed1-144d7c7db139) 评论 `01a0e28a-3e8e-78bd-9ce2-46581f05c7b6` 的附件 `proposal-transition-feel.html`。ack7 于 2026-09-27 在评论 `01a0e291-73a7-7c6b-b007-e869f693dd83` 回复「默认」，下面三题按该提问里写下的默认答案采纳。

术语按 `CONTEXT.md`：Accept 是决策者同意采用，不表示已经发布；Promote 才把已 Accept 的 Candidate content 发布出去；Gate 挡的是 Promote；`reverted` 是遗留 Proposal status，不是当前动作。

## 要回答的问题

`PROPOSAL_TRANSITIONS`（`packages/skill-evolution/src/proposal.ts:24`）有三处在纸上定不下来：

1. `replayed` / `observed` 可以不经 `evaluated` 直接到 `accepted`。这和 `skill-进化设计-MVP.md` 第 7 节「生产目录的发布需要满足评测门禁」是否冲突，门禁在 Accept 还是在 Promote？
2. `rejected → observed`、`deferred → observed` 让被拒或暂缓的提案重新进来。这条回流会不会绕开 Evaluation？
3. `reverted` 没有任何入边，`rolled-back` 没有出边。Rollback 之后，同一份候选怎样再次发布？

## 怎么试的

页面里的转移表与 `proposal.ts` 的 `PROPOSAL_TRANSITIONS` 是同一张。自由按钮始终可点：一组只改 Proposal status，一组模仿现有代码。

- 维护命令跑评测：只接受 `proposed` 或 `evaluating`（`packages/skill-evolution/src/operations.ts:123`）。
- 服务层评测：`proposed` 先到 `evaluating`，其他状态直接尝试到 `evaluated`，能不能走只问转移表（`packages/skill-evolution/src/service.ts:190`）。
- Promote：状态必须已是 `accepted`，并且有一份通过 Gate 的 Evaluation artifact（`packages/skill-evolution/src/operations.ts:161`、`packages/skill-evolution/src/operations.ts:263`）。Accept 本身只问转移表（`packages/skill-evolution/src/service.ts:236`）。
- Rollback：只从 `promoted` 到 `rolled-back`（`packages/skill-evolution/src/service.ts:334`）。

四页引导覆盖这三类情形。第二页是第一页的对照：同一条 `replayed` 先评测再 Accept 再 Promote。用 Node 抽出页面里的纯模块，跑完四页，并与 `proposal.ts` 的表做字符串对照。浏览器里点过自由试和这四页，1100px 与 390px 宽度都没有横向溢出。

这个 HTML 把状态放在内存里，没有用 `ledgerRecordId`。所以「拒绝之后又回来」那一页只说明转移表放行、以及旧 Evaluation artifact 还在；它没有覆盖 ADR-0005 的记录身份。同一 root 上第二次评测写不进台账，是 Reviewer 对已构建的 `lib` 实测出来的，见下面「与 ADR-0005 冲突」。

## 实际输出

对照结果是 `table matches proposal.ts: true`。没有出边的是 `rolled-back`、`reverted`。没有入边的是 `draft`、`reverted`。四页都按预期走完（`all assertions passed`）：

```
## 不经评测直接同意
start status=replayed evaluation=none catalog=v1
1. 同意采用  ok        status=accepted evaluation=none
2. 发布到生产目录  blocked   没有评测记录。已是 accepted，补评测走不通
3. 用维护命令补评测  blocked  维护命令只接受 proposed / evaluating
4. 用服务层补评测  blocked    accepted 到不了 evaluated

## 回放之后先评测再发布
1. 用维护命令跑评测  blocked   现在是 replayed
2. 用服务层跑评测（通过）  ok  status=evaluated evaluation=pass/服务层
3. 同意采用  ok
4. 发布到生产目录  ok          catalog=P-回放

## 拒绝之后又回来
start status=evaluated evaluation=pass
1. 拒绝  ok                     评测记录仍在
2. 记为已观察  ok               旧记录没有作废
3. 同意采用  ok
4. 发布到生产目录  ok           用的是拒绝之前那份维护命令记录，catalog=P-被拒

## 回滚后还想发同一份
start status=promoted catalog=P-回滚
1. 回滚到上一个版本  ok         status=rolled-back catalog=v1
2. 再次同意采用  blocked        rolled-back 没有下一步
3. 再次发布  blocked
4. 标成已撤销  blocked          没有任何状态能到 reverted
5. 另开一条新提案  ok           新 id P-2 为 draft；P-回滚 仍是 rolled-back
6. 提出候选  ok
7. 用维护命令跑评测（通过）  ok
8. 同意采用  ok
9. 发布到生产目录  ok           catalog=P-2，previous=v1
```

## 结论与取舍

### 门禁留在 Promote，去掉两条直接 Accept

发布到生产目录时才检查 Gate。这和 MVP 第 7 节、以及 `CONTEXT.md` 里「没过 Gate 的 Proposal 不能 Promote」一致，和 Accept 的定义也一致：Accept 不表示已经证明有收益。

手感上要收紧的是另一件事。`replayed` 可以直接 Accept，Accept 之后转移表只剩 `promoted` 和 `rejected`，维护命令和服务层都补不进 Evaluation，Promote 又因没有 artifact 失败。这条候选被同意了，却永远发不出去。服务层可以从 `replayed` 评到 `evaluated`（表上有这条边），维护命令拒绝，两个入口不一致。

采纳：

- Gate 留在 Promote。`evaluated → accepted` 继续不看 Gate 是否通过；没过 Gate 仍然可以 Accept，Promote 时拒绝。
- 从 `PROPOSAL_TRANSITIONS` 去掉 `replayed → accepted` 和 `observed → accepted`。
- 维护命令跑评测与服务层使用同一条规则：`proposed` 可以开始评测，其他状态在表允许走到 `evaluated` 时也可以。这样 `replayed` 和 `observed` 进得了评测，`accepted` 仍然进不去。

### 拒绝或暂缓可以回到 observed，旧 Evaluation artifact 作废

`rejected` 只能到 `observed`，`deferred` 可以到 `observed` 或再到 `rejected`。拒绝和暂缓都不清 Evaluation artifact，而 `observed` 又能直接 Accept，于是「评测通过 → 拒绝 → observed → Accept → Promote」会用拒绝之前的那份通过记录再次发布。没有任何维护命令负责走到 `observed`，只有表上的边。

采纳的规则与第 1 题是同一条，不在 Accept 前另加一道 Gate：

- 回流之后必须重新跑评测，并且 Proposal status 再次走到 `evaluated`，才能 Accept。`acceptProposal`（`packages/skill-evolution/src/service.ts:236`）继续只问转移表，不查 `passedGate`。
- Gate 仍然只在 Promote 检查。Promote 只认回流之后新写的 artifact；这份新 artifact 没过 Gate，Promote 拒绝，Accept 仍然可以发生。
- 提问里第 2 题的默认答案写过「重新跑评测并通过，才能同意」。这里把「通过」收成「新的 Evaluation 已经记上，状态走到 `evaluated`」；过不过 Gate 留给 Promote。这是把第 2 题收成和第 1 题同一条规则，不再另问。
- 旧 artifact 不能再被这次 Promote 拿去用。具体怎么作废见下一节，不改已落盘的记录。
- 成员要保留 `rejected → observed` 和 `deferred → observed`，并补一个显式的「重新观察」维护动作，目标是 `observed`，能否执行只问转移表。这两条边在现有台账里当不了「再次评测」的路，见「与 ADR-0005 冲突」。本 PR 不去掉它们，也不假装同一 root 上的第二次 `evaluated` 写得进去。

### rolled-back 保持终态，再次发布另开一条 Proposal

`rolled-back` 没有出边。Rollback 之后同一条 Proposal 不能再 Accept，也不能再 Promote。`reverted` 没有入边，从 `rolled-back` 和其他状态都点不进去；`CONTEXT.md` 已把它标成遗留状态，metrics 仍兼容这个旧词（`packages/skill-evolution/src/metrics.ts:63`）。

另开一条 Proposal（新的 root id、同一份 Candidate content）之后，旧记录停在 `rolled-back`，新记录可以从 `draft` 走通提出、评测、Accept、Promote。

采纳：

- `rolled-back` 保持终态，不加出边。
- 再次发布同一候选必须新开一条 Proposal。这沿用现有的 `createProposal` / `stageProposal`，不新增状态。
- `reverted` 保持不可达，不加边，也不在本结论里删除这个类型。

## 要做成产品代码还缺什么

本 PR 不改 `packages/`。实现时按 ADR-0004 只改 `PROPOSAL_TRANSITIONS` 这一张表，再让守卫跟着表走，并同步 `docs/architecture-design-zh.md` §4.1 里抄出来的那张图（`replayed` 与 `observed` 两行今天仍含 `accepted`）。

1. **去掉两条边。** `proposal.ts` 的 `replayed` 改为 `['observed', 'evaluated', 'rejected', 'deferred']`，`observed` 改为 `['evaluated', 'rejected', 'deferred']`。`evaluated → accepted` 保留。
2. **对齐评测入口。** `operations.ts` 的 `evaluateProposal` 今天把状态写死成 `proposed` 和 `evaluating`（`:125-127`）。改成与 `service.evaluate` 相同的判断：`proposed` 可以开始；否则 `canTransition(status, 'evaluated')` 才调用服务层。不要再维护第二份允许列表。
3. **旧 artifact 不再用于 Promote，且不改已落盘的记录。** `evaluations.jsonl` 走 `JsonlRecordStore`：`append` 在 id 已存在时返回 `false`（`packages/skill-evolution/src/records.ts:17`），整表修改只有 `replaceAll`（`records.ts:43`）。把旧 artifact 的 `expiresAt` 改写成决定时间必须 `replaceAll`，这和 `docs/architecture-design-zh.md:42` 的 append-only 相反，不采用。实现时二选一，都只读不改旧行：同一 root 继续用时，Promote 读 evaluations 和 decisions，只认 `createdAt` 晚于该 root 最近一次 `rejected` 或 `deferred` decision 的 artifact；若回流改为新 root（下一节选项 A），旧 artifact 留在旧 root，新 root 在自己的 Evaluation 之前没有 artifact，Promote 不会读到旧的。
4. **重新观察。** 在 `operations.ts` 增加一个维护动作，转到 `observed`，合法性只调用 `assertCanTransition`。`rejected`、`deferred`、`replayed` 因此都能到 `observed`，`rolled-back` 不能。这个动作只解决「谁来走到 `observed`」。它不解决第二次 `evaluated` 写不进去。
5. **测试。** 现在就能写的：去掉的两条边；`rolled-back` / `reverted` 仍然没有出边；从 `replayed` 第一次评测成功；Accept 之后再评测失败；拒绝后旧 artifact 不能 Promote；Rollback 后同一 root 不能再 Promote，新 root 可以。现在写不出来的：同一 root 上「重新观察 → 第二次评测后状态是 `evaluated` → Accept → Promote」。Reviewer 对已构建的 `lib` 实测，第二次评测后状态仍是 `observed`，artifact 有 2 份，台账 id 停在 `(root) :evaluating :evaluated :rejected :observed`，没有第二条 `:evaluated`。这条测试要等下面 A 或 B 选定之后再写，断言必须跟选定的记录身份一致。
6. **不在这次范围里。** 不删除 `reverted`。不把 HTML 原型提交进仓库。不新增「回滚后再发布」状态；新 Proposal 就是再次发布的路径。本 PR 不选下面的 A 或 B，也不新写 ADR。

### 与 ADR-0005 冲突

_与 ADR-0005 冲突（proposal 台账的记录身份是 `root:status`，同一状态只能写一次），但值得重开，因为去掉 `observed → accepted` 之后，成员采纳的「回流后重新评测再 Accept」在现有 id 方案下走不通。_

ADR-0005 规定 Ledger record 的 id 是 Proposal root 加 `:status` 后缀。`ledgerRecordId` 就是 `` `${root}:${status}` ``（`packages/skill-evolution/src/proposal.ts:75`）。`JsonlRecordStore.append` 看到已有 id 直接返回 `false`，不写（`records.ts:17`）。`service.evaluate` 仍把评测结果追加成 `ledgerRecordId(root, 'evaluated')`，并且不看 `append` 的返回值（`packages/skill-evolution/src/service.ts:231`）。第一次评测已经占用 `root:evaluated` 之后，回流再评测时这条记录被静默丢掉，再读台账，状态停在 `observed`。Evaluation artifact 的 id 带时间，所以第二份 artifact 写得进去，Proposal 状态写不进去。

同一问题也落在第二次 `rejected` 和第二次 `deferred` 上：这些后缀第一次用过就不能再写。按本文去掉 `observed → accepted` 之后，一条已经 `evaluated` 又 `rejected` 再回到 `observed` 的 root，第二次评测到不了 `evaluated`，第二次拒绝也到不了 `rejected`。`observed` 上剩下的新后缀最多是还没写过的 `deferred`，写过一次之后，`deferred → observed` 同样因为 `root:observed` 已存在而写不进去。旧 root 会停住。现在表上还有 `observed → accepted`，第一次 Accept 还能写进从未用过的 `root:accepted`，所以这条死路被盖住了。

Decision 的 id 已经带 `updatedAt`（`service.ts:369`），决定记录可以重复。卡住的是 Proposal 台账这一层。ADR-0004 只要求转移表一张来源，不规定记录 id，解不了这个冲突。

两个选项，本 PR 不选：

- **A. 回流另开一个新 root。** 和第 3 题「再次发布另开一条 Proposal」同一种做法。旧 root 停在 `rejected` 或 `deferred`，新 root 从 `draft` 走自己的第一次 `evaluated`，id 还没被占用。后果：`rejected → observed` 和 `deferred → observed` 不再承担「重新评测再 Accept」。留着它们，只表示把旧 root 标回 `observed`，不能在这条 root 上再写入第二个 `evaluated`。成员默认答案里的两半在这个选项下不能同时成立：要保留这两条边，就不要指望同一 root 再次评测；要再次评测并 Accept，就走新 root，这两条边可以不留。实现时要在这两句里收成一句，不能两句都写成已经可行。
- **B. 修改 ADR-0005 的 record id，让同一状态可以重复进入。** 例如后缀带序号或决定时间。这是台账数据格式的改动，必须新 ADR，不能只改 `PROPOSAL_TRANSITIONS`。`proposalRootId`（`proposal.ts:66`）靠「最后一个后缀正好是状态名」剥出 root，新格式仍要剥回同一个 root，并且已经落盘的 `root:evaluated` 要继续读得出来。`latestProposalsByRoot` 今天把文件里最后一条当成最新（`proposal.ts:79`），重复进入之后「哪一条算最新」要在新 ADR 里写明。后果：同一 root 可以第二次写入 `evaluated`、`rejected`、`deferred`，成员要的「回流 → 再评测 → Accept → Promote」才写得进去。

去掉 `replayed → accepted` 和 `observed → accepted` 本身仍然只改 ADR-0004 那张表，可以先做，也不让回流突然变得可发布。真正让回流后的 Accept 变得可做的，是 A 或 B，而不是再加一条转移。
