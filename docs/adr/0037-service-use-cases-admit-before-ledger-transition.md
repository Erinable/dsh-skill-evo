---
status: proposed
---

# service 里推进台账的用例先问准入、再转移；守卫在 service 一层，operations 只做 I/O 映射

`EvolutionService` 的 `stageProposal`、`evaluate`、`acceptProposal`，以及 promote 唯一的准入入口 `preparePromotion`（dry-run 和真实发布共用），第一步都是调 `admit`，通过之后才写台账。operations 不再自己做守卫，只做「解析引用 → 读文件 → 调一个 service 方法 → 写报告和 artifact → 映射错误」（ADR-0006）。这样一来，经 operations 和直接调 service 的结果相同，dry-run 和真实路径的结果也相同。stale Proposal 不再卡在 `evaluating`。

这条改了 service 的公开行为，包外直接调 service 的调用方（例如 `dsh-adapter` 的测试）会看到。所以记成不可逆：

- `service.evaluate`：Base 过期、current 缺失、用例非法时，抛 `OperationError`（`stale-base` / `invalid-option`），台账不动。以前抛不带 code 的 `Error`，台账已经转到 `evaluating`。
- `service.stageProposal`：Base 过期报 `stale-base`；还没有守卫的 operation，以及违反 ADR-0024「当且仅当」的记录，报 `invalid-option`。两种情况都不写台账，也不写候选目录。以前不检查。
- `service.acceptProposal`：create-skill 不管有没有 `source`，accept 前都要有 passing artifact。以前只看 `source.kind === 'pattern'`。普通 `edit` 仍然不要求 artifact，门槛在 promote 时查（SKIL-172 有意保留的 pattern-only accept gate）。

错误码沿用 `OperationErrorCode`，不新增。转移表不允许的转移仍是 `ProposalLedgerError('invalid-transition')`。runner 本身抛错时 Proposal 仍停在 `evaluating`，因为「评估开始过」是已经发生的事实。

## Considered Options

- 守卫留在 operations，service 维持「先转移」：直接调 service 的路径继续卡住、继续不带 code，dry-run 和真实路径继续可能分叉。这就是 SKIL-185 要解决的问题。否决。
- 新建 facade 类，让所有调用方只走它：ADR-0006 已经否决了 facade 类和命令分发器。service 的用例方法本身就是唯一入口。否决。

来源：`docs/design/proposal-admission.md` §4、§5、§7、§12（SKIL-186）
