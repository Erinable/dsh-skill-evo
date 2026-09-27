# Designer 子代理的后端与只读工具集

> SKIL-102（SKIL-96 调研票）。查证日期 2026-09-27。
> 一手来源：DeepSeek Harness 源码 [`deepseek-ai/deepseek-harness@477b4f4`](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)，与 [SKIL-99 调研](dsh-plugin-service-topology-zh.md)是同一个提交。本仓库代码固定在 [`Erinable/dsh-skill-evo@5f027b1`](https://github.com/Erinable/dsh-skill-evo/tree/5f027b1ddb5f484dfe8aa649b65fa217c0781045)。所有行号都在这两个提交的本地克隆上核对过。
> 标注说明：【明说】表示源码或注释原文就这么写；【推断】表示从源码推出，没有运行验证；【查不到】表示已写明查过哪些地方。
> 范围：只回答「能不能、怎么收窄、怎么取回、怎么失败」。选哪个后端、`DesignerInput` 怎么变成子代理上下文，不在本文范围内。

## 结论

1. **能不能「构造上只读」：能，但只有一条路，而且只对 `spawn`/`fork` 两个进程内 provider 成立。**
   - 【明说】`subagents.start(name, request)` 的请求里有 `toolFilter: { allow?, deny? }`。进程内后端会在子代理创建窗口里，把它作为该子代理 scope 上的 `tools.restrict()` 套上。被滤掉的工具既从 prompt 里消失，也拒绝执行（[types.ts L186-193][sa-req-filter]、[child-agent.ts L200-219][child-compose]）。
   - 【明说】只有 `spawn` 和 `fork` 声明了 `toolFilter` 能力（[spawn][cap-spawn]、[fork][cap-fork]）。`acp`、`claude-code`、`codex`、`dsh-sdk` 都不支持（[acp][cap-acp]、[NO_START_CAPABILITIES][cap-none]、[dsh-sdk][cap-sdk]）。给它们传 `toolFilter`，`start()` 会同步抛出 `UNSUPPORTED_CAPABILITY`（[index.ts L644-660][sa-assert]），不会静默忽略。
   - 【明说】`workflowEngine.start` 这条路**做不到**。`agent()` 只接受 `label/phase/schema/provider/model` 这几个选项，其它键直接报 `UNSUPPORTED_OPTION`（[runtime.ts L33-35][ptc-opts]、[L252-258][ptc-opts-check]）。宿主转给 `subagents.start` 的也只有 `prompt/parent/signal/outputSchema/agentOptions{provider,model}`，从来不传 `toolFilter`（[host.ts L197-211][ptc-host-start]）。`WorkflowStartRequest` 本身也没有工具过滤字段（[runtime-types.ts L19-34][wf-req]）。
   - 【推断】所以如果 Designer 必须只读，`workflowEngine.start` 作为 Designer 的后端，在 477b4f4 上不满足「构造上只读」。
2. **不收窄时子代理默认拿到什么。**
   - 【明说】子代理通过 `agentPresets.composeFrom(childCtx, parent.ctx)` 加入**父代理那一份 preset**（[child-agent.ts L204][child-compose]、[agent-preset-registry L268-283][preset-compose]），因此继承父代理能看到的全部工具。
   - 【明说】模型路由默认也继承：provider、model、reasoningEffort、maxTokens 都取父代理的值，请求里给了哪项就覆盖哪项（[child-agent.ts L99-120][child-opts]）。
   - 【明说】审批策略被钉成 `never`，需要审批的操作会自动拒绝（[child-agent.ts L172-176][child-deleg]、[L249-280][child-policy]）。
   - 【明说】sandbox 只继承父 session **显式设置过**的 override。请求里没有字段能单独给子代理设 `sandboxMode`（[child-agent.ts L249-280][child-policy]）。
   - 【明说】`fork` 还会带上父代理已完成轮次的对话前缀，`spawn` 不带（[fork L48-55][fork-seed]、[spawn L41-50][cap-spawn]）。源码注释写明这个字段「says nothing about tool registration, injected services, or authority inheritance」（[types.ts L349-354][sa-inherits]）。
3. **请求里能指定什么、不能指定什么。**
   - 【明说】能指定：`toolFilter`、`persona`（只是一个前缀段落，会盖过部署级的 `deployment:persona-prefix`）、`agentOptions`（provider/model/reasoningEffort/maxTokens）、`outputSchema`、`maxDepth`、`label`（[types.ts L145-201][sa-req]）。
   - 【明说】请求里**没有** preset 字段，也没有「替换整段 system prompt」的字段。子代理只能加入父代理的 preset（[child-agent.ts L200-219][child-compose]）。
4. **返回值能不能直接得到 Designer 形状。** 目标形状是 `Omit<ProposalInput,'intent'|'addressedExperienceIds'>`（[workflow.ts L12][designer]、[proposal.ts L5-21][proposal]）。
   - 【明说】`subagents.start` 返回 `SubagentRun`，`await run.result` 得到 `SubagentResult { output, structured?, diagnostic?, stopReason }`（[types.ts L271-334][sa-result]）。传了 `outputSchema` 时，子代理通过自己 scope 里注册的结构化捕获工具交回结果，放在 `structured` 里；如果跑完了但没有捕获到，返回 `stopReason: 'error'`（[driver L211-237][drv-read]、[structured.ts L74][drv-struct]）。
   - 【明说】`workflowEngine.start` 返回 `WorkflowRun`，`await run.result` 得到 `WorkflowResult { value, stopReason, error?, agentsStarted }`。`value` 是脚本的 JSON 返回值（[types.ts L72-87][wf-result]）。脚本里 `agent(prompt, {schema})` 返回 `structured`，不带 schema 时返回纯文本；子代理失败或缺结构化值时返回 `null`（[runtime.ts L180-229][ptc-agent]）。
   - 【推断】两条路都能拿到一个 JSON 对象。但 `structured`/`value` 的类型都是 `unknown`，宿主必须自己校验，再收窄成 Designer 形状。`ProposalInput` 里的 `changedSurfaces` 是字面量联合（[types.ts L147][surface]），可以写进 JSON Schema 的 `enum`。只是这份 schema 得手写：【查不到】仓库里有没有从 TS 类型生成 JSON Schema 的现成设施，我没找到：在 `packages/*/src` 里 grep 过 `zod`、`JsonSchema`、`json-schema`，也看过各包 `package.json` 的依赖。
5. **取消、超时、失败。**
   - 【明说】`subagents.start` 的 `signal: AbortSignal` 是必填项。发布前 signal 已经 abort，`start` 会直接抛错；发布后再 abort，会调用 `child.cancel({kind:'parent'})`，结果的 `stopReason` 为 `'aborted'`（[driver L104-152][drv-start]、[L158-209][drv-drive]）。子代理自身失败时，`result` **不 reject**，而是以 `stopReason` 为 `error`/`refusal`/`max-tokens`（外加可选的 `diagnostic`）resolve；只有基础设施故障才 reject（[types.ts L252-263][sa-stop]、[L308-334][sa-result]）。
   - 【查不到】`SubagentStartRequest` 没有超时字段。查过 `types.ts` 的请求定义、`index.ts` 的 `start()`、in-process driver 的 `startInProcessRun`/`drivePublishedRun`。【推断】要超时只能由调用方自己传 `AbortSignal.timeout(ms)` 或 `AbortSignal.any([...])`。
   - 【明说】`workflowEngine.start` 的 `signal` 是可选项；`run.result` 从不 reject，失败时表现为 `stopReason: 'error' | 'cancelled'` 加 `error` 字符串（[runtime-types.ts L40-49][wf-run]、[host.ts L273-305][ptc-drive]）。整体运行没有超时，`timeoutMs: null`；只有单个同步片段有 `syncTimeoutMs` 限制，默认 5000 ms（[host.ts L273-305][ptc-drive]、[workflow-ptc index.ts L41-42、L110][ptc-sync]）。

## 收窄工具的各条路径

| 路径 | 是否需要改部署配置 | 是否影响宿主 session 的工具 | 结论 |
|---|---|---|---|
| A. `subagents.start('spawn'\|'fork', { toolFilter })` | 不需要（前提：部署里装了 spawn/fork provider） | 不影响 | 【明说】可行，是唯一的单次调用收窄方式 |
| B. 部署一个 `tool-subagent` 实例，静态配置 `toolFilter` | 需要 | 不影响（只作用于它启动的子代理） | 【明说】机制存在；【推断】它是给模型用的工具，不是宿主代码的调用入口 |
| C. 专用 preset / `isolate` realm | 需要 | 不影响 | 【明说】子代理无法选 preset；【推断】对 Designer 子代理不可用 |
| D. `tools.guard()` | 不需要 | 挂在全局或父代理上都会影响宿主 | 【推断】不适合作为构造上的保证 |
| E. 父 session 的 sandbox `read-only` override | 取决于 session 设置 | 影响（它本来就是父 session 的设置） | 【明说】子代理会继承，但请求里不能单独给子代理设 |

### A. `toolFilter`（推荐的唯一单次调用路径）

- 【明说】作用域：`restrict()` 必须在带 scope 的 ctx（agent.ctx）上调用，否则直接抛错，错误信息说明全局限制会遮住所有 agent（[tools L1097-1124][tools-restrict]）。限制只在该 scope 及其子孙上生效，所以宿主 session 的工具不受影响。
- 【明说】多层限制在整条 scope 链上取交集（[tools L1163-1219][tools-view]）。子代理再往下派生的孙代理也不可能拿回被滤掉的工具。
- 【明说】校验很严：`{}` 会抛错；点名 `run_code` 会抛错；名字不在已知全局工具里也会抛错，错误信息会列出已知工具（[tools L1097-1124][tools-restrict]）。
- 【明说】`allow` 和 `deny` 语义不同：`allow` 是「只保留这些」，`deny` 是「去掉这些」（[tools L696-705][tools-restriction]）。
- 【推断】对「只读」来说应该用 `allow`。它是封闭集合，以后新注册的写工具或 MCP 工具默认不可见；`deny` 是开放集合，新工具会漏进来。代价是 `allow` 里每个名字都必须在部署里真实存在，否则 `start()` 失败。
- 【明说】子代理自己 scope 里注册的工具不受过滤，典型例子是 `outputSchema` 对应的结构化捕获工具（[tools L1163-1169][tools-view]、[structured.ts L74][drv-struct]）。所以 `allow` 里不用、也不能写它。
- 【明说】PTC 模式下，`run_code` 作为传输层总会插入；但它内部发起的嵌套调用只能调用该 scope **可见**的工具，被过滤掉的会以 `UNKNOWN_TOOL` 拒绝（[tools L1234-1252][tools-exec]、[tools L1210-1216][tools-view]）。【推断】因此 `run_code` 不会成为绕过 `toolFilter` 的通道。
- 【查不到】工具定义上没有「只读」标记。查过 `ToolDefinition`/`ToolSchema` 的全部字段（[tools L222-300][tools-def]），并 grep 了 `readOnly`、`readonlyHint`、`sideEffect`、`mutating`。唯一接近的是 `isConcurrencySafe`，但它的语义是「可否与兄弟调用并行」，不是只读。【推断】`allow` 列表只能手工列出。
- 【明说】内置文件与 shell 工具的注册名如下（只列源码里看到的，具体部署装了哪些需要现场确认）：
  - 读：`read`（[tool-fs read.ts L78][t-read]）、`read_image`（[L210][t-readimg]）、`grep`（[tool-fs-search grep.ts L285][t-grep]）、`glob`（[glob.ts L307][t-glob]）。
  - 写或执行：`edit`、`write`、`str_replace_editor`、`bash`、`pwsh`（[edit.ts L85][t-edit]、[write.ts L73][t-write]、[str-replace-editor L430][t-sre]、[tool-bash L372][t-bash]、[tool-pwsh L382][t-pwsh]）。
  - 【推断】只要 `bash`/`pwsh` 在 `allow` 里，「只读」就不成立。一个候选写法是 `toolFilter: { allow: ['read', 'grep', 'glob'] }`，但前提是这三个名字确实注册在部署里。我没有在任何部署上运行验证。
- 【推断】`toolFilter` 只管 DSH 工具表。子代理照常调用模型、照常写自己的 session 日志，这些不算「工具」，不受它约束。

### B. `tool-subagent` 实例的静态 `toolFilter`

- 【明说】`tool-subagent` 的配置项里有 `toolFilter { allow?, deny? }`，注释写明「Tool filter applied to every child … unknown names fail startup」。空对象会被视为配置错误（[tool-subagent L82-92][tsa-cfg]、[L124-129][tsa-schema]），运行时它把 `persona/toolFilter/maxDepth` 原样放进 `subagents.start` 的请求（[L512-523][tsa-req]）。
- 【推断】这证明 A 的用法是 DSH 自己在用的正路。但 `tool-subagent` 是给模型调用的委托工具；如果 Designer 由宿主代码（例如一条命令）直接发起，直接调 `subagents.start` 更直接，不需要额外部署一个工具实例。

### C. 专用 preset / `isolate` realm

- 【明说】`SubagentStartRequest` 没有 preset 字段（[types.ts L145-201][sa-req]）。子代理由 `composeFrom` 加入父代理「当前绑定的那一份」preset 修订版（[preset-registry L268-283][preset-compose]）。
- 【推断】按 session 选 preset 的机制（见 [SKIL-99 调研](dsh-plugin-service-topology-zh.md)）只对顶层 session 生效，做不到「给某个子代理换一个只读 preset」。要走这条路，就得另起一个用只读 preset 的顶层 session，而不是用 subagent。这既要改部署配置，也超出了本题两个后端的范围。

### D. `tools.guard()`

- 【明说】guard 是单调的、只拒不放。挂在普通 ctx 上时全局生效；挂在 agent.ctx 上时，对该 agent 以及 scope 链上的子孙生效（[tools L1136-1154][tools-guard]）。
- 【推断】挂在全局或父代理上都会拦住宿主自己的调用，因此不满足「不影响宿主」。挂在子代理上也不可行：它的 `setup` 回调由 driver 内部持有，调用方插不进去。`start()` 返回 `run.localAgent` 时，prompt 已经在 `drivePublishedRun` 里通过 `followup` 发出去了（[driver L158-209][drv-drive]），这时再补挂 guard 存在竞态，不能算「构造上」的保证。

### E. sandbox 只读

- 【明说】子代理只继承父 session 显式设置过的 sandbox override；`approvalPolicy` 固定为 `never`；`permissionPreset` 只在父代理是 `auto` 或 `danger-full-access` 时继承（[child-agent.ts L249-280][child-policy]）。
- 【推断】这是一层纵深防御，不是工具集收窄：工具仍然在，只是写操作可能被 sandbox 拒绝。而且它取决于宿主 session 当时的设置，Designer 这边控制不了。

## 两个后端对照

| 维度 | `subagents.start(name, request)` | `workflowEngine.start(request)` → 脚本内 `agent()` |
|---|---|---|
| 收窄工具 | 【明说】`toolFilter`，仅限 `spawn`/`fork` | 【明说】不能：`agent()` 不接受该选项，宿主也不转发 |
| 选模型 | 【明说】`agentOptions.provider/model/reasoningEffort/maxTokens` | 【明说】`agent()` 只接受 `provider`/`model`；`effort` 被显式延后 |
| system prompt | 【明说】只有 `persona` 前缀；preset 继承自父代理 | 【明说】什么都不能设（不转发 `persona`） |
| 结构化输出 | 【明说】`outputSchema` → `result.structured` | 【明说】`agent(p, {schema})` → 脚本拿到 `structured`，脚本返回值 → `result.value` |
| 子代理失败 | 【明说】`result` resolve，`stopReason` ≠ `completed`，可带 `diagnostic` | 【明说】脚本内 `agent()` 返回 `null`；启动失败或基础设施故障则抛出致命的 `AGENT_START`/`AGENT_RESULT`，整个 run 变成 `stopReason: 'error'` |
| 取消 | 【明说】`signal` 必填；发布前 abort 就抛错，发布后 abort 得到 `aborted` | 【明说】`signal` 可选，另有 `run.cancel(reason?)`；结果为 `cancelled` |
| 超时 | 【查不到】没有字段；【推断】用 `AbortSignal.timeout` | 【明说】整体没有超时；只有同步片段默认 5000 ms |
| 清理 | 【明说】`run.dispose()` 幂等 | 【明说】每个子代理用完即 dispose；`run.dispose()` |

- 【明说】`agent()` 的致命错误会穿透 `parallel`/`pipeline` 向上传播（[workflow index.ts L108-148][wf-errors]），错误码表见同一段。
- 【推断】从宿主代码的角度看，如果只起一个 Designer，`workflowEngine` 比直接调用 `subagents.start` 多了一层脚本 VM，却换不来工具收窄能力。这是事实对比，不是选型建议。

## 来源

以下链接均固定到 `deepseek-ai/deepseek-harness@477b4f420553e8a52c2fbccc464d7561b239c443` 或 `Erinable/dsh-skill-evo@5f027b1ddb5f484dfe8aa649b65fa217c0781045`，查证日期均为 2026-09-27。

[sa-req]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/types.ts#L145-L201
[sa-req-filter]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/types.ts#L186-L193
[sa-stop]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/types.ts#L252-L263
[sa-result]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/types.ts#L271-L334
[sa-inherits]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/types.ts#L349-L354
[sa-assert]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/index.ts#L559-L660
[cap-spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-spawn-in-process/src/index.ts#L41-L59
[cap-fork]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-fork-in-process/src/index.ts#L63-L72
[fork-seed]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-fork-in-process/src/index.ts#L48-L55
[cap-acp]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-acp/src/index.ts#L147-L153
[cap-none]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/out-of-process.ts#L57-L63
[cap-sdk]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-dsh-sdk/src/index.ts#L110-L113
[drv-start]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-in-process-driver/src/index.ts#L104-L152
[drv-drive]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-in-process-driver/src/index.ts#L158-L209
[drv-read]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-in-process-driver/src/index.ts#L211-L237
[drv-struct]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-in-process-driver/src/structured.ts#L74
[child-opts]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/child-agent.ts#L99-L120
[child-deleg]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/child-agent.ts#L172-L176
[child-compose]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/child-agent.ts#L200-L219
[child-policy]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/child-agent.ts#L249-L280
[preset-compose]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/src/index.ts#L268-L283
[tools-def]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L222-L300
[tools-restriction]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L696-L705
[tools-restrict]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1097-L1124
[tools-guard]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1136-L1154
[tools-view]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1163-L1219
[tools-exec]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1234-L1252
[t-read]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs/src/read.ts#L78
[t-readimg]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs/src/read-image.ts#L210
[t-grep]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs-search/src/grep.ts#L285
[t-glob]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs-search/src/glob.ts#L307
[t-edit]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs/src/edit.ts#L85
[t-write]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs/src/write.ts#L73
[t-sre]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-str-replace-editor/src/index.ts#L430
[t-bash]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/shell/tool-bash/src/index.ts#L372
[t-pwsh]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/shell/tool-pwsh/src/index.ts#L382
[tsa-cfg]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/tool-subagent/src/index.ts#L82-L92
[tsa-schema]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/tool-subagent/src/index.ts#L124-L129
[tsa-req]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/tool-subagent/src/index.ts#L512-L523
[wf-req]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow/src/runtime-types.ts#L19-L34
[wf-run]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow/src/runtime-types.ts#L40-L49
[wf-result]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow/src/types.ts#L63-L87
[wf-errors]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow/src/index.ts#L108-L148
[ptc-opts]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/runtime.ts#L33-L35
[ptc-opts-check]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/runtime.ts#L252-L258
[ptc-agent]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/runtime.ts#L180-L229
[ptc-host-start]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/host.ts#L197-L211
[ptc-drive]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/host.ts#L273-L305
[ptc-sync]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/index.ts#L39-L110
[designer]: https://github.com/Erinable/dsh-skill-evo/blob/5f027b1ddb5f484dfe8aa649b65fa217c0781045/packages/skill-evolution/src/workflow.ts#L5-L12
[proposal]: https://github.com/Erinable/dsh-skill-evo/blob/5f027b1ddb5f484dfe8aa649b65fa217c0781045/packages/skill-evolution/src/proposal.ts#L5-L21
[surface]: https://github.com/Erinable/dsh-skill-evo/blob/5f027b1ddb5f484dfe8aa649b65fa217c0781045/packages/skill-evolution/src/types.ts#L147
