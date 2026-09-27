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

采纳：

- 保留 `rejected → observed` 和 `deferred → observed`。
- 拒绝或暂缓时作废该 Proposal root 上已有的 Evaluation artifact。
- 回流之后必须重新跑评测并且通过 Gate，才能 Accept。Promote 只认这次新 artifact。
- 补一个显式的「重新观察」维护动作，目标是 `observed`，能否执行只问转移表。

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
3. **作废旧 artifact。** `rejectProposal` / `deferProposal` 把该 root 上现有 Evaluation artifact 的 `expiresAt` 写成这次决定的时间。Promote 已有的过期检查（`operations.ts:261`）就会拒绝旧记录；调用方拿旧的 `expiresAt` 来对，也过不了持久化比对。回流后的新评测会写下一份新的、未过期的 artifact，Promote 只认它。
4. **重新观察。** 在 `operations.ts` 增加一个维护动作，转到 `observed`，合法性只调用 `assertCanTransition`。`rejected`、`deferred`、`replayed` 因此都能到 `observed`，`rolled-back` 不能。
5. **测试。** `proposal-ledger` 覆盖去掉的两条边、保留的回流，以及 `rolled-back` / `reverted` 仍然没有出边。操作测试覆盖：从 `replayed` 评测成功；Accept 之后再评测失败；拒绝后旧 artifact 不能 Promote；重新观察并重新评测通过之后可以 Promote；Rollback 后同一 root 不能再 Promote，新 root 可以。
6. **不在这次范围里。** 不删除 `reverted`。不把 HTML 原型提交进仓库。不新增「回滚后再发布」状态；新 Proposal 就是再次发布的路径。

实现这些改动会碰到台账契约。若那张实现票需要 ADR，编号接在 `origin/main` 已有的 `docs/adr/` 之后，并写明它收紧的是 ADR-0004 那张表的两条边，表本身仍然是唯一来源。本结论稿不另立 ADR，避免和那张表分成两处定义。
