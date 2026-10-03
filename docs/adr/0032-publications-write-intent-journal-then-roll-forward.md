---
status: proposed
---

# Promote / Rollback 先写 intent journal 再前滚提交；收尾只在写路径和 repair 里做，不可完成就隔离；纯读不写文件、不取发布锁

Promote 和 Rollback 在持有发布锁、通过唯一一份晋升校验之后，第一件写入的事是 `.skill-evolution/publications/<skill>.json`。它是这次操作的 intent journal，里面有：

- `operation`、`skillName`、`scope`；
- `proposalId`，以及 Rollback 的回滚对象；
- `from` / `to` 两端的 `{version, contentHash}`；
- `startedAt`；
- 台账转移需要的 `fromRecordId`、`reason`、`actor`、`policyVersion`、`evidenceIds`。

journal 不放正文，正文按 hash 从候选目录或 `versions/<to>` 取。journal 写成就是提交点：之前崩溃等于什么都没发生，之后只前滚，不回退。

收尾由一个函数 `completePublication` 完成。它按固定顺序做完剩下的事，每一步都是「比较后才写」或「按确定 id 追加」：

- 版本快照
- live 文件
- `invalidate`
- Observation
- Skill 级 decision
- 台账转移（Ledger record 和 decision）
- 最后删除 journal

所有时间和带时间的 id 都取自 `startedAt`，所以重跑写出来的是同样的字节、同样的 id。收尾有四个入口：操作本身、同一 Skill 的下一次 Promote / Rollback、reject、`repair()`。`readCurrent`、`healthReport` 这类纯读路径不再写文件，也不再取发布锁；health 用 `publications` 字段只读地报告未完成的发布，锁被持有时照常返回，并标 `lock: 'held'`。旧的 `<skill>/.publish.json` 只读兼容，不再写。

**台账守卫**：journal 存在期间，它的 `fromRecordId` 必须一直是该 root 的最新记录。所以凡是出发状态是 `accepted` 或 `promoted` 的台账转移，都在该 Skill 的发布锁内执行，并且先收尾。这类转移除了 Promote / Rollback 自己，只剩 `accepted → rejected`，也就是 `rejectProposal`。收尾之后，以台账里的最新记录为准做校验。于是「崩溃后 reject」等价于「先完成 Promote、再 reject」，后者报 `conflict`（SKIL-121 实现之前是 `invalid-transition`）。守卫放在 service 层，ADR-0021 的判定不变。

**收尾失败**分两类：
- **可重试**：I/O 错误、store 锁拿不到、`invalidate` 抛错。journal 保留。
- **不可完成**：重试多少次结果都一样，包括：
  - 台账转移报 `conflict` / `invalid-transition`，只有协议之外的写入才会造成，例如未升级的旧进程；
  - 正文缺失或 hash 不符；
  - journal 损坏。

  这时 journal 被**隔离**：原文写进 `publications/quarantine/<skill>-<ms>-<pid>-<uuid>.json`，然后删掉 journal。已经前滚的文件保持不动。隔离文件只由成员删除，health 在 `quarantinedPublications` 里一直报告。

各入口的处理：

| 入口 | 可重试失败 | 不可完成 |
|---|---|---|
| Promote、reject | 报 `publication-pending`，什么都不写 | 隔离后照常执行 |
| Rollback | 隔离后照常回滚 | 隔离后照常回滚 |
| repair | 报 `failed` | 隔离，报 `quarantined` |

Rollback 是逃生口，任何旧 journal 都挡不住它。

**Rollback 的回滚对象**在锁内、写 journal 之前推断一次，写进 journal 的 `proposalId` / `fromRecordId`，之后只读 journal：
- 本次隔离了旧 journal：被隔离的 journal 的 `proposalId`，前提是它最新记录是 `promoted`；否则不做台账转移。
- 否则按 live **正文** hash 匹配最新记录是 `promoted` 的 Proposal 的候选 hash；多个时用 live manifest 版本区分；匹配不到或仍有歧义就不做台账转移，只做文件步骤和 Skill 级记录。
- 正文和 manifest 不一致时以正文为准。今天的 `latestPromoted` 按 manifest 版本匹配，manifest 落后于正文时会把上一个 Proposal 标成 `rolled-back`（设计稿 §1.3 R1b、§4 G6）。

