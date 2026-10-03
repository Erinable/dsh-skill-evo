---
status: accepted
---

# bundle 把 DSH 的上下文遮蔽记为 `context-shadowed` Observation

DSH 已经通过 `session/event` 暴露了摘要压缩（`compaction/summary`）、工具结果裁剪和上下文移除（`compaction/prune`）。这些事件都带被遮蔽的 session seq，之后紧跟一条 `surfaceOp: replace` 的替换事件。今天 bundle 把它们记成只带 `eventType` 的 `agent-step`，替换用的 `tool/result` 则记成一条不关联任何调用的 `tool-result`。决定：bundle 把 `compaction/summary` 和 `compaction/prune` 映射成新的 Observation kind `context-shadowed`，payload 带 `shadowedSeqRanges`、`shadowedTokenCount` 和 `mechanism`。所有 `surfaceOp.op === 'replace'` 的事件带 `surfaceReplace: true`。每条 `skill-loaded` 带 `shadowTracked: true`，表示产生它的 bundle 会报告遮蔽。三项都是 `schemaVersion` 1 下的可选增量。core 只读这些核心词汇，不读 `payload.eventType`，符合 ADR-0014。

Skill window 的结束条件和 Skill 资格区间都依赖「这次加载的正文还在不在上下文里」。没有 `shadowTracked` 的加载一律视为遮蔽不可见，窗口标 `endCertainty: 'uncertain'`，不能把「没看到遮蔽」当成「没有遮蔽」。

## Considered Options

- **core 按 `payload.eventType === 'compaction/prune'` 判断**：被拒绝。违反 ADR-0014，DSH 改名就会静默失效。
- **只在 `agent-step` 的 payload 上加 `shadowedSeqRanges`，不加新 kind**：被拒绝。遮蔽是结束窗口、收缩资格区间的事实，和普通步骤语义不同。放在 `agent-step` 里，所有把 `agent-step` 当步骤的下游都要记得排除它。
- **请 DSH 新增「Skill 正文被移除」事件**：被拒绝。现有事件已经足够：被遮蔽的 seq 和 `skill-loaded` 的 `sessionSeq` 一比就知道；在 DSH 侧新增事件还要跨仓库协调。
- **用 session 结束近似窗口结束，不记遮蔽**：被拒绝。压缩可以发生在 task 中间，之后模型已经看不到 Skill 正文，后验却仍会把步骤归给它。

## Consequences

- `ObservationKind`、bundle 的 kind 白名单、dsh-adapter 的 kind 列表同时加 `context-shadowed`。旧版 core 读到新 kind 仍能通过 `isObservationValue`，只是不理解它。
- 旧日志没有这些字段，只能按降级规则处理（设计稿 §2.4）。
- 来源：`docs/design/skill-window-posterior-attribution.md` §2。
