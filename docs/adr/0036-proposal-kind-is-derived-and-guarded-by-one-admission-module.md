---
status: proposed
---

# Proposal 种类在读取时推出、不持久化；按种类的守卫只住在准入 module 里

一个 Proposal 属于哪个种类（`edit`、`pattern-edit`、`environmental-edit`、`create-skill`，以后还有 `retire` 等），由 `admission.ts` 的 `proposalKind` 从现有字段推出：`operation`、`source`、`expectedBase`。种类不写进台账。按种类定的规则都只写在这个 module 私有的种类表里：Base 检查、允许的 scope、accept 前是否要求 passing artifact，以及 stage / evaluate / accept / promote 各阶段的守卫顺序。种类表用 `Record<ProposalKind, …>` 写成穷举，新增种类漏一行就编译失败。别处不再自己看 `'absent'`、`operation === 'create-skill'`、`source.kind`、`environmental` 来做守卫，由架构测试守住。

推导规则同时就是「老记录怎么读」的契约，所以不可逆：

- 没有 `operation` 的老记录读成 `edit`。
- `split`、`merge`、`retire`、`observe-only` 在有守卫之前一律报 `invalid-option`，不会被当成 `edit` 放行。
- `operation === 'create-skill'` 与 `expectedBase.contentHash === 'absent'` 不同时成立，报 `invalid-option`。这是 ADR-0024 写下的「当且仅当」，以前没有任何地方检查。

依赖方向是 operations → service → admission → 叶子 module（`promotion-check`、`adoption`、`proposal`、`correction`）。operations 不再依赖准入和 promotion-check。lifecycle 的锁内 Base 复查和准入共用叶子函数 `adoption.ts` 的 `baseMatches`，lifecycle 不依赖准入。准入是纯函数，事实由 service 读好传入。

## Considered Options

- 给 `SkillProposal` 加持久化的 `kind` 字段：会改台账格式，违反 ADR-0024 / SKIL-185 的约束，老记录要回填；`kind` 和 `operation`、`'absent'` 会变成三份需要保持一致的事实。否决。
- 准入带一个读取 port，自己读 current 和 artifact：生产上只有一个 adapter，是假想的 seam，测试反而要多写一个 in-memory reader。否决。
- 准入把台账转移一起包进去（`admitAndTransition`）：evaluate 要转两次，promote 的转移在 journal 收尾里（ADR-0032），准入就成了台账的第二个入口，和 ADR-0004 冲突。否决。
- lifecycle 引用准入的 Base 检查：`SkillVersionStore` 可以单独使用，反向依赖会形成类型环。否决，改为共享叶子函数。

来源：`docs/design/proposal-admission.md` §2.1、§2.2、§2.4、§2.5、§3（SKIL-186）
