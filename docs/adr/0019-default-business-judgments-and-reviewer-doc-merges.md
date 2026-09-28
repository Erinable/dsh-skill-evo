---
status: accepted
---

# 可逆业务判断采用推荐答案，纯 Markdown PR 由 Reviewer 合并

本 ADR 明确标记并解决与 ADR-0017、ADR-0018 的冲突：部分取代 ADR-0017 关于 business judgment 的提问目标与回复归属，部分取代 ADR-0018 关于 business judgment 7 天超时采用默认答案；两份旧 ADR 的其余规则继续有效。

可逆的 business judgment 在提出时记录推荐答案并继续，决议明确「采用默认答案，成员可推翻」；架构扫描选题属于可逆的 business judgment，按默认答案执行；不可逆决策、权限或花费仍需成员明确回复。Reviewer PASS 后，只有当前路径和重命名前路径都匹配 `^(docs/|specs/|skills/).+\.md$` 或 `^CONTEXT\.md$` 的 PR 才由 Reviewer 自动合并；这包括 `skills/**` 下的智能体规则和文档，`*.sh`、`agents/openai.yaml`、代码、测试、配置以及其他非 Markdown 文件仍由成员合并。

## Considered Options

- 所有业务判断都置为 `blocked` 等成员回复被拒绝，因为可逆判断会让 stage 和 grilling 无谓停滞，且推荐答案已经能推进工作。
- Reviewer 合并所有 PASS 的 PR 被拒绝，因为代码、测试、配置和 skill 变更仍需要成员承担最终合并责任。
- 用人工判断「像文档」的 PR 被拒绝，因为文件名白名单可以机械执行并避免误合并。

## Consequences

每次默认决议都必须留下可追溯的可推翻记录；成员回复只作为覆盖已采用答案的输入。平台中 Reviewer、Cartographer、Spec Writer、Architect、Triager 的指令需要同步引用这条规则，但本仓库不直接修改平台配置。
