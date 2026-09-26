本文回应 SKIL-40：把「维护用例」（propose / evaluate / promote 等）与「proposal 台账」（id 解析、latest 状态、状态转移表）各自收敛成 core 里的一个 deep module，让 CLI（`bin/dsh-skill-evolution.mjs`）和 bundle（`dsh-bundle/index.js`）退化成薄 adapter。只出设计，不含实现代码。

## 1. 现状

### 1.1 读了哪些代码

- `packages/skill-evolution/bin/dsh-skill-evolution.mjs`（224 行）—— CLI adapter：`propose`(97-122)、`evaluate`(124-136)、`promote`(138-150)、`accept/reject/defer`、`rollback`，以及自带的 `findProposal`(195-201)。
- `packages/dsh-bundle/index.js`（562 行）—— `/skill-evolution` slash 命令 adapter：`executeMaintenanceCommand`(183-262)、`findProposal`(264-270)、`parseFlags`(277-288)。
- `packages/skill-evolution/src/service.ts`（472 行）—— `EvolutionService`：`stageProposal`、`evaluate`(176-237)、`acceptProposal`(239-256)、`promote`(258-304)、`verifyEvaluation`/`requireEvaluationArtifact`(306-327)、`rollback`(329-367)、`rejectProposal`(369-376)、`deferProposal`(378-385)、私有 `recordDecision`(387-411)、私有 `proposalRootId`(444-446)。
- `packages/skill-evolution/src/proposal.ts`（129 行）—— `createProposal`、`transitionProposal`(55-75) 及其转移表。
- `packages/skill-evolution/src/metrics.ts` —— `aggregateMetrics`，自带一份 `proposalRootId`(78-80)。
- `packages/skill-evolution/src/lifecycle.ts` —— `SkillVersionStore`、`writeCandidate`(66)、`promote`。
- `packages/skill-evolution/src/types.ts`、`records.ts`、`index.ts`、`report.ts`、`evaluator.ts`。
- 测试：`packages/skill-evolution/tests/evolution.spec.ts`、`packages/dsh-bundle/tests/bundle.spec.mjs`、`packages/dsh-adapter/tests/adapter.spec.ts`。
- 文档：`packages/dsh-bundle/README.md`、`docs/architecture-design-zh.md` §2.5/§4.1、`AGENTS.md`。

基线：`npm --prefix packages/skill-evolution test` → 33 passed；`npm --prefix packages/dsh-bundle test` → 12 passed（先装依赖、build core 与 adapter 后）。

### 1.2 两个 adapter 各写了一份维护流程

`propose / evaluate / accept / reject / defer / promote / rollback` 的编排在 CLI 和 bundle 里**各实现一遍**：读文件、拼 `createProposal` 入参、调 service、落文件、拼输出。二者是同一 use case 的两个 adapter —— 按 codebase-design「一个 adapter 是假想 seam，两个 adapter 才是真 seam」，这里已经是真 seam，但 seam 后面没有 deep module，behaviour 散在两个 adapter 里，于是漂移（下面的缺陷全部来自这个漂移）。

### 1.3 复现（脚本已删除，`git status` 干净；命令与输出如下）

在临时目录、skill 置于 `<root>/api-debugging`，通过 bundle 注册的 handler 复现：

- **dry-run 不校验**：`promote --dry-run` 传入一个伪造的 `{passedGate:true}` 文件（对应 artifact 根本不存在）仍返回 `{dryRun:true}` success。`index.js:247` 直接返回，没调 `verifyEvaluation`。
- **scope 不校验**：`promote --scope bogus` 成功，落盘 manifest 里 `scope = bogus`、version 1.1.0。`index.js:248` 把 `flags.scope ?? 'project'` 直接透传。
- **evaluate 不落文件**：bundle `evaluate` 只返回文本，`.skill-evolution/evaluations` 目录不存在；随后 `promote --evaluation .../p1.json` 抛 ENOENT。DSH 内 evaluate→promote 因此走不通。
- **parseFlags 吃掉带引号的值**：`--intent "Add timeout diagnosis"` 解析成 `{intent:'"Add'}`。README 示例恰恰用引号。
- **accept 回显旧 id**：bundle accept 返回 `proposalId:"p1:evaluated"`（输入 id），而非新 record id，输出自相矛盾。
- **CLI dry-run 也不查状态/gate**：core 侧对一个 evaluated 且 gate 失败的 proposal，`verifyEvaluation` 通过（CLI dry-run OK），而 `promote` 抛 "requires an accepted review before promotion"。`verifyEvaluation`(306) 只调 `requireEvaluationArtifact`，不查 status 也不查 passedGate。

