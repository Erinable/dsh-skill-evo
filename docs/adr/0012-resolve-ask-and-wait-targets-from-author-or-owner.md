---
status: accepted
---

# 提问对象身份解析：只使用已验证的 member `user_id`（目标选择见 ADR-0017）

ADR-0017 部分取代本 ADR 的目标选择顺序，但本 ADR 仍约束身份来源：触发评论的作者是 member 时可用作者；否则从 workspace member list 解析 owner 的 `user_id`。The wakeup filter therefore uses a verified member `user_id`, rather than an issue field that may identify an agent. ADR-0017 另加了 issue 描述中的提出人元数据，并允许仅在 `creator_type == member` 时使用 `creator_id`；这两个受限来源不会把 agent id 当成员。

## Considered Options

- Using `creator_id` or `assignee_id` as the fallback was rejected because those fields are often agent ids, which makes a member-only wakeup silently never trigger.

成员确认：SKIL-39
来源：[docs/design/skil-36-seams.md §4、D-4](../design/skil-36-seams.md)
