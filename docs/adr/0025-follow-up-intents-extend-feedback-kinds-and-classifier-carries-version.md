---
status: accepted
---

# Follow-up intent 的取值是 `FEEDBACK_KINDS` 的超集；分类器以带 `version` 的对象注入 core

`FOLLOW_UP_INTENTS = [...FEEDBACK_KINDS, 'not-attributable', 'unknown']`。`FEEDBACK_KINDS` 是它的真子集，显式反馈的 kind 原样就是意图，不需要映射表。分类器和规则都不输出 `other`，它只留给显式反馈。

core 导出 `FollowUpClassifier = { readonly version: string; classify(input, signal): Promise<{ intent, confidence, rationale? }> }`，通过 `EvolutionServiceOptions.followUpClassifier` 注入。注入点和 Designer 一样，都是 core 定义形状、宿主传进实现，不同的是它必须带 `version`：Classification memo（ADR-0024）的键是版本加输入 hash，版本和行为绑在同一个对象上，才不会出现换了模型却忘了换版本号的情况。

这两件事难以逆转，原因是：意图的字符串值会写进 Classification memo，memo 不随 Projection 重建；接口会由 core 之外的包按结构类型实现，例如 adapter 将来的分类器工厂（参考 SKIL-101 里 Designer 工厂的做法）。

## Considered Options

- 另起一套意图词表，再维护一张到 `FEEDBACK_KINDS` 的映射表：同一个意思会有两个名字，显式反馈和推断结果放在一起比较时还得先翻译。被否。
- 把「继续 / 无关」拆成 `continue` 和 `not-attributable` 两个值：下游的严重度、归因、根因对两者完全一样，拆开只会多一个值。被否，以后需要区分时可以追加取值。
- 分类器做成裸函数（和 `Designer` 一样），另加一个 `classifierVersion` 选项：版本和实现分开传，换实现时容易漏改版本，memo 会把新模型的输出记在旧版本名下。被否。
- 批量接口 `classifyMany(inputs[])`：能省调用次数，但超时、部分失败和写 memo 的粒度都会变复杂。被否。需要批量的实现可以在对象内部自己合并请求，接口不变。

来源：[docs/design/follow-up-intent-classification.md §2.2–2.3](../design/follow-up-intent-classification.md)

成员确认：SKIL-126