这样做是因为 SKIL-124 的复现（设计稿 §1.3）：

- Promote 在 W1 中途、W1 之后的 8 个崩溃点里，重跑有 6 个卡在 `stale-base`，1 个卡在不完整的快照，1 个卡在 `invalid-transition`。
- Rollback 没有 journal，R1 一旦覆盖了 live，重跑就推不出「从哪个版本、回滚了谁」，结果把另一个 Proposal 标成 `rolled-back`。
- repair 不碰发布，所以哪一行都收敛不了。

只有在覆盖 live 之前把这些输入持久化，重跑和 repair 才能得到同一个结果。

## 各崩溃点的收敛方式

- **P0**（journal 之前）：什么都没写，重跑就是正常执行，repair 什么都不做。
- **P1a–P1f**（W1 中途）：收尾从第一个与 journal 不一致的文件开始写，已经一致的跳过。快照写了一半时，live 仍等于 `from.contentHash`，快照照样补齐。
- **P2–P4**（W1 之后）：Observation id 是 `adoption:<root>`，`append` 返回 `false` 就说明写过；台账转移按 `fromRecordId` 判断是否写过，缺 decision 就补上。
- **R1a–R1c**：收尾按 journal 的 `to` 写 live，回滚对象取 journal 的 `proposalId`（写 journal 前按正文推断好的），不再重新推断。
- **R2–R5**：Observation 和 decision 的 id 用 `startedAt` 的毫秒值；台账转移同 P3、P4。
- **收尾之后的重跑**：Promote 的 Proposal 已是 `promoted` 并且 current 等于它的版本，或者 Rollback 的 current 已是目标版本，就什么都不写、直接返回成功。
- **提交点之后有人 reject 同一个 Proposal**：
  - 协议内：reject 先收尾，Proposal 变为 `promoted`，reject 报 `conflict`（SKIL-121 实现之前是 `invalid-transition`）。结果等于一次成功的 Promote。
  - 协议外（旧进程已写入 `<root>:rejected`）：收尾时文件前滚，台账转移报 `conflict`，journal 被隔离。结果是 live 为新版、Proposal 为 `rejected`，health 报告隔离文件。成员可以直接 Rollback。
  - 「提交之后等于一次成功执行」的保证，只在不可完成时失效。不可完成只有三种来源：协议之外的台账写入、候选或快照文件被删改、journal 损坏。三种都会隔离 journal，并在 health 里报告。

**对 SKIL-121 的依赖**（ADR-0021，已接受并合并；实现尚未合并）：台账转移要求幂等（以 `previousRecordId` 加目标状态判断是否写过），decision id 要由 record id 决定。ADR-0021 的 `conflict` 挡不住「journal 写成之后，别人从同一个 `accepted` 合法地转走」，这一缺口由上面的台账守卫补上。在 SKIL-121 实现之前，`promoted` 和 `rolled-back` 对每个 root 各只进入一次，现有的 `<root>:<status>` id 就不会撞；transition decision 的 `updatedAt` 取 `startedAt` 也能得到确定 id。因此本 ADR 不依赖 ADR-0021 的编号规则落地，只依赖它不改变「按确定 id 判断写过」这一点。

与已有 ADR 的关系：

- **ADR-0001**：journal 位于状态目录，这正是它的要求。
- **ADR-0004**：转移合法性仍只由转移表判断。
- **ADR-0007**：repair 遇到 `held` 或 `foreign` 的发布锁时不回收，跳过并报告 `skipped-locked`。
- **ADR-0016**：journal 是临时状态文件，不是 Fact record；收尾只追加记录。
- **ADR-0020**：repair 先修 JSONL、隔离残行，再收尾。journal 的隔离沿用它「原样保留字节、后缀带 ms-pid-uuid」的惯例。

与 `specs/skil-46-unified-lock-protocol/tasks.md` 的 P1、P1b 冲突：它们要求「下一次 `readCurrent` 回收死锁并前滚 journal」，本 ADR 把这两步都移到下一次 Promote / Rollback / reject 或 repair。回收规则（ADR-0007）不变，只是 `readCurrent` 不再取锁，也就不再是回收入口。

## Considered Options

