# 从工具调用的自我纠正片段提炼 Skill

> 状态：SKIL-128 设计提案（父 issue SKIL-127，S1）。不可逆决策见 ADR-0023、ADR-0024（成员 2026-10-03 确认，`accepted`）。
> 本文合并后冻结，不随代码更新；与现状不一致时以代码、ADR 和 spec 为准。基线 `origin/main` @ `2a442af`（代码）；第 2 轮修订时已合并到 `6accc8b`，这之间 main 只合入了 PR #78 的文档（ADR-0021 与 `proposal-ledger-transition.md`），代码没有变化；交付前又合并到 `63d2007`，新增的 SKIL-134 只改 failure case 的来源字段和 cluster id，与本设计没有交集。本文只出设计，不写实现代码。

要解决的问题：模型 `git push` 连续报 443，自己想到设置代理后成功。这段上下文今天在采集、投影、提案三层都留不下来，几天后模型还会先犯同样的错，再自己纠正一遍。

## 1. 现状

### 1.1 读了什么

- 本仓库：`packages/dsh-bundle/index.js`（全文）；`packages/skill-evolution/src/` 下的 `types.ts`、`experience.ts`、`proposal.ts`、`service.ts`、`operations.ts`、`workflow.ts`、`records.ts`、`events.ts`、`projection.ts`、`metrics.ts`、`report.ts`（全文），`lifecycle.ts:27-155,268-285`、`evaluator.ts:40-60,107-125,174-260`、`state-root.ts:1-80`、`portfolio.ts:1-42,130-144`。
- 文档：`CONTEXT.md`、`AGENTS.md`、`docs/agents/domain.md`、`docs/agents/issue-tracker.md`，ADR-0002、0004、0005、0006、0014、0015、0016、0019、0020；PR #78（SKIL-123，已在 `6accc8b` 合并）的 `docs/design/proposal-ledger-transition.md` 和 ADR-0021（`accepted`）；`research/designer-subagent-readonly-tools-zh.md`；SKIL-104 的收尾决议评论；SKIL-125 / SKIL-126 的描述（SKIL-126 还没有设计 PR）。
- DSH 源码（本机克隆 `deepseek-harness` @ `6ce94ee`，比 SKIL-102 调研用的 `477b4f4` 新）：`packages/shell/tool-bash/src/render.ts:10-60`、`packages/shell/tool-bash/src/index.ts:150-180,243,275-300,380-390`、`packages/shell/shell/src/render.ts:37-43`、`packages/core/session/src/types.ts:344-363`。
- 基线：`npm --prefix packages/skill-evolution test` 输出 `Test Files  12 passed (12)`、`Tests  134 passed (134)`。

### 1.2 采集层：看不出失败的是什么

- `mapToolCall`（`packages/dsh-bundle/index.js:400-429`）解析了参数（`:404`），但普通工具只把 `toolCallId`、`toolName` 写进 payload。
- `mapToolResult`（`:431-464`）只写 `failed: true`（`:442`），不带报错文本。
- **非零退出码不算 `failed`。** `toolResultFailed`（`:516-524`）只看 `data.error` 和 `isError`。DSH 的 bash 工具把非零退出写成正文末尾的 `[exit code: N]` 标记，明确「reported, not errored」，只有 spawn 失败和中止才是 `isError`（DSH `packages/shell/tool-bash/src/render.ts:17-21,52-58`）。所以 `git push` 报 443、退出码 128 的那次调用，今天在事实流里就是一次**成功**的 `bash` 调用。
- 脱敏有两份。bundle 自己有一份 `redactText`（`:314-319`），套在所有 payload 上（`:156`）；core 有 `redactSensitiveText`（`packages/skill-evolution/src/events.ts:10-15`），只用在 follow-up 原文（`index.js:391`）和反馈备注上。两份的规则一样，都没覆盖本需求要求的五类。在 `2a442af` 上 build 后，用一次性脚本实测 core 的 `redactSensitiveText`（脚本已删除）：

```
"https_proxy=http://alice:s3cretpw@10.0.0.1:7890 git push"                       ← userinfo 原样保留
"git push https://x-access-token=[REDACTED]"                                      ← 误把 URL 当成 token=，整段 host 被吞
"curl -H 'Authorization: token abc123def456' https://api.example.com"            ← 原样保留
"mytool --token abcdef123456 --password hunter2"                                  ← 原样保留
"GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 npm publish"                    ← 原样保留
"export NPM_AUTH=xyz; token=[REDACTED]"
```

### 1.3 投影层：tool-result 进不来

- `isExperienceEvent`（`experience.ts:203-209`）只收 Skill 加载、follow-up、任务结束。
- `buildFailureCases`（`:77-135`）只产出能归到某个 Skill 的失败。没加载 Skill 的 session 什么也留不下。
- `refreshDerived` 用「Observation 条数 + 最后一个 id + id 指纹」判断要不要重投影（`service.ts:391-406`）。投影规则或注入的判断器换了，这个判断看不出来，不带 `force` 就不会重投影。

### 1.4 提案层：只能改已有 Skill

- `ProposalOperation` 没有新建（`types.ts:131`），`SkillProposal` 上也不记 operation（`types.ts:149-169`）。
- 所有维护用例都假定 Skill 已存在：`proposeSkillChange` 读不到当前版本就报 `stale-base`（`operations.ts:103-107`）；`evaluate` 读不到就抛错（`service.ts:200-201`）；`lifecycle.promoteUnlocked` 的 `assertExpectedBase` 要求当前版本存在（`lifecycle.ts:99`、`:280-285`）。
- 评测对空 Base 不成立：`boundaryHighFailures` 在 Base 文档无效时，直接把所有 high boundary 用例算作 Base 失败（`evaluator.ts:228-235`）。空 Base 永远无效，于是新 Skill 在 boundary 上「不可能比 Base 差」，这项检查形同虚设。
- Publication scope 只校验取值（`service.ts:253`），没有按 Proposal 类型限制；bundle 默认 `project`（`index.js:233`）。scope 目前只写进 manifest、传给 `invalidate`，不改变写入路径：`skillDirectory` 永远是 `<root>/<name>`（`lifecycle.ts:268-270`）。

## 2. 总体形状

```
运行闭环（bundle，DSH 相关）                维护闭环（core，与 DSH 无关）
tool/call ─┐                               tool-result（带摘要）
           ├─ mapToolResult ─ 脱敏 + 摘要 ─▶ Observation log
tool/result┘                                   │ Projection
                                               ▼
                            ToolAttempt ─▶ CorrectionRecognizer（注入 / 规则）
                                               ▼
                                        Correction episode（Derived）──▶ Experience
                                               ▼ 按签名跨 session 聚合（K / N / D）
                                        Correction pattern（Derived）
                                               ▼ 人发起 design --pattern（Designer）
                                        Proposal：create-skill（Base = absent）或 patch-content
                                               ▼ evaluate（original-failure + boundary）→ 人 accept → 人 promote（project / user）
```