### 1.4 三处「同一件事」各有多份定义

- **root-id 后缀正则**：`service.ts:444`、`metrics.ts:78`、`bin:131`（内联在 evaluate 报告路径里）三份拷贝。bundle `findProposal` 虽不剥后缀，但依赖同一套 `${id}:` 命名。
- **latest 状态算法**：两套 —— 按 rootId 建 Map（`service.ts:333` rollback、`metrics.ts:60`）vs `matches.at(-1)` + `startsWith` 前缀匹配（`bin:197-198`、`bundle:266-267`）。前缀匹配有真实 bug：所有自动 id 都是 `proposal:<uuid>`，`findProposal('proposal')` 会把 `startsWith('proposal:')` 的记录全部命中、返回最后一个（复现确认返回了第二个 1.2.0 提案）。
- **状态转移表 vs 守卫**：转移表在 `proposal.ts:55-75`，但 service 的守卫是另写的硬编码 `includes` 列表（`service.ts:181, 370, 379`，以及 240/264 附近的分支），两处独立维护，逐条核对后已经对不上：
  - reject：转移表允许 `draft→rejected`、`accepted→rejected`，`service.ts:370` 守卫却不含 `draft`、`accepted`。
  - defer：转移表允许 `draft→deferred`，`service.ts:379` 守卫不含 `draft`。
  - evaluate：守卫 `service.ts:181` 表达的是一条多步路径（`proposed→evaluating→evaluated`，或 `replayed/observed→evaluated`），不是单步转移，只能靠人读懂后与表比对。

此外，decision 双写且不幂等：每次 evaluate/accept/promote 既走 `recordDecision`（`decision:transition:<root>:<to>:<updatedAt>`）又各自再写一条（`decision:evaluate:<root>:<policy>` `service.ts:226`、`decision:accept:<root>:<Date.now()>` `service.ts:246`、`decision:promote:<root>` `service.ts:290`）。其中 accept 带 `Date.now()`，**非幂等**：重放/重试会写出多条。一个生命周期实测落 8 条 decision。

## 2. 设计问题与选项

以下每个问题至少两个选项，逐项列复杂度、可测性、可逆性、迁移成本。

### 2.1 维护用例放在哪个 module、interface 什么形状

use case 要收进 core，让 CLI 与 bundle 只做「参数 → 选项」「结果 → 输出」两步。三种形状：

- **A. 纯函数集**（`operations.ts`：`proposeSkillChange(service, opts)`、`evaluateProposal(service, opts)`、`promoteProposal(service, opts)`…）。
  - 复杂度：低。无新生命周期状态，函数签名即 interface。
  - 可测性：高。core 单测直接喂 opts、断结果，不经 argv/rawInput。
  - 可逆性：高。纯 re-export，回退只需删导出。
  - 迁移成本：低。service 不动，只把编排从 adapter 提上来。
- **B. facade 类**（`MaintenanceCommands`，构造时持 `EvolutionService`，方法 `propose/evaluate/promote/...`）。
  - 复杂度：中。多一层对象生命周期与构造约定。
  - 可测性：高，但每个用例都要先造对象。
  - 可逆性：中。类的公开方法是更宽的 interface，收回来更贵。
  - 迁移成本：中。
- **C. 命令表 / dispatcher**（core 暴露 `dispatch(commandName, opts)`）。
  - 复杂度：高。等于把 adapter 的 `switch` 挪进 core，interface 变宽（要暴露命令名字符串协议）。
  - 可测性：中。多一层字符串路由要测。
  - 可逆性：低。命令名协议一旦公开就是契约。
  - 迁移成本：中高。

