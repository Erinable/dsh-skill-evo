---
status: proposed
---

# Promote / Rollback 先写 intent journal 再前滚提交；收尾只在写路径和 repair 里做，纯读不写文件

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

所有时间和带时间的 id 都取自 `startedAt`，所以重跑写出来的是同样的字节、同样的 id。收尾有三个入口：操作本身、同一 Skill 的下一次 Promote / Rollback、`repair()`。`readCurrent`、`healthReport` 这类纯读路径不再写文件，health 用 `publications` 字段只读地报告未完成的发布。旧的 `<skill>/.publish.json` 只读兼容，不再写。

这样做是因为 SKIL-124 的复现（设计稿 §1.3）：

- Promote 在 W1 中途、W1 之后的 8 个崩溃点里，重跑有 6 个卡在 `stale-base`，1 个卡在不完整的快照，1 个卡在 `invalid-transition`。
- Rollback 没有 journal，R1 一旦覆盖了 live，重跑就推不出「从哪个版本、回滚了谁」，结果把另一个 Proposal 标成 `rolled-back`。
- repair 不碰发布，所以哪一行都收敛不了。

只有在覆盖 live 之前把这些输入持久化，重跑和 repair 才能得到同一个结果。

## 各崩溃点的收敛方式

- **P0**（journal 之前）：什么都没写，重跑就是正常执行，repair 什么都不做。
- **P1a–P1f**（W1 中途）：收尾从第一个与 journal 不一致的文件开始写，已经一致的跳过。快照写了一半时，live 仍等于 `from.contentHash`，快照照样补齐。
- **P2–P4**（W1 之后）：Observation id 是 `adoption:<root>`，`append` 返回 `false` 就说明写过；台账转移按 `fromRecordId` 判断是否写过，缺 decision 就补上。
- **R1a–R1c**：收尾按 journal 的 `to` 写 live，回滚对象取 journal 的 `proposalId`，不再重新推断。
- **R2–R5**：Observation 和 decision 的 id 用 `startedAt` 的毫秒值；台账转移同 P3、P4。
- **收尾之后的重跑**：Promote 的 Proposal 已是 `promoted` 并且 current 等于它的版本，或者 Rollback 的 current 已是目标版本，就什么都不写、直接返回成功。

**对 SKIL-121 的依赖**（ADR-0021，`proposed`）：台账转移要求幂等（以 `previousRecordId` 加目标状态判断是否写过），decision id 要由 record id 决定。在 SKIL-121 实现之前，`promoted` 和 `rolled-back` 对每个 root 各只进入一次，现有的 `<root>:<status>` id 就不会撞；transition decision 的 `updatedAt` 取 `startedAt` 也能得到确定 id。因此本 ADR 不依赖 ADR-0021 的编号规则落地，只依赖它不改变「按确定 id 判断写过」这一点。

与已有 ADR 的关系：

- **ADR-0001**：journal 位于状态目录，这正是它的要求。
- **ADR-0004**：转移合法性仍只由转移表判断。
- **ADR-0007**：repair 遇到 `held` 或 `foreign` 的发布锁时不回收，跳过并报告 `skipped-locked`。
- **ADR-0016**：journal 是临时状态文件，不是 Fact record；收尾只追加记录。
- **ADR-0020**：repair 先修 JSONL、隔离残行，再收尾。

与 `specs/skil-46-unified-lock-protocol/tasks.md` 的 P1、P1b 冲突：它们要求「下一次 `readCurrent` 前滚 journal」，本 ADR 把这一步移到下一次 Promote / Rollback 或 repair。回收死锁的部分不变。

## Considered Options

- **A. 按写入顺序幂等，不加 journal**，被拒绝。它的代价是：
  - Promote 的每个崩溃点都要一条「从 live 和台账推断进度」的规则，分散在 promote、rollback、repair 三处。两个 Proposal 的候选正文相同时，推断有歧义。
  - Rollback 在 R1 之后已经丢了回滚前的版本和回滚对象，R2、R3 的 `Date.now()` id 也无法重现。要补上，就得在 R1 之前把这些写进某个 store，这就等于一个拆散的 journal，却没有统一的完成标记。
  - health 也只能靠推断，才能报告 P2–P4 这类未完成的发布。
- **journal 保留在 `<skill>/.publish.json`、只扩展字段**，被拒绝。演化状态会继续散落在 Skill 目录（与 ADR-0001 相悖），Rollback 也要往 Skill 目录写状态，repair 还得扫描整个 Skill 根。
- **把 intent / done 作为事件追加进 `decisions.jsonl`**，被拒绝。事实流里会出现「尚未发生」的语义（与 ADR-0016 相悖），repair 也要 fold 整条流才知道哪些没做完。
- **在读路径（`readCurrent`）继续收尾**，被拒绝。health 读一次就改变了它要报告的状态；读路径拿不到台账和 Observation 的依赖，只能做完文件那一半，留下「live 已是新版、Proposal 仍是 `accepted`」的状态。
- **发现半截发布就回退到发布前**，被拒绝。W1 写完 live 之后，Skill 的下一次加载可能已经读到新版，回退会让外部看到版本来回跳。前滚只有一个方向，也不需要保存回退用的旧文件。

## Consequences

- journal 格式 `v: 1` 成为持久格式。以后加字段只能是可选字段；不兼容的改动要升 `v`，并在读取端同时支持两个版本。
- W2–W5 挪进发布锁内。锁顺序固定为「发布锁 → store 锁」，任何路径都不许反向加锁。
- `readCurrent` 不再前滚。依赖读时恢复的 3 条现有测试（设计稿 §3.2）改为通过 repair 或下一次 Promote 收尾。
- journal 未收尾期间，`readCurrent` 返回的可能是一半新、一半旧的 live 文件（例如正文是新版、manifest 是旧版），和今天崩溃之后、下一次读之前的状态相同。消费方以 `healthReport().publications` 为准。
- 旧的 `.publish.json` 要兼容读，直到所有部署都跑过一次 repair。之后可以另开 ADR 删掉这段兼容代码。
- 如果 SKIL-121 最终改变了「按确定 id 判断写过」的做法，`completePublication` 的台账步骤要跟着改，journal 格式不变。

来源：[docs/design/publication-crash-recovery.md](../design/publication-crash-recovery.md)
