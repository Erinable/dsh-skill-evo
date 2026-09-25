# DSH Skill 进化设计（MVP）

> 状态：设计基线
>
> 目标：在现有 DSH Skill Registry、filesystem provider、workflow/subagent 能力之上，建立“失败轨迹 → 候选 Skill → 回归评测 → 发布/回滚”的可验证闭环。

## 1. 目标与非目标

### 目标

MVP 需要解决四件事：

1. 记录 Skill 在真实任务中的使用和结果。
2. 从失败案例中生成候选 Skill 修改。
3. 用原失败案例、历史成功案例和边界案例做回归评测。
4. 通过版本状态和发布指针安全地晋升或回滚 Skill。

### 非目标

第一版不做以下工作：

- 修改模型权重或训练 Controller。
- 让模型直接覆盖生产 Skill。
- 自动从任意网页内容生成可执行 Skill 并立即发布。
- 把评测逻辑塞进 `SkillProvider`。
- 依赖隐藏的线上答案作为唯一质量信号。

## 2. 现有 DSH 能力与新增层的边界

现有能力继续保持原职责：

| 层 | 现有职责 |
|---|---|
| `dsh-skill` | Provider 注册、作用域、优先级、Skill 加载 |
| `dsh-skill-filesystem` | 从项目和用户目录发现 `SKILL.md`，监听变更 |
| `dsh-tool-skill` | catalog、按需加载、用户显式调用 |
| `workflow` / `subagent` | 编排 Designer、Evaluator 和分析任务 |

新增 `skill-evolution` 层负责：

- 轨迹和结果记录
- 失败案例聚合
- 候选 Skill 生成
- 版本管理
- 沙箱评测
- 晋升、拒绝和回滚

Provider 只回答“有哪些 Skill、如何加载”，Evolution Service 回答“哪个版本值得发布”。

## 3. Skill 目录结构

建议将可进化 Skill 与普通静态 Skill 区分开：

```text
.dsh/skills/api-debugging/
├── SKILL.md
├── manifest.json
├── eval/
│   ├── case-001.json
│   ├── case-002.json
│   └── run.sh
├── changelog.md
└── versions/
    ├── 0.1.0/SKILL.md
    └── 0.2.0/SKILL.md
```

`SKILL.md` 是当前发布版本的入口，`versions/` 保存可回滚版本，`eval/` 保存与 Skill 相关的可重复测试案例。

### manifest.json

```json
{
  "name": "api-debugging",
  "version": "0.2.0",
  "parentVersion": "0.1.0",
  "status": "promoted",
  "source": "project-agents",
  "createdBy": "human",
  "updatedAt": "2026-09-01T00:00:00.000Z",
  "metrics": {
    "successRate": 0.78,
    "regressionRate": 0.04,
    "evaluatedCases": 24
  }
}
```

### 版本状态

```text
draft → candidate → evaluated → promoted
                         ↘ rejected
promoted → deprecated
```

只有 `promoted` 版本进入默认 Skill 发现路径。`candidate` 和 `draft` 可以通过 Evolution Service 显式加载评测，但不能被普通模型 catalog 自动使用。

## 4. 核心数据模型

### Skill 使用记录

```ts
interface SkillUsageRecord {
  id: string
  sessionId: string
  taskId?: string
  skillName: string
  skillVersion?: string
  invokedBy: 'model' | 'user'
  taskSummary: string
  startedAt: string
  finishedAt?: string
  outcome?: 'success' | 'failure' | 'cancelled' | 'unknown'
  evidence: SkillEvidence[]
}
```

### 失败案例

```ts
interface SkillFailureCase {
  id: string
  usageId?: string
  skillName: string
  skillVersion?: string
  task: string
  failure: string
  evidence: string[]
  context?: {
    repository?: string
    model?: string
    tools?: string[]
  }
  severity: 'low' | 'medium' | 'high'
  createdAt: string
  status: 'open' | 'clustered' | 'addressed' | 'ignored'
}
```

`evidence` 必须能指向可复核事实，例如测试失败、工具错误、用户明确纠正或审查结论。仅有“模型感觉不对”不能直接触发自动发布。

### 候选变更

```ts
interface SkillCandidateChange {
  id: string
  skillName: string
  baseVersion: string
  proposedVersion: string
  patch: string
  rationale: string
  addressedCases: string[]
  generatedBy: 'designer' | 'human'
  status: 'draft' | 'evaluating' | 'accepted' | 'rejected'
}
```

### 评测结果

```ts
interface SkillEvalResult {
  candidateId: string
  total: number
  passed: number
  failed: number
  categories: {
    originalFailures: number
    historicalSuccesses: number
    boundaryCases: number
  }
  regressions: string[]
  durationMs: number
  passedGate: boolean
}
```

## 5. MVP 流程

```text
Skill 调用
   ↓
记录使用结果和证据
   ↓
失败案例聚类
   ↓
Designer 生成最小候选修改
   ↓
候选版本进入隔离目录
   ↓
Evaluator 执行三类回归案例
   ↓
通过门禁？
  ├─ 否：rejected，保留诊断
  └─ 是：candidate → promoted
                         ↓
                    触发 Skill catalog invalidate
```

### 5.1 轨迹记录

第一版可以从已有 session/tool 事件构建记录，不需要修改 agent loop 的核心行为。重点记录：

- Skill 名称和版本
- 任务摘要
- Skill 是否实际加载
- 后续工具调用
- 测试和命令结果
- 用户纠正或审查结果

### 5.2 失败聚类

不要让单个失败直接修改 Skill。初始规则：