新增 module 只有一个：core 的 `correction.ts`（识别、签名、聚合、评测用例草稿）。命令摘要和脱敏规则放进 core 的 `events.ts`，和已有的 `redactSensitiveText` 在一起。bundle 只做 DSH 相关的映射：哪个工具的哪个参数是命令，`[exit code: N]` 标记怎么解析。依赖方向不变（ADR-0014）。

新词条（S2 定稿时写进 `CONTEXT.md`）：

- **Correction episode**：同一 session 里，同一意图的工具调用连续失败 ≥ N 次后成功的一段；引用失败、纠正、成功三类 Observation id。属于 Derived record。
- **Correction pattern**：签名相同的 Correction episode 跨 session 的集合；达到门槛才能成为提案来源。属于 Derived record。
- `CONTEXT.md` 里 **Proposal**「针对一个 Skill」和 **Base**「Proposal 所针对的那一版 Skill 内容」要补一句：Base 可以是「不存在」（ADR-0024）。

## 3. 采集字段与脱敏（成员已确认）

> 这一节改 Observation 格式、放宽采集面，是隐私决策，按票面要求走 `Ask a person and wait`，不按默认答案跳过。决策本身见 ADR-0023。

### 3.1 字段清单

全部是 payload 上的可选字段，平铺，与现有 `toolCallId`、`toolName`、`failed` 同级。`schemaVersion` 仍是 1。

| 事件 | 字段 | 内容 | 上限 | 哪些工具 |
|---|---|---|---|---|
| `tool/call`（kind `agent-step`） | `argKeys` | 参数的顶层键名，不含值 | 16 个，每个 ≤ 64 字符 | 所有普通工具 |
| 同上 | `command` | 命令参数脱敏后的前 16 个 shell token，空格拼接 | ≤ 240 字符 | 只限命令型工具：`bash` 的 `command`、`pwsh` 的 `command`（bundle 内一张映射表） |
| 同上 | `commandTruncated` | `true`，表示 `command` 被截断 | — | 同上 |
| `tool/result`（kind `tool-result`） | `exitCode` | 进程退出码 | 整数 | 命令型工具 |
| 同上 | `signal` | 被信号杀掉时的信号名 | ≤ 32 字符 | 同上 |
| 同上 | `timedOut` | `true` | — | 同上 |
| 同上 | `errorLine` | 报错首行，脱敏、压缩空白后 | ≤ 200 字符 | 失败时才写（见 3.3） |

不采集：

- 完整输出（stdout/stderr 全文）
- bash 的 `description`（模型写的自由文本）
- `workdir`
- 非命令型工具的参数值（文件路径、搜索词、编辑内容）
- `command` / `errorLine` 里 URL 的 query 和 fragment：由 R7 在截断之前换成 `?[REDACTED]` / `#[REDACTED]`（§3.4）
- 密钥类变量的值：变量名命中 R5 的那些

会留在事实里的（`command` 前 16 个 token 以内、`errorLine` 200 字符以内），成员确认的正是这一部分：

- 非密钥类环境变量的值，例如代理地址 `http_proxy=http://10.0.0.1:7890`。userinfo 部分已由 R1 脱敏。
- URL 的 scheme、host、端口和路径，例如 `https://github.com/o/r.git`。
- 命令行里的位置参数和普通 flag 的值：分支名、文件路径、包名等。
- 报错首行里的 host、路径和数字。

`failed` 语义不变，仍然只表示工具报错（`isError` / `data.error`）。「非零退出算不算失败」由投影层的识别器决定（§4），事实里只记退出码本身。理由：事实只记发生了什么，判断放派生层（ADR-0016）；老记录里的 `failed` 也不会被悄悄换了含义。

每条 Observation 因此最多多出约 1 KiB：`argKeys` 约 1 KiB 的极端值，常见情况 300 字节以内。

### 3.2 `command` 怎么截

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. 前 N 个 token（推荐） | 脱敏 → 按 shell 规则分词 → 取前 16 个，每个 token ≤ 64 字符 → 总长 ≤ 240 | 低，分词 + 截断 | 纯函数，表驱动测试 | 事实一旦落盘不能改；截得太短只影响今后的记录 | 无 |
| B. 落盘时就规范化成「命令形状」 | `https_proxy=<url> git push <arg>`，值全换成占位符 | 中 | 同上 | 差：形状规则一改，老事实就和新事实对不上，又不能回写 | 规则每次变更都会让历史失配 |
| C. A + B 都存 | 两份 | 中 | 同上 | 形状部分同 B | 同 B |

推荐 A。形状放到投影层从 `command` 算（§4.3），带识别器版本，规则可以随时改、重投影即生效。代价是事实里会留下 §3.1「会留在事实里的」那几类值，这一点列进待确认项。

### 3.3 `exitCode` 和 `errorLine` 从哪里来

都在 bundle 里取，因为这是 DSH 的格式（ADR-0014）：

1. 事件里有结构化结果（DSH bash 的 `{ kind: 'foreground', exitCode, signal, timedOut }`）就用它。**没核实**这份结构化结果会不会出现在 session 的 `tool/result` 事件上，S3 实现时先确认。
2. 否则解析正文末尾的标记，和 DSH `parseExitStatus`（`packages/shell/shell/src/render.ts:37-43`）同一套正则：`\n[exit code: N]$`、`\n[killed by signal: X]$`，再加 `[timed out after Nms]`。
3. `errorLine`：只在 `failed`、`exitCode ≠ 0`、`signal`、`timedOut` 任一成立时写。先看 `[stderr]` 段，取第一行匹配 `error|fatal|failed|denied|refused|timed out|could not|unable|not found`（不分大小写）的；没有就取 stderr 第一个非空行；stderr 为空时在 stdout 最后 64 行里找匹配行。最多扫 64 行、8 KiB，扫完就丢，不落盘。

例：`fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server`。耗时这类每次都变的数字不在事实里抹掉，签名规范化在投影层做（§4.3）。

### 3.4 脱敏规则

放在哪：

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. 只扩 core 的 `redactSensitiveText`，bundle 删掉自己那份 `redactText` 改为 import（推荐） | 一套规则 | 低 | core 单测覆盖全部规则，bundle 只测「调用了」 | 规则可随时加；已落盘的漏网值不可逆 | bundle 改一个 import |
| B. 两份各自扩 | 维持现状 | 低 | 两份测试，必然走样 | 同上 | 无 |
| C. 引入第三方秘密扫描库 | 规则最全 | 中：新依赖，bundle 要能加载 | 依赖库自己的测试 | 同上 | 增加依赖与体积 |

推荐 A。bundle 本来就 import core（`index.js:391` 已经在用 `redactSensitiveText`），两份规则今天是同一套，合并没有行为差异。

规则按表中顺序执行，每条都幂等：对输出再跑一次，结果不变。「现有 1–3」是今天已有的规则，保留，但排在最后。R1 必须排在现有规则 3 前面，否则会重现 §1.2 里整段 host 被吞的问题。R7 排在第二，URL 里的参数因此在其他规则之前就整段去掉了。

