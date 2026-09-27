---
status: accepted
---

# 锁只承诺同主机、本地文件系统；`held` 与 `foreign` 锁永不自动回收

The lock protocol is scoped to one host and a local filesystem: locks whose owner is still `held` or whose hostname is `foreign` are retained indefinitely, while only unknown, rebooted, or dead local locks may be reclaimed. This avoids concurrent writers and leaves network-filesystem support for a future lease-and-heartbeat protocol.

## Considered Options

- A lease with heartbeat was rejected for this local-only protocol; supporting network filesystems would require a different liveness mechanism rather than a second hidden rule.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/design/unified-lock-protocol.md §2.3、§3.5、D3–D4](../design/unified-lock-protocol.md)
