---
status: accepted
---

# 事实 append-only，派生判断必须引用 observation id、允许修正，禁止把归因写回事实

Original observations are append-only authority; every derived attribution cites observation ids and may be corrected later. Model-generated attribution must remain derived rather than being written back into the fact stream, preserving provenance and the ability to revise judgments.

## Considered Options

- Writing attribution into fact observations was rejected because it would mutate or contaminate immutable evidence and make later corrections indistinguishable from what actually happened.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/architecture-design-zh.md §1.2、不变量 1–2](../../docs/architecture-design-zh.md)