**取 A**：interface 最小（每个用例一个签名）、depth 最大（读文件、拼参、落文件、错误分类都在函数体内），leverage 落在 CLI+bundle+未来任何 adapter 上。C 把 adapter 的分发逻辑误当成 core 职责，是「浅 module + 宽 interface」，正是要消除的形状。

### 2.2 evaluation.json / 报告文件谁来写

bundle 的 evaluate 不落文件是核心缺陷之一，落文件必须进共享 use case。两种归属：

- **A. core 写盘**：use case 拿 `root`（或输出路径）自己写 `.skill-evolution/evaluations/<root>.json` 与报告，返回写入路径；adapter 可用显式 `--output`/`--report` 覆盖。
  - 复杂度：中。core 摸文件系统，但它本就通过 `SkillVersionStore`/`JsonlRecordStore` 摸盘，不算新依赖方向。
  - 可测性：中。要用临时目录断言文件；已有测试就是这么做的。
  - 可逆性：中。默认路径方案成了约定。
  - 迁移成本：低。直接修掉「bundle 不落文件」。
- **B. core 只返回字节 + 建议相对路径，adapter 写**：
  - 复杂度：低（core 保持少碰 FS）。
  - 可测性：高（core 纯数据）。
  - 可逆性：高。
  - 迁移成本：中，且**缺陷会复发**——两个 adapter 又各自决定写不写、写哪，正是今天的病根。

**取 A**：把「必须落文件」这条 invariant 收进 interface 内部，locality 到位。默认路径方案与 SKIL-42（state-root 布局）重叠，见 §4 —— 用例把输出路径当**已解析入参**接收，当前自带默认值，SKIL-42 落地后由 state-root module 提供，seam 已经留好。

### 2.3 proposal 台账的 interface

- **A. 扩 `proposal.ts` 为纯函数**：`mintProposalId()`、`proposalRootId(id)`（唯一定义）、`ledgerRecordId(root, status)`、`latestProposalsByRoot(records): Map`、`findProposalById(records, ref): SkillProposal`（精确 root 或精确 record id，找不到/歧义各自报错，**不做裸前缀匹配**）、`allowedTargets(status)`/`canTransition(from,to)`（复用现有转移表）。
  - 复杂度：低。全是纯函数，无状态。
  - 可测性：高。喂 records 断结果。
  - 可逆性：高。
  - 迁移成本：低。三处正则、两处 latest、两处 findProposal 全部指过来。
- **B. `ProposalLedger` 类包 `JsonlRecordStore`**，把「转移 + 落一条 decision」做成一个方法 `record(transition)`。
  - 复杂度：中。多一个有状态对象，且与 `EvolutionService` 职责重叠（service 已经持 store）。
  - 可测性：中。
  - 可逆性：中。
  - 迁移成本：中高。service 里散落的 append+recordDecision 都要迁进来。

**取 A + 把「转移 + decision」留在 service**：id 方案、latest、守卫这些纯逻辑用 A 收敛（这是 SKIL-40 的硬要求：单一定义）；有状态的「append 记录 + 写 decision」不强行拆出 service，避免 B 造出与 service 重叠的第二个有状态 module。`findProposalById` 用「先剥后缀再比对 root 相等」替换裸 `startsWith`，修掉 §1.4 的前缀 bug。

### 2.4 service 守卫的单一来源

- **A. 守卫从转移表反推**：`assertCanTransition(from, target)` 读 `proposal.ts` 的转移表，service 的 `includes([...])` 全删。
  - 复杂度：低。可逆性高。迁移成本低。已经有 `transitionProposal` 会抛 `invalid proposal transition`，守卫只是提前、带更友好的错误码。
  - 多步用例（evaluate）的守卫写成「能沿表到达目标」：`canTransition(s, 'evaluated') || canTransition(s, 'evaluating')`（后者再由 `evaluating→evaluated` 保证），仍然只读表。
  - 行为影响：§1.4 列出的 reject/defer 差异会随之消失 —— `accepted` 可以被 reject、`draft` 可以被 reject/defer。这是行为变更，见 §5 D9。
