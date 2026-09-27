---
status: superseded by ADR-0017
---

# 提问对象解析：触发评论作者是 member 时用作者；否则用拍板人 = 工作区 owner，按 `user_id` 解析；都不从 issue 的 `creator_id` / `assignee_id` 取

触发评论的作者是 member 时，优先用作者；否则用 owner 的 `user_id`。The wakeup filter therefore uses the triggering member when available and otherwise resolves the workspace owner from the member list, rather than reading issue creator or assignee fields that may identify an agent.

## Considered Options

- Using `creator_id` or `assignee_id` as the fallback was rejected because those fields are often agent ids, which makes a member-only wakeup silently never trigger.

成员确认：SKIL-39
来源：[docs/design/skil-36-seams.md §4、D-4](../design/skil-36-seams.md)
