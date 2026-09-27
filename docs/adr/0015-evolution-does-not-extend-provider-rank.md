---
status: accepted
---

# Evolution 是独立能力，不把质量分、灰度或生命周期写进 Skill Registry 的 provider rank

Evolution is an independent capability and must not put quality scores, rollout state, or lifecycle state into Skill Registry provider rank. Provider rank remains only the precedence used to resolve same-name sources, so maintenance policy cannot silently change discovery.

## Considered Options

- Reusing provider rank for quality, canary routing, or lifecycle was rejected because it conflates source precedence with Evolution decisions and changes registry resolution semantics.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/architecture-design-zh.md §1.1、不变量 8](../../docs/architecture-design-zh.md)
