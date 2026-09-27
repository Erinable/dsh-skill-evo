---
status: accepted
---

# 归档段是权威 observation 事实；retention 缺省不删归档

The observation log consists of all archive segments plus the current file, and retention does not delete archives by default. This keeps derived state fully rebuildable from facts; explicit retention is the only operation allowed to shorten that history.

## Considered Options

- B-2, an incremental cursor that treats archived data as a baseline, was rejected because derived state could no longer be rebuilt from the current fact stream alone and the cursor format would become harder to migrate.

成员确认：SKIL-38
来源：[docs/design/evolution-state-root.md §2、B-2、A2–A3](../design/evolution-state-root.md)
