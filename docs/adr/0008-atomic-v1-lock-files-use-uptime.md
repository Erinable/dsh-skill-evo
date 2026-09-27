---
status: accepted
---

# 锁文件用 tmp + `link()` 原子创建，owner 记录 v1，靠 `uptimeMs` 判断重启

Lock owners use a v1 record and are created by writing a temporary file then linking it into place atomically; reboot detection compares monotonic `uptimeMs` rather than wall-clock timestamps. The v1 format remains readable by v0 processes while preventing partial-owner races and clock-jump misclassification.

## Considered Options

- Writing directly with `open('wx')` leaves a partial-owner window, and `mkdir` changes the lock from a file to a directory that old processes cannot use; both were rejected.
- Wall-clock `createdAt` was rejected for v1 reboot detection because clock changes can make a live lock appear rebooted.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/design/unified-lock-protocol.md §2.2、§2.3、F1](../design/unified-lock-protocol.md)
