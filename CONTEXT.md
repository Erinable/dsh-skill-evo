# DSH Skill Evolution

从 Skill 的运行时事实中积累证据，诊断失败，提出、评估并显式发布 Skill 的修改；运行闭环只记录事实，维护闭环在事后做判断和发布。

## 事实

**Observation**:
运行时发生的一条不可变事实，例如 Skill 可见、加载、工具返回、用户跟进、任务结束。
_Avoid_: event, 事件

**Observation log**:
一个 Skill root 的全部 Observation 按写入顺序构成的逻辑事实流，由当前文件和它的全部 Archive segment 组成。
_Avoid_: event store, events 文件

**Archive segment**:
轮转后移出当前文件、仍属于 Observation log 的只读段。
_Avoid_: 备份, 历史日志

**Rotation**:
把当前文件整体变成一个 Archive segment，Observation log 的内容不变。
_Avoid_: truncate, 清理

**Retention**:
显式删除过期 Archive segment，因此会缩短 Observation log。
_Avoid_: rotation（两者不是一回事）

**Fact record**:
只追加、不修改的权威记录；Observation、Ledger record、Decision record 都属于这一类。
_Avoid_: raw data

**Derived record**:
可以重建的判断：Experience、Failure case、Failure cluster、Diagnosis、Follow-up resolution。没注入分类器时只依赖 Observation log；注入后，分类器来源的结论还依赖 Classification memo 和推导版本（ADR-0034）。
_Avoid_: cache, 结论

**Projection**:
从 Observation log、Classification memo 和推导版本确定性地重建全部 Derived record 的过程；没注入分类器时只读 Observation log。Projection 从不调用分类器。
_Avoid_: sync, 刷新

**Classification memo**:
分类器输出的缓存，按分类器版本和输入哈希存放，供 Projection 复现分类结论；它不是 Fact record，不当作证据，也不是 Derived record，Projection 和 repair 都不删它（ADR-0034）。
_Avoid_: 分类结果事实, cache（它不能随意丢弃）

**Exposure view**:
一个 Skill 在一次 session 里「可见 → 请求加载 → 加载成功/失败」的三段证据；它不是成功率。
_Avoid_: usage rate, 成功率

## 经验与诊断

**Experience**:
从 Observation 压缩出来的局部经验片段，保留上下文和证据 Observation 的 id；它不是 Skill。
_Avoid_: lesson, memory, 经验总结

**Attribution**:
把一个结果归到某类原因（routing、content、tool 等）的判断；属于派生，可以修正。
_Avoid_: blame

**Follow-up intent**:
对一条用户跟进的意图判断，例如纠正、补充约束、改目标、致谢；取值是 feedback kind 的超集，另有 `not-attributable`、`unknown`（ADR-0035）。显式反馈的 kind 优先于任何推断。
_Avoid_: sentiment, 情绪

**Follow-up resolution**:
一条用户跟进的意图、来源（显式、规则、分类器）和推导版本，属于 Derived record；Failure case 只从这里读意图，不再看跟进原文。
_Avoid_: label, 标注

**Failure case**:
一次能定位到某个 Skill 的失败，引用证据 Observation。
_Avoid_: error, incident

**Failure cluster**:
同一个 Skill 下签名相同的 Failure case 的集合。
_Avoid_: group, bucket

**Diagnosis**:
对一个 Failure cluster 的根因假设，附建议的 proposal operation。
_Avoid_: analysis

## Proposal 与台账

**Proposal**:
针对一个 Skill 的一次候选修改，绑定 Base，沿 Proposal status 的 Transition table 走完生命周期；Proposal 指整件事，包括其 Candidate content、评估和台账记录。
_Avoid_: candidate, change request, PR

**Proposal status**:
Proposal 当前所处的生命周期状态；`draft` 是其中一个 Proposal status 值。
_Avoid_: status（留给 Proposal）

**Candidate content**:
Proposal 携带的候选 Skill 正文；隔离存放，Promote 之前不可见。Candidate content 只指候选正文，不指整个 Proposal。
_Avoid_: draft

**Base**:
Proposal 所针对的那一版 Skill 内容；Skill 当前内容已不是 Base 时，Proposal 过期（stale）。
_Avoid_: parent version, original

**Proposal root**:
一个 Proposal 在所有状态记录之间共享的逻辑身份。
_Avoid_: proposal id 前缀

