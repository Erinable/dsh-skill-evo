---
name: delivery-contract
description: "交付契约。在被指派的子 issue 上交付 PR、提交或回应评审（PASS / BLOCK）、需要成员拍板提问、发现 spec 有问题时使用。"
---

执行 agent 在一张子 issue 上交付一个 PR 的完整契约：怎么交付、怎么被评审、怎么提问、怎么交接。Reviewer 按「评审契约」一节执行。

本文用到的两个标识：

- `<KEY>`：本 issue 的编号，如 `SKIL-18`，取自 `multica issue get <issue> --output json` 的 `identifier`。
- **成员 id** `cb288268-0840-47ad-837b-f1c63c65b0e6`：工作区唯一的成员（ack7，owner），所有需要人拍板的事都找这位。

## 交付步骤

1. **分支**：只在本次 run 起始的任务分支（`agent/<agent>/<key>`）上提交并推送，由 `multica repo checkout` 或 worktree 给出。分支名里带着 issue key，PR 靠它自动关联 issue。
   完成判据：`git branch --show-current` 输出的仍是起始分支名。
2. **同步基点**：开工前 `git fetch origin`。任务分支落后于 `origin/main` 时，在任务分支上 `git merge origin/main`，不新建也不切换分支。
   完成判据：`git merge-base --is-ancestor origin/main HEAD` 退出码为 0，`git branch --show-current` 仍是起始分支名。
3. **推送**：`git push -u origin <任务分支>`。失败时重试，**最多 3 次**，可带 `-c http.lowSpeedLimit=1 -c http.lowSpeedTime=30` 防止挂住（`git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 push -u origin <任务分支>`）。3 次都失败就停止重试，把 issue 置为 `blocked`，评论里贴出失败的命令和实际输出。
   完成判据：`git status -sb` 显示与 `origin/<任务分支>` 同步；或 issue 已为 `blocked` 且评论里有失败命令和输出。
4. **开 draft PR**：
   ```bash
   gh pr create --draft --base main --title "<KEY>: <一句话>" --body-file ./pr-body.md
   ```
   `pr-body.md` 第一行是 `Closes <KEY>`，正文最后一行是 `修改意见请评论在 <KEY> 上`（有 attribution 行时放在它之前）。成员合并后，这个子 issue 会自动置为 `done`。
   完成判据：`gh pr view --json isDraft,title,body` 显示 `isDraft: true`，标题以 `<KEY>: ` 开头，首行是 `Closes <KEY>`，attribution 之前的最后一行是 `修改意见请评论在 <KEY> 上`。
5. **状态**：先 `multica issue status <issue> in_review`，再发交接评论。顺序不能反：@Reviewer 会立刻起 Reviewer 的 run，状态还没改就可能被读到旧状态。缺信息无法推进时改用「提问」一节，状态置 `blocked`。`done` 由合并 PR 自动完成。
   完成判据：`multica issue get <issue> --output json` 的 `status` 为 `in_review` 或 `blocked`。
6. **交接评论**：在自己的子 issue 上发一条评论，写 PR 链接、证据（实际命令和实际输出），并显式 @Reviewer（见「交接」）。
   完成判据：评论已发出，正文里有 `mention://agent/<Reviewer 的 id>`。

修改意见的唯一来源是 Multica issue 上的评论；GitHub 上的评论不会触发任何 agent，所以 PR 末尾那句提示是必需的。

## 被评审之后

- **PASS**：Reviewer 已把 PR 转为正式 PR，issue 上会有「等待合并」的评论。你的工作到此为止，等成员合并。
- **BLOCK**：Reviewer 在 issue 上写明哪条验收标准没过、在哪、改什么，并 @ 你。回到**原任务分支**返工、推送（同一个 PR 自动更新），再按交付步骤 5、6 先置 `in_review`、再发交接评论并 @Reviewer。
- **第 3 次 BLOCK**：Reviewer 会把 issue 置为 `blocked` 并写明需要成员决定什么。此时等成员回复，回复到来时按回复继续。

## 评审契约（Reviewer）

1. **只读检出**：`git fetch origin` 后执行 `git diff origin/main...origin/<分支>`，工作区保持无提交。
2. **PASS**：`gh pr ready <n>` 把 draft 转为正式 PR，`gh pr comment <n> --body-file <file>` 贴结论；再在子 issue 上评论，写明「等待合并」。
3. **BLOCK**：在子 issue 上评论，写清哪条验收标准没过、在哪个位置、要改什么，并 @ 原执行 agent。
4. **轮次**：发 BLOCK 前先数这张 issue 上已有几条 BLOCK。本次是第 3 次时，改为把 issue 置为 `blocked`，评论里写明需要成员做什么决定，这一次不 @ 执行 agent。

为了让轮次可数，每条评审评论的第一行固定写 `评审结论：PASS` 或 `评审结论：BLOCK`。

## 提问（需要成员拍板时）

1. **一次问完**：一轮问题写在一条评论里，每个问题带编号并附默认答案，成员可以只回「默认」。然后把 issue 置为 `blocked`。
2. **看负责人，决定要不要注册 wakeup**：读提问所在 issue 的 `assignee_id`（`multica issue get <issue> --output json`）。
   - **负责人就是自己**：**不注册 wakeup**。成员在负责人的 issue 上评论，本身就会唤醒负责人；再挂一条等成员评论的 wakeup，同一条评论会起两个 run（SKIL-15 已验证：成员 02:48:02 的一条评论起了 `direct_human comment` 和 `trigger_owner issue_wakeup` 两个 run，相隔 29 秒，两个 run 有重叠；SKIL-21 里成员评论也直接唤醒了负责人）。
   - **没有负责人，或负责人不是自己**：成员评论不会唤醒你，只有 wakeup 能把你带回来（SKIL-24 已验证，run_only autopilot 注册的也一样）。注册一条只触发一次、只认成员的 wakeup：
     ```bash
     multica issue wakeup create <issue> --kind event --event comment.created --mode once --filter-actor-type member --filter-actor-id cb288268-0840-47ad-837b-f1c63c65b0e6
     ```
3. **结束本次 run**：问题留给成员回答，下一次 run 从成员的回复继续往下做。

完成判据：问题评论已发出、issue 为 `blocked`；负责人不是自己（或没有负责人）时，`multica issue wakeup list <issue>` 里还要能看到这条 wakeup。负责人是自己时不检查 `wakeup list`，那里本来就不该有。

## 交接：必须显式 @

agent 在已指派的 issue 上评论，**不会**唤醒该 issue 的负责人或其他 agent（SKIL-16/17 已验证）。所以每次把工作交给另一个 agent，都要在评论里写 mention 链接：

```markdown
[@Reviewer](mention://agent/<Reviewer 的 id>)
```

id 现查，不要记：`multica agent list --output json`，按 `name` 取 `id`。mention 会给对方起一个新 run，只在真的交出工作时用；致谢和告知写纯文本。

## spec 有问题时

实现中发现 spec 矛盾、缺失或写不通：把子 issue 置为 `blocked`，评论写清是 spec 的哪一处、为什么写不通、你建议怎么改，并 @Mika。Mika 会追加一张 Spec Writer 修订票，修订合并后再放行你这张。
