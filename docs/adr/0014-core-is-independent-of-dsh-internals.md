---
status: accepted
---

# core 包不依赖 DSH 内部，DSH 集成只放 adapter / bundle

The core package does not depend on DSH internals; DSH-specific integration belongs in the adapter or bundle. This preserves a reusable evolution core and keeps integration changes at the boundary.

## Considered Options

- Importing DSH or bundle modules from core was rejected because it violates the repository dependency red line and couples the core package to one host runtime.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[AGENTS.md:14](../../AGENTS.md)
