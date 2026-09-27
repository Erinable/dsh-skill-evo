---
status: accepted
---

# 演化状态集中在 `<root>/.skill-evolution/`，observation log 可以放在状态目录之外

Evolution state lives in `<root>/.skill-evolution/`, while the observation store may be explicitly placed outside that directory. Keeping this layout avoids migrating existing data and preserves a reversible rollback path.

## Considered Options

- Moving the state directory beside each Skill was rejected because it would require an online data migration and a reverse move to roll back.

成员确认：SKIL-38
来源：[docs/design/evolution-state-root.md §1.1、A1](../design/evolution-state-root.md)