- **A. 按写入顺序幂等，不加 journal**，被拒绝。它的代价是：
  - Promote 的每个崩溃点都要一条「从 live 和台账推断进度」的规则，分散在 promote、rollback、repair 三处。两个 Proposal 的候选正文相同时，推断有歧义。
  - Rollback 在 R1 之后已经丢了回滚前的版本和回滚对象，R2、R3 的 `Date.now()` id 也无法重现。要补上，就得在 R1 之前把这些写进某个 store，这就等于一个拆散的 journal，却没有统一的完成标记。
  - health 也只能靠推断，才能报告 P2–P4 这类未完成的发布。
- **journal 保留在 `<skill>/.publish.json`、只扩展字段**，被拒绝。演化状态会继续散落在 Skill 目录（与 ADR-0001 相悖），Rollback 也要往 Skill 目录写状态，repair 还得扫描整个 Skill 根。
- **把 intent / done 作为事件追加进 `decisions.jsonl`**，被拒绝。事实流里会出现「尚未发生」的语义（与 ADR-0016 相悖），repair 也要 fold 整条流才知道哪些没做完。
- **在读路径（`readCurrent`）继续收尾**，被拒绝。health 读一次就改变了它要报告的状态；读路径拿不到台账和 Observation 的依赖，只能做完文件那一半，留下「live 已是新版、Proposal 仍是 `accepted`」的状态。
- **reject 不取发布锁，靠收尾时处理冲突**（Reviewer 的选项 b 单独使用），被拒绝。协议内的 reject 也会让已经上线的版本配上一个 `rejected` 的 Proposal，每次都要成员介入。守卫让这种结局只剩协议之外的写入一种来源。
- **不可完成时保留 journal、一直报 `failed`**，被拒绝。同一 Skill 的下一次 Promote / Rollback 要么永远被挡，要么每次都得跳过同一个 journal，两者都会让 health 的报告失去意义。隔离之后 journal 目录只剩还能做完的发布。
- **纯读路径继续取发布锁**，被拒绝。W2–W5 挪进锁内之后，持锁时间变长，health、propose、evaluate、dry-run 在这段时间里都会报「already in progress」，health 也就报告不出 `lock: 'held'`。读路径取锁本来只为了串行化「读时恢复」，恢复挪走之后，这把锁对读已经没有用处。
- **发现半截发布就回退到发布前**，被拒绝。W1 写完 live 之后，Skill 的下一次加载可能已经读到新版，回退会让外部看到版本来回跳。前滚只有一个方向，也不需要保存回退用的旧文件。
- **回滚对象沿用 `latestPromoted`（按 live manifest 版本匹配）**，被拒绝。manifest 落后于正文时（被隔离的半截 Promote 留下的 live），它指向的是正文并未生效的上一个 Proposal，会把它标成 `rolled-back`。按正文匹配的代价是：正文来自未完成的 Promote 时，台账里不会留下这次回滚的转移，只能从 Skill 级 decision、Observation 和隔离文件看出来。

## Consequences

- journal 格式 `v: 1` 成为持久格式。以后加字段只能是可选字段；不兼容的改动要升 `v`，并在读取端同时支持两个版本。
- W2–W5 挪进发布锁内。锁顺序固定为「发布锁 → store 锁」，任何路径都不许反向加锁。
- `readCurrent` 不再前滚，也不取发布锁、不回收死锁。依赖读时恢复的 3 条现有测试（设计稿 §3.2）改为通过 repair 或下一次 Promote 收尾。
- `rejectProposal` 要取发布锁，最多等 5s。发布进行中调用 reject 会等待，或者报「already in progress」。
- `publications/quarantine/` 成为持久目录，格式 `v: 1`。代码只写不删，删除由成员决定。
- journal 未收尾期间，`readCurrent` 返回的可能是一半新、一半旧的 live 文件（例如正文是新版、manifest 是旧版），和今天崩溃之后、下一次读之前的状态相同。消费方以 `healthReport().publications` 为准。
- 旧的 `.publish.json` 要兼容读，直到所有部署都跑过一次 repair。之后可以另开 ADR 删掉这段兼容代码。
- SKIL-121 的实现合并后，`completePublication` 的台账步骤换成 `ProposalLedger.transition`，journal 格式不变。

来源：[docs/design/publication-crash-recovery.md](../design/publication-crash-recovery.md)