| # | 覆盖 | 匹配（示意，大小写不敏感） | 替换后 |
|---|---|---|---|
| R1 | URL userinfo、带凭据的 remote URL | `<scheme>://<user>[:<pass>]@` | `<scheme>://[REDACTED]@` |
| R7 | URL 的 query 和 fragment（签名 URL、`?access_token=`、`?sig=` 等） | 以 `<scheme>://` 开头的 URL，其中 `?` 之后、到空白或引号为止的内容；`#` 之后同理 | `?[REDACTED]`、`#[REDACTED]`，host 和路径保留 |
| R2 | `Authorization` 等头，含 `-H` / `--header` 的值 | `(proxy-)?authorization`、`x-api-key`、`x-auth-token`、`cookie` 后接 `:`，吃到引号或行尾 | `Authorization: [REDACTED]` |
| R3 | `--token` / `--password` 类参数 | `--(token\|password\|passwd\|pass\|secret\|api-key\|apikey\|auth\|auth-token\|access-token\|client-secret)` 后接 `=` 或空白再跟一个值 | `--token [REDACTED]` |
| R4 | curl 的 `-u` / `--user` | `(-u\|--user)\s+\S+:\S+` | `-u [REDACTED]` |
| R5 | 环境变量赋值里的密钥（含 `export`、`env`） | 只在 shell token 的开头生效：变量名以 `TOKEN`、`SECRET`、`PASSWORD`、`PASSWD`、`PASS`、`KEY`、`AUTH`、`CREDENTIAL(S)`、`COOKIE` 结尾，后接 `=值`。URL 里的 `key=value` 不归它管，已由 R7 整段去掉 | `GITHUB_TOKEN=[REDACTED]` |
| R6 | 已知格式的令牌，不论出现在哪 | `ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_`、`glpat-`、`xox[abp]-`、`AKIA[0-9A-Z]{16}`、`npm_` 加 36 位 | `[REDACTED]` |
| 现有 1–3 | `sk-` key、`Bearer` / `Basic`、`password\|token\|secret` 加 `:` / `=` | 不变 | 不变 |

§1.2 的六个探针在新规则下的期望输出（S2 写成验收用例）：

```
"https_proxy=http://[REDACTED]@10.0.0.1:7890 git push"
"git push https://[REDACTED]@github.com/o/r.git"
"curl -H 'Authorization: [REDACTED]' https://api.example.com"
"mytool --token [REDACTED] --password [REDACTED]"
"GITHUB_TOKEN=[REDACTED] npm publish"
"export NPM_AUTH=[REDACTED]; token=[REDACTED]"
```

URL query / fragment 的探针（R7）。Reviewer 在 `2a442af` 的现有规则上实测，前三条原样保留：

```
"curl \"https://api.example.com/v1?access_token=abc123def\""                        → "curl \"https://api.example.com/v1?[REDACTED]\""
"curl \"https://b.s3.amazonaws.com/o?X-Amz-Signature=deadbeef&X-Amz-Credential=AKID\"" → "curl \"https://b.s3.amazonaws.com/o?[REDACTED]\""
"curl \"https://x.blob.core.windows.net/c?sv=2020&sig=abc%2Fdef\""                   → "curl \"https://x.blob.core.windows.net/c?[REDACTED]\""
"open https://app.example.com/cb#access_token=abc123"                              → "open https://app.example.com/cb#[REDACTED]"
"git clone https://u:p@git.example.com/r.git?ref=main"                             → "git clone https://[REDACTED]@git.example.com/r.git?[REDACTED]"
```

`errorLine` 走同一套规则，报错首行里的 URL 同样去掉 query 和 fragment。

执行顺序：命令先脱敏、再分词截断。反过来的话，截断可能把一个密钥切成两半，两半都匹配不上。落盘前 bundle 仍对整个 payload 跑一遍 `redactRecord`（`index.js:156`），这一遍因为幂等不会改坏已脱敏的值。

已知漏网（不追求完备，写进文档和测试名）：`mysql -pPASS` 这类短参数紧贴值；位置参数里的密码；base64 编码后的凭据；heredoc 正文。`command` 只保留前 16 个 token，限制了这些情况的暴露面。

代理地址本身（`10.0.0.1:7890`）不是凭据，不脱敏，和 §3.1「会留在事实里的」一致。它是 §4 纠正动作和 §8 环境事实的依据。它会不会进入候选正文，由 §6.4 的正文检查挡住。

### 3.5 向后兼容

- 新字段全是可选的，`isObservationValue`（`events.ts:41-53`）不看 payload 内部，老记录、新记录都能读，不迁移。
- 读取方把缺字段当「不知道」。老记录只有 `failed` 没有 `command`，识别器拿不到意图，就不产出片段（§4.2 的规则第 1 步），不会误判。
- 已经落盘的老记录里没有参数，不存在「老记录漏脱敏」的问题。新规则上线前的 follow-up 原文和反馈备注用的是旧规则，本需求不回溯重写（事实 append-only，ADR-0016）；`repair` 也不碰它们。

## 4. 片段识别

### 4.1 输入：ToolAttempt

投影时，按 `correlationIds` 把一条 `agent-step`（tool/call）和对应的 `tool-result` 配成一次 ToolAttempt：

```ts
interface ToolAttempt {
  readonly sessionId: string
  readonly sessionSeq?: number
  readonly callObservationId: string
  readonly resultObservationId?: string   // 没有结果（中断）就缺
  readonly occurredAt: string
  readonly toolName: string
  readonly command?: string                // 来自 §3.1，已脱敏
  readonly argKeys: readonly string[]
  readonly outcome: 'failure' | 'success' | 'unknown'
  readonly exitCode?: number
  readonly errorLine?: string
}
```

`outcome` 在 core 里判：`failed`、`exitCode ≠ 0`、`signal`、`timedOut` 任一成立就是 `failure`；有 `exitCode === 0` 或非命令型工具没 `failed` 就是 `success`；缺结果是 `unknown`。这个判断属于投影规则，改了靠重投影生效（§4.5），不回写事实。

### 4.2 识别器接口

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. 按 session 识别（推荐） | `recognize({ sessionId, attempts }) → EpisodeDraft[]`，一个 session 一次调用 | 低：一个方法，core 负责校验、编号、缓存 | 注入假识别器即可测聚合和重投影；规则识别器用事实夹具测 | 接口在 core 内，暂时只有仓库内调用方，可改 | 无 |
| B. 拆成三个判断 | `sameIntent(a, b)`、`isFailure(a)`、`diff(fail, ok)`，由 core 拼装 | 中：三个 seam、拼装逻辑固定在 core | 单个判断好测，但模型识别器要被切成三次调用 | 同上 | 无 |
| C. 运行时在 bundle 里识别 | 边跑边判 | 高 | 要起 DSH | 违反 ADR-0014，也超出本需求（不做会话内实时纠正） | — |

推荐 A。模型识别器天然看整段 session；B 让模型识别器变成三次调用，失去上下文。

接口形状和 SKIL-125 / SKIL-126 的 follow-up 分类器统一成一个通用形状，放在 core：

