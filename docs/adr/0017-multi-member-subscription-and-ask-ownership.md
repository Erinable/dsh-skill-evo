---
status: accepted
---

# 多成员订阅、提问归属与回复过滤

当一个工作区有多个 member 时，父 issue 和子 issue 默认订阅需求提出人与 Decision maker，按 `user_id` 去重。提出人按 issue 描述中的 `需求提出人 user_id`、显式 `unresolved` 回退 Decision maker、触发评论 member 作者、`creator_type == member` 时的 `creator_id`、Decision maker 的顺序解析；父 issue 写下的提出人行由每个 child 继承，因而子 issue 上的任意评论不会覆盖原始提出人。业务判断问需求提出人；不可逆决策、权限或花费问 Decision maker；只有被问目标的 member 回复算回答，wakeup 只过滤该目标。这样保留需求上下文，同时避免旁观者的回复意外结算需要授权的决定。

## Considered Options

- 让所有订阅成员的回复都唤醒并算回答被拒绝，因为订阅表示关注，不表示有权作出当前决定，且会使不同成员的相反意见产生竞态。
- 所有问题都问 Decision maker 被拒绝，因为业务判断应由提出需求的人给出，owner 只承担授权和不可逆决策。

本 ADR supersedes ADR-0012 的目标选择顺序，但保留其 `user_id` 约束；`creator_id` 只有在平台给出 `creator_type == member` 时才是有意的受限例外，`assignee_id` 永远不是提出人来源。