**Ledger record**:
Proposal 在某个状态下追加的一条记录，身份由 Proposal root 和该状态组成。
_Avoid_: proposal version

**Proposal ledger**:
全部 Ledger record 构成的 append-only 历史；Proposal 的最新状态从它推出。
_Avoid_: proposal 表

**Transition table**:
Proposal status 之间唯一合法的转移集合。
_Avoid_: guard list

**Decision record**:
对 Proposal 或 Skill 生命周期所做的一次决定的持久记录，rejected、deferred、rolled-back 也要保留。
_Avoid_: audit log

## 评估与发布

**Evaluation**:
在一组 Evaluation case 上对 Base 与 Candidate content 的反事实比较；它不是总分。每个 Evaluation case 在两侧各跑 R 次（ADR-0030）。
_Avoid_: score, benchmark

**Evaluation case**:
参与比较的一个用例，分为 original-failure、historical-success、boundary 三类。
_Avoid_: test

**Sample**:
一个 Evaluation case 在 Base 或 Candidate 一侧的一次运行；用例是否通过按 R 个 Sample 的多数判定（ADR-0030）。
_Avoid_: trial, run

**Execution cost**:
一条轨迹的步数（工具调用次数）和 token（输入加输出，含缓存命中）；只在双方都通过的用例的通过 Sample 上比较（ADR-0029）。
_Avoid_: 总成本, latency

**Context cost**:
一份 Skill 正文在目录曝光（name 与 description）和加载（整份 SKILL.md）时占用的 token 估计，由 core 从正文确定性算出，评测和 metrics 共用（ADR-0031）。
_Avoid_: prompt size, 运行时 inputTokens

**Evaluation artifact**:
一次 Evaluation 的持久结果，只对它所评估的那个 Proposal、Base 和 Candidate content 有效；是 Promote 的前置证据。
_Avoid_: report

**Gate**:
评估策略给出的通过门槛；没过 Gate 的 Proposal 不能 Promote。
_Avoid_: threshold score

**Accept**:
决策者同意采用一个 Proposal；它不表示已经发布，也不表示已经证明有收益。
_Avoid_: approve, merge

**Promote**:
把一个已 Accept 的 Proposal 的 Candidate content 发布为 Skill 的新版本，并指定 Publication scope。
_Avoid_: adopt, 采用, deploy

**Rollback**:
把 Skill 的当前版本恢复到先前一个已发布版本。Proposal status `reverted` 是遗留状态，不是当前动作名称或有效转移。
_Avoid_: revert

**Publication scope**:
Promote 之后新版本在哪个范围生效：explicit-only、project、user、stable。这里的 `stable` 是 Publication scope 值，不是 Lifecycle state 定义中的阶段。
_Avoid_: target, channel, 灰度

**Next load**:
新版本只在下一次加载边界生效，已经加载进模型的正文不会被热替换。
_Avoid_: hot reload

**Skill version**:
一个 Skill 已发布的正文快照；current 指向其中之一。

## 库与范围

**Skill root**:
一组 Skill 所在的目录，也是它们演化状态的归属单位。
_Avoid_: state root, workspace

**State directory**:
Skill root 下保存演化状态的目录。
_Avoid_: state root, 状态根目录

**Portfolio**:
一个 Skill root 下全部 Skill 作为整体的维护视图：重叠、上下文成本、休眠与退役候选。
_Avoid_: catalog, registry

**Lifecycle state**:
Skill 在 Portfolio 里所处的阶段，取值为 `draft`、`observed`、`canary`、`stable`、`dormant`、`retired`。这里的 `draft`、`observed`、`stable` 是 Lifecycle state 值；Publication scope 中的 `stable` 是另一概念。
_Avoid_: status（留给 Proposal）

**Provider rank**:
DSH 在同名 Skill 的多个来源之间做选择的优先级；它不承担质量、灰度或生命周期判断。
_Avoid_: quality score, priority

**Runtime loop**:
会话内同步发生、只追加 Observation、从不阻塞当前任务的那一侧。

**Maintenance loop**:
事后运行的那一侧：Projection、诊断、Proposal、Evaluation、Promote。
_Avoid_: background job

**Maintenance operation**:
由人或 worker 显式触发的一次维护动作（propose、evaluate、review、promote、rollback）。
_Avoid_: command（command 只指 CLI / slash 命令这层 adapter）
