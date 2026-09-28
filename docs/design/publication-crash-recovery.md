> 状态：SKIL-124 设计提案（父 issue SKIL-122）。决策见 ADR-0022（`proposed`，待成员确认）。台账转移与 record id 依赖 SKIL-121（设计 SKIL-123，PR #78，ADR-0021 `proposed`）。
> 本文合并后冻结，不随代码更新；与现状不一致时以代码、ADR 和 spec 为准。

本文要解决三件事。第一，Promote / Rollback 在任一写入点崩溃后，重跑或 repair 都能收敛到「成功跑过一次」的状态。第二，两份晋升校验收成一份。第三，health 能报告没做完的发布，repair 能把它做完。基线是 `origin/main` @ `2a442af`。本文只出设计，不写实现代码；随 PR 附带的复现测试 `packages/skill-evolution/tests/publication-crash-recovery.spec.ts` 同时是回归测试。

## 1. 现状

### 1.1 读了什么

- 源码：
  - `packages/skill-evolution/src/`：`service.ts`、`operations.ts`、`lifecycle.ts`、`proposal.ts`、`records.ts`、`repair.ts`（全文）。
  - 按需读了 `health.ts`、`state-root.ts:20-77`、`jsonl.ts`、`locking.ts`（导出与 `withLock`）、`metrics.ts`、`index.ts`。
- 调用方：
  - `packages/dsh-bundle/index.js:196-197`（health / repair）
  - `packages/skill-evolution/bin/dsh-skill-evolution.mjs:89,177`
  - `packages/dsh-adapter/tests/adapter.spec.ts:161-190`
- 现有测试：
  - `tests/evolution.spec.ts:175-375`：发布、journal 恢复、SIGKILL、锁。
  - `tests/evolution.spec.ts:482-571`：`service.promote`、artifact 校验。
  - `tests/cli.spec.mjs:66-110`。
- 文档：
  - `CONTEXT.md`（Proposal 与台账、评估与发布两节）。
  - ADR-0001、0002、0004、0005、0006、0007、0016、0020。
  - `docs/design/unified-lock-protocol.md`、`specs/skil-46-unified-lock-protocol/tasks.md` P1/P1b。
  - SKIL-123 的 PR #78：`docs/design/proposal-ledger-transition.md`、ADR-0021 草案。
- 基线 `npm test`（`packages/skill-evolution`）：`Test Files  12 passed (12)`、`Tests  134 passed (134)`。

### 1.2 写入点

**Promote**：`promoteProposal` 先检查状态、加载 artifact、做 `precheckPromotion`（`operations.ts:158-167`），再调用 `service.promote`（`service.ts:247-279`），依次写入：

| 写入点 | 内容 | 位置 | id |
|---|---|---|---|
| W1 | `versions.promote`，持发布锁：写候选 → `.publish.json` → mkdir `versions/<to>` →（旧版本是有版本号但没快照时）快照 `versions/<from>/SKILL.md`、`manifest.json` → `versions/<to>/SKILL.md`、`manifest.json` → live `SKILL.md`、`manifest.json`、`current.json` → `invalidate` → 删 `.publish.json` | `lifecycle.ts:88-153` | — |
| W2 | Observation `adoption-applied` | `service.ts:260` | `adoption:<root>` |
| W3 | Ledger record | `service.ts:277` | `<root>:promoted` |
| W4 | transition decision | `service.ts:278` → `:361-385` | `decision:transition:<root>:promoted:<updatedAt>`，`updatedAt` 取自 `new Date()` |

W2–W4 在发布锁之外写。

**Rollback**：`service.rollback`（`service.ts:304-341`）先 `readCurrent`，拿到的是回滚前的版本 `before`，然后依次写入：

| 写入点 | 内容 | 位置 | id |
|---|---|---|---|
| R1 | `versions.rollback`，持发布锁：live `SKILL.md`、`manifest.json`、`current.json` → `invalidate`。**没有 journal** | `lifecycle.ts:164-193` | — |
| R2 | Observation | `service.ts:310` | `rollback:<skill>:<ver>:<Date.now()>` |
| R3 | Skill 级 rollback decision | `service.ts:326` | `decision:rollback:<skill>:<ver>:<Date.now()>` |
| R4 | Ledger record | `service.ts:338` | `<root>:rolled-back` |
| R5 | transition decision | `service.ts:339` | 同 W4 |

R4 要回滚的是哪个 Proposal，由 `latestPromoted` 决定（`service.ts:307`）：它按 `proposedVersion === before.manifest.version` 在最新状态里查找。

现有恢复只覆盖 W1。`readCurrentUnlocked` 每次读都会调用 `recoverPublication`（`lifecycle.ts:39-42,309-338`）：

- 版本目录不完整时，删除版本目录和 journal。
- 版本目录完整、hash 对得上时，把 live 三个文件前滚，然后删掉 journal。

所以任何读路径都可能写文件，`healthReport` 也是（它经 `healthIssues` 调用 `readCurrent`，见 `lifecycle.ts:206-225`）。`repair()`（`service.ts:151-163`）只做四件事：回收锁、修 JSONL、检查 manifest、刷新投影。它不碰发布。

### 1.3 复现

复现测试是 `tests/publication-crash-recovery.spec.ts`，它按三种方式注入崩溃：

- `file`：拦截 `writeFile` 写目标文件的 `.tmp-` 临时文件，此时目标文件还没被 rename 覆盖，等同于在这次原子写之前崩溃。
- `invalidate`：让 `invalidate` 回调抛错。
- `call`：让某个 store 第 n 次 `append` 抛错。

