---
status: accepted
---

# 成员不回复时的定时升级与默认答案

只有 `irreversible / permission / spending` 提问评论必须记录目标、问题类别、默认答案、恢复状态和时间戳。目标成员 2 天未回复时提醒一次，4 天再次提醒并在目标不是 Decision maker 时停掉旧 wakeup、转给 Decision maker 并注册新 wakeup；7 天时停掉仍挂着的 wakeup，并将 issue 置为 `backlog` 等 Decision maker 安排。可逆的 business judgment 不进入等待状态，而是在评论中直接记录 `采用默认答案，成员可推翻` 并继续。2 / 4 / 7 的间隔分别给一次提醒、一次授权升级和跨过一个周末的最终处理窗口；固定标记让每日巡检幂等，同时不会把缺少授权的默认值变成线上事实。

## Considered Options

- 无限期保持 `blocked` 被拒绝，因为成员暂时离线会永久阻塞后续 stage，且没有可观察的升级动作。
- 7 天后对受保护问题自动采用默认答案被拒绝，因为权限、花费和不可逆决策需要明确授权；business judgment 在提问时就采用默认答案。