- **B. 维持双份，加一致性测试**把两处锁在一起。
  - 复杂度：中（新测试）。可逆性中。迁移成本中。始终留着漂移面，只是用测试兜底。

**取 A**：转移表是唯一事实源，守卫是它的派生。B 是「明知有重复却用测试守着」，不如直接消除。

### 2.5 slash 命令的参数解析（引号）

- **A. 换 shell 式 tokenizer**（支持 `"..."`/`'...'`）：`parseFlags` 前先正确分词。
  - 复杂度：低。可测性高（纯函数）。可逆性高。迁移成本低。
  - 兼容性：修的是 bug，但改变了 `/skill-evolution` 的输入文法 —— 见 §5 待定项 D5。
- **B. 要求调用方不加引号 / 用 `=`**：
  - 复杂度：最低。但把负担推给用户，README 示例全要改，且多词 intent 无法表达。

**取 A**：文法向「符合直觉」靠拢，README 示例本就假设引号可用。

## 3. 推荐方案

两个 deep module，一条既有 seam（`EvolutionService`）保留：

```
              ┌──────────────────────────────────────────┐
   CLI adapter│ argv → options            result → stdout │
 bundle adapter rawInput → options  result → CommandResult│  ← 薄 adapter：只做映射
              └───────────────┬──────────────────────────┘
                              │ 调用（唯一 seam）
              ┌───────────────▼──────────────┐
              │ operations.ts（维护用例）     │  ← deep：编排+落文件+错误分类
              │ propose/evaluate/promote/...  │
              └───────┬───────────────┬───────┘
                      │               │
        ┌─────────────▼──┐   ┌────────▼─────────────────┐
        │ EvolutionService│   │ proposal.ts（台账纯函数） │  ← 单一定义
        │ 有状态：append   │   │ id/latest/find/守卫派生   │
        │ +decision       │   └──────────────────────────┘
        └─────────────────┘
```

### 3.1 proposal 台账 module（扩 `proposal.ts`，纯函数）

单一事实源，删掉 §1.4 的所有拷贝：

- `PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]>` —— 把 `transitionProposal` 内联的表提为导出常量，`transitionProposal` 改为读它。
- `canTransition(from, to): boolean` / `assertCanTransition(from, to): void`（抛带 `code:'invalid-transition'` 的错误）。
- `TERMINAL_STATUS_SUFFIXES` —— 从 `PROPOSAL_TRANSITIONS` 的所有**目标状态**集合派生（即会被写进 record id 后缀的状态：evaluating/evaluated/accepted/promoted/rolled-back/replayed/observed/rejected/deferred），供正则使用，避免手写清单再次漂移。
- `proposalRootId(id): string` —— 唯一定义，正则由 `TERMINAL_STATUS_SUFFIXES` 生成。
- `ledgerRecordId(root, status): string` = `${root}:${status}`，替换 service 里散落的模板字符串。
- `latestProposalsByRoot(records): Map<root, SkillProposal>` —— 唯一 latest 算法（按 rootId 建 Map，取最后写入）。
- `findProposalById(records, ref): SkillProposal` —— ref 命中规则：先 `proposalRootId(record.id) === proposalRootId(ref)` 精确匹配 root，再退回 `record.id === ref` 精确匹配 record id；命中多 root 抛 `code:'ambiguous'`，无命中抛 `code:'not-found'`。**不做裸 `startsWith`**，修掉前缀 bug。

`metrics.ts`、`service.ts`（rollback + 各守卫 + 各 `${root}:${status}` 拼接）、CLI、bundle 全部改为 import 这些函数。

### 3.2 维护用例 module（新增 `operations.ts`，纯函数集）

每个函数：入参是**已解析的 options**（adapter 负责从 argv/rawInput 解析），返回结构化结果，抛**带 `code` 的类型化错误**。错误 `code` ∈ `not-found | ambiguous | invalid-option | stale-base | invalid-transition | evaluation-missing | evaluation-mismatch | gate-failed`，adapter 据此决定 exit code / `{kind:'error'}`。

