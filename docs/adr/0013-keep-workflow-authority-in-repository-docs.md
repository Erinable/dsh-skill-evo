---
status: accepted
---

# 权威规则放在仓库文档里，不做成 skill；前提是引用它的 run 都检出了本仓库

The authoritative tracker, runtime, and instance rules stay in repository documents, assuming runs that consume them have checked out this repository. A model-invoked skill is deferred until workflows must operate without a checkout, avoiding a second installation and reference path.

## Considered Options

- Making runtime a shared model-invoked skill was rejected because every consumer would need it installed and one omission would recreate the missing-rule failure.

成员确认：SKIL-39
来源：[docs/design/skil-36-seams.md §7、D-5](../design/skil-36-seams.md)
