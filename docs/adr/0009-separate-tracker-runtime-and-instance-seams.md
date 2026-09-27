---
status: accepted
---

# agent 工作流拆成 tracker / runtime / instance 三条 seam，依赖方向固定为 skill → runtime → tracker、skill → instance

Agent workflow documentation is split into tracker adapters, a runtime seam, and repository-specific instance facts, with dependencies fixed as `skill → runtime → tracker` and `skill → instance`. This keeps each changing concern in one module and prevents adapters from naming skills or agents.

## Considered Options

- Reversing those dependencies or merging the seams was rejected because changing a tracker or a skill would then require coordinated edits across unrelated concerns.

成员确认：SKIL-39
来源：[docs/design/skil-36-seams.md §3、D-3](../design/skil-36-seams.md)