- `proposeSkillChange(service, opts): Promise<{ proposal, reportPath }>`
  - opts：`{ root, skillName, baseContent|baseFile, candidateContent|candidateFile, proposedVersion, intent, id?, baseVersion?, reportPath? }`
  - 内部：校验 base==当前内容（不符抛 `stale-base`）、`createProposal`、`stageProposal`、写 proposal markdown（默认 `.skill-evolution/proposals/<root>.md`）、返回。
- `evaluateProposal(service, opts): Promise<{ proposal, result, evaluationPath, reportPath }>`
  - opts：`{ root, proposalRef, cases|casesFile, evaluationPath?, reportPath? }`
  - 内部：`findProposalById` 定位、`assertCanTransition` 提前守卫、`service.evaluate`、**始终写** `.skill-evolution/evaluations/<root>.json`（修 bundle 缺陷）与报告、返回真实 record id。
- `reviewProposal(service, opts): Promise<{ proposal }>`
  - opts：`{ proposalRef, decision:'accept'|'reject'|'defer', reason }`；返回**新 record id**（修 accept 回显旧 id）。
- `promoteProposal(service, opts): Promise<PromoteResult>`
  - opts：`{ proposalRef, evaluation?|evaluationPath?, scope, dryRun }`
  - `scope` 用 `assertPublicationScope`（见 §3.3）校验，非法抛 `invalid-option`（修 `--scope bogus`）。
  - `evaluation` 缺省时取该 root 最新已落盘 artifact（修「evaluate→promote 走不通」的默认路径）。
  - **dryRun 与真跑走同一条 precheck**：状态（转移表）+ artifact 校验 + `passedGate` + base 当前 + candidate 有效；dryRun 只是跳过 `versions.promote` 写盘。修 §1.3「dry-run 不校验」和「dry-run 不查状态/gate」两条。
  - 返回 `{ dryRun:true, proposal, evaluation }` 或 `{ promoted:true, skillName, version, scope }`。
- `rollbackSkill(service, opts): Promise<{ skillName, version }>`
  - opts：`{ skillName, version, reason? }`（CLI 目前无 `--reason`，补齐）。

### 3.3 顺带收敛的两个字面量

- `PublicationScope = 'explicit-only'|'project'|'user'|'stable'` 提为 core 导出的 named type + `PUBLICATION_SCOPES` 常量 + `assertPublicationScope`，替换 `types.ts:58/285`、`lifecycle.ts:76/86/237`、`service.ts:261`、CLI 的 `assertOneOf`、bundle 的透传。
- `FeedbackKind` 校验（bundle feedback 默认 `'other'` 不校验）沿用同一 `assertOneOf` 模式，收进 core。

### 3.4 decision 双写与幂等（并入本设计，因它与「单一定义」同源）

- 去掉 evaluate/accept/promote 各自那条 bespoke decision，统一走 `recordDecision` 一条 `decision:transition:<root>:<to>:<updatedAt>`。`updatedAt` 由转移产生、稳定，天然幂等（`JsonlRecordStore` 按 id 去重）。
- 删 `decision:accept:<root>:<Date.now()>` 的时间戳 id —— 这是唯一非幂等来源。
- `metrics.ts` 统计 promoted/rejected/rolledBack 改为从 `decision:transition:*:<status>` 数，而非 bespoke id。见 §5 D4。

### 3.5 这条 seam 将来会被什么拉扯

- **新增维护动作**（如 `revert`、批量 promote）：只在 `operations.ts` 加一个函数 + 两个 adapter 各加一行分发，不再两处各写一遍流程。
- **状态机演进**（新状态、新转移）：只改 `PROPOSAL_TRANSITIONS` 一张表，守卫、正则、latest 自动跟随。
- **落盘路径变更（SKIL-42）**：用例已把输出路径当已解析入参，state-root module 落地后替换默认值即可，seam 不动。
- **新增 adapter**（如 HTTP/MCP 暴露维护命令）：直接复用 `operations.ts`，零重复。

## 4. 迁移顺序（供 Spec Writer 拆 task，每步可单独合并）

