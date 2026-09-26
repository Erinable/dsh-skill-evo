# 每日巡检

何时读：由「每日巡检」autopilot 触发的 run。目的是补漏平台不会重放的事件，不是重新评审。

## 步骤

1. 列出所有负责人是 Mika、状态不是 `done` / `cancelled` 的父 issue：`multica issue list --assignee Mika --output json`。
2. 对每个父 issue 读 `multica issue children <parent-id> --output json`，逐张子 issue 做下面四查。子 issue 的 PR 用 `gh pr list --state all --search "<KEY> in:title" --json number,url,state,isDraft,mergedAt,closedAt` 查。
3. 能补的当场补（第 1、3 查），其余记入「待你处理」。
4. **四查全部正常、也没有任何待处理项时，不发评论**，本次 run 结束。
5. 否则在固定的「每日巡检」issue 上发一条摘要（该 issue 按标题找：`multica issue list --output json` 中标题为「每日巡检」的那张）。

完成判据：每个未完成父 issue 下的每张子 issue 都过了四查；有待处理项时摘要已发出，没有时一条评论都没发。

## 四查

1. **stage 已全部 done，下一阶段还没建或仍是 `backlog`**：唤醒丢了。对这个父 issue 执行一次 `SKILL.md` 的「放行」。
2. **PR 已合并但子 issue 不是 `done`**（漏写 `Closes`）：在该子 issue 上说明，并列入摘要。
3. **子 issue 处于 `in_review`，PR 仍是 draft 且超过 1 天**：Reviewer 没被触发。在该子 issue 上补一次 @Reviewer（写法见 `delivery-contract` 的「交接」）。
4. **`blocked` 超过 2 天，或提问后成员没有回复**：只在当天摘要里列一次，不在 issue 上评论。

另外一种要列入摘要的情况：**PR 已关闭未合并，issue 仍未决**，且成员没在 issue 上评论原因。列为「PR 已关闭、issue 未决」。

## 摘要格式

只有一段「待你处理」，每行一个 PR 链接或 issue 链接，加一句要成员做什么：

```markdown
## 待你处理

- [SKIL-31](mention://issue/<id>) PR #12 已合并但 issue 未完成：确认是否手动置 done
- [SKIL-33](mention://issue/<id>) blocked 3 天：回答第 2 个问题
- https://github.com/<owner>/<repo>/pull/14 已关闭、issue 未决：在 SKIL-34 上说明原因
```

mention 用 `mention://issue/...`，它只是链接，不会通知或起 run。
