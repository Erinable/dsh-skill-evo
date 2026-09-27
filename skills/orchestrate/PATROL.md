# 每日巡检

何时读：由「每日巡检」autopilot 触发的 run。目的是补漏平台不会重放的事件，不是重新评审。

## 步骤

1. 列出所有负责人是 Mika、状态不是 `done` / `cancelled` 的父 issue：`multica issue list --assignee Mika --limit 100 --output json`，只保留 `parent_issue_id` 为空的（Mika 名下也有子 issue）。`has_more` 为 true 时加 `--offset` 翻页，直到取完。
2. 对每个父 issue 读 `multica issue children <parent-id> --output json`，逐张子 issue 做下面五查。子 issue 的 PR 用 `gh pr list --state all --search "<KEY> in:title" --json number,url,state,isDraft,createdAt,mergedAt,closedAt,headRefName,title,mergeable,mergeStateStatus` 查，只认 `title` 以 `<KEY>: ` 开头的那个（标题里提到别的 key 的 PR 也会被搜出来；分支名是 `agent/<agent>/<任务 id>`，不含 KEY，不能拿来匹配）。
3. 另列出所有状态不是 `done` / `cancelled` 的 issue（同样翻页），对每张先用 `multica issue comment list <issue> --roots-only --summary --compact --output json` 扫线程，再以 `--thread <root-id> --tail 30 --compact --output json` 展开含提问或仍有回复活动的线程。必要时按 `--before` / `--before-id` 翻到早于 tail 的提问评论。把带有 `提问目标 user_id`、`提问时间` 且尚未出现目标回复或该提问的 `提问超时处理：` 的 issue 加入第 4 查集合。这个集合不受父子关系限制，覆盖 Mika 在父 issue 上的提问、Triager 的无父 issue 分诊提问和普通子 issue 提问。
4. 能补的当场补（第 1、3、4、5 查），其余记入「待你处理」。
5. **五查全部正常、也没有任何待处理项时，不发评论**，本次 run 结束。
6. 否则在固定的「每日巡检」issue 上发一条摘要（该 issue 按标题找：`multica issue list --output json` 中标题为「每日巡检」的那张）。

完成判据：每个未完成父 issue 下的每张子 issue 都过了五查；所有待回答提问（含父 issue 和无父 issue）都按固定标记完成当日阶段且重复巡检不重复动作；有待处理项时摘要已发出，没有时一条评论都没发。

## 五查

1. **stage 已全部 done，下一阶段还没建或仍是 `backlog`**：唤醒丢了。对这个父 issue 执行一次 `SKILL.md` 的「放行」。
2. **PR 已合并但子 issue 不是 `done`**（漏写 `Closes`）：在该子 issue 上说明，并列入摘要。
3. **子 issue 处于 `in_review`，PR 仍是 draft 且 `createdAt` 早于 1 天前**：Reviewer 没被触发。在该子 issue 上补一次 @Reviewer（写法见 `delivery-contract` 的「交接」）。
4. **提问后目标成员没有回复**：按提问评论中的目标、类别、默认答案、`resume status` 和时间戳执行下面的幂等升级表。每个标记都带原提问评论 id，例如 `提问提醒 1/2：<question-comment-id>`；只查同一 id 的标记。先判 7 天，再判 4 天，再判 2 天，一次巡检只执行当前最高阶段；只有当前目标成员的回复算回答，原目标被转交后迟到的回复只作上下文。
   - **2 天**：若该提问没有 `提问提醒 1/2：<id>`，发一次提醒评论，以该标记开头，并单独一行使用 `[@<目标名字>](mention://member/<target-user-id>)` 通知目标成员；已有标记则跳过。
   - **4 天**：目标不是 Decision maker 时，先从 `multica issue wakeup list <issue>` 找出与原提问线程、旧目标 `user_id` 匹配的 wakeup，用 `multica issue wakeup disable <issue> <wakeup-id>` 停掉。issue 负责人是原提问 agent 时，member 回复会直接唤醒它，不另挂 wakeup；否则按 tracker adapter 的转交分支，以原 `parent`、`next`、Decision maker `user_id` 和 `--agent-id <原提问 agent id>` 建一个替代 wakeup，发现已有匹配的新 wakeup 就复用。最后发一条以 `提问转交：<id>` 开头、包含 `提问提醒 2/2：<id>` 的评论，写明新目标及原目标迟到回复只作上下文，并单独一行 `[@<Decision maker 名字>](mention://member/<owner-user-id>)` 通知 Decision maker。目标本来就是 Decision maker 时只发 `提问提醒 2/2：<id>`，仍单独一行通知。标记已存在就跳过；不得重新注册 wakeup 或重复通知。
   - **7 天**：若该提问没有 `提问超时处理：<id>`，先禁用仍匹配原提问线程的 wakeup。类别为可逆 `business judgment` 时，将 issue 状态改回提问记录的 `resume status`（子 issue 通常为 `todo`，父 issue 通常为 `in_progress`），再发一条以 `提问超时处理：<id>` 开头的评论，写明采用的默认答案，并通知原提出人；原提问方是 agent 时再追加 `[@<agent 名>](mention://agent/<原提问评论的 author_id>)` 交回继续处理。不可逆、权限或花费问题改为 `backlog`，在同标记评论中通知 Decision maker 重新安排。已有该标记就跳过所有动作。
   **`blocked` 超过 2 天但没有待回答提问**：只在当天摘要里列一次。
   **第 3 次 BLOCK 例外，不等 2 天**：子 issue 为 `blocked`、且最新一条 `评审结论：BLOCK` 评论是第 3 条时，当天就列入摘要，写「第 3 次 BLOCK：<Reviewer 要你决定的事>」。
5. **PR 与 main 冲突**：按下面「PR 冲突查」处理。

另外一种要列入摘要的情况：**PR 已关闭未合并，issue 仍未决**，且成员没在 issue 上评论原因。列为「PR 已关闭、issue 未决」。

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