每个崩溃点跑两条测试。「重跑」是崩溃后再调一次同样的 `promoteProposal` / `rollbackSkill`；「repair」是崩溃后只调 `service.repair()`。两条测试都把结果和另一个目录里「成功跑过一次」的参考状态逐项比较。比较范围是 Skill 目录下的全部文件、journal 目录、`proposals` / `decisions` / `observations` 三个 JSONL，时间戳和毫秒 id 已归一化。

`beforeCommit` 行（P0）的 repair 期望的是操作之前的状态。今天会失败的行标成 `it.fails`，设 `EXPECT_PUBLICATION_RECOVERY=1` 可以当普通测试跑，看到今天的实际失败。

```
$ npm test                     # packages/skill-evolution
 Test Files  13 passed (13)
      Tests  137 passed | 36 expected fail (173)

$ EXPECT_PUBLICATION_RECOVERY=1 npx vitest run tests/publication-crash-recovery.spec.ts
      Tests  36 failed | 3 passed (39)
```

今天能收敛的只有 3 条：P0 的重跑、P0 的 repair、P1a 的重跑。P1a 能收敛，是因为 `recoverPublication` 会删掉空的版本目录。

**Promote**（场景：Skill 没有 manifest，accepted 的 `proposal-crash` 把 1.1.0 发布出去；P1f 改用已有 1.0.0 manifest 的 Skill）

| 崩溃点 | 崩溃后 health | 重跑 | 只跑 repair |
|---|---|---|---|
| P0 写 journal 之前 | — | 收敛 | 收敛（本来就什么都没写） |
| P1a `versions/1.1.0/SKILL.md` 之前 | `skillIssues` 只有 `current.json`，状态 `accepted` | 收敛 | 不收敛：留着 `.publish.json`，live 没有 manifest 和 `current.json` |
| P1b live `SKILL.md` 之前 | `skillIssues: []`，`readCurrent` 已是 1.1.0，状态 `accepted` | **`stale-base`** | 不收敛：缺 Ledger record、decision、Observation |
| P1c live `manifest.json` 之前 | 同上 | **`stale-base`** | 同上 |
| P1d `current.json` 之前 | 同上 | **`stale-base`** | 同上 |
| P1e `invalidate` 抛错 | 同上 | **`stale-base`** | 同上 |
| P1f 快照 `versions/1.0.0/manifest.json` 之前 | `current.json`、`versions/1.0.0` 两条 | **卡死**：`incomplete published Skill version at .../1.0.0` | 不收敛：快照缺一半，live 未写 |
| P2 W1 之后、Observation 之前 | `[]`，1.1.0，`accepted` | **`stale-base`** | 不收敛：缺 W2–W4 |
| P3 W2 之后、Ledger record 之前 | 同上 | **`stale-base`** | 不收敛：缺 W3、W4 |
| P4 W3 之后、decision 之前 | `[]`，1.1.0，状态已是 `promoted` | **`invalid-transition`**：`must be accepted before promotion` | 不收敛：缺 W4 |

扫描推断的「卡在 `stale-base`」在 P1b–P3 得到证实。另外还有两种卡法：P1f 卡在不完整的快照，P4 卡在转移表。health 在所有行都不报告「有一次 Promote 没做完」；P1b–P3 时 live Skill 已经是新版本，Proposal 却还停在 `accepted`。

**Rollback**（场景：`proposal-one` 发布 1.0.0，`proposal-two` 发布 1.1.0，然后回滚到 1.0.0）

| 崩溃点 | 崩溃后 health | 重跑 | 只跑 repair |
|---|---|---|---|
| R1a live `manifest.json` 之前 | 只有 `current.json` | 返回成功但状态错：`fromContentHash` 取的是已经回滚的 live 正文 | 不收敛：manifest、`current.json` 仍是 1.1.0 |
| R1b `current.json` 之前 | 只有 `current.json` | **标错 Proposal**：重跑时 current 已是 1.0.0，`latestPromoted` 选中 `proposal-one`，把它标成 `rolled-back`，`proposal-two` 仍是 `promoted` | 不收敛：`current.json` 仍是 1.1.0，缺全部记录 |
| R1c `invalidate` 抛错 | `[]` | 同 R1b | 不收敛：缺全部记录 |
| R2 Observation 之前 | `[]` | 同 R1b | 同上 |
| R3 rollback decision 之前 | `[]` | 同 R1b，另外 Observation 多一条（新的 `Date.now()` id） | 缺 R3–R5 |
| R4 Ledger record 之前 | `[]` | 同 R3 | 缺 R4、R5 |
| R5 transition decision 之前 | `[]`，`proposal-two` 已 `rolled-back` | 多一条 `proposal-one:rolled-back`，缺 `proposal-two` 的 decision，Observation 4 条（应为 3） | 缺 R5 |

Rollback 没有 journal。R1 之后，「这次回滚的是谁、从哪个版本回滚」只能从 live 文件重新推断，而 live 文件已经被改写，所以每次重跑都会推错。「再回滚到已是 current 的版本」也不是 no-op，会再写一轮记录（测试 `a second rollback to the version that is already current writes nothing`）。

**读路径会写文件**：P1c 之后调一次 `healthReport()`，Skill 目录从 4 个文件变成 5 个，因为 `recoverPublication` 前滚了 live 文件（测试 `health reads a half-written promote without changing any file`）。

### 1.4 两份晋升校验

