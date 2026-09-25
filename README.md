# dsh-skill-evo

面向 DSH 的 Skill 进化研究与工程验证项目。

本项目研究如何把 Agent 在真实任务中的失败轨迹、用户反馈和评测结果，转化为可审阅、可回归验证、可发布和可回滚的 Skill 版本演化闭环。

## 当前状态

- 已建立 Git 仓库。
- 已有一份 MVP 设计基线：[skill-进化设计-MVP.md](./skill-进化设计-MVP.md)。
- 已有一份面向真实开放任务的机制设计：[docs/skill-evolution-mechanism-zh.md](./docs/skill-evolution-mechanism-zh.md)。
- 已形成 DSH 落地架构：[docs/architecture-design-zh.md](./docs/architecture-design-zh.md)。
- 已实现独立 Phase 1 核心包：[packages/skill-evolution/README.md](./packages/skill-evolution/README.md)。
- 研究现状调研结果见 [docs/research-landscape-zh.md](./docs/research-landscape-zh.md)。
- 研究来源索引见 [research/sources.md](./research/sources.md)。

## 研究问题

1. Skill、tool-use policy、memory 和 workflow 在当前研究中如何区分？
2. 哪些方法可以从轨迹和失败反馈中发现、合成或修订 Skill？
3. 如何评测 Skill 的真实增益、回归风险、误触发和安全边界？
4. 如何把研究方法落到 DSH 的 Provider、catalog、workflow 和版本发布模型中？

## 目录

- `skill-进化设计-MVP.md`：现有设计基线。
- `docs/skill-evolution-mechanism-zh.md`：面向真实开放任务的 Skill evolution 机制设计。
- `docs/architecture-design-zh.md`：DSH 插件、事件、存储、版本和实施阶段的落地架构。

## 研究原则

- 观察、归因、候选生成和采用分离，运行时观察不阻塞当前任务。
- 每次变化都保留来源、事件、决策和版本关系；拒绝和暂缓也保留。
- 固定 benchmark 只作为离线参考，不把它当作 DSH 在线质量真相。
- 可重放案例是可选证据；不可重放的真实反馈也必须保留其不确定性。
- 把 Skill 正文、经验、决策历史和运行时加载事实分开管理。
