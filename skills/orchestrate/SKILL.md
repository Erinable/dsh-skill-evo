---
name: orchestrate
description: "Mika 的编排规则。成员在聊天里提需求、在父 issue 上被触发（新建、stage 完成唤醒、成员回复）、Triager 或 Architect @Mika 交接、跑每日巡检时使用。"
---

Mika 统一编排：成员只提需求和合 PR，其余由 Mika 把需求变成父 issue、按 stage 建子 issue、放行、收口。执行 agent 的交付和 Reviewer 的评审以 `delivery-contract` 为准。

向成员提问使用所选 tracker adapter 的 `Ask a person and wait` 一节。

- **agent id** 现查：`multica agent list --output json`，按 `name` 取 `id`。
- **建票前查重**：本 skill 里每一次 `multica issue create`（父 issue、stage 子 issue、拆票、修订票）之前，先按 `delivery-contract` 的「建票前查重」查，只有同一问题、同一来源的票才复用，不新建。

先判断本次 run 属于哪个入口，只执行对应一节：

| 触发 | 去哪一节 |
|---|---|
| 聊天里成员提需求 | 入口 |
| 父 issue 新建后的第一次 run | 路由并建 Stage 1 |
| 父 issue 上收到「Stage N complete」 | 放行 |
| 子 issue 上执行 agent 报 spec 有问题并 @Mika | 故障：spec 修订 |
| Triager 或 Architect 在某 issue 上 @Mika | 交接入口 |
| 每日巡检 autopilot | 读 `PATROL.md` |

## 入口（聊天回合）

1. 只需要一个答案的，直接在聊天里回答，不开票，到此结束。
2. 其余需求只建父 issue，别的都留给父 issue 上的 run：
   ```bash
   multica issue create --title "<需求一句话>" --description-file ./parent.md --assignee Mika --status backlog
   # 查重第 6 步复查：没有更早的同源父 issue
   multica issue status <parent-id> todo
   ```
   `parent.md` 写成员原话、你理解的目标，以及提出人元数据：`需求提出人 user_id: <member-user-id>`。聊天上下文拿不到成员 `user_id` 时写 `需求提出人 user_id: unresolved (fallback to Decision maker)`，不要写 agent id。成员点名了现有 issue 的，照样建父 issue，在 `parent.md` 里写出它的 KEY，让父 issue 的首次路由 run 去复用它（查重第 2 步：建父 issue 时点名的 KEY 不跳步）。
3. 聊天回合到此为止：不建子 issue，不改现有 issue 的父 issue、stage、负责人。这些是父 issue 首次路由 run 的事；聊天 run 也做，就是两个 run 同时对一件事建票（SKIL-80 的聊天 run 和首次路由 run 并发，聊天 run 另建了重复的 SKIL-81）。

完成判据：父 issue 存在，负责人 Mika，状态 `todo`；本次聊天 run 没有建子 issue。`Subscribers` 集合在首次仓库路由 run 中完成订阅。

## 路由并建 Stage 1

开始仓库检出后的首次路由时，先按 `docs/agents/instance.md` 的提出人解析顺序读取父 issue 描述。tracker 来源票若尚无 `需求提出人 user_id` 行，先用已验证的 `creator_type == member` / 触发评论作者解析，重读完整描述后追加该行并用 `multica issue update <parent-id> --description-file <file>` 写回；仍解析不出就写 `unresolved`。再按 `Subscribers` 补齐父 issue 订阅，最后检查子 issue；此前在聊天入口不订阅。已有提出人元数据优先于本次触发来源，避免把路由 agent 或子 issue 上的评论作者误认成提出人。

```bash
# Repeat once for each resolved `user_id` in `instance.md`'s `Subscribers` set.
multica issue subscriber add <parent-id> --user-id <subscriber-user-id>
```

0. 先查 `multica issue children <parent-id> --output json`。已经有子 issue 的，不再路由、不再建票，再看 `multica issue get <parent-id> --output json` 的 `assignee_id`：
   - 不是 Mika（Triager 交接时上次 run 建完子 issue、没走到最后一步指派就中断了）：`multica issue assign <parent-id> --to-id <Mika 的 id>`，再 `multica issue status <parent-id> in_progress`，本次 run 结束。
   - 已经是 Mika：本次 run 直接结束。

   同一张 issue 被多跑一次也不会建出第二套子 issue，也不会留下没有负责人的父 issue。
1. 按路由表判断类型。判断不了时，按所选 tracker adapter 的 `Ask a person and wait` 一节问成员**一个**问题（带默认答案），传入父 issue、问题正文、触发线程（如有）及回复后路由的 next 指令；本次 run 结束。成员回复后按回复路由，不再追问。
2. 在父 issue 上评论本次路由：类型、全部 stage 的计划。
3. 按「stage 模板」建 Stage 1 的子 issue（先查重；父 issue 描述里点名的现有 KEY 是同一种票，直接复用），父 issue 置 `in_progress`。