| 检查 | `service.requireEvaluationArtifact`（`service.ts:285-302`） | `operations.precheckPromotion`（`operations.ts:252-267`） | `lifecycle.promoteUnlocked` |
|---|---|---|---|
| 状态 | `assertCanTransition(proposal.status, 'promoted')`，看的是传进来的对象 | 按 ref 从台账取最新记录，要求 `accepted` | — |
| artifact 来源 | 必须带 `artifactId`；只比 `passedGate`、`candidateContentHash` | 支持 `--evaluation` 文件、传入对象，或最新未过期的 artifact；`sameArtifactEvidence` 比 15 个字段 | — |
| 归属 | 三个 id 都比 | 同 | — |
| Base hash | current、expectedBase、artifact 三者相等 | 同 | `assertExpectedBase` |
| **Base version** | 不查 | **不查** | 查（`lifecycle.ts:100-102`），抛普通 `Error` |
| candidate hash | artifact 与 result 都比 | 同 | — |
| **policy** | **只比 artifact** | artifact 与 result 都比 | — |
| 过期 | 查 | 查 | — |
| **caseIds** | **只在 `comparisonCaseIds` 非空时比** | 总是比 | — |
| gate | 在 `promote` 里只查 result（`service.ts:257`） | artifact 与 result 都查 | — |
| 文档 / 变更校验 | 不查 | 查 | 查 |
| 错误类型 | 普通 `Error`，没有 code | `OperationError`，带 code | 普通 `Error` |

两处分歧已复现：

- base version 过期时，dry-run 通过，真 Promote 在 lifecycle 抛错。见测试 `dry-run rejects a base version that real promotion rejects`。
- result 的 policy 与当前策略不符时，`promoteProposal` 报 `evaluation-mismatch`，`service.promote` 直接发布。见测试 `service.promote and promoteProposal reject the same inconsistent artifact with the same code`。

## 2. 设计问题与选项

### 2.1 恢复协议（ADR-0022）

**A. 按写入顺序幂等，不加 journal**

每一步都写成可以重复执行，重跑时逐步判断「这一步做过没有」，做过就跳过：

- W1：重跑时如果 live 已经等于候选 hash、版本号等于 `proposedVersion`、Proposal 仍是 `accepted`，就把它当成「W1 已完成」，不再报 `stale-base`。
- W2–W4：id 都是确定的（`adoption:<root>`；Ledger record 与 decision 依 SKIL-121），`append` 返回 `false` 就算做过。
- 重跑时 Proposal 已是 `promoted`、current 等于它的版本，就补写缺的 decision 后返回成功。
- repair 靠推断：扫描所有 `accepted` 或「`promoted` 但缺 decision」的 Proposal，与 live hash 对照，推断出哪一次 Promote 没做完。

取舍：

- 复杂度：不需要新的文件格式，但每个崩溃点都要一条推断规则，分散在 promote、rollback、repair 三处。
- 可测性：推断规则要逐条测；两个 Proposal 的候选正文相同时，推断会有歧义。
- Rollback 做不到。R1 之后，「回滚前是哪个版本、回滚的是哪个 Proposal」已经被覆盖（§1.3 R1b–R5 全部推错）。R2、R3 的 id 里带的 `Date.now()` 在重跑时也拿不回来。要补上这两样，就得在 R1 之前先把它们写进某个 store，这实际上就是把 journal 拆散写进三个 store，而且没有一个统一的「做完了」标记。
- health 没法直接报告「P2–P4 有一次 Promote 没做完」，也要靠推断。
- 可逆性、迁移成本：没有新格式，所以最容易回退，但 Rollback 的缺口补不上。

**B. 先写 intent journal，再提交，由操作本身、同一 Skill 的下一次维护操作或 repair 收尾（推荐）**

1. **提交点**：持发布锁、通过晋升校验（2.2）之后，第一件写入的事就是 journal `.skill-evolution/publications/<skill>.json`（`writeAtomic`）。journal 写成之前崩溃，就等于什么都没发生（P0）；写成之后，任何恢复都只**前滚**，不回退。写 journal 之前，按今天的做法先写候选目录（`writeCandidate`）。它的内容完全由 Proposal 决定，重复写的结果相同，而且候选目录在 Promote 之前本来就不可见。
2. **journal 内容**：只放完成这次操作需要的确定输入，不放正文。

   ```ts
   interface PublicationJournal {
     readonly v: 1
     readonly operation: 'promote' | 'rollback'
     readonly skillName: string
     readonly scope: PublicationScope    // explicit-only 时文件步骤为空，只写记录（与今天 `lifecycle.ts:111-117` 一致）
     readonly proposalId?: string        // promote：被发布的 Proposal root（必填）；rollback：被回滚的 Proposal root（可缺）
     readonly from: { readonly version: string; readonly contentHash: string }
     readonly to: { readonly version: string; readonly contentHash: string }
     readonly startedAt: string          // 所有派生记录的时间与带时间的 id 都取自这里
     readonly record?: {                 // 由 service 发起时才有；直接调用 SkillVersionStore 时缺省，只做文件步骤
       readonly fromRecordId?: string    // 台账转移的出发记录：promote 为 `<root>:accepted`，rollback 为 `<root>:promoted`
       readonly targetProposalId?: string // 仅 rollback：目标版本对应的 Proposal root
       readonly reason: string
       readonly actor: string
       readonly policyVersion?: string
       readonly evidenceIds: readonly string[]
     }
   }
   ```

   正文从已有的持久文件中取，并用 journal 中的 hash 校验。Promote 从候选目录 `candidates/<root>/SKILL.md` 取，今天就是在 journal 之前写入（`lifecycle.ts:134`）。Rollback 从 `versions/<to>/SKILL.md` 取。hash 不符就停止，保留 journal，报告 `failed`。
