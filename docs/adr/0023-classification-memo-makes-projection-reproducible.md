---
status: proposed
---

# 分类器输出存进 Classification memo；Projection 是 Observation log + memo + 版本的纯函数

模型分类本身不确定。为了让 `repair` 和重新投影能确定性地重算，把注入的分类器的每次有效输出按 `classification:<classifierVersion>:<inputHash>` 存进 State directory 下的 Classification memo（`classifications.jsonl`）。memo 是 Observation log 之外的第三类记录：它不是 Fact record，不写回 Observation，不当作证据；也不是 Derived record，Projection 读它但从不重建它。「确定性」的定义是：给定 Observation log、规则版本、分类器版本（没注入时为 `none`）和 memo，Projection 的输出唯一。

这一条修订了 ADR-0002 和 `CONTEXT.md` 对 **Derived record**、**Projection** 的表述（「从 Observation log 完整重建」）：没注入分类器时照旧只依赖 Observation log；注入后，分类器来源的结论要靠 memo 才能复现，memo 丢了只能重新分类，结果可能不同。ADR-0016 不受影响：模型给的意图只出现在 Derived record 里，不写进事实流。

## Considered Options

- 不做 memo，每次 Projection 都调用分类器：重投影结果会漂移，每次 `failures` 都要花钱，`repair` 也没法「确定性重算」。被否。
- 把分类结果作为 Fact record 追加进 Observation log 或另一个 fact store：模型判断会变成权威事实，和 ADR-0016「模型归因必须保持派生」冲突，事后也分不清哪些是发生过的事、哪些是模型的看法。被否。
- 把 memo 标成 `derived`：以后任何「按 role 重建全部 derived store」的代码都会把它清空，已经花钱得到的分类会丢，重投影结果也会变。所以另设 role `memo`。

## Consequences

- `layout.stores` 新增 role `memo`。health 和 repair 按分帧规则照常检查它，但 repair、Retention 和 Projection 都不删它、不重写它。
- Projection cursor 要加 `derivationKey`（规则版本、意图策略版本、分类器版本、memo 指纹），否则换了分类器或改了规则，cursor 仍会判定「无需重投影」。
- 分类器实现方必须在模型、prompt 或输出映射变化时换 `version`；core 无法校验这一点。

来源：[docs/design/follow-up-intent-classification.md §2.7](../design/follow-up-intent-classification.md)
