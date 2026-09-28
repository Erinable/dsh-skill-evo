---
status: superseded by ADR-0021
---

# proposal 台账的记录身份：record id 带 `:status` 后缀、只按精确 root 或 record id 查、每次转移只写一条确定性 decision

Ledger records use a proposal root plus a `:status` suffix, lookups accept only an exact root or exact record id, and each transition writes one deterministic decision record. This preserves the durable format while removing ambiguous prefix matches and non-idempotent decision writes.

## Considered Options

- Bare prefix lookup was rejected because a prefix can identify multiple proposals and previously returned an arbitrary latest record instead of reporting ambiguity.

设计 PR 合并即接受默认答案（SKIL-43 / SKIL-46）
来源：[docs/design/maintenance-use-cases-proposal-ledger.md §2.3、D1、D2、D4](../design/maintenance-use-cases-proposal-ledger.md)

被 [ADR-0021](0021-ledger-record-ids-count-repeated-status-entries.md) 取代：record id 改为可区分同一状态的多次进入；精确查询与单条确定性 decision 两条规则在 ADR-0021 里保留。