3. **收尾函数 `completePublication(journal)`** 按固定顺序执行，每一步都是「先比较、不同才写」或「按确定 id 追加」：
   - Promote：
     1. 快照旧版本。仅当 `from.version` 有版本号、快照不完整，并且 live hash 等于 `from.contentHash` 时才写。
     2. `versions/<to>/SKILL.md`、`manifest.json`。
     3. live `SKILL.md`、`manifest.json`、`current.json`。
     4. `invalidate`。
     5. Observation `adoption:<root>`。
     6. 台账转移 `fromRecordId → promoted`，写 Ledger record 和 decision（SKIL-121）。
     7. 删除 journal。
   - Rollback：
     1. live `SKILL.md`、`manifest.json`、`current.json`。
     2. `invalidate`。
     3. Observation `rollback:<skill>:<to>:<ms(startedAt)>`。
     4. decision `decision:rollback:<skill>:<to>:<ms(startedAt)>`。
     5. 有 `fromRecordId` 时做台账转移 `→ rolled-back`。
     6. 删除 journal。

   Observation、decision、台账转移只在 journal 带 `record` 时写。直接调用 `SkillVersionStore.promote` / `rollback` 的 journal 不带 `record`，只做文件步骤，这与今天 `SkillVersionStore` 不写 store 的行为一致。

   manifest 的 `createdAt` / `updatedAt` 同样取 `startedAt`。这样重跑写出来的字节和第一次完全一样，比较时就是「相同，不写」。
4. **谁来收尾**：
   - 操作本身：正常路径就是写 journal 后调用 `completePublication`。
   - 同一 Skill 的下一次 Promote / Rollback：拿到发布锁后，先对该 Skill 的 journal 执行 `completePublication`，再做自己的事。`propose` / `evaluate` 不取发布锁，也不收尾；它们读到的是 live 状态，之后的 Promote 会先收尾再校验，所以不会基于过期的 base 发布。
   - `repair()`（2.4）。
   - **纯读不收尾**：`readCurrent`、`health`、`metrics` 都不写文件。`readCurrentUnlocked` 去掉 `recoverPublication` 调用，journal 未完成时照实返回 live 状态。
5. **重跑即成功**：
   - `promoteProposal` / `service.promote` 收尾后，如果该 Proposal 最新是 `promoted`，并且 current 等于它的 `proposedVersion` 和候选 hash，就不写任何东西，直接返回 `promoted: true`。这个判断排在校验之前，所以 artifact 在崩溃后过期也不影响重跑。
   - `rollback` 收尾后，如果 current 已经是目标版本和 hash，就不写任何东西，直接返回。
   - 这两条让 P4 和 R1–R5 的重跑不再报 `invalid-transition`，也不再标错 Proposal。
6. **锁**：从写 journal 到删除 journal，全程持发布锁，W2–W4 也挪进锁内。锁顺序固定为「发布锁 → store 锁」，没有任何路径反向加锁。repair 在 JSONL 修完、没有持 store 锁的时候再逐个 Skill 取发布锁。
7. **旧 journal**：`<skill>/.publish.json`（`{proposalId, version, contentHash}`）只读不写。
   - repair 或下一次维护操作遇到旧 journal，先按今天的 `recoverPublication` 规则处理文件：版本目录不完整就删目录，hash 对上就前滚 live。
   - 然后在台账里找 `proposalId`。它仍是 `accepted`、候选 hash 相符时，补 W2–W4。
   - 找不到或不符时只处理文件，报告 `legacy: true`。
   - 版本号不合法、路径越界的旧 journal 原样保留，报告 `failed`。今天「不删不可信 journal」的保护不变（`evolution.spec.ts:213-234`）。

取舍：

- 复杂度：新增一个文件格式、一个 module（2.3），`lifecycle` 的 promote / rollback 退化为「按 journal 写文件」的步骤函数。所有恢复规则集中在 `completePublication` 一处。
- 可测性：每个崩溃点的期望都是「和成功一次相同」，§1.3 的 17 个崩溃点 × 2 条测试直接成为验收，不需要逐点写推断规则。
- 可逆性：journal 是临时状态文件，不是 Fact record，做完就删。回退到 A 只要停止写 journal；落盘数据没有长期形态。
- 迁移成本：`.publish.json` 兼容读一段时间；现有 3 条依赖「读时恢复」的测试要改（§3.2）。

**推荐 B。** 理由是 Rollback：只有在 R1 覆盖 live 之前把「从哪来、回滚谁、什么时间」持久化下来，重跑和 repair 才可能得到同一个结果；A 做到这一点时已经等于 B，却没有统一的完成标记。不可逆（数据格式和位置），写入 ADR-0022，待成员确认。

### 2.2 一份晋升校验

**A. 新 module `promotion-check.ts`：一个纯函数，两边都调用（推荐）**

```ts
export interface PromotionCheckInput {
  readonly proposal: SkillProposal          // 台账里该 root 的最新记录，不是调用方手里的对象
  readonly artifact: EvaluationArtifact     // 已按 id 从 evaluations 取出的持久 artifact
  readonly current: CurrentSkill | undefined
  readonly policyVersion: string
  readonly now: number
}
export function checkPromotion(input: PromotionCheckInput): void // 不通过时抛 OperationError(code)

export function resolvePromotionArtifact(
  evaluations: readonly EvaluationArtifact[],
  proposal: SkillProposal,
  supplied?: SkillEvalResult | EvaluationArtifact,
): EvaluationArtifact                      // 抛 evaluation-missing / evaluation-mismatch
```