- 相同 Skill、相似失败描述至少出现 2 次，才进入自动 Designer 阶段。
- 高严重度失败可以单独进入人工审查队列。
- 聚类结果保留原始案例 ID，确保 Designer 可以回看证据。

### 5.3 Designer

Designer 接收：

- 当前 Skill 正文
- Skill manifest
- 一组相似失败案例
- 相关评测案例
- 修改约束

Designer 只输出结构化候选：

```json
{
  "patch": "...",
  "rationale": "...",
  "newCases": [],
  "confidence": 0.82
}
```

候选结果写入隔离目录，不直接覆盖 `SKILL.md`。

### 5.4 Evaluator

评测至少包含三类案例：

1. **原失败案例**：验证候选是否解决触发进化的问题。
2. **历史成功案例**：检测候选是否破坏原有能力。
3. **边界案例**：检测 Skill 是否扩大误触发范围或引入危险动作。

建议的初始门禁：

```text
原失败案例通过率必须提升；
历史成功案例通过率不得下降超过 5 个百分点；
边界案例不得新增高严重度失败；
候选 Skill 必须通过 Markdown/frontmatter/schema 校验；
候选 Skill 不得修改工具权限和 invocation policy；
```

### 5.5 发布与回滚

发布动作应是原子的：

1. 将候选正文和 manifest 写入新版本目录。
2. 校验所有文件完整存在。
3. 更新当前版本指针。
4. 调用 Provider invalidate。
5. 记录 promotion 事件。

回滚只需把当前版本指针切回上一个 `promoted` 版本，并再次触发 invalidate。旧版本不得删除，至少保留最近 10 个版本或最近 30 天版本。

## 6. DSH 集成建议

### 第一阶段：独立插件

建议实现为 `dsh-skill-evolution` 插件，而不是直接修改 `dsh-skill`：

- 订阅 Skill invocation 和 session/tool 相关事件。
- 维护本地 JSONL 或 SQLite 记录。
- 通过 `workflow` 调用 Designer 和 Evaluator。
- 使用现有 filesystem provider 的 invalidate 能力刷新 catalog。

### 第二阶段：服务接口

可以增加以下服务：

```ts
interface SkillEvolutionService {
  recordUsage(record: SkillUsageRecord): Promise<void>
  listFailures(options?: FailureQuery): Promise<SkillFailureCase[]>
  proposeChange(input: ProposalInput): Promise<SkillCandidateChange>
  evaluate(candidateId: string): Promise<SkillEvalResult>
  promote(candidateId: string): Promise<void>
  rollback(skillName: string, version?: string): Promise<void>
}
```

### 不建议的改法

不要直接把 `version`、`status`、`successRate` 变成 `SkillRegistry` 的决策字段。Registry 的职责是确定可见 Skill 和加载内容，质量指标属于 Evolution 层，避免两个生命周期相互耦合。

## 7. 安全和质量边界

### 进化权限

自动 Designer 只能写入候选目录。生产目录的发布需要满足评测门禁；涉及工具权限、文件系统范围或外部网络能力的变更必须人工批准。

### 信息来源

每条自动生成的规则都应能追溯到：

- 失败案例
- 测试案例
- 外部文档来源
- Designer 输出
- 发布版本

### 防止自我验证

生成 Skill 的 Designer 与执行评测的 Evaluator 应尽量分离 prompt 和上下文。Evaluator 不应只判断“Skill 看起来合理”，而应执行真实测试或结构化检查。

### 防止上下文膨胀

Skill 正文应保持短小。重复经验应合并，详细案例放在 `references/` 或评测数据中，不能把完整轨迹追加到 `SKILL.md`。

## 8. 分阶段实施计划

### Phase 1：可观测性

- 定义使用记录和失败案例格式。
- 从现有事件生成 JSONL 记录。
- 提供按 Skill、版本和失败类型查询的最小接口。

验收：能从一次真实会话中还原“用了哪个 Skill、结果如何、证据在哪里”。

### Phase 2：候选生成

- 实现失败聚类。
- 实现 Designer workflow。
- 将候选修改写入隔离目录。

验收：同类失败能生成可审阅的候选 patch，且不会修改生产 Skill。

### Phase 3：评测和晋升

- 实现三类回归案例。
- 实现评测门禁。
- 实现 promote/reject/rollback。
- 接入 Provider invalidate。

验收：候选版本可以自动通过或拒绝，并能在会话内刷新 Skill catalog。

### Phase 4：路由优化

- 统计 Skill 的任务触发和成功率。
- 根据任务和失败类型排序 Skill。
- 评估 Skill 拆分、合并和废弃。

验收：Skill 选择效果提升，并且误触发率可观测。

## 9. 第一批建议实现的文件

如果开始编码，建议按下面顺序拆分：

```text
packages/skill/evolution/
├── src/types.ts
├── src/store.ts
├── src/failure-cluster.ts
├── src/candidate.ts
├── src/evaluator.ts
├── src/promotion.ts
└── src/index.ts

packages/skill/tool-evolution/
└── src/index.ts

packages/skill/evolution-workflow/
└── src/index.ts
```

第一批只实现 `types`、`store`、`evaluator` 和 `promotion`，先不做自动 Designer。先把“记录—评测—发布—回滚”做成可靠底座，再接入模型生成候选，能显著降低进化器自身不稳定带来的风险。

## 10. 成功标准

MVP 达成的标准不是“Skill 自动变长”，而是：

- 失败案例可以被结构化记录。
- 候选 Skill 可以独立评测。
- 评测失败不会污染生产版本。
- 评测通过可以原子发布。
- 发布后 catalog 能正确刷新。
- 任意一次发布都能回滚。
- 每条规则变更都有证据和版本来源。