完成判据：Stage 1 子 issue 全部存在、状态 `todo`、已指派；路由评论写了查重关键词和结论；父 issue 和 Stage 1 子 issue 都订阅 `docs/agents/instance.md` 的 `Subscribers` 集合。

### 路由表

| 需求特征 | 阶段安排 |
|---|---|
| 目标明确的功能 | S1 Spec Writer → S2 若干 Builder |
| 涉及模块边界或接口设计 | S1 Architect（设计 PR）→ S2 Spec Writer → S3 若干 Builder |
| bug | S1 Sleuth（先写复现测试，再修复并开 PR） |
| 事实问题、选型 | S1 Scout（调研 PR）；成员想继续做时，追加后续 stage |
| 看了才知道的设计问题 | S1 Prototyper（原型附件 + 结论文档 PR）→ 合并后按结论问成员是否追加后续 stage |
| 大而模糊的方向 | S1 Cartographer（地图 + 决策票，决策票由 Cartographer 挂在地图 issue 下）→ 地图清楚后追加 Spec Writer 和 Builder 的 stage |
| skill 或文档修改 | S1 Scribe |
| 只需要一个答案 | 不开票（见入口第 1 步） |

「合并后按结论问成员是否追加后续 stage」「成员想继续做时」都通过所选 tracker adapter 的 `Ask a person and wait` 一节问成员**一个**问题（带默认答案），传入父 issue、问题正文、触发线程（如有）及按回复追加 stage 的 next 指令。

### stage 模板

每个 stage 只在放行时才建。每张子 issue 先按 `delivery-contract`「建票前查重」第 1–5 步查，同源重复的就复用那张（改父 issue 和 stage），不走下面的 `create`。没有同源重复才建，先建成 `backlog`，复查（第 6 步）通过后再置 `todo`，置 `todo` 后立即开工：

```bash
multica issue create --parent <parent-id> --stage <N> --status backlog \
  --assignee "<agent 名>" --title "<一句话>" --description-file ./child.md
# 查重第 6 步复查：没有更早的同源票
multica issue status <child-id> todo
# Repeat once for each resolved `user_id` in `instance.md`'s `Subscribers` set.
multica issue subscriber add <child-id> --user-id <subscriber-user-id>
```

| stage 内容 | 张数 | 指派 |
|---|---|---|
| spec / 设计 / 调研 / 原型 / 地图 / bug / 文档 | 1 张 | 路由表对应的 agent |
| 实现 | `tasks.md` 每条 task 一张，同一 stage 并行 | Builder |

`child.md` 必须继承父 issue 的 `需求提出人 user_id: <member-user-id>` 行（父 issue 写的是 `unresolved` 时原样继承），另写清目标、验收标准、上游产物的位置（已合并的 `specs/<slug>/` 路径或 PR 链接）、相关 ADR 编号（本需求涉及的 `docs/adr/NNNN-*.md`），末尾一行：「按 `delivery-contract` 交付」。没有父 issue 的 tracker 来源票按 `creator_type == member` 解析 `creator_id`，否则回退 Decision maker。

## 放行

被「Stage N complete」唤醒时，平台只尝试唤醒一次，所以每次都先核对再动：

1. `multica issue children <parent-id> --output json`，确认 Stage N 每张子 issue 的 `status_category` 都是 `done` 或 `cancelled`。有未完成的，在父 issue 上说明是哪张，本次 run 结束。
2. **下一 stage 已存在就不再建。** 同一份 `issue children` 输出里已有 Stage N+1 的子 issue 时（spec 修订票合并后 Stage N 会再次完成，就是这种情况）：找出 Stage N 里修订票描述中点名的原子 issue，其中仍是 `blocked` 的逐个 `multica issue status <child-id> todo`，本次 run 结束。不拆票、不建新票。
3. 按路由计划建下一 stage。下一 stage 是实现时，按「拆票」来建。
4. 已经没有下一 stage 时，去「收口」。

完成判据：Stage N+1 的子 issue 只有一套（没有重复建票），且为 `todo` 或已开工；或已进入收口。

### 拆票

实现票只从**已合并**的 `specs/<slug>/tasks.md` 拆：

1. `git fetch origin` 后读 `origin/main` 上的 `specs/<slug>/tasks.md`。文件不在 `origin/main` 上说明 spec PR 还没合，在父 issue 上说明，本次 run 结束。
2. 每条 task 建一张 Builder 子 issue，全部放在同一个 stage，`child.md` 里写 task 原文和 `specs/<slug>/` 路径。查重时问题关键词用 task 编号，来源锚点用 `specs/<slug>/`：只有描述里也写着同一个 `specs/<slug>/` 的同号 task 票才复用，别的 spec 的 `Task N` 是同号不同源，照建。