- `checkPromotion` 取两份检查的并集，并采用较严的一边：
  1. 状态必须是 `accepted`，不符报 `invalid-transition`。
  2. 三个归属 id 都要比。
  3. base hash 三方一致；**base version 等于 current 的版本号（`unversioned` 除外）**。不符报 `stale-base`。
  4. candidate hash 两处都比。
  5. **policy 两处都比**。
  6. 过期检查。
  7. **caseIds 总是比**。
  8. gate 两处都查，不符报 `gate-failed`。
  9. 文档校验和变更校验。
- `resolvePromotionArtifact` 合并 `loadPromotionArtifact` 与 `requireEvaluationArtifact`：
  - 支持三种来源：`--evaluation` 文件内容、传入的对象、最新未过期的 artifact。
  - 传入的对象一律用 `sameArtifactEvidence` / `sameResultEvidence` 与持久版本比对。
  - 错误消息沿用今天的文本（`requires a persisted evaluation artifact`、`supplied evaluation does not match`），`evolution.spec.ts:568-569` 不用改。
- `OperationError` 与 `OperationErrorCode` 移到新 module `errors.ts`，由 `operations.ts` 再导出，避免 `service.ts → operations.ts → service.ts` 的循环依赖。
- 调用方式：两边都进同一个 service 内部方法，只有 dry-run 不进锁。

  ```ts
  // service.ts，内部方法
  private publishPromotion(input: {
    readonly proposalRef: string                               // root 或 record id
    readonly supplied?: SkillEvalResult | EvaluationArtifact
    readonly scope: PublicationScope
    readonly reason: string
  }): Promise<{ readonly replayed: boolean }>
  ```

  - `promoteProposal`（非 dry-run）：`scope` 校验之后，直接调用 `publishPromotion`，它本身不再做状态检查或预检。`--evaluation` 文件由它读成对象，作为 `supplied` 传入。
  - `promoteProposal`（dry-run）：从台账取最新记录，调用 `resolvePromotionArtifact`，读 current，再调用 `checkPromotion`。全程不拿锁、不写文件。
  - `service.promote(proposal, evaluation, scope, reason)`：签名不变，委托给 `publishPromotion({ proposalRef: proposal.id, supplied: evaluation, ... })`。
  - `publishPromotion` 的步骤：
    1. 取发布锁。
    2. 收尾该 Skill 的旧 journal。
    3. 从台账取最新记录。
    4. 做 2.1 第 5 步的「已发布即成功」判断。
    5. `resolvePromotionArtifact`。
    6. 读 current。
    7. `checkPromotion`。
    8. 写 journal。
    9. `completePublication`。

    检查和写入都在同一把锁内，消除了今天「锁外预检、锁内只再检一部分」的竞态。
  - 调用方传入的 `proposal.id` 不是最新记录时，第 3 步取到的最新状态可能不是 `accepted`，按 `checkPromotion` 报 `invalid-transition`。与 SKIL-121 的 `conflict` 语义一致；SKIL-121 定稿后改用它的错误码。
  - `service.verifyEvaluation` 改为调用 `resolvePromotionArtifact`。
- `lifecycle` 只保留文件层的不变量：版本目录已存在且内容不同、历史快照 hash 不符。它不再做业务校验（`lifecycle.ts:100-107` 删除）。

取舍：纯函数，按表驱动就能测完所有分支，不需要文件系统；两边的调用只差「锁内还是锁外」。代价是新增两个小 module，`service.promote` 的错误类型从 `Error` 变成 `OperationError`。`OperationError` 是 `Error` 的子类，消息不变，属于向上兼容。

**B. 校验放到 `EvolutionService` 的公开方法 `checkPromotion`，operations 调它**

改动最少，但每条测试都要搭一个 service 和一个 Skill 目录。service 已经有 430 行，校验会和发布、投影继续混在一处。

**C. 只保留 operations 这一份，`service.promote` 改为内部方法**

最彻底，但会删掉公开接口。adapter 测试（`adapter.spec.ts:183-184`）和外部集成都直接调用 `service.promote`，迁移成本最高。

**推荐 A。** 可逆（module 内部实现，公开签名不变），采用默认答案，成员可推翻。

### 2.3 journal 的位置与 module 边界

| 选项 | 位置 | 优点 | 代价 |
|---|---|---|---|
| **A. `.skill-evolution/publications/<skill>.json`（推荐）** | 状态目录 | 符合 ADR-0001「演化状态集中在状态目录」；health / repair 只扫一个目录，不用遍历 Skill 根下的每个子目录；不会被 Skill 的打包或同步带出去 | 要兼容读旧的 `<skill>/.publish.json` |
| B. 保留 `<skill>/.publish.json`，扩展字段 | Skill 目录 | 不用迁移 | 状态散落在 Skill 目录里，与 ADR-0001 相悖；Rollback 也要写进 Skill 目录；repair 要扫描 Skill 根 |
| C. 追加进 `decisions.jsonl` 的 intent / done 事件 | 事实流 | 有完整历史 | 事实流里出现「未完成」语义；repair 要 fold 整条流才能知道哪些没做完；与 ADR-0016「事实只记发生过的事」相悖 |

Module 边界：

- 新 module `publication.ts`（名字采用默认答案，成员可推翻）持有：
  - `PublicationJournal` 的读、写、删
  - `completePublication`
  - `inspectPublications(layout)`（只读）
  - `recoverPublications(layout, deps)`（repair 用）
