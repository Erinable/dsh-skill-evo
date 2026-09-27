---
status: accepted
---

# proposal 状态机只有一张转移表，service 守卫都从表推出

The proposal transition table is the single source of truth, and service guards derive their allowed paths from it. This prevents drift and makes changes such as allowing `accepted` to be rejected or `draft` to be deferred explicit table changes.

## Considered Options

- B, keeping a second set of service guards and adding consistency tests, was rejected because it preserves a permanent drift surface instead of removing the duplicate rule.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/design/maintenance-use-cases-proposal-ledger.md §2.4、D9](../design/maintenance-use-cases-proposal-ledger.md)
