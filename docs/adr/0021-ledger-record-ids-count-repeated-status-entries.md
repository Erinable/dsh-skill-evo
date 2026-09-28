---
status: proposed
---

# Ledger record id 按「第几次进入该状态」编号；旧记录原样兼容读；每条 Ledger record 恰好对应一条 decision

取代 ADR-0005。

Ledger record 的 id 改为：一个 Proposal root 第 1 次进入某状态时仍是 `<root>:<status>`，第 n 次（n ≥ 2）是 `<root>:<status>:<n>`。n 是该 root 在台账里已有的同状态记录数加 1，在持有 `proposals.jsonl.lock` 时计算；算出的 id 已被占用（只可能来自历史脏数据）时继续加 1 直到空闲。`proposed` 记录的 id 仍是 root 本身。新记录带可选字段 `previousRecordId`，指向这次转移的出发记录；「同一个 `previousRecordId` + 同一个目标状态」就是同一次转移，重跑时返回已有记录，不再新写。

磁盘上已有的记录不改写、不迁移：ADR-0005 下写出的每个 id 都是新规则里的「第 1 次」，天然合法；缺 `previousRecordId` 的旧记录照常读。每条 Ledger record 恰好对应一条 transition decision，id 为 `decision:ledger:<recordId>`，并带 `recordId` 字段；重跑同一次转移得到同一个 record 和同一个 decision id。

这样做是因为 ADR-0005 的 `<root>:<status>` 让同一状态只能写一次。Proposal 回流（`rejected` / `deferred` → `observed` → `evaluated`）时，第二次 `<root>:evaluated` 被 `JsonlRecordStore.append` 判重返回 `false`，调用方不看返回值，记录静默丢失，而对应的 decision 却写进去了（SKIL-95 Reviewer 与 SKIL-123 设计稿 §1.3 均已复现）。

ADR-0005 里仍然成立的部分原样保留：只按精确 root 或精确 record id 查，不做裸前缀匹配；每次转移只写一条确定性 decision。

与已有 ADR 的关系：

- **ADR-0004**：转移表仍是唯一来源。写台账前的合法性校验只在台账转移操作里做一次（`assertCanTransition`），operations 的提前检查只是为了早报错，不是第二份规则。
- **ADR-0016**：Ledger record 和 Decision record 都是 Fact record，只追加。正因为如此旧数据只做兼容读，不做改写式迁移。
- **ADR-0020**：`proposals.jsonl` 与 `decisions.jsonl` 复用同一套 JSONL 分帧与残行隔离。残行不是记录，所以计算 n 时不计入残行；崩溃遗留的半条记录被隔离后，它的编号会被下一次成功写入重新使用，这是正确的，因为那条记录从未被确认写入。

## Considered Options

- **每条记录都带编号（`<root>:<status>:1` 起）**：被拒绝。旧记录没有 `:1`，同一条逻辑记录会有两种拼法，查询和重跑判断都要兼容两套。
- **按 root 的全局序号（`<root>:<seq>:<status>` 或 `<root>#<seq>`）**：被拒绝。它给出全序，但第一次进入某状态的 id 也跟着变，旧数据只能靠「按文件顺序推断序号」兼容读或一次性迁移；CLI、bundle 和测试里拼 `<root>:evaluated` 的写法全部失效。
- **随机或时间戳后缀（transition uuid、`updatedAt`）**：被拒绝。id 不确定，重跑同一次转移会写出第二条，重新引入 SKIL-51 修掉的非幂等问题，也让 Promote / Rollback 的恢复（SKIL-122）无法判断「这一步写过没有」。
- **保留 `<root>:<status>`、允许台账里出现重复 id**：被拒绝。id 不再是身份，`JsonlRecordStore` 的去重契约和「按 record id 精确查」同时失效。
- **一次性迁移旧文件**：被拒绝。要用 `replaceAll` 改写 Fact record，违反 ADR-0016；而且在上面的编号规则下旧 id 已经合法，迁移没有收益。
- **decision id 继续用 `decision:transition:<root>:<to>:<updatedAt>`**：被拒绝。同一毫秒内两次进入同一状态会撞 id，decision 又会被静默判重；绑定 record id 后一一对应、天然唯一。

## Consequences

- Proposal root 不能以「状态后缀」或「状态后缀 + 编号」结尾，否则 root 解析会把它截短。staging 时校验 `proposalRootId(root) === root`，不满足就报错。
- 编号语法固定为 `[2-9]` 或 `[1-9][0-9]+`；`<root>:<status>:1` 不是合法 record id。
- `proposed` 只能从 `draft` 进入一次。转移表以后若新增进入 `proposed` 的边，需要新 ADR 决定第 2 次 `proposed` 的 id。
- 判断「这次转移写过没有」只看 `previousRecordId`，不看时间戳。Promote / Rollback 的恢复（SKIL-122）依赖这一点。
- 本 ADR 之前因为判重被丢掉的记录无法补回。那次转移的 decision 已经写入，于是旧数据里可能存在「有 decision、无 Ledger record」的情况。不自动回填；metrics 按 root 去重计数，不受影响。
- 旧 decision（`decision:transition:<root>:<to>:<updatedAt>`，以及更早的 action-only 记录）不改写，metrics 继续兼容读。
- 部署期间旧版进程不认识 `:<n>` 后缀，会把 `<root>:evaluated:2` 当成另一个 root，出现一条幽灵 Proposal；旧版进程也仍会静默丢掉重复进入。CLI、bundle 和 adapter 必须一起升级，之后这个风险才消失。

来源：[docs/design/proposal-ledger-transition.md](../design/proposal-ledger-transition.md)