1. **台账纯函数 + 单测**：`proposal.ts` 加 `PROPOSAL_TRANSITIONS`/`canTransition`/`proposalRootId`/`ledgerRecordId`/`latestProposalsByRoot`/`findProposalById`；`transitionProposal` 改读常量。此步不动 adapter。
2. **切换既有调用点**：`metrics.ts:78` 与 `service.ts:444` 的 `proposalRootId` 删除、改 import；`service.ts:333` rollback 与 `metrics.ts:60` 的 latest 改用 `latestProposalsByRoot`；service 各守卫（181/240/264/370/379）改 `assertCanTransition`。回归 core 33 项测试。
3. **`PublicationScope` + `assertPublicationScope`**：收敛 5 处字面量与 `assertOneOf`。
4. **decision 单写 + 幂等**：删 bespoke decision 与 `Date.now()` id；调整 `metrics` 计数来源；更新断言 8 条 decision 的测试。
5. **`operations.ts` 维护用例 + 单测**：把两 adapter 的编排提上来，含「始终落 evaluation 文件」「dryRun 全量 precheck」「scope 校验」「evaluation 默认取最新 artifact」。
6. **CLI adapter 瘦身 + 首个 CLI 测试**：`bin` 删自带 `findProposal`/正则/verify，改调 `operations.ts`；补 `bin` 冒烟测试（现无）。
7. **bundle adapter 瘦身 + tokenizer + node:test**：`index.js` 删 `findProposal`、换引号感知 tokenizer、类型化错误转 `{kind:'error'}`、feedback kind 校验；加 evaluate→promote 的 node:test。
8. **文档**：更新 `packages/dsh-bundle/README.md`（它仍说 proposal 全流程只在 CLI，已过时）与 `docs/architecture-design-zh.md` §2.5/§4.1。
9. **DSH 手动 e2e**：见 §6.2，非阻塞、留给验收执行。

### 4.1 兼容性风险（Spec Writer 需在对应 task 标注）

- **既有 `proposals.jsonl` 后缀 record**：`proposalRootId` 正则必须仍覆盖历史后缀（draft/proposed/reverted 从不入后缀，保持不列）。回归时用现有 fixtures。
- **既有 `candidates/<id:suffix>` 目录**：`writeCandidate`(lifecycle.ts:66) 用 `proposal.id` 建目录，suffixed id 会造出 `p1:accepted` 之类目录。本次**不改**该键，仅记为 §5 D6 待定项，避免牵动 lifecycle 数据布局。
- **调用方传 suffixed id / 前缀**：`findProposalById` 只认精确 root 或精确 record id，裸前缀（如 `proposal`）从「返回最后一个」变为报 `ambiguous`。这是**行为变更**（D2）。
- **CLI evaluate 默认输出路径**：现为 `<proposal.id>.json`（可能带后缀），改为 `<root>.json`。是 D3。
- **查 `:evaluated` 等 id 的测试**：`evolution.spec.ts`、`bundle.spec.mjs:304/315`、`adapter.spec.ts:182` 直接拼后缀 id。改动 record id 拼接函数后需同步（值不变，只是改为 `ledgerRecordId`）。
- **metrics 计数**：D4 改 decision 形状后，metrics 计数来源要一起改，否则数字回退为 0。
- **与 SKIL-42（state-root 布局）/ SKIL-41（锁协议）重叠**：路径默认值与文件写入是 SKIL-42 的地盘；本设计只把路径作为入参留 seam，不自行定稿布局。

## 5. 不可逆决策清单 / 待定项

均已给默认值并选择了向后兼容的方向；按 Architect 交付约定在此**明确列为待定项**，交 Reviewer / 成员在 PR 上确认或推翻，不阻塞设计交付。

