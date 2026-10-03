---
status: accepted
---

# create-skill 提案用哨兵值 `absent` 表示空 Base；自我纠正片段单独存为不绑定 Skill 的派生记录

`ProposalOperation` 增加 `create-skill`。`SkillProposal` 增加可选字段 `operation` 和 `source`。`create-skill` 的 `baseVersion` 与 `expectedBase.contentHash` 都写成字面量 `'absent'`，并且 `operation === 'create-skill'` 当且仅当 `expectedBase.contentHash === 'absent'`。凡是检查 Base 的地方（design、evaluate、evaluation artifact、promote 预检、`assertExpectedBase`），遇到 `absent` 都要求当前 Skill 仍然不存在，这样同名并发创建在发布锁内就会报 stale base。转移表不加状态、不加转移（ADR-0004），record id 沿用 ADR-0021。

自我纠正片段（Correction episode）和它跨 session 的聚合（Correction pattern）存进两个新的派生 store：`episodes`、`patterns`。它们引用 observation id，带识别器版本和策略版本，可以删掉重建（ADR-0002、ADR-0016）。它们不塞进 `failures`：Failure case 按定义必须能归到某个 Skill，而这类片段往往出现在没有加载任何 Skill 的 session 里。投影 cursor 记下这些注入判断的版本，版本一变就重投影。`patterns` 只存和时间、Skill root、台账都无关的字段，也就是签名和每次出现的 episode、session、时间。时间窗内的计数、是否是候选、目标 Skill 都在读取时按传入的 `now` 现算。原因是投影缓存不随时间失效，存下来的判断会过期。

这个决策不可逆：`'absent'` 会写进台账，派生 store 的名字和记录形状会被报告、metrics 和以后的读取方依赖。

## Considered Options

- 把 `AdoptionBase` 改成判别联合 `{ name, absent: true } | { name, contentHash }`：类型更准确，但所有读 `contentHash` 的地方都要改，老记录读取时也要补字段。哨兵值不可能与 sha256 十六进制串相等，已经足够安全。
- 让 `expectedBase` 可选、缺省就表示不存在：`options.expectedBase ?? proposal.expectedBase` 里「没传」和「不存在」会混在一起，会悄悄绕过 Base 检查。否决。
- 把片段硬塞进 `SkillFailureCase`，`skillName` 放一个占位值：会污染按 Skill 聚类和诊断的逻辑，还破坏 CONTEXT.md 对 Failure case 的定义。否决。
- 只在 Experience 里记片段、不单独建 store：聚合时要把 `observedPattern` 字符串解析回去，签名和门槛都没有结构化的落点。否决。

## Consequences

- 空 Base 的评测 baseline 改为真正跑一遍「没有这个 Skill」的对照，不再把 Base 记为无效；否则 high boundary 检查会失效。
- `create-skill` 发布后没有可以回滚到的版本；要撤掉走 `retire`。
- Publication scope 对 create-skill 和环境性补丁默认只允许 `project` / `user`，由带版本的 `CorrectionPolicy` 控制，放宽要换策略。这一条可以逆转，不在本 ADR 的范围内。

来源：`docs/design/tool-correction-create-skill.md` §4.4、§5.3、§6.1（SKIL-128）
