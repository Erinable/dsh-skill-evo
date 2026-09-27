# 每日巡检

何时读：由「每日巡检」autopilot 触发的 run。目的是补漏平台不会重放的事件，不是重新评审。

## 步骤

1. 列出所有负责人是 Mika、状态不是 `done` / `cancelled` 的父 issue：`multica issue list --assignee Mika --limit 100 --output json`，只保留 `parent_issue_id` 为空的（Mika 名下也有子 issue）。`has_more` 为 true 时加 `--offset` 翻页，直到取完。
2. 对每个父 issue 读 `multica issue children <parent-id> --output json`，逐张子 issue 做下面五查。子 issue 的 PR 用 `gh pr list --state all --search "<KEY> in:title" --json number,url,state,isDraft,createdAt,mergedAt,closedAt,headRefName,title,mergeable,mergeStateStatus` 查，只认 `title` 以 `<KEY>: ` 开头的那个（标题里提到别的 key 的 PR 也会被搜出来；分支名是 `agent/<agent>/<任务 id>`，不含 KEY，不能拿来匹配）。
3. 能补的当场补（第 1、3、5 查），其余记入「待你处理」。
4. **五查全部正常、也没有任何待处理项时，不发评论**，本次 run 结束。
5. 否则在固定的「每日巡检」issue 上发一条摘要（该 issue 按标题找：`multica issue list --output json` 中标题为「每日巡检」的那张）。

完成判据：每个未完成父 issue 下的每张子 issue 都过了五查；有待处理项时摘要已发出，没有时一条评论都没发。

## 五查

1. **stage 已全部 done，下一阶段还没建或仍是 `backlog`**：唤醒丢了。对这个父 issue 执行一次 `SKILL.md` 的「放行」。
2. **PR 已合并但子 issue 不是 `done`**（漏写 `Closes`）：在该子 issue 上说明，并列入摘要。
3. **交接没接上**：按下面「交接漏查」处理。
4. **`blocked` 超过 2 天，或提问后成员没有回复**：只在当天摘要里列一次，不在 issue 上评论。
   **第 3 次 BLOCK 例外，不等 2 天**：子 issue 为 `blocked`、且最新一条 `评审结论：BLOCK` 评论是第 3 条时，当天就列入摘要，写「第 3 次 BLOCK：<Reviewer 要你决定的事>」。
5. **PR 与 main 冲突**：按下面「PR 冲突查」处理。

另外一种要列入摘要的情况：**PR 已关闭未合并，issue 仍未决**，且成员没在 issue 上评论原因。列为「PR 已关闭、issue 未决」。

## 交接漏查

执行 agent 交付后没 @Reviewer、或 @ 错了人，Reviewer 就不会起 run，issue 停在 `in_review` 没人动。不看 PR 是不是 draft：漏 @ 的交付往往连 draft 也没开（SKIL-55/61/62/66/67），有的交付根本没有 PR（SKIL-56）。

对象：状态为 `in_review` 的子 issue。

1. **取两个时间**：
   - 执行 agent 最后一条评论的时间：`multica issue comment list <child-id> --compact --output json` 中 `author_id` 等于该 issue `assignee_id` 的最后一条的 `created_at`。
   - Reviewer 最后一次 run 的时间：`multica issue runs <child-id> --output json` 中 `agent_id` 等于 Reviewer id 的最新一条的 `created_at`，没有就当作无。
2. **判定**：执行 agent 最后一条评论早于 1 小时前，且晚于 Reviewer 最后一次 run（或 Reviewer 从没跑过），就是交接漏了。Reviewer 打回之后还没返工的，Reviewer 的 run 晚于执行 agent 的评论，自然不算。
3. **补交接**：用 `delivery-contract`「交接」一节的交接命令（Mika 没装这个 skill，从仓库 `skills/delivery-contract/SKILL.md` 读），`TO=Reviewer`、`PARENT` 留空，正文写「巡检补交接：<执行 agent 名> 的交付评论没有触发 Reviewer」加那条评论的链接。命令输出 `handoff ok` 才算补上。
4. 列入当天摘要：「<KEY> 交接漏了，已补 @Reviewer」。同一张 issue 连续两天都漏，说明执行 agent 没按交接命令交付，摘要里写明是哪个 agent。

完成判据：每张 `in_review` 子 issue，要么 Reviewer 最后一次 run 晚于执行 agent 最后一条评论，要么今天已有一条 `handoff ok` 的巡检补交接。

## PR 冲突查

已交付的 PR（draft 待评审或已 PASS 待合并）在 main 前进后可能冲突，平台不会为此唤醒任何人。这一查把冲突交回执行 agent。评审时已冲突的由 Reviewer 在 PASS 前拦下（`delivery-contract`「评审契约」第 2 步），评审之后才冲突的只靠这一查发现，最迟一天。

对象：状态为 `in_review` 的子 issue，其 PR `state` 为 `OPEN`。

1. **判定**：`mergeable` 为 `CONFLICTING`（`mergeStateStatus` 此时为 `DIRTY`）才算冲突。`mergeable` 为 `UNKNOWN` 是 GitHub 还没算完：等 10 秒用 `gh pr view <n> --json mergeable,mergeStateStatus` 再查一次，仍是 `UNKNOWN` 就跳过，下次再查。`MERGEABLE` 不处理，只是落后于 main 不算冲突。
2. **去重**：`multica issue comment list <child-id> --recent 3 --compact --output json`。最近一条以 `PR 冲突：#<n>` 开头的评论晚于 PR 最后一次提交（`gh pr view <n> --json commits --jq '.commits[-1].committedDate'`），说明已经通知过、执行 agent 还没处理：不再 @，只列入摘要「冲突已通知未处理」。
3. **唤醒**：在该子 issue 上发一条评论，唤醒 issue 负责人（`multica issue get <child-id> --output json` 的 `assignee_id`，即原执行 agent）。正文按 `delivery-contract` 的「贴原始输出前清理 mention」清理后，最后单独一行追加交接 mention：
   ```markdown
   PR 冲突：#<n>

   <PR 链接> 与 `origin/main` 冲突（`mergeable: CONFLICTING`）。请按 `delivery-contract` 的「PR 冲突时」处理。

   [@<执行 agent 名>](mention://agent/<assignee_id>)
   ```
   负责人不是 agent（成员接手了）时不 @，列入摘要。
4. 列入当天摘要：「PR #<n> 冲突，已交回 <执行 agent 名>」。

完成判据：每个冲突的 PR，其子 issue 上都有一条晚于 PR 最后一次提交的 `PR 冲突：#<n>` 评论，且同一次冲突只 @ 过一次。

## 摘要格式

只有一段「待你处理」，每行一个 PR 链接或 issue 链接，加一句要成员做什么：

```markdown
## 待你处理

- [SKIL-31](mention://issue/<id>) PR #12 已合并但 issue 未完成：确认是否手动置 done
- [SKIL-33](mention://issue/<id>) blocked 3 天：回答第 2 个问题
- [SKIL-35](mention://issue/<id>) PR #15 冲突，已交回 Builder：无需操作，等重新评审
- https://github.com/<owner>/<repo>/pull/14 已关闭、issue 未决：在 SKIL-34 上说明原因
```

mention 用 `mention://issue/...`，它只是链接，不会通知或起 run。