```ts
/** 可注入的派生判断：版本是契约，同版本同输入必须同输出。 */
interface DerivedJudge<Input, Output> {
  readonly version: string
  judge(input: Input): Output | Promise<Output>
}

type CorrectionRecognizer = DerivedJudge<{ sessionId: string; attempts: readonly ToolAttempt[] }, readonly EpisodeDraft[]>

interface EpisodeDraft {
  readonly intent: string
  readonly errorSignature: string
  readonly correction: readonly string[]          // 规范化后的纠正动作，见 4.3
  readonly failureObservationIds: readonly string[]
  readonly correctionObservationIds: readonly string[]
  readonly successObservationId: string
}
```

- 注入点：`EvolutionServiceOptions.correctionRecognizer`，和 `evaluationPolicy` 同一处；没注入就用规则识别器 `RULE_CORRECTION_RECOGNIZER`（`version: 'rule-1'`）。bundle 暂不注入模型识别器。
- core 校验每个 draft：引用的 id 都在这个 session 的输入里（ADR-0016 的引用要求），`failureObservationIds.length ≥ N`（§5 的策略值），字段长度有上限。不合格的 draft 丢掉，计入 `metrics.corrections.rejectedDrafts`。识别器抛错时，这个 session 回退到规则识别器，episode 上记 `fallbackFrom`。
- SKIL-126 还没有设计 PR。默认：谁先合并谁定 `DerivedJudge` 的形状，另一方对齐。采用默认答案，成员可推翻。

### 4.3 规则识别器 `rule-1`

1. 只看有 `command` 的 attempt。没有 `command` 的（老记录、非命令型工具）跳过，不产出。
2. **意图**：把 `command` 按 `&&`、`||`、`;`、`|` 切段，取最后一段；去掉前导的 `VAR=值` 赋值和 `sudo`、`env`、`command`、`time` 前缀；取程序名加第一个不以 `-` 开头的参数，并跳过已知带值的全局选项的值（`git -C <dir>`、`git -c <k=v>`、`npm --prefix <dir>`、`make -C <dir>`、`docker --context <c>`）。`https_proxy=http://… git push origin main` → `git push`；`git -C repo push` → `git push`。
   已知限制（S2 列入 spec）：`bash -c "…"`、`sh -c`、`eval` 这类只取到外层程序，不拆内层命令；`npx <pkg>`、`pnpm dlx <pkg>` 取到的是包名，同一个工具的不同调用方式会分成不同意图。这些是投影层规则，升级识别器版本、重投影就能改，不影响事实。
3. **片段**：同一 session 里按 `sessionSeq`（没有时按 `occurredAt`）排序。同一意图累计失败 ≥ N 次，之后 20 次 attempt 以内出现同意图的成功，就构成一段。中间夹着别的意图的调用不打断计数。
4. **报错签名**：取最后一次失败的 `exitCode` 和 `errorLine`，规范化成 `exit:<n>|<line>`，≤ 160 字符。规范化步骤：转小写；URL 只留 `scheme://host[:port]`；引号内的内容换成 `<q>`；`after N ms`、时间戳、7 位以上十六进制、UUID 换成占位符。端口号和退出码保留，它们正是区分信号的地方。上例得到 `exit:128|fatal: unable to access <q>: failed to connect to github.com port 443 after <n> ms: couldn't connect to server`。
5. **纠正动作**：对比最后一次失败和成功那次，再加上两者之间成功的其他意图调用，只提取名字，不取值：
   - 成功那次多出来的环境赋值 → `set-env:https_proxy`（变量名转小写）
   - 多出来的 flag → `flag:--force-with-lease`
   - 多出来的前置段和中间调用 → `run:git config http.proxy`（意图，加 `config` 类子命令的第一个键）

   排序、去重后得到纠正动作。都为空时是 `retry`。
6. **环境性**：纠正动作里有 `set-env:*proxy*`、`run:git config http.proxy`、`run:npm config proxy` 这类，或者任意 `set-env:`，就标为 `environmental: true`。

签名 = `hash(intent, errorSignature, correction)`。签名里只有名字和规范化后的报错，没有任何值，所以代理地址进不了签名。

### 4.4 输出：Correction episode

新 derived store `episodes`（`state-root.ts:51-61` 的列表里加一行，`role: 'derived'`）：

```ts
interface CorrectionEpisode extends EpisodeDraft {
  readonly id: string                    // `episode:<sessionId>:<第一条失败的 observation id>`
  readonly sessionId: string
  readonly taskId?: string
  readonly signatureKey: string
  readonly environmental: boolean
  readonly retryOnly: boolean
  readonly loadedSkills: readonly string[]   // 这个 session 里加载过的 Skill，供 §6.2 判断
  readonly occurredAt: string                // 成功那次的时间
  readonly recognizerVersion: string
  readonly fallbackFrom?: string
  readonly inputHash: string                 // 这个 session 的 attempts 的哈希
  readonly createdAt: string
}
```

每个 episode 同时产出一条 Experience（`experience:correction:<episode id>`）：`attribution: 'tool'`，`taskCluster` 取意图，`observedPattern` 为 `self-correction: <intent> | <errorSignature> → <correction>`，`evidenceEventIds` 是全部引用的 id，`relevantSkillVersions` 取 `loadedSkills`。这条路径不依赖 Skill 加载，没加载 Skill 的 session 也能留下 Experience。`buildFailureCases` 不变，episode 不冒充 Failure case（后者按定义必须能归到某个 Skill）。

### 4.5 重投影

- 投影 cursor（`state-root.ts:21-25`）加一个 `judges` 字段，记下各注入判断的版本和策略版本：`{ correction: 'rule-1', correctionPolicy: '1' }`。和上次不一致就全量重投影，不需要 `force`。老 cursor 没有这个字段，当作不一致，首次升级后重投影一次。
- 模型识别器的缓存：`inputHash` 和 `recognizerVersion` 都没变的 session 直接复用上次的 episode，不再调识别器。这就是 SKIL-125 说的「版本 + 输入哈希」确定性。
- episode 和 pattern 都是 derived，删掉可以重建（ADR-0002）；不写回 Observation（ADR-0016）。

## 5. 聚合门槛

### 5.1 策略放在哪

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. `CorrectionPolicy` 对象，走 `EvolutionServiceOptions.correctionPolicy`，形状仿照 `EvaluationPolicy`（推荐） | 带 `version`，默认值在 core 常量 `DEFAULT_CORRECTION_POLICY` | 低 | 测试直接传策略 | 可逆，改默认值只是改常量 | 无 |
| B. 状态根下的配置文件 `.skill-evolution/policy.json` | 用户可改，不用重新打包 | 中：要定文件格式、校验、热更新 | 要读文件 | 文件格式一旦发布就要兼容 | 新增一种持久化格式 |
| C. 写死常量 | 最简单 | 最低 | 测试没法换门槛 | — | 以后改成 A 要动接口 |

推荐 A。bundle 的 `config` 可以把用户配置透传进来（今天的 `config.invalidate` 就是这么传的），文件格式留到有人真要改时再说。

### 5.2 默认值

```ts
const DEFAULT_CORRECTION_POLICY = {
  version: '1',
  minFailures: 2,          // N：同意图连续失败 ≥ 2 次才算一段
  minSessions: 3,          // K：≥ 3 个不同 session
  windowDays: 30,          // D：只数最近 30 天（按 episode.occurredAt，相对读取时传入的 now，见 5.3）
  maxAttemptsToSuccess: 20,
  allowedScopes: ['project', 'user'],   // §6.5
}
```

