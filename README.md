# dsh-skill-evo

面向 DSH 的 Skill 进化研究与工程验证项目。

本项目研究如何把 Agent 在真实任务中的失败轨迹、用户反馈和评测结果，转化为可审阅、可回归验证、可发布和可回滚的 Skill 版本演化闭环。

## 当前状态

- 已建立 Git 仓库。
- 已有一份 MVP 设计基线：[skill-进化设计-MVP.md](./skill-进化设计-MVP.md)。
- 正在进行第一轮研究现状调研，结果见 [docs/research-landscape-zh.md](./docs/research-landscape-zh.md)。
- 研究来源索引见 [research/sources.md](./research/sources.md)。

## 研究问题

1. Skill、tool-use policy、memory 和 workflow 在当前研究中如何区分？
2. 哪些方法可以从轨迹和失败反馈中发现、合成或修订 Skill？
3. 如何评测 Skill 的真实增益、回归风险、误触发和安全边界？
4. 如何把研究方法落到 DSH 的 Provider、catalog、workflow 和版本发布模型中？

## 目录

- `skill-进化设计-MVP.md`：现有设计基线。
- `docs/research-landscape-zh.md`：研究现状与 DSH 对照分析。
- `research/sources.md`：论文、官方文档和开源项目来源。

## 研究原则

- 生成和发布分离，候选 Skill 必须经过独立评测。
- 每次变化都保留来源、案例、评测结果和版本关系。
- 评测同时覆盖原失败案例、历史成功案例和边界案例。
- 把 Skill 正文、评测数据、轨迹和运行时权限分开管理。
