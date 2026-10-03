---
status: proposed
---

# Skill window、Skill posterior、Failure attribution 是按 session 的派生记录，Projection 不调模型

多 Skill 归因需要三种新的派生结果：确定性的 Skill window、每个工具步上的 Skill 后验、每个失败主体的归属份额。决定：新增三个派生 store，`skill-windows`、`skill-posteriors`（每个 session 一条）和 `failure-attributions`（每个失败主体一条）。后验记录带序列模型版本（`hmm-1`）、参数、参数哈希、发射版本、发射来源（`rule` 或 `judge`）、回退原因和输入哈希；概率存到小数点后 6 位；只写资格区间内的 Skill，其余隐含为 0；`createdAt` 取证据时间，重投影逐字节可复现。这些记录都引用 Observation id，不写回事实（ADR-0016）。

注入的发射模型（embedding、LLM）只在显式的 Maintenance operation `scoreSkillEmissions` 里调用，输出写进 memo store `emissions`，键是 `emission:<version>:<inputHash>`。Projection 保持同步纯函数，只读 memo，没有命中时回退到规则实现 `rule-1`。序列模型版本、参数哈希、发射版本、memo 游标和取到的正文哈希集合一起进投影 cursor 的版本键（`docs/design/tool-correction-create-skill.md` §4.5 的 `judges` 加 `docs/design/follow-up-intent-classification.md` §2.7 的 `derivationKey`，合并形状见设计稿 §3.4），任一变化都触发全量重投影；移除注入后结果回到规则结果。

_与 ADR-0002 的字面冲突_：有注入模型时，派生记录由 Observation log 加 `emissions` memo 重建，而不只靠 Observation log。这里沿用 SKIL-126 的 ADR-0034对 Classification memo 的同一解释：memo 只追加，不被 Projection 重建；丢失时回退到规则。没有注入时，派生结果只依赖 Observation log 和按内容寻址的 Skill 正文。

## Considered Options

- **把后验写回 Observation**：被拒绝，违反 ADR-0016。
- **每步一条后验记录**：被拒绝。记录数和工具步一样多，而归因和汇总都按 session 读，拆开只会增加 join。
- **在 Projection 里直接调用注入的 judge，按 `inputHash` 复用上次结果**（SKIL-128 识别器的做法）：被拒绝。`failures`、`metrics`、worker 都会触发 Projection，模型调用会变成它们的隐式开销，失败重试也无处安放。
- **窗口和后验放进同一个 store**：被拒绝。窗口不依赖发射模型，换 judge 时不该重写窗口；分开之后窗口的验收可以单独测。

## Consequences

- `StoreName` 加 `skill-windows`、`skill-posteriors`、`failure-attributions`、`emissions`；`emissions` 的 role 按 SKIL-126 引入的 `memo`。
- `metrics()` 改为先刷新派生再读，和 `failures` 看同一份投影。
- 来源：`docs/design/skill-window-posterior-attribution.md` §3.4、§4。