取值理由（采用默认答案，成员可推翻）：

- N = 2。模型失败一次就换做法很常见，这种情况留作 Experience 足够。连续两次同样的失败才说明模型自己并不知道这件事。票面例子是 3 次，N = 2 能覆盖。
- K = 3。1 次可能是偶然，2 次可能是同一天的同一个任务；3 个不同 session 才像一个会反复出现的问题。成本侧：凑够 3 次才提案，最多再浪费两次纠正。
- D = 30。环境事实会过期（代理撤了、网络换了）。超过 30 天的 episode 不参与计数，但仍保留在 `episodes` 和 Experience 里。
- `retryOnly` 的 episode（纠正动作只有 `retry`）永远不进候选：它们说明的是网络抖动，不是可以学的做法。

### 5.3 Correction pattern

新 derived store `patterns`，投影时按 `signatureKey` 对 episode 分组。**只存和时间、Skill root、台账都无关的字段**：

```ts
interface CorrectionPattern {
  readonly id: string                 // `pattern:<signatureKey 前 16 位>`
  readonly signatureKey: string
  readonly intent: string
  readonly errorSignature: string
  readonly correction: readonly string[]
  readonly environmental: boolean
  readonly retryOnly: boolean
  readonly occurrences: readonly { readonly episodeId: string; readonly sessionId: string; readonly occurredAt: string }[]
  readonly totalSessionCount: number  // 全部 occurrence 的不同 session 数
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly policyVersion: string
}
```

窗口计数和「是不是候选」都不存。`refreshDerived` 在 Observation 不变时直接返回旧结果（`service.ts:396`），而 cursor 里没有时间，所以存下来的窗口计数在 30 天没有新事实时会一直不变，已经过期的 pattern 仍然是候选。改成读取时现算：

```ts
function assessPattern(input: {
  pattern: CorrectionPattern
  policy: CorrectionPolicy
  now: string                                  // 调用方传入；bundle 取当前时间，测试固定
  proposals: readonly SkillProposal[]          // 来自这个 pattern 的提案（source.patternId）
}): {
  since: string                                // 计数起点：max(now − D, 最近一次 promote 的时间)；promote 时间取台账里 promoted 记录的 updatedAt
  windowSessionCount: number                   // since 之后的不同 session 数
  candidate: boolean                           // windowSessionCount ≥ K 且不是 retryOnly 且没有进行中的提案
  blockedBy?: { proposalId: string; status: ProposalStatus }   // 进行中的提案
  promotedSkill?: string                       // 最近一次 promote 发布的 Skill 名
}
```

`design`、`failures`、`metrics` 都调用这一个纯函数，不读存下来的判断。门槛只有这一处实现，「超出 D 天后不再是候选」和「promote 之后重新计数」（§6.3）都在这里成立。

「新建还是补丁到哪个 Skill」（§6.2）同样不存进 pattern。它取决于 Skill root 里现有哪些 Skill，而 Skill root 的变化不经过 Observation，投影 cursor 看不见，存进去就会过期。这个目标在 `failures` 渲染和 `design` 时现算。

所有 pattern 都写进 store，不管到没到门槛，给人看。能不能作为 `design` 的来源，只看 `assessPattern(…).candidate`。

### 5.4 在 `failures` / `metrics` 里可见

- `failures` 的 Markdown 报告（`report.ts` 的 `renderFailuresMarkdown`）在现有按 cluster 分组的内容后面加一节「自我纠正」：每个 pattern 一行，列出意图、报错签名、纠正动作、`windowSessionCount / K`、计数起点、是否候选（没成为候选时写原因：未到门槛、只是重试、或被哪个提案挡住）、目标（新建，或补丁到哪个 Skill）。这些都在渲染时按当前时间用 `assessPattern` 现算。报告头写出策略版本、K / N / D 和计算用的 `now`。
- `metrics`（`EvolutionMetrics`）加一段：

```ts
corrections: {
  policy: { version, minFailures, minSessions, windowDays },
  recognizer: { version, fallbacks },
  episodes: number,
  patterns: number,
  candidates: number,      // 按 metrics 调用时的 now 现算（assessPattern），不读缓存
  rejectedDrafts: number,
}
```

- `observe` 的输出加 `episodes`、`patterns` 两个计数。

## 6. `create-skill` 提案与发布范围

### 6.1 Base = absent 怎么表示

决策本身见 ADR-0024。

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. 哨兵值（推荐） | `SkillProposal` 加可选 `operation`；`create-skill` 时 `baseVersion: 'absent'`，`expectedBase.contentHash: 'absent'`。`AdoptionBase` 类型不变 | 低：每处 Base 检查加一个分支 | 每处分支都能单测 | 写进台账后不可改（ADR-0024） | 老记录没有 `operation`，按「改已有 Skill」读，不迁移 |
| B. `AdoptionBase` 改成判别联合 `{ name, absent: true } \| { name, contentHash }` | 类型更准确 | 中：所有读 `contentHash` 的地方都要先收窄类型 | 编译器帮忙找遗漏 | 同上 | 老记录要在读取时补 `absent: false` |
| C. `expectedBase` 可选，缺省即不存在 | 改动最少 | 低 | 差：`options.expectedBase ?? proposal.expectedBase`（`lifecycle.ts:97`）里「没传」和「不存在」混在一起 | 同上 | 无 |

推荐 A。`'absent'` 不可能与 sha256 十六进制串相等，不会误配。`operation` 与哨兵必须互相印证：`operation === 'create-skill'` 当且仅当 `expectedBase.contentHash === 'absent'`，`createProposal` 和读取时都校验。

空 Base 在 §1.4 列出的每处检查里的新行为：

| 位置 | 今天 | Base = absent 时 |
|---|---|---|
| `design` / `proposeSkillChange`（`operations.ts:103-107`） | 读不到当前版本 → `stale-base` | 反过来：读到了（有人同名建了）→ `stale-base`，提示重新 `design` 得到 `patch-content` |
| `service.evaluate`（`service.ts:200-201`） | 读不到就抛错 | 要求读不到；`baseContent = ''` |
| `requireEvaluationArtifact`（`service.ts:291-303`） | 要求当前 hash 等于 Base hash | 要求当前仍不存在，artifact 的 `baseContentHash === 'absent'` |
| `precheckPromotion`（`operations.ts:265`） | `validateSkillCandidate(current.content, …)` | `validateSkillCandidate('', …)`（`evaluator.ts:175-194` 已经容忍空 Base） |
| `assertExpectedBase`（`lifecycle.ts:280-285`） | 当前必须存在且 hash 相等 | 当前必须不存在 |
| `promoteUnlocked`（`lifecycle.ts:116-152`） | 目录已存在 | 先 `mkdir` Skill 目录；manifest 不写 `parentVersion` |

同名并发：两个 `create-skill` 都指向 `git-network-proxy`，第一个 promote 后，第二个在发布锁（`lifecycle.ts:227-242`）内的 `assertExpectedBase` 读到当前已存在，报 stale base。不需要新锁。

