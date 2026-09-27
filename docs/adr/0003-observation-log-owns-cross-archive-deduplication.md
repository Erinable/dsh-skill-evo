---
status: accepted
---

# 跨归档去重放在 observation log 类本身，service 和 bundle 构造同一个类

Cross-archive de-duplication belongs in the observation log class itself, and both the service and bundle construct that class, because the bundle writes observations without passing through the service. If de-duplication is moved out of this class, the bundle will silently write duplicate observations; once those duplicates enter the append-only fact stream they cannot be deleted.

## Considered Options

- A-3, putting archive assembly and de-duplication in a service wrapper, was rejected because the bundle bypasses that wrapper on its hot write path.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/design/evolution-state-root.md §1.5、A-3、A5](../design/evolution-state-root.md)
