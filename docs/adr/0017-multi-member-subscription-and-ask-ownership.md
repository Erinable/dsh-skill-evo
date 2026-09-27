---
status: accepted
---

# 多成员订阅、提问归属与回复过滤

当一个工作区有多个 member 时，父 issue 和子 issue 默认订阅需求提出人与 Decision maker，按 `user_id` 去重。业务判断问需求提出人；不可逆决策、权限或花费问 Decision maker；只有被问目标的 member 回复算回答，wakeup 只过滤该目标。这样保留需求上下文，同时避免旁观者的回复意外结算需要授权的决定。

## Considered Options

- 让所有订阅成员的回复都唤醒并算回答被拒绝，因为订阅表示关注，不表示有权作出当前决定，且会使不同成员的相反意见产生竞态。
- 所有问题都问 Decision maker 被拒绝，因为业务判断应由提出需求的人给出，owner 只承担授权和不可逆决策。

本 ADR supersedes ADR-0012 对“author 或 owner”二选一的简化目标规则；ADR-0012 的 `user_id` 解析和不使用 issue `creator_id` / `assignee_id` 的身份约束继续有效。