`create-skill` 发布后的回滚：只有一个版本，没有可回退的目标。本需求不支持「回滚到不存在」，要撤掉走已有的 `retire`。采用默认答案，成员可推翻。

### 6.2 命中已有 Skill 时走 `patch-content`

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. 确定性规则 + 人工覆盖（推荐） | 见下 | 低 | 纯函数 | 可逆，规则在 core 里 | 无 |
| B. 交给 Designer 判断 | 模型决定新建还是补丁 | 低 | 差：要 mock 模型 | 可逆 | Designer 输出格式要多一个字段 |
| C. 只按名字 | Designer 起的名字已存在就补丁 | 最低 | 好 | 可逆 | 无 |

推荐 A。按顺序判断，第一条命中就停：

0. 这个 pattern 有过 `promoted` 的提案（`assessPattern(…).promotedSkill`），而且那个 Skill 仍然存在：`patch-content` 这个 Skill。发布之后还在犯同样的错，要么是 Skill 没被加载（描述、触发条件的问题），要么是加载了但做法不够，两种都该改它，不该再建一个。
1. 人给了 `--skill <name>`：这个 Skill 存在就 `patch-content`，不存在就 `create-skill` 并用这个名字。
2. pattern 里过半的 episode 加载过同一个 Skill（`loadedSkills`）：`patch-content` 这个 Skill。它在上下文里，模型还是犯了错，说明它缺这一段。
3. pattern 的词（意图的词加报错签名的 host）和某个 Skill 的名字、描述的词做 Jaccard（复用 `portfolio.ts` 的切词），最高分 ≥ 0.5：`patch-content` 这个 Skill；前两名分数相同就报 `ambiguous-target`，要求带 `--skill`。
4. 都不命中：`create-skill`，名字由 Designer 起（kebab-case，写在候选正文的 frontmatter `name`），必须不与现有 Skill 重名。

判断结果和理由（第几条规则、分数）写进 Proposal 的 `source.targetReason`，报告里可见。

### 6.3 提案怎么发起

沿用 SKIL-104 定下的 `design` 子命令形状，加一个来源：

```
/skill-evolution design --pattern <id> --proposed-version <v> [--skill <name>] [--id <id>] [--output <path>]
```

`--pattern` 和 `--cluster` 二选一。core 用例 `designFromPattern(service, { patternId, designer, proposedVersion, skillName? })`，所有前置检查都在起子代理之前做，失败不落任何东西（SKIL-104）：

1. pattern 存在，并且 `assessPattern({ pattern, policy, now, proposals }).candidate` 为真（§5.3）。
   - 没有进行中的提案、只是没到门槛时，报 `insufficient-evidence`，写出 `windowSessionCount / K` 和计数起点 `since`。这就是「门槛没过不能提案」。
   - 有进行中的提案时，报 `already-proposed`，给出它的 id 和状态。
2. 按 6.2 定目标。
3. 调 Designer，校验输出（`validateSkillDocument`、6.4 的环境值检查），通过后 `createProposal` 并转到 `proposed`，停在这里。

同一个 pattern 上的提案按状态分三类：

| 状态 | 算作 | 对这个 pattern 的影响 |
|---|---|---|
| `draft`、`proposed`、`evaluating`、`evaluated`、`replayed`、`observed`、`accepted`、`deferred` | 进行中 | 挡住新提案（`already-proposed`）。`deferred` 也算，想重新提案的人先 reject 它 |
| `promoted` | 已发布 | 不挡。计数起点移到这次 promote 的时间，只有发布之后新出现的 episode 才计入 K；目标按 6.2 规则 0 改成补丁这个 Skill |
| `rejected`、`rolled-back`、`reverted` | 已结束 | 不挡，计数起点不变 |

所以 `create-skill` 发布之后，要再积累 K 个 session 的同样错误，才会出现一个补丁这个新 Skill 的 `patch-content` 候选。这个 pattern 不会被永久挡住，也不会因为发布前的老 episode 马上又成为候选。
`DesignerInput` 改成判别联合，`{ source: 'cluster', … }` 维持现状，新增：

```ts
{
  source: 'pattern'
  operation: 'create-skill' | 'patch-content'
  skillName?: string            // patch-content 时是目标，create-skill 时是 --skill 给的名字
  baseContent?: string          // patch-content 时的当前正文
  pattern: CorrectionPattern
  episodes: readonly CorrectionEpisode[]    // 最多 5 条，最近的优先
  attempts: readonly ToolAttempt[]          // 这些 episode 引用的 attempt，只含已脱敏的摘要字段
}
```

Designer 拿到的全部是已脱敏的派生字段，没有完整输出，因为事实里本来就没有。

`SkillProposal` 新增的可选字段：`operation`、`source: { kind: 'pattern', patternId, signatureKey, episodeIds, targetReason }`。`evidenceEventIds` 填 episode 引用的 observation id。台账和转移表：`create-skill` 走现有的同一张表（`proposal.ts:24-37`），不加状态，不加转移，ADR-0004 不受影响。record id 按 ADR-0021（`<root>:<status>`，重复进入同一状态时是 `<root>:<status>:<n>`），通过 ADR-0021 设计的 `ProposalLedger.transition`（`docs/design/proposal-ledger-transition.md`）写入。ADR-0021 已经 `accepted`，但 `ledger.ts` 还没实现（`6accc8b` 上没有这个文件，实现在 SKIL-121 后续阶段），所以 S3 的第 3 张要排在 SKIL-121 的实现之后。

### 6.4 候选正文不写死环境值

分两层：

- **Designer 的指令**（S2 写进 Designer 提示）：写成条件化的做法，比如「网络命令在 443 上连接失败时，先检查 `https_proxy` 等环境变量和 `git config --get http.proxy`；都没有就问用户要代理，不要盲目重试」。不写地址、主机名、端口、用户名。
- **确定性检查** `assertEnvironmentNeutral(candidate, attempts)`，在 `design` 落盘前和 `promote` 预检时各跑一次，不过就拒绝（`design` 时是 `designer-failed`，不落盘）。以下任一出现在候选正文里就不过：
  - attempts 的 `command` 里环境赋值的值，和其中 URL 的 host、端口
  - `errorLine` 里的 host，除非它就是公共服务名、也是意图的一部分（例如 `github.com`）。这类 host 的白名单 S2 定，默认空。
  - IPv4 / IPv6 字面量
  - `[REDACTED]` 本身，说明 Designer 抄了命令原文
  - `:<数字>@`、`://…@` 这类带 userinfo 的 URL

「条件化」这件事本身没法用词法可靠地判断。它靠 Designer 指令、boundary 用例（§7）和人工 accept 兜住，这里不假装能自动检查。

### 6.5 发布范围

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. `CorrectionPolicy.allowedScopes`，在 core 的 `promoteProposal` 里查（推荐） | 默认 `['project', 'user']` | 低 | 单测 | 可逆：放宽就是换一份策略（新 `version`） | 无 |
| B. design 时在 Proposal 上写 `maxScope` | 每个 Proposal 自带上限 | 低 | 单测 | 写进台账后，老 Proposal 不随策略变化 | 新字段 |
| C. 只在 bundle 里查 | — | 低 | 要起 bundle | 可逆 | 其他调用方（CLI）绕得过去，违反 ADR-0006 |