- 它依赖 `SkillVersionStore` 的文件步骤、`ObservationLog`、SKIL-121 的台账转移操作，以及 `decisions` store。
- `service.promote` / `service.rollback` 退化为：
  1. 取锁
  2. 收尾旧 journal
  3. 校验
  4. 写 journal
  5. 调用 `completePublication`
- `SkillVersionStore.promote` / `rollback` 保留为公开方法（`evolution.spec.ts` 直接使用），内部同样走 journal，只是不带 `record`。

这条 seam 将来会被这些变化拉扯：

- 新的 Publication scope（`user`、`stable` 的真实生效面）会改变 `invalidate` 这一步。
- 发布前后的钩子（通知、缓存预热）会在 `completePublication` 的步骤表里加一行。
- 多 Skill 原子发布（split / merge）会让一个 journal 覆盖多个 Skill。

它们都只改 `publication.ts`，不改调用方。

**推荐 A。** 位置本身属于 ADR-0022 的数据格式决策。

### 2.4 health 与 repair 接口

**health（只读）**

```ts
interface UnfinishedPublication {
  readonly skillName: string
  readonly operation: 'promote' | 'rollback'
  readonly proposalId?: string
  readonly fromVersion: string
  readonly toVersion: string
  readonly startedAt?: string        // 旧 `.publish.json` 没有这个字段
  readonly journalPath: string
  readonly stage: 'files' | 'records' // 只读推断：live 已等于 to 时为 records，否则为 files
  readonly legacy: boolean           // true 表示旧 `<skill>/.publish.json`
  readonly lock: LockState['kind']   // 发布锁的状态；held 表示可能正在进行，不是崩溃遗留
}

healthReport(): Promise<{
  readonly jsonl: readonly JsonlHealth[]
  readonly skillIssues: readonly string[]
  readonly publications: readonly UnfinishedPublication[]  // 新增
}>
```

- `publications` 来自 `inspectPublications`：扫描 `publications/*.json` 和每个 Skill 目录下的旧 `.publish.json`，用 `inspectLock` 标注锁状态，不取锁，不写任何文件。
- `healthIssues` 改用不收尾的读取；`skillIssues` 里的 `.publish.json` 条目保留一个版本，之后由 `publications` 取代。
- 调用方 `dsh-bundle/index.js:196`、`bin/dsh-skill-evolution.mjs:89` 原样输出 JSON，自动带上新字段，不用改。

**repair**

```ts
interface PublicationRepair {
  readonly skillName: string
  readonly operation: 'promote' | 'rollback'
  readonly proposalId?: string
  readonly toVersion: string
  readonly outcome: 'completed' | 'skipped-locked' | 'failed'
  readonly legacy: boolean
  readonly error?: string
}

interface EvolutionRepairReport {
  // ... 现有字段不变
  readonly publications: readonly PublicationRepair[]  // 新增
}
```

`repair()` 的顺序：

1. 回收锁。沿用 ADR-0007：`held` 和 `foreign` 的锁不回收。
2. 按 `layout.stores` 修 JSONL，这一步不变。
3. **对每个未完成的 journal，按 Skill 取发布锁（`waitMs: 0`），执行 `completePublication`。**
   - 锁拿不到时报告 `skipped-locked`，journal 保留。
   - 失败时报告 `failed`，journal 保留，继续处理下一个 Skill。
4. `inspectManifests`。
5. 刷新投影。

第 3 步放在第 2 步之后，是因为收尾要追加 JSONL，必须先把残行隔离掉（ADR-0020）；放在第 5 步之前，是因为投影要看到补写的 Observation 和 Ledger record。repair 的 store 清单仍只来自 `layout.stores`，journal 不是 store，不进这张表。

**选项对比**：

- 另一种做法是新增单独的 `repairPublications()`，不并进 `repair()`。它的好处是调用方可以只修发布；代价是 bundle 和 CLI 各要多暴露一个动作，而且成员跑 `repair` 后仍然留着半截发布，和验收口径「repair 就能收敛」不符。
- 所以推荐并进 `repair()`。报告字段新增、不删不改，属于可逆的接口扩展。采用默认答案，成员可推翻。

### 2.5 对 SKIL-121 的接口假设

本设计依赖 SKIL-121 提供两样东西（对应 SKIL-123 / PR #78 的 `ProposalLedger.transition` 和 ADR-0021）：

1. **幂等转移**：`transition(from, to, input)` 以 `previousRecordId === from.id` 且目标状态相同作为「这次转移写过」的判断。写过就返回已有记录，并补写缺失的 decision。`completePublication` 用 journal 里的 `fromRecordId` 作为 `from`。
2. **确定 id**：decision id 由 record id 决定（`decision:ledger:<recordId>`），不再带 `updatedAt`。

如果 SKIL-121 最终不提供这两条，退路不需要改 journal 格式：

- `promoted` 和 `rolled-back` 在转移表里对每个 root 各只能进入一次，因为 `promoted` 只能由 `accepted` 进入，而 `rolled-back` 是终态（`proposal.ts:31-33`）。所以今天的 `<root>:promoted`、`<root>:rolled-back` 已经不会撞 id，`append` 返回 `false` 就说明写过了。
- decision id 今天带 `updatedAt`（`service.ts:371`）。`completePublication` 调 `transitionProposal(from, to, journal.startedAt)`，于是 `updatedAt = startedAt`，id 就成了确定值。

因此 T2、T3（§5）不用等 SKIL-121 合并就能落地。SKIL-121 合并后由 T4 换成 `ProposalLedger.transition`。本票不定 record id 规则。

