---
status: accepted
---

# 维护用例住在 core，CLI 与 bundle 是薄 adapter；evaluation artifact 由 core 写盘

Core exposes one function per maintenance use case, writes evaluation artifacts itself, and leaves CLI and bundle adapters responsible only for input and output mapping. This keeps the file-writing invariant in one place and prevents adapters from diverging again.

## Considered Options

- A facade or command dispatcher was rejected because it adds a wider, stateful or string-based interface to core.
- Having adapters write artifacts was rejected because each adapter would again decide whether and where the required file is written.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/design/maintenance-use-cases-proposal-ledger.md §2.1–§2.2、D7](../design/maintenance-use-cases-proposal-ledger.md)
