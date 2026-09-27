---
status: accepted
---

# setup 模板与 `docs/agents/` 安装副本逐字节相同；实例事实只放 `docs/agents/instance.md`

Setup templates and the installed `docs/agents/issue-tracker.md` copy remain byte-for-byte identical, while repository-specific facts live only in `docs/agents/instance.md`. This gives setup a mechanically verifiable output contract and prevents member ids, labels, and routing facts from leaking into reusable templates.

## Considered Options

- Appending an instance override section to the installed copy was rejected because a simple `diff` could no longer verify template parity and unrelated facts would be mixed into the tracker seam.
- Parameterized placeholders were rejected because consumers would still need a second source for the resolved values.

成员确认：SKIL-39
来源：[docs/design/skil-36-seams.md §5、D-2、D-6](../design/skil-36-seams.md)