Skill 级的 rollback Observation 和 decision 不属于台账，由本设计负责：id 里的时间取 journal 的 `startedAt`（毫秒），格式和今天一样，只是同一次 Rollback 重跑时取到的是同一个值。

## 3. 推荐方案小结

- Promote / Rollback 统一为「锁 → 收尾旧 journal → 一份校验 → 写 journal（提交点）→ `completePublication` 前滚 → 删 journal」。
- 下一次维护操作和 `repair()` 用同一个 `completePublication` 收尾；纯读路径不写文件。
- 晋升校验收成 `promotion-check.ts` 的 `checkPromotion` / `resolvePromotionArtifact`，dry-run 在锁外调，真 Promote 在锁内调。
- `healthReport().publications` 报告未完成的发布，`repair().publications` 报告收尾结果。

### 3.1 与已有 ADR 和 spec 的关系（Flag ADR conflicts）

- **ADR-0001**：不冲突。journal 从 Skill 目录挪进状态目录，正是它的要求。`docs/design/evolution-state-root.md:90` 里把 `.publish.json` 列在 Skill 目录下，那是历史布局，旧文件只读兼容。
- **ADR-0004**：不冲突。转移合法性仍然只看转移表。`checkPromotion` 里的状态检查只是为了早报错，台账转移操作里的 `assertCanTransition` 仍是唯一执行点（与 ADR-0021 草案的表述一致）。
- **ADR-0005 / ADR-0021**：依赖，不冲突。Promote / Rollback 只调用台账转移，不拼 record id（§2.5）。
- **ADR-0007**：不冲突。repair 不回收 `held` / `foreign` 的发布锁，遇到这种锁报告 `skipped-locked`；health 用 `inspectLock` 标注锁状态，不回收。
- **ADR-0016**：不冲突。journal 是临时状态文件，不是 Fact record。收尾只追加 Observation、decision、Ledger record，不改写已有记录。拒绝选项 C（§2.3）正是为了守住这条。
- **ADR-0020**：不冲突。repair 先修 JSONL 再收尾；收尾追加用的仍是 `appendFrames`。
- _与 `specs/skil-46-unified-lock-protocol/tasks.md` P1、P1b 的验收冲突（「下一次 `readCurrent` 自动回收死锁、运行 `recoverPublication`、删除 `.publish.json`」），值得重开，因为读路径写文件会让 health 改变它要报告的状态（§1.3 最后一段），而且读路径拿不到台账依赖，只能收尾一半。_ 本设计把这两条改为「下一次 Promote / Rollback 或 repair」。回收死锁这一半不变。spec 已冻结，不改原文，由 S2 spec 写明取代关系。

### 3.2 需要同步修改的现有测试

| 测试 | 今天断言 | 改为 |
|---|---|---|
| `evolution.spec.ts:193-211` 空版本目录 | `readCurrent` 删掉空目录和 journal | 改为 `store.promote(next)` 先收尾再发布；或 `repair()` 之后断言删除 |
| `evolution.spec.ts:213-234` 不可信 journal | `readCurrent` 不删 | 不变。新增 `repair()` 同样不删、报告 `failed` |
| `evolution.spec.ts:300-320` 死锁 + 完整 journal | `readCurrent` 前滚 | 改为 `repair()` 或下一次 promote 前滚；`readCurrent` 只回收死锁、返回 live |
| `evolution.spec.ts:322-344` SIGKILL | `readCurrent` 之后 `.publish.json` 被删 | 改为 `repair()` 之后 journal 被删，`current.json` 为 1.0.0 |
| `evolution.spec.ts:568-569` artifact 错误消息 | 两个 `toThrow` 子串 | 消息不变，另加 `code` 断言 |

`tests/publication-crash-recovery.spec.ts` 的 P0 行已同时覆盖新旧两个 journal 路径（`journal` 类崩溃），不用改。

## 4. 验收口径

S2 spec 按下面几张表写验收标准。除 R0、H3、C3、L1–L3 由 Builder 新增外，每一行都对应 `tests/publication-crash-recovery.spec.ts` 里现成的测试：每个崩溃点一条「重跑」、一条「repair」，H1、H2、H4、C1、C2 各一条。修复落地后，把对应的 `it.fails` 改回 `it`，删除 `pending` 和 `convergesToday`。

**总判据**：在任一崩溃点注入崩溃后，无论（a）用同样的参数重跑一次该操作，还是（b）只调用 `repair()`，`publicationState` 都与另一个目录里「成功跑过一次」的状态逐项相等。比较范围：

- Skill 目录下的全部文件，内容逐字节比较，时间戳已归一化；
- `.skill-evolution/publications/`；
- `proposals`、`decisions`、`observations` 三个 JSONL 的全部记录，以及每个 root 的最新状态。

例外是提交点之前的崩溃（P0）：repair 之后，状态要与操作开始之前逐项相等。

**Promote**

