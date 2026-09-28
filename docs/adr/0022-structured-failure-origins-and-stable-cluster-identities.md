---
status: accepted
---

# Failure case 的来源结构化，问题簇使用最早 case id

Failure case 是由 Observation 投影出的派生记录。投影必须保留失败来源的
结构化事实：`load-failure` 表示 Skill 加载失败，`implicit-follow-up` 表示
Skill 使用后的隐式用户跟进，`explicit-feedback` 表示显式反馈；后者额外
保留 `feedbackKind` 和输入的 `attributionConfidence`。诊断只读取这些字段，
不从自由文本猜测根因。

问题簇先按 `createdAt`、`id` 稳定排序，再按现有相似度规则聚类。簇 id 使用
簇内按该顺序最早的 case id：`cluster:<skillName>:<caseId>`。签名仍用于展示，
不再参与身份。中文文本按 unigram/bigram 生成 token，并使用 overlap coefficient
比较。这样同一批 Observation 无论输入顺序如何，簇成员、顺序和 id 都一致。

这些对象都是可从 Observation log 完整重建的派生记录（见 ADR-0016），因此
签名式旧 cluster id 会在下一次投影时一次性替换；调用方必须重新读取投影结果，
不能把旧 id 当作跨投影的永久标识。

Proposal 是 append-only 事实，已持久化的 Proposal 可能仍保存旧的
`clusterId`。重投影后 `renderProposalMarkdown` 无法解析这个旧派生 id，会静默
省略 Cluster 行；调用方应从当前投影刷新 Proposal 引用。

置信度是证据强度分，不是概率。诊断综合出现次数、不同 session 数、显式反馈、
显式归因置信度和反证；在校准策略建立前，该分数不参与发布门槛。

## Considered Options

- **把自由文本继续作为诊断输入**：拒绝。用户原话和反馈 note 没有稳定的
  语义标签，会把 upload/download 等词误判为加载失败，也无法处理中文反馈。
- **用签名生成簇 id**：拒绝。签名会随簇代表文本变化，导致 proposal 引用漂移。
- **依赖调用方传入顺序**：拒绝。Observation log 重放和增量读取不能保证同一顺序。
- **把置信度当概率并用于门槛**：拒绝。当前分数未校准，只能用于排序和人工查看。