推荐 A。适用于 `operation === 'create-skill'`，以及 `source.kind === 'pattern'` 且 pattern `environmental` 的 `patch-content`。不在范围内的 scope（`stable`，也包括 `explicit-only`）一律报 `scope-not-allowed`，信息里写出当前策略版本和允许的取值。`promote --dry-run` 也会报这个错，所以不会出现「预检通过、真发布被拒」的情况。

**已知缺口**（不在本需求内修，提出来给成员）：scope 今天不改变写入路径，`project` 和 `user` 都写到 `<root>/<name>`（`lifecycle.ts:268-270`）；而 DSH 实际从 `<project>/.dsh/skills` 和 `~/.dsh/skills` 分两处读（DSH `packages/skill/skill-filesystem/src/index.ts:246-254`）。所以「发到 `user`」目前只是 manifest 上的一个标签。本需求只保证拒绝 `stable`；让 `user` 真的写到用户级目录，建议 S2 定稿时另立一张票。

## 7. 评测与人工发布

### 7.1 用例从哪里来

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| A. core 生成草稿，人补齐后照常 `evaluate --cases`（推荐） | `design --pattern` 同时写出 `<proposal root>.cases.json` 草稿 | 低 | 纯函数 | 可逆 | 无，`evaluate` 接口不变 |
| B. `evaluate` 直接从 pattern 生成用例 | 少一步 | 中：`evaluate` 要认识 pattern | 同上 | 可逆 | `evaluate` 多一个来源 |
| C. 全部人写 | — | 最低 | — | — | 重放信息丢失 |

推荐 A。草稿内容：

- **original-failure**：每个 episode 一条（最多 5 条）。`task` 是那次失败时的意图加脱敏后的命令加报错签名，比如「在本仓库执行 `git push origin main`；上次报 `exit:128|… port 443 …`」。`expected.contains` 写纠正动作对应的检查（`https_proxy` 或 `http.proxy`），`expected.excludes` 写 `[REDACTED]`。
- **boundary**：固定 3 条，`severity: high`，意图相同但与网络无关的失败，以及不相关的任务。例如「`git push` 被拒，原因是 non-fast-forward」「`git status`」「`npm test`」。`expected.excludes` 写 `proxy`，确保新 Skill 不会在这些场景下把模型引向代理。
- 草稿开头写明需要人工确认，DSH 评测的 `task` 是自然语言，重放的真实性靠人检查。

### 7.2 空 Base 让评测失效，要修

- **baseline**：Base 为空时，原 `evaluateCandidate` 把 baseline 的每条用例都记为「Base 无效 → 未通过」（`evaluator.ts:64-66`）。对 original-failure 这是对的：没有这个 Skill 的时候，模型确实会失败。但对 boundary 不对：§1.4 已经说明，这会让「新增 high boundary 失败」这项检查失效。
- **改法**：Base = absent 时，baseline 跑一次「没有这个 Skill」的对照，而不是记为失败。core 的 `EvaluationRunner` 签名不变，给 `runner('', case)` 传空内容；DSH 评测 adapter（`packages/dsh-adapter/src/evaluator.ts:120-137`）收到空内容时不写 `SKILL.md`。`boundaryHighFailures` 对空 Base 同样真跑，不再直接返回用例总数。
- **invocation policy**：空 Base 的 invocation policy 是 `{}`。候选只要写了 `disable-model-invocation` 之类的键，就会被判为「invocation policy changed」。`create-skill` 改成要求候选不写这些键（用默认策略）。要写的话，必须由人在 accept 前手工改。
- 门槛本身不变：original-failure 必须比 baseline 多过（`requireOriginalFailureImprovement`），high boundary 不能比 baseline 多失败。

### 7.3 人工发布约束

- 顺序不变：`proposed → evaluating → evaluated → accepted → promoted`，`promote` 要求 `accepted`（`operations.ts:161`），`accepted` 只能从 `evaluated`（或 `replayed` / `observed`）进入（`proposal.ts:24-37`）。
- accept 只有人通过 `/skill-evolution accept` 发起。识别器和 Designer 的接口都只返回数据，拿不到 `EvolutionService`，没有调用 accept 或 promote 的路径。S3 加一条架构测试：`correction.ts` 不 import `service.ts`、`operations.ts`、`lifecycle.ts`。
- 门槛不过不能 accept：`acceptProposal` 今天只查转移表，不查 `passedGate`（`service.ts:238-245`）。一个 `evaluated` 但 `passedGate: false` 的提案现在就能 accept，只有到 promote 时才被 `service.ts:257` 拦下。票面要求「门槛没过不能 accept」，所以对 `source.kind === 'pattern'` 的提案，accept 也要读最新的 evaluation artifact，`passedGate` 为 false 就报 `gate-failed`。
  - 其他提案保持今天的行为，因为扩到全部提案会改变现有的行为：没过门槛也能 accept，等 promote 时再拦（包括走 `replayed` / `observed` 路径、没有 artifact 的提案）。这超出本需求。采用默认答案，成员可推翻。
- 发布范围见 6.5。

## 8. Skill、memory、workflow 的边界

需要成员拍板的业务判断。结论：**「这台机器需要代理」这类环境事实不进 Skill，Skill 里只写条件化的做法。**

| 内容 | 放在哪 | 例子 |
|---|---|---|
| 做法：遇到什么信号、先查什么、怎么判断 | Skill（本需求的产物） | 「443 连接失败时先查 `https_proxy` 和 `git config http.proxy`；都没有就问用户，不要盲目重试」 |
| 环境事实：这台机器、这个项目的具体值 | 项目配置或用户配置，不在本系统里 | 代理地址写进 `~/.gitconfig` 的 `http.proxy`、shell profile 或项目 `AGENTS.md`（DSH `packages/context/agent-instructions` 会加载） |
| 固定的多步流程 | workflow / 命令脚本 | 「发布前先 build、再 test、再 push」 |

理由：

- 环境值随机器变，会过期，还可能带凭据。放进会被复用、会被发布的 Skill，就会把一台机器的事实带到另一台机器上，也违背票面「不写死环境值」的要求。
- 做法在不同机器上都成立。代理撤了的机器上，这个 Skill 查一遍、发现没有代理需求就继续，代价很小。
- 本系统不写项目配置，也不写 memory：那是运行时行为，属于「在会话内改变运行时行为」，不在本需求内。候选正文可以建议用户把代理写进 `http.proxy`，但不能替用户写。
- 边界靠 §6.4 的确定性检查和人工 accept 两道把关。

默认答案：按上表执行，本需求不新增 memory 通道。成员可推翻，比如要求把环境事实也作为一类产物输出给人看。

## 9. 父 issue 的五条验收在设计上怎么成立

夹具（S2 写成测试数据）：一个 session 里依次有三次 `git push origin main`，都是 `exit 128` 加 443 报错；然后 `https_proxy=http://alice:s3cretpw@10.0.0.1:7890 git push origin main`，`exit 0`。session 里没有加载任何 Skill。K 份这样的 session，`sessionId` 各不相同，都在 30 天内。