| 崩溃点 | 崩溃时的状态 | 重跑怎么收敛 | repair 怎么收敛 |
|---|---|---|---|
| P0 journal 之前 | 只有候选目录 | 正常执行 | 没有 journal，什么都不做；状态等于操作之前 |
| P1a `versions/<to>/SKILL.md` 之前 | journal、空版本目录 | 先收尾：写版本快照 → live → 记录；再判定「已发布」，直接返回 | 同左 |
| P1b live `SKILL.md` 之前 | journal、版本快照完整 | 收尾从 live 那一步开始；版本快照内容相同，不重写 | 同左 |
| P1c live `manifest.json` 之前 | live 正文已是新版 | 同上，从 manifest 开始写 | 同左 |
| P1d `current.json` 之前 | live 两个文件已是新版 | 同上，从 `current.json` 开始写 | 同左 |
| P1e `invalidate` 抛错 | live 全部是新版 | 重新 `invalidate`，然后写记录 | 同左 |
| P1f 旧版本快照写了一半 | journal、`versions/<from>` 只有 `SKILL.md` | live 仍等于 `from.contentHash`，补齐快照后继续 | 同左 |
| P2 Observation 之前 | 文件全部完成 | 追加 `adoption:<root>`，然后做台账转移 | 同左 |
| P3 Ledger record 之前 | Observation 已写 | `append` 返回 `false`，然后做台账转移 | 同左 |
| P4 decision 之前 | Ledger record 已写 | 台账转移判定「写过」，补写 decision | 同左 |

Promote 的三条附加验收：

- **H1**：P3 之后 `healthReport().publications` 恰好一条，内容为 `{ skillName, operation: 'promote', proposalId, fromVersion: 'unversioned', toVersion: '1.1.0' }`。repair 报告一条 `outcome: 'completed'`，之后 health 为 `[]`，Proposal 为 `promoted`。
- **H2**：P1c 之后调用 `healthReport()`，`publicationState` 不变。
- **H3**：成功 Promote 之后再重跑一次，返回 `promoted: true`，并且什么都不写。

**Rollback**（先发布 1.0.0、再发布 1.1.0，然后回滚到 1.0.0）

| 崩溃点 | 崩溃时的状态 | 重跑怎么收敛 | repair 怎么收敛 |
|---|---|---|---|
| R0 journal 之前（新增的提交点） | 无变化 | 正常执行 | 什么都不做 |
| R1a live `manifest.json` 之前 | journal、live 正文已是 1.0.0 | 先收尾：manifest → `current.json` → 记录；journal 里的 `from` 仍是 1.1.0，`fromContentHash` 是对的 | 同左 |
| R1b `current.json` 之前 | 同上，manifest 也已改 | 同上，从 `current.json` 开始写；回滚目标取 journal 的 `proposalId`（`proposal-two`），不再重新推断 | 同左 |
| R1c `invalidate` 抛错 | live 全部是 1.0.0 | 重新 `invalidate`，然后写记录 | 同左 |
| R2 Observation 之前 | 文件完成 | 追加 Observation，id 用 `startedAt` 的毫秒值 | 同左 |
| R3 rollback decision 之前 | Observation 已写 | Observation `append` 返回 `false`，写 decision | 同左 |
| R4 Ledger record 之前 | decision 已写 | 两次 `append` 都返回 `false`，做台账转移 | 同左 |
| R5 transition decision 之前 | Ledger record 已写 | 台账转移判定「写过」，补写 decision | 同左 |

Rollback 的附加验收：

- **H4**：回滚到已经是 current 的版本（hash 也相同），什么都不写，也不改任何 Proposal 状态。
- 收尾之后再重跑，都命中 H4。

**晋升校验**

- **C1**：base version 与 current 不符时，dry-run 与真 Promote 都报 `stale-base`，也都不写任何文件。
- **C2**：同一个不一致的 artifact（例如 result 的 policy 不符），`promoteProposal` 的 dry-run 与 `service.promote` 都报 `evaluation-mismatch`。
- **C3**：`checkPromotion` 按 §1.4 表中每一行各有一条表驱动测试，每条都给出期望的错误码。

**兼容**

- **L1**：只有旧 `<skill>/.publish.json`，内容为完整版本目录、Proposal 仍是 `accepted`。repair 之后文件前滚、W2–W4 补齐，报告 `legacy: true`。
- **L2**：不可信的旧 journal（`evolution.spec.ts:213-234` 那五种）在 repair 之后保持原样，报告 `failed`。
- **L3**：§3.2 表中修改后的现有测试全部通过；core、bundle、adapter 三个包的测试全绿。

## 5. Builder task 边界（供 S2 spec 参考）

- **T1 · 一份晋升校验**：
  - 新增 `errors.ts`、`promotion-check.ts`。
  - `precheckPromotion`、`requireEvaluationArtifact`、`lifecycle.ts:100-107` 都改为调用这两个模块。
  - 验收：C1–C3。
  - 与 T2 无依赖。
- **T2 · journal 与 `completePublication`**：
  - 新增 `publication.ts`；`lifecycle` 的 promote / rollback 改为按 journal 执行文件步骤；`readCurrentUnlocked` 去掉恢复逻辑；旧 journal 兼容读。
  - 验收：P0–P1f、R0–R1c 的文件部分，H2、L2，以及 §3.2 的测试修改。
- **T3 · service 收尾与 repair / health**：
  - 实现 `publishPromotion`、rollback 走 journal、W2–W5 挪进锁内、`healthReport().publications`、`repair().publications`。
  - 验收：§4 的全部行，外加 H1、H3、H4、L1。
  - 依赖 T1、T2。
- **T4 · 切换到 SKIL-121 的台账转移**：
  - 等 SKIL-121 实现合并后，把 `completePublication` 里的台账写入换成 `ProposalLedger.transition`。
  - 验收：§4 表不变，全部仍然通过。

## 6. 不可逆决策

- **ADR-0022**：Promote / Rollback 采用先写 intent journal（`.skill-evolution/publications/<skill>.json`）再前滚提交的恢复协议。收尾由操作本身、同一 Skill 的下一次 Promote / Rollback 或 `repair()` 完成，纯读路径不写文件。状态为 `proposed`，待成员确认。
