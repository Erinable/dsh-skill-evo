---
status: proposed
---

# 工具调用 Observation 记录脱敏后的命令摘要和报错签名，不记完整输出

为了从「失败几次后自己纠正」的片段里学东西，普通工具调用的 Observation 在 payload 上增加几个可选字段：tool/call 上加 `argKeys`（只有键名），命令型工具（今天是 `bash`、`pwsh`）再加 `command`（脱敏后的前 16 个 shell token，≤ 240 字符）和 `commandTruncated`；tool/result 上加 `exitCode`、`signal`、`timedOut`，失败时加 `errorLine`（脱敏后的报错首行，≤ 200 字符）。`schemaVersion` 仍为 1，老记录照样能读。这些值落盘前统一过 core 的 `redactSensitiveText`，并补齐这些规则：URL userinfo、`Authorization` 类请求头、`--token` / `--password` 类参数、`-u user:pass`、以 `TOKEN` / `SECRET` / `KEY` 等结尾的环境变量赋值、已知格式的令牌。先脱敏再截断。bundle 删掉自己那份 `redactText`，改用 core 的。

事实只记发生了什么：`failed` 的含义不变，仍然只表示工具报错；非零退出只写成 `exitCode`，「算不算失败」和命令形状的规范化都放在投影层（ADR-0016）。这个决策不可逆：写进事实流的内容不能回写、不能再脱敏（ADR-0002、ADR-0016），字段名一旦有了读取方也不能改。

## Considered Options

- 落盘时就规范化成命令形状、把值全换成占位符：暴露面更小，但形状规则一改，老事实和新事实就对不上，事实又不能重写。否决。它的一部分好处由「命令只留前 16 个 token」和脱敏拿到。
- 存完整的 stdout / stderr：票面明确排除，暴露面和体积都不可控。
- 在 core 里解析 DSH 的 `[exit code: N]` 标记：违反 ADR-0014。解析留在 bundle，core 只收 `exitCode`。
- 引入第三方秘密扫描库：规则更全，但要新增依赖，bundle 还得能加载它。现有规则按需补齐就够用。

## Consequences

- 脱敏后的非凭据值会留在事实里，比如代理 host 和端口、remote URL 的 host 和路径。它们不能进入候选 Skill 正文，由 create-skill 的环境值检查挡住（见 ADR-0023 与设计稿 §6.4）。
- 已知漏网：`-pPASS` 这类短参数紧贴值、位置参数里的密码、编码过的凭据。只保留前 16 个 token 限制了这些情况的暴露面。

来源：`docs/design/tool-correction-create-skill.md` §3（SKIL-128）
