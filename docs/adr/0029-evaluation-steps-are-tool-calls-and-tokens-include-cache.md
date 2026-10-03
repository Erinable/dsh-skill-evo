---
status: accepted
---

# 评测的步数是工具调用次数，token 是输入加输出、含缓存命中；成本只在通过的 Sample 上比较

`CaseRunResult.toolCalls` 是步数：一条轨迹里模型发出的工具调用总数，失败的调用和模型自己发起的重试每次都算一步，harness 重跑整条用例不算。没有数据时写 `undefined`，不写 `0`。`modelTurns` 可选，只报告，不进门槛。`tokenCost` 是整条轨迹所有模型调用的输入 token 加输出 token，缓存命中的输入 token 按全量计入。步数和 token 的比较只用通过的 Sample，而且只在可比用例（Base 和 Candidate 用例级都通过）上比较，其余用例不参与成本比较。

这些口径一旦写进 Evaluation artifact（Fact record，ADR-0016），老数字就只能按这个定义解读，以后改口径只能加新字段，不能改义。数字由 adapter / executor 提供，core 只定义字段（ADR-0014）。

## Considered Options

- 步数取模型轮次：一轮可以并行发多个工具调用，轮次会低估工作量；自我纠正（SKIL-127）浪费的正是被重试的工具调用。被否，轮次只作为 `modelTurns` 报告。
- 步数取轮次加工具调用：串行循环里每步都数两次，数值没有单一含义。被否。
- 失败的调用或重试不算步数：省掉「失败 → 重试」正是要量化的收益，不算就量不出来。被否。
- token 不含缓存命中：同一对 Base / Candidate 按不同顺序跑，缓存命中率不同，R 次 Sample 之间不可比；Skill 正文被缓存后，它的上下文占用也被低估。被否。
- token 拆成 input / output / cached 三项：门槛要多选一个维度，interface 变宽；以后需要时作为新增字段加上，不影响已有数据。暂不采用。
- 在全部 Sample 上比较成本：失败的运行可能很早就放弃，步数少不代表好。被否。
- 缺数据记 0：会让「没数据」看起来像「0 步、更省」，门槛误判为通过。被否。

来源：[docs/design/evaluation-execution-cost.md §3](../design/evaluation-execution-cost.md)