| 验收 | 怎么成立 | 落在哪 |
|---|---|---|
| 1 个 session 只产生 Experience，K 个 session 产生 `create-skill` 候选 | 规则识别器产出 1 个 episode（3 次失败 ≥ N = 2）和 1 条 Experience；`assessPattern` 得到 `windowSessionCount = 1 < K = 3`，不是候选，`design --pattern` 报 `insufficient-evidence`。K 份夹具时是候选，因为 `loadedSkills` 为空、没有 Skill 的词能匹配上，6.2 判到规则 4，`design` 用假 Designer 得到 `operation: 'create-skill'`、`expectedBase.contentHash: 'absent'`、停在 `proposed` | §4.3、§5.2、§6.2、§6.3 |
| 候选和所有产物里没有代理凭据 | bundle 在落盘前按 R1 把 userinfo 换成 `[REDACTED]`，事实里没有 `alice` 和 `s3cretpw`；此后所有派生记录和产物（episode、pattern、Experience、Designer 输入、Proposal、用例草稿、报告）都只从事实派生，所以都没有。候选正文另过 §6.4 检查，代理 host `10.0.0.1` 和端口 `7890` 也不能出现。测试对状态根下的每个文件和 bundle 的每个输出 grep 这两个值 | §3.4、§6.4 |
| promote 到 `stable` 被拒 | `promoteProposal` 查 `CorrectionPolicy.allowedScopes`，`stable` 报 `scope-not-allowed`，`--dry-run` 同样报 | §6.5 |
| 没经 accept 不能 promote | 现有 `operations.ts:161` 和转移表保证；另加 accept 读 `passedGate`，没过门槛也不能 accept | §7.3 |
| 换识别器后重投影，结果随之改变 | 注入一个 `version: 'fake-1'`、永远返回空的识别器 → cursor 的 `judges.correction` 从 `rule-1` 变成 `fake-1` → `refreshDerived()` 不带 `force` 就重投影 → `episodes` 和 `patterns` 被清空，`metrics.corrections.recognizer.version === 'fake-1'`，观测数不变 | §4.5 |

第 1 条验收补两条相关用例：

- **过期**：K 份夹具都放在 `now` 之前 31 天。`refreshDerived()` 之后不写任何新事实，直接调 `design --pattern`，报 `insufficient-evidence`，`windowSessionCount = 0`；`failures` 和 `metrics.corrections.candidates` 都显示不是候选。对照组把 `now` 移回 29 天前，就是候选。这证明窗口判断不依赖投影缓存（§5.3）。
- **发布后**：K 份夹具产生的 `create-skill` 被 promote 之后，同一个 pattern 立刻不是候选（发布后新 episode 数为 0，不报 `already-proposed`）。再写入 K 份发布之后的夹具，它重新成为候选，`design` 判到 6.2 规则 0，得到 `patch-content` 这个新 Skill（§6.3）。

## 10. seam 与变化频率

| seam | 会被什么拉扯 | 为什么放这里 |
|---|---|---|
| `CorrectionRecognizer`（core，可注入） | 最常变：签名规则、意图切分、以后换成模型识别器 | 变化只影响派生，靠版本和重投影吸收；测试只需注入假实现 |
| bundle 的命令型工具映射表 + 退出标记解析 | DSH 改工具名、改输出格式 | 这是 DSH 的格式，按 ADR-0014 只放 bundle；core 拿到的永远是 `exitCode` / `errorLine` |
| `redactSensitiveText`（core） | 新的凭据格式 | 一处改、全部生效；幂等，重复执行安全 |
| `CorrectionPolicy`（core） | K / N / D、允许的 scope | 带版本，改了进 cursor，触发重投影 |
| `Designer` 的 `source: 'pattern'` 分支 | 提示词和候选格式 | 已有 seam，SKIL-104 定形，这里只加一个输入分支 |

不开的 seam：没有给「命中已有 Skill」的规则开注入点（§6.2）。它依赖 portfolio 切词，变化少；以后需要时再按同一个 `DerivedJudge` 形状开出来。

## 11. 不可逆决策

- ADR-0023：tool-call / tool-result 的 Observation 增加脱敏后的命令摘要和报错签名字段，`schemaVersion` 不变。
- ADR-0024：`create-skill` 提案用哨兵值 `'absent'` 表示空 Base，自我纠正片段作为不绑定 Skill 的 Derived record 单独存放。

编号：`origin/main`（`63d2007`）当前最大是 0022（SKIL-134 的 failure case 来源与 cluster id），所以本 PR 用 0023、0024。两条都依赖 ADR-0021（`accepted`）的 record id 规则，但不与它冲突。与现有 ADR 没有冲突：ADR-0014（依赖方向不变）、ADR-0016（episode 是派生的，引用 observation id，不回写）、ADR-0004（转移表不加状态）。

## 12. 给 S2 / S3 的拆分建议

ADR-0021 已经 `accepted`，S2 spec 可以直接定稿，不用再等。S3 可以拆成三张，前两张互不依赖：

1. **采集与脱敏**（bundle + `events.ts`）：§3 全部；bundle 删掉 `redactText`；六个探针和各条规则的表驱动测试；bash 退出标记解析测试。
2. **识别与聚合**（`correction.ts`、`state-root.ts`、`service.ts` 的投影、`metrics.ts`、`report.ts`）：§4、§5；验收 1 的前半和验收 5。
3. **create-skill 与发布**（`types.ts`、`proposal.ts`、`operations.ts`、`service.ts`、`lifecycle.ts`、`evaluator.ts`、`dsh-adapter` 评测、bundle 的 `design --pattern`）：§6、§7；验收 1 的后半、2、3、4。依赖第 2 张和 SKIL-121 的 `ProposalLedger` 实现。

验证方式：每张都跑 `npm --prefix packages/skill-evolution test` 和 bundle 的测试，全部通过；第 3 张另跑一条端到端夹具，从事实写入一直到 promote 到 `project`，中间 `stable` 被拒。

## 13. 待定项

- **成员已确认（2026-10-03）**：§3 的采集字段清单和脱敏规则 R1–R7（ADR-0023）；空 Base 的表示和新增派生 store（ADR-0024）。两条 ADR 都已改为 `accepted`。
- **业务判断（采用默认答案，成员可推翻）**：§8 的 Skill / memory / workflow 边界；§5.2 的 K = 3、N = 2、D = 30；§6.1 不支持回滚到不存在；§6.2 的目标判断规则（含规则 0：发布过的 pattern 改为补丁这个 Skill）；§6.3 进行中的提案（包括 `deferred`）挡住新提案，promote 后重新计数；§7.3 accept 查门槛只对 pattern 来源生效；§4.2 `DerivedJudge` 的形状和 SKIL-126 谁先合并谁定。
- **没核实**：DSH 的 session `tool/result` 事件上会不会带 bash 的结构化结果（§3.3 第 1 步）；没有它也能用标记解析，所以不影响设计。
- **范围外、建议另立票**：scope 真正改变写入路径（§6.5 的已知缺口）。