完成判据：子 issue 张数等于 `tasks.md` 的 task 条数；每条 task 在 `specs/<slug>/` 下恰好一张（新建或复用同源票），没有一张是从别的 spec 挪过来的。

## 收口

这一节是共同规则「`done` 留给人」的明确例外：每张子 issue 都是成员合并 PR 后才变 `done` 的，合并就是验收，所以父 issue 由 Mika 直接关闭。不置 `in_review`，也不请成员确认后再关。

1. 在父 issue 上发一条汇总评论：每个 stage 的子 issue、对应 PR 链接（`gh pr list --state all --search "<KEY> in:title" --json number,url,state`）、遗留问题。
2. 直接置 `done`：
   ```bash
   multica issue status <parent-id> done
   ```

完成判据：`multica issue get <parent-id> --output json` 的 `status` 为 `done`。停在 `in_review` 就是没收口。

## 交接入口

- **Triager @Mika**：原 issue 就是父 issue，不另建。本次 run 按顺序做完（Mika 在这次 run 里把 issue 指派给自己，不会取消当前 run，也不会另起新 run，所以接手不能留给指派去触发）：
  1. 按 `docs/agents/instance.md` 的 `Subscribers` 订阅原 issue；
  2. 按「路由并建 Stage 1」路由（Triager 的 brief 在评论里）：发路由评论，建 Stage 1 子 issue（先按「建票前查重」查：原 issue 本身可能就是别处已建的跟踪票，或者同一问题已有另一张父 issue）；
  3. **最后一步**：`multica issue assign <原 issue id> --to-id <Mika 的 id>`，再 `multica issue status <原 issue id> in_progress`。

  指派放在最后：指派不会起新 run，前面几步做完 issue 才有负责人，stage 完成后也才能唤醒到 Mika。
- **Architect @Mika**（成员在架构扫描 issue 上回复了编号）：按成员选的编号，以路由表「涉及模块边界或接口设计」一行建父 issue，走入口第 2 步。建之前查重：问题关键词用编号，来源锚点用架构扫描 issue 的 KEY，两者都对上的已有父 issue 才不再建。

## 故障

| 情况 | 处理 |
|---|---|
| 执行 agent 报 spec 有问题（子 issue `blocked` 并 @Mika） | 先按「建票前查重」查（来源锚点是原子 issue 的 KEY），描述里点名同一原子 issue 的未完成修订票已存在就不再追加；否则在 spec 所在的 stage 追加一张 Spec Writer 修订票（`--stage <该 stage> --status backlog`，复查后置 `todo`），描述里写原子 issue 的 KEY 和它报的问题。修订合并后该 stage 再次完成、唤醒你，按「放行」第 2 步把原子 issue 置回 `todo` |
| 交付后没 @Reviewer 或 @ 错人、Reviewer 第 3 次 BLOCK、run 失败、stage 唤醒丢失、PR 被关闭不合 | 由每日巡检发现、进摘要，见 `PATROL.md` |
| 已交付的 PR 与 main 冲突（评审前或 PASS 后） | 每日巡检「PR 冲突查」发现，在子 issue 上 @ 原执行 agent，执行 agent 按 `delivery-contract`「PR 冲突时」解冲突并交回 Reviewer 复核，见 `PATROL.md`。巡检依赖「每日巡检」autopilot 真实存在 |
| 成员把修改意见留在 GitHub 上 | 平台不会触发任何 agent，Multica 也不同步 PR 评论。每日巡检「GitHub 意见查」把 `OPEN` PR 上的成员意见转到对应 issue 并 @ 执行 agent，最迟一天，见 `PATROL.md`。PR 末尾「修改意见请评论在 <KEY> 上」的提示保留，走 issue 是即时的。巡检依赖「每日巡检」autopilot 真实存在 |

## 自动任务

三个 autopilot 与本 skill 的关系（创建与配置不在本 skill 内）：

| 名称 | 触发 | 模式 | 执行者 | 与 Mika 的接口 |
|---|---|---|---|---|
| 每日巡检 | 每天 09:07 Asia/Shanghai | run_only | Mika | 读 `PATROL.md` |
| 每日分诊 | 每天 09:37 Asia/Shanghai | run_only | Triager | 捞没有负责人也没有父 issue 的 issue，分诊后 @Mika，走「交接入口」 |
| 每周架构扫描 | 每周一 10:13 Asia/Shanghai | create_issue | Architect | 报告作为附件挂在它建的 issue 上；成员回复编号后 Architect @Mika，走「交接入口」；成员不回复就什么都不发生 |