- **D1（数据格式，低风险）**：保留磁盘上带 `:status` 后缀的 record id 台账格式。默认：保留，读路径完全兼容。
- **D2（公开行为变更）**：`findProposalById` 去掉裸前缀匹配，只认精确 root / record id，歧义报错。默认：采用（修真实 bug）。影响传裸前缀的调用方。
- **D3（默认路径 + 可选入参）**：CLI/bundle evaluate 默认写 `.skill-evolution/evaluations/<root>.json`，`promote --evaluation` 变可选（缺省取最新 artifact）。默认：采用。最终路径以 SKIL-42 为准。
- **D4（durable 格式 + metrics）**：decision 停止双写、去掉 accept 的 `Date.now()`，metrics 计数改从 transition decision 统计。默认：采用（消除唯一非幂等写）。历史 decisions.jsonl 仍可读，仅新写变确定性。
- **D5（公开接口 / 输入文法）**：`/skill-evolution` 换引号感知 tokenizer。默认：采用（README 示例本假设引号可用）。
- **D6（数据布局，本次不动）**：`candidates/<id>` 目录键含后缀 id 的问题留给 SKIL-42 一并处理。默认：本次不改。
- **D7（依赖方向，红线校验）**：`operations.ts` 与台账函数全在 core，**不 import DSH / bundle 任何东西**（AGENTS.md 红线）；文件写入沿用 core 已有的 `SkillVersionStore`/`JsonlRecordStore` 依赖方向，不新增出向依赖。默认：遵守。
- **D8（公开导出面）**：core `index.ts` 新增 `operations.*` 与台账函数导出，均为**新增**，不删既有 re-export。默认：采用。
- **D9（行为变更：守卫以表为准）**：守卫从转移表派生后，service 新允许 `accepted→rejected`、`draft→rejected`、`draft→deferred`。默认：以表为准（架构文档 §4.1 的状态机即此表；accepted 未发布前撤回是合理操作）。若成员认为 accepted 不应可撤回，改的是**表**，而不是再加一份守卫。

## 6. 测试策略与验收

### 6.1 单测（随各迁移步）

- 台账：`proposalRootId` 覆盖所有后缀与「无后缀」；`findProposalById` 覆盖精确 root、精确 record id、裸前缀→`ambiguous`、无命中→`not-found`；`canTransition` 遍历转移表。
- 用例：`evaluateProposal` 断言 evaluation 文件确实落盘；`promoteProposal` dryRun 对「伪造 artifact / 未 accepted / gate 失败 / scope 非法」四种输入分别抛对应 `code`；`reviewProposal` accept 返回新 record id。
- adapter：bundle tokenizer 对 `--intent "Add timeout diagnosis"` 解析出完整值；类型化错误映射为 `{kind:'error'}`。

### 6.2 DSH 内 evaluate → promote 端到端（验收项 4）

`/skill-evolution` 只在 web/desktop 客户端派发（headless 不派发 slash 命令，走 `remote.commands.execute`）。两条等价路径，验收时择一：

- **手动（贴近真实）**：
  1. `dsh plugin --profile web add '@dsh-skill-evo/dsh-bundle@link:<本 checkout>/packages/dsh-bundle'`
  2. web session 内依次：`/skill-evolution propose … --intent "…"` → `evaluate` → `accept` → `promote --dry-run` → `promote`。
  3. 断言：evaluate 后 `.skill-evolution/evaluations/<root>.json` 存在；`promote --dry-run` 对伪造/未 accepted 输入报错；`promote --scope bogus` 报 `invalid-option`；成功 promote 后 manifest scope 合法、版本递增。
- **自动（可进 CI）**：node:test 直接取 `registered[0].handler`、喂 fake ctx，跑同一串命令并断同样后置条件。建议至少把自动版加进 `bundle.spec.mjs`。

> 注：`SkillVersionStore` 读 `<cwd>/<name>/SKILL.md`，与 DSH 发现路径 `.dsh/skills/<name>/SKILL.md` 不一致，是既有的布局错配，**属 SKIL-42 范围**，本设计只在 e2e 步骤里用与 store 一致的 skill 摆放规避，不在此修。

### 6.3 验收时要跑的命令

```
npm --prefix packages/skill-evolution test   # 期望 ≥ 33 passed（新增台账/用例测试后更多）
npm --prefix packages/dsh-bundle test        # 期望 ≥ 12 passed（新增 evaluate→promote node:test）
```
