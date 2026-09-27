# dsh-skill-evo

> 为 [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/) 提供的 Skill 演化工具集：观察 Agent 的真实运行轨迹，把失败、反馈和评测证据变成**可审阅、可回归、可发布、可回滚**的 Skill 版本。

![status](https://img.shields.io/badge/status-experimental-orange)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

装上 DSH bundle，它会在后台把每次 session 的 Skill 曝光、加载、工具结果和用户 follow-up 记成事实流；再用 `/skill-evolution`（或 `dsh-skill-evolution` CLI）把这些证据聚成失败聚类、生成候选、离线评测、审阅通过后发布新版本，需要时一键回滚。运行时观察**不阻塞**当前任务，Skill 正文的发布始终经过人工 accept。

## 这是什么

- **一个 DSH 观察 bundle** —— 装进 profile 后自动记录 session 事件，无需改动 DSH 的 agent loop 或 registry。
- **一套维护命令** —— session 内的 `/skill-evolution` 斜杠命令，或仓库外的 `dsh-skill-evolution` CLI，二者共享同一批核心操作。
- **一个可复用的核心库** —— 证据、评测、版本发布原语，独立于 DSH 内部实现，可单独在 Node 项目里使用。

> 面向的是**维护者 / 使用者**：想让 DSH 里的 Skill 随真实使用不断变好、又不想丢掉可追溯性和回滚能力的人。

## 安装

要求 Node.js **>= 22**。仓库没有根 workspace manifest，命令需带包前缀在各包目录里执行。

### 1. 构建本地依赖（按顺序）

```bash
(cd packages/skill-evolution && npm install && npm run build)
(cd packages/dsh-adapter    && npm install && npm run build)
(cd packages/dsh-bundle      && npm install)
```

### 2. 把 bundle 装进 DSH profile

以 symlink 方式安装，源码改动对 profile 即时可见：

```bash
dsh plugin --profile web add \
  '@dsh-skill-evo/dsh-bundle@link:/absolute/path/to/packages/dsh-bundle'
```

编辑 bundle 后重启 DSH 重新加载模块；只有 manifest 或依赖图变化时才需要重新安装。用 `file:` 协议安装的是拷贝副本，适合隔离验证或类发布检查。

安装细节（bundle / profile / `cordis.patch.yml` patch 分层）见 DSH 官方文档
[Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。

## 快速上手

装好之后 bundle 会自动开始记录事实流；维护流程按下面的顺序推进。session 内用斜杠命令，仓库外用等价的 CLI（加 `--root <项目路径>`）。

```text
# 1. 看积累了什么证据、有哪些失败聚类
/skill-evolution observe
/skill-evolution failures

# 2. 基于一个 Skill 的当前正文生成候选提案
/skill-evolution propose --skill api-debugging \
  --base-file SKILL.md --candidate-file candidate.md \
  --proposed-version 1.1.0 --intent "Add timeout diagnosis"

# 3. 用确定性回归用例离线评测候选
/skill-evolution evaluate --proposal <proposal-id> --cases cases.json

# 4. 人工审阅通过（accept 是显式的审阅动作）
/skill-evolution accept --proposal <proposal-id> --reason "Reviewed evaluation"

# 5. 先干跑，再正式发布到指定 scope
/skill-evolution promote --proposal <proposal-id> --scope project --dry-run true
/skill-evolution promote --proposal <proposal-id> --scope project

# 需要时回滚到某个历史版本
/skill-evolution rollback --skill api-debugging --version 1.0.0
```

等价的 CLI 形式（session 外运行，需显式指定项目根）：

```bash
dsh-skill-evolution observe  --root /path/to/project
dsh-skill-evolution failures --root /path/to/project --format markdown
dsh-skill-evolution propose  --root /path/to/project --skill api-debugging \
  --base-file SKILL.md --candidate-file candidate.md \
  --proposed-version 1.1.0 --intent "Add timeout diagnosis"
dsh-skill-evolution evaluate --root /path/to/project --proposal <proposal-id> --cases cases.json
dsh-skill-evolution accept   --root /path/to/project --proposal <proposal-id> --reason "Reviewed evaluation"
dsh-skill-evolution promote  --root /path/to/project --proposal <proposal-id> --scope project
dsh-skill-evolution rollback --root /path/to/project --skill api-debugging --version 1.0.0
```

其余命令：`metrics`（运营指标）、`health`（只读就绪探针）、`repair`（校验并隔离损坏的 JSONL）、`rotate`（轮转事件文件）、`feedback`（显式反馈）、`reject` / `defer`（审阅决策）。完整参数见各命令 `--help`。

## 配置

- **事件存储位置**：默认写到 `$DSH_HOME/skill-evolution/events.jsonl`。在 bundle 配置里设 `storePath` 可覆盖；归档段始终紧邻该文件。
- **发布 scope**：`explicit-only`、`project`、`user`、`stable` —— 决定新版本对哪些 session 可见。
- **评测策略**：向 CLI `evaluate` 传 `--policy policy.json`（同样的 `EvaluationPolicy` 也能通过 `EvolutionServiceOptions` 注入），可配置回归判据。
- **自定义事件映射**：bundle 配置里可传同步的 `mapEvent(session, event, { id })` 覆盖内置映射；返回 `undefined` 回退到通用观察。
- **产物路径**：提案 Markdown 默认写到 `.skill-evolution/proposals/`，评测产物写到 `.skill-evolution/evaluations/`。

安全提示：用户和反馈文本在落成证据前，会对常见的 API key、bearer 凭据、密码和 token 做脱敏。

## 目录导航

三个包各有独立 README，根 README 只做导航。

| 路径 | 包名 | 作用 |
| --- | --- | --- |
| [`packages/skill-evolution/`](./packages/skill-evolution/README.md) | `@dsh-skill-evo/core` | 核心库：观察、Experience、候选、评测、版本发布与回滚、portfolio 维护，以及 `dsh-skill-evolution` CLI。独立于 DSH 内部实现。 |
| [`packages/dsh-adapter/`](./packages/dsh-adapter/README.md) | `@dsh-skill-evo/dsh-adapter` | 适配边界：把 DSH 运行时事实翻译成核心观察，并提供 DSH 评测执行器。不 import DSH 内部。 |
| [`packages/dsh-bundle/`](./packages/dsh-bundle/README.md) | `@dsh-skill-evo/dsh-bundle` | 可安装的 DSH 观察 bundle，含 `cordis.patch.yml` 与 `/skill-evolution` 斜杠命令。 |

开发约定（构建/测试命令、代码风格、提交规范）见 [AGENTS.md](./AGENTS.md)。

## 研究背景

本项目同时是一份研究记录：探索如何把 Agent 在真实开放任务里的失败轨迹、用户反馈和评测结果，转化为可审阅、可回归验证、可发布和可回滚的 Skill 版本演化闭环。

核心研究问题：

1. Skill、tool-use policy、memory 和 workflow 在当前研究中如何区分？
2. 哪些方法可以从轨迹和失败反馈中发现、合成或修订 Skill？
3. 如何评测 Skill 的真实增益、回归风险、误触发和安全边界？
4. 如何把研究方法落到 DSH 的 Provider、catalog、workflow 和版本发布模型中？

设计原则：观察、归因、候选生成与采用分离，运行时观察不阻塞当前任务；每次变化都保留来源、事件、决策和版本关系（拒绝和暂缓也保留）；固定 benchmark 只作离线参考，不当作在线质量真相；把 Skill 正文、经验、决策历史和运行时加载事实分开管理。

设计与调研文档：

- [`skill-进化设计-MVP.md`](./skill-进化设计-MVP.md) —— 现有设计基线。
- [`docs/skill-evolution-mechanism-zh.md`](./docs/skill-evolution-mechanism-zh.md) —— 面向真实开放任务的机制设计。
- [`docs/architecture-design-zh.md`](./docs/architecture-design-zh.md) —— DSH 插件、事件、存储、版本与实施阶段的落地架构。
- [`docs/sdd-practice-zh.md`](./docs/sdd-practice-zh.md) —— SDD 管线与多 Agent 角色分工对照。
- [`docs/research-landscape-zh.md`](./docs/research-landscape-zh.md) —— 研究现状调研。
- [`research/sources.md`](./research/sources.md) —— 研究来源索引。

## License

[MIT](./packages/skill-evolution/package.json)
