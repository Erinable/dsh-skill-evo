# DSH 插件服务机制、catalog 刷新接口与进程拓扑

> SKIL-99（SKIL-96 Stage 1 调研票）。查证日期 2026-09-27。
> 一手来源：DeepSeek Harness 源码 [`deepseek-ai/deepseek-harness@477b4f4`](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)（提交日期 2026-09-24，根 `package.json` 版本 `0.1.7-rc.2`）。所有行号都在这个提交的本地克隆上核对过，文中链接都固定到这个提交。
> 标注说明：【明说】表示来源原文就这么写；【推断】表示来源暗示，由我推出结论；【查不到】表示已写明查过哪些地方。
> 版本冲突：2026-09-27 执行 `npm view @deepseek-ai/dsh-skill dist-tags` 的输出是 `{ alpha: '0.1.7-alpha.2', latest: '0.0.1-rc.1', next: '0.1.7-rc.2' }`，也就是 `latest` 标签指向 `0.0.1-rc.1`，`next` 标签指向 `0.1.7-rc.2`。本文按 `next` 标签（与源码一致）作答。安装时如果按 `latest` 解析，行为可能不同；这一点我没有验证。

## 结论

1. **服务的声明与提供**
   - 写法【明说】：提供方继承 Cordis `Service`，调用 `super(ctx, '<key>')`，再用 `declare module '@deepseek-ai/cordis'` 给 `ctx.<key>` 补类型。消费方写 `export const inject = ['<key>']` 或 `static inject = ['<key>']`。
   - 依赖语义【明说】：inject 里的每一项都是硬依赖。缺了任何一项，插件就停在 PENDING，不报错也不启动；服务出现后会自动 apply。可选依赖的写法是用 `ctx.get()` 探测，或者用 `ctx.inject([...], cb)` 包一层子插件。
   - 作用域【明说】：服务注册在所在 profile 进程那棵插件树的 root 上，provider 卸载时服务自动注销。
   - 按 session 的作用域【明说】：官方机制是 agent preset 加 `isolate` realm，架构文档原文是 “Give one session a different capability set → compose an agent preset; a service row there needs an `isolate` realm”。粒度是这样的：preset 的插件树在声明时按 preset 建一份；session 创建时选定 preset，由 preset 绑定给这个 session 的 agent；realm 里的服务不能泄漏到 root，挂载时的 leak 检查会拒绝。
   - 按 session 的作用域【推断】：普通插件（不经过 preset）没有「每个 session 一份」的 `provide` 方式。另外，用同一个 preset 的多个 session 共享同一棵 preset 树，所以这里的「按 session」实际上是「按 session 选的 preset」。
   - 三角色约定【明说】：「Service Definition / Provider / Consumer」是 DSH 的官方约定，写在 `AGENTS.md` 和 `docs/glossary.md` 里。拆包规则只有一句：「角色各自演化时才拆」，不强制按 `<capability>-<impl>` 命名。
   - `capability-seams.md` 本身【明说】：它是脚本生成的服务图谱，不是规范原文。
2. **catalog 刷新接口**
   - 服务上没有【明说】：`ctx.skills` 对外没有公开的 invalidate、refresh 或 reload 方法。
   - 唯一的失效入口【明说】：`registerProvider` 注册时借给该 provider 的 `SkillProviderControl.invalidate(): void`。它不带参数，调用一次会清空整个 registry 的缓存，粒度既不是单个 Skill 也不是 scope。
   - filesystem provider【明说】：默认用 chokidar 监听 Skill 根目录，外部写入 `SKILL.md` 后 registry 会失效。模型那一侧只有 name 或 description 变了才会在下一个 step 收到新 catalog；只改正文不会通知模型，下次调用 `skill` 工具时直接读到新正文（见第 2 节）。
   - 对本仓的影响【推断】：`EvolutionServiceOptions.invalidate(skillName, scope)` 在 DSH 里没有签名相同的对应接口；两个参数到了 DSH 侧都用不上；`stable` scope 在 DSH 里没有对应概念。
3. **进程拓扑**
   - 各 profile 的进程【明说】：
     - headless、sdk、acp 都是单个 `dsh` Node 进程。
     - web 分成 Node Host 进程和浏览器 Client 页面两部分。
     - desktop 分成 Electron main、RunAsNode Host 子进程（Host 和插件跑在同一个进程里）、渲染页三部分。
   - 第三方 bundle【明说】：bundle 的 Host 代码在 Host 进程内执行，不受 workspace 沙箱约束。
   - 远程接口【明说】：官方有，插件可以注册处理器，入口有 `ctx.connection.rpc.handle/intercept`、`ctx.connection.fetch.register`、`ctx.webServer.register`。
   - 鉴权【明说】：
     - 启动时生成一次性 launch token，换成签名 Cookie，再加 Host/Origin 检查，所有请求只对应一个 operator 身份。
     - 这套鉴权只覆盖走 `connection` 的请求，`webServer` 本身不做鉴权。
     - SDK 的 stdio JSON-RPC 方法表是写死的，插件无法扩展。
     - headless 模式不开任何端口。
4. **先例**【明说】
   - 插件之间互相提供服务的先例有：`skills`（`dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill`）、`web`（`dsh-web`、`dsh-web-search-*`、`dsh-tool-web`）、`workflowEngine`、`subagents`。调用方的拿法都是先 `inject` 服务，再直接调 `ctx.<key>.method()`。
   - workflow 脚本在 `vm` 沙箱里运行，只能拿到 `agent/parallel/pipeline/phase/log/args` 六个全局函数，没有 `ctx`。
   - in-process 的子 agent 和父 agent 在同一个 Cordis context 上。跨进程的子 agent（ACP、dsh-sdk）不共享任何 Cordis context。

对 SKIL-96 的含义【推断，供后续决策票参考】：skill-evolution 的服务接口做成 Host 进程内的一个 Cordis `Service` 就能被其他插件、in-process 子 agent 和工具消费，不需要跨进程。workflow 脚本和跨进程子 agent 只能通过工具间接使用它。catalog 刷新要在两条路里选一条：一是把发布结果写进一个已经被 watch 的根目录，靠 watcher 触发；二是由本仓 bundle 自己注册一个 SkillProvider，把 `control.invalidate` 留下来用。

## 1. 服务的声明与提供

### 提供方

- 【明说】Cordis `Service` 的构造函数内部会调用 `ctx.reflect.provide(name, self, check)`。源码注释写的是 “service is unregistered automatically when the owning fiber unloads”。来源：[`vendor/cordis/src/service.ts:32-59`][cordis-service]。
- 【明说】`provide` 是一个 fiber effect，在同一作用域里重复注册会抛错 `service "…" has been registered`。`ctx.set` 只能覆盖本 fiber 已经 provide 过的值。来源：[`vendor/cordis/src/reflect.ts:254-305`][cordis-reflect-provide]。
- 【明说】标准模板是 shell seam。它的写法是 `declare module` 加上 `shell: ShellExecutor`，再写 `abstract class ShellExecutor extends Service { super(ctx, 'shell') }`。来源：[`packages/shell/shell/src/index.ts:30-67`][shell-seam]。官方教程对这种写法的说明是 “The registration is an effect — unloading the provider removes the service”，来源：[`docs/cordis-tutorial/03-services.md:11-42`][tut-services]。
- 【推断】在 `packages/**/src` 里 grep 的计数：`super(ctx, '` 出现 103 处，`ctx.provide(` 31 处，`ctx.set(` 0 处。据此判断主流写法是继承 `Service`。

### 作用域与生命周期

- 【明说】`provide` 的 key 存在 root 的 isolate 表里。provider 注销时，依赖它的插件会先收到通知并卸载。来源：[`vendor/cordis/src/reflect.ts:277-305`][cordis-reflect-provide]。
- 【明说】`ctx.isolate(name)` 可以给某个服务开一个独立的 realm，在这个 realm 里换一个实现不会影响父作用域。来源：[`vendor/cordis/src/context.ts:109-125`][cordis-isolate]。
- 【明说】按 session 使用不同服务集合，官方给的机制是 agent preset。架构文档的原文是 “Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm”，来源：[`docs/architecture.md:145`][arch-145]。
- 【明说】这个机制的粒度如下：
  - 每个 preset 声明时就建好一个 registry 自有的 scope 和一棵内存里的 Loader 树。插件注册继承 preset 的 scope，可见性由 Agent scope 的父链接控制。来源：[`packages/preset/agent-preset-registry/README.md:56`][preset-readme-56]。
  - 新 session 在创建时解析 preset，先看用户选的默认值，再回退到部署的 `default`。来源：[`README.md:46`][preset-readme-46]。
  - 挂载时会审计 “globally leaked services”，发现泄漏就拒绝挂载。来源：[`README.md:58`][preset-readme-58]。代码里的对应检查会抛错 `Preset services require isolate realms`，见 [`packages/preset/agent-preset-registry/src/mount.ts:258-267`][preset-mount]。
- 【明说】`agent.ctx` 不会复制服务，它只给注册打一个 scope 标签。架构文档里写的规则是 “Scope a registration to one agent → use that agent's `agent.ctx`”。来源：[`docs/architecture.md:162`][arch-162]。
- 【推断】一次 `dsh --profile <name>` 启动会组合出一棵插件树，服务就挂在这棵树的 root 上，所以这里说的「全局」实际上是按进程和 profile 划分的。依据：[`docs/architecture.md:15-27`][arch-profiles]。
- 【推断】除了 preset 这条路，普通插件没有「每个 session 一份」的 `provide` 方式。依据：Cordis 里生命周期的单位是 Fiber，没有按 session fork 服务的 API（`vendor/cordis/src`）；`agent.ctx` 只给注册打 scope 标签，不复制服务（见上一条）。
- 【推断】用同一个 preset 的多个 session 共享同一棵 preset 树（README:56 说树是按声明建的，Agent 持有它的引用），所以「按 session」隔离的实际单位是「session 选中的 preset」。如果要求每个 session 各有一份独立的服务实例，按现有文档做不到；这一点我没有在代码里验证。

### 消费方与依赖缺失

- 【明说】`Inject` 的类型是 `(keyof M)[] | { [K]?: config }`。其中对象形式的值是 intercept config，不是 required/optional 开关。来源：[`vendor/cordis/src/registry.ts:15-19`][cordis-inject-type]，归一化逻辑在 [`registry.ts:71-88`][cordis-inject-norm]。`ctx.inject(deps, cb)` 等价于 `this.plugin({ inject, apply: cb })`，来源：[`registry.ts:300-302`][cordis-ctx-inject]。
- 【明说】只要缺任何一个 inject 项，fiber 就停在 PENDING；服务出现后执行 `_reload`，服务消失后执行 `_unload`。来源：[`vendor/cordis/src/fiber.ts:597-639`][cordis-fiber]。官方教程的表述是 “Cordis holds the plugin in PENDING until every listed service exists”，缺失时 “stays PENDING and prints nothing — no crash”，来源：[`docs/cordis-tutorial/03-services.md:59-76`][tut-pending]。
- 【明说】访问一个没有 inject 的服务会抛错 `cannot get property "…" without inject`。来源：[`vendor/cordis/src/reflect.ts:144-166`][cordis-reflect-get]。
- 【明说】可选依赖的写法是 “skip `inject` and probe at the use site”，也就是在使用处调用 `ctx.get('x')`。来源：[`docs/cordis-tutorial/03-services.md:80-90`][tut-optional]。实际例子是 `tool-bash`，它用 `ctx.get('jobs')` 加 `ctx.inject(['jobs'], …)` 做可选升级，来源：[`packages/shell/tool-bash/src/index.ts:34`][tool-bash]。

### Service Definition / Provider / Consumer 是否官方约定

- 【明说】这是官方约定。`AGENTS.md` 原文：“A capability seam comprises Service Definition / Service Provider / Consumer roles. It is complete, never one role; split only when roles evolve independently”。来源：[`AGENTS.md:138`][dsh-agents-138]，以及 [`docs/architecture.md:129-133`][arch-seams]。
- 【明说】glossary 规定 Service Definition 必须是 Cordis `Service`，可以是抽象类，也可以是具体的 registry，但 “never a TypeScript `interface`”。拆包的说法是 “Roles normally occupy separate packages when they evolve independently, but a package may own multiple roles”。来源：[`docs/glossary.md:7-9`][glossary]。
- 【明说】命名方面只有指导性说法，没有格式要求：“An interface package names the capability. An implementation package adds the mechanism, protocol, environment, or vendor”。来源：[`docs/cookbook/adding-a-package.md:44-50`][cookbook-pkg]。另一份文档写的是 “Don't split preemptively”，来源：[`.agents/notes/implemented/architecture/2026-06-13-capability-seams.md:15-25`][note-seams]。
- 【明说】`docs/capability-seams.md` 由 `scripts/gen-doc-graphs.ts` 从 Cordis 声明生成，文件头写明 “do not edit by hand”，内容是按 core/seam/bundle/standalone 分类的服务图谱；服务从 Cordis 声明里发现，接口/实现/消费方的角色在生成脚本里归类。来源：[`docs/capability-seams.md:1-6`][seams-doc]、[`:661`][seams-661]。【推断】它是现状图谱而不是规范，里面没找到规范性条文。
- 【推断】本仓 `docs/architecture-design-zh.md:535` 写的「遵循 DSH capability seam 的 Service Definition / Provider / Consumer 结构」和官方约定一致。但它建议的 `packages/skill/evolution` 加 `evolution-filesystem` 拆分是本仓自己的设计，DSH 没有规定这种拆法。按官方「不预先拆分」的原则，只有一个 provider 时也可以放在一个包里。

## 2. catalog 刷新接口

### `dsh-skill`（`ctx.skills: SkillRegistry`）

- 【明说】服务通过 `super(ctx, 'skills')` 注册，另外声明了一个事件 `'skills/change'(): void`，不带参数。来源：[`packages/skill/skill/src/index.ts:283-298`][skill-ctx]、[`:373-377`][skill-ctor]。
- 【明说】公共方法列在 [`index.ts:390-517`][skill-api]：

  ```ts
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
  register(skill: SkillRegistration): () => void   // 运行时 Skill
  list(options?: SkillViewOptions): Promise<SkillSummary[]>
  snapshot(options?: SkillViewOptions): Promise<SkillCatalogSnapshot>
  get(name: string, options?: SkillViewOptions): Promise<SkillDefinition | undefined>
  ```

  `invalidateCache()` 和 `invalidateEntry()` 都是 `private`，外部调用不到。来源：[`index.ts:621-631`][skill-invalidate]。
- 【明说】失效能力通过 provider 注册时拿到的 control 对象暴露（[`index.ts:268-275`][skill-control]）：

  ```ts
  export interface SkillProviderControl {
    readonly signal: AbortSignal
    /** Invalidate completed catalogs and notify consumers only while the exact registration remains active. */
    readonly invalidate: () => void
  }
  ```

- 【明说】失效粒度是整个 registry：`revision += 1`，然后 `collectCache.clear()`，再发出 `skills/change`。README 的原文是 “only a provider calling its registration-scoped `invalidate()`, or a runtime registration or disposal, clears completed catalogs”。Skill 正文从不缓存，每次 `get()` 都重新读取。来源：[`packages/skill/skill/README.md:99-103`][skill-readme-inv]。
- 【明说】设计取舍的原文是 “Invalidation is provider-driven — the registry has no TTL … each mutable provider must retain and call its registration-scoped `invalidate()`”。来源：[`README.md:138`][skill-readme-138]。
- 【明说】rank 不挂在 provider 上，而是挂在每个 `SkillCandidate` 上，数值越小越优先。来源：[`index.ts:77-84`][skill-rank]。

### filesystem provider（`dsh-skill-filesystem`）

- 【明说】`apply()` 里通过 `ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, config))` 注册 provider。它另外订阅了 `fs/observed`，当 actor 是 `write` 或 `edit` 时调用 `observeHostMutation()`。provider 实例存在 `apply` 的局部变量里，没有作为服务暴露出去。来源：[`packages/skill/skill-filesystem/src/index.ts:133-147`][fs-apply]。
- 【明说】`watch` 默认开启。已经存在的根目录用 `chokidar.watch(..., { depth: 1, atomic: true, awaitWriteFinish })`，写入稳定期默认 200ms。还不存在的根目录用 `fs.watchFile` 探测祖先目录。同一个 microtask 内的多个事件会合并成一次 `control.invalidate()`。来源：[`index.ts:58-62`][fs-config]、[`:456-506`][fs-watch]、[`:583-592`][fs-coalesce]。
- 【明说】README 原文是 “adding, renaming, or deleting a skill (or editing its frontmatter) triggers a catalog refresh for the next model step … External IDE, Git, and shell changes are picked up by the host watcher”。来源：[`packages/skill/skill-filesystem/README.md:81`][fs-readme-81]。
- 【明说】根目录和 rank 的对应关系：`.dsh/skills` 100，`.agents/skills` 200，`customSkillDirs` 300，`~/.dsh/skills` 400，`~/.agents/skills` 500，bundled 600。来源：[`index.ts:245-265`][fs-roots]。
- 【明说】一个根目录要先被 `list()` 碰到一次，之后才会被 watch。来源：[`index.ts:187-194`][fs-list]。

### catalog 重算时机

- 【明说】`tool-skill` 不监听 `skills/change`。它在每次 `agent/pre-step` 调用 `ctx.skills.snapshot()`，对可调用条目的 `[name, description]` 计算 sha256，和会话里最近一次的 catalog digest 比较，不一致时追加一份完整的替换 catalog。来源：[`packages/skill/tool-skill/src/index.ts:213-251`][ts-prestep]、[`:328-335`][ts-digest]。
- 【明说】原文是 “Bodies are not versioned — body-only edits do not change the catalog digest or notify the model; a later tool call reads the current provider content”。来源：[`packages/skill/tool-skill/README.md:247-248`][ts-readme]。
- 【推断】如果 skill-evolution 发布的新版本只改了正文，模型那一侧不需要刷新 catalog，下一次调用 `skill` 工具时就会读到新正文。只有 frontmatter 的 name 或 description 变了，才会进 catalog。

### 第三方插件怎么触发刷新

- 【查不到】DSH 没有提供给第三方的显式 refresh/invalidate 服务接口。查过的地方：`packages/skill/{skill,skill-filesystem,tool-skill}` 的 `src` 和 README；在全仓 grep 过 `skills.(reload|refresh|rescan|invalidate)`、`reloadSkills`、`skills/(reload|refresh)`。唯一的命中是 [`packages/hooks/hooks-claude-code/README.md:175`][hooks-reload]，它说明不支持 Claude Code 的 `reloadSkills`。
- 【推断】能用的路径有三条。
  - A：把新版本写进一个已经被 watch 的根目录，由 watcher 触发刷新。前提是 `watch` 没被关掉，并且这个根目录已经被发现过。依据是上面的 README:81。
  - B：本仓 bundle 用 `inject = ['skills']` 自己注册一个 provider，比如复用包导出的 `FileSystemSkillProvider` 并设置 `customSkillDirs`，然后保留 `control.invalidate`，在 `EvolutionServiceOptions.invalidate` 里调用它。代价是每次都会清掉整个缓存，而且同名 Skill 谁胜出要靠 rank 决定。
  - C：伪造 actor 为 `write` 的 `fs/observed` 事件。这等于借用了给工具执行准备的事件，不是官方路径，不建议用。
- 【推断】DSH 的 `scope` 是按 agent 身份分层的 `ScopeKey`（[`packages/core/scope/src/index.ts:14-15`][scope-key]），和 project/user 没有关系。project 和 user 的区分体现在 `SkillSource` 标签和 rank 上（[`skill/src/index.ts:39-40`][skill-source]）。本仓的 `'project'` 大致对应 `project-*`，`'user'` 对应 `user-*`，`'stable'` 没有对应项。DSH 的 `invalidate()` 不带参数，所以本仓回调里的 `skillName` 和 `scope` 传到 DSH 侧不起作用。

## 3. 进程拓扑与远程接口

### 各 profile 下插件跑在哪个进程

| profile | 插件所在进程 | 依据 |
|---|---|---|
| headless | 单个 `dsh` Node 进程，“opens no ports” | 【明说】[`packages/bundle/headless/README.md:12`][headless] |
| sdk / acp | 单个 `dsh` Host 进程，通过 stdio 走 JSON-RPC。sdk：“Stdout carries only JSON-RPC frames”；acp：“automation-only ACP stdio application” | 【明说】[`packages/sdk/server/README.md:12`][sdk-readme]、[`packages/bundle/acp-app/README.md:12`][acp-readme] |
| web | Host 插件运行在 Node Host 进程；Client 插件由 `dsh.client` 声明，经 `/plugins/<id>/client.js` 下发，在浏览器里激活 | 【明说】[`docs/api-gateway.md:99-101`][gw-faces]、[`packages/bundle/web-app/cordis.patch.yml:42-43`][webapp-patch] |
| desktop | Electron main 以 RunAsNode 子进程方式启动 Desktop Host，“Both host and plugins execute in the same Electron Node-mode process”；Client 插件运行在渲染页，渲染页拿不到 fs、原始 IPC 和 shell | 【明说】[`docs/architecture.md:55`][arch-desktop]、[`apps/desktop/README.md:5`][desktop-readme-5]、[`:77-79`][desktop-readme] |

- 【明说】所有 Node 应用都只能通过 `dsh --profile <name>` 启动。自带的模板有 `web`、`headless`、`sdk`、`sdk-minimal`、`acp`。来源：[`docs/architecture.md:19-27`][arch-profiles]、[`:45`][arch-launch]。
- 【明说】第三方 bundle 的 Host 代码 “executes in-process outside the workspace sandbox”，来源：[`packages/boot/plugin-manager/README.md:31`][pm-readme]。bundle 用 `package.json` 里的 `dsh.bundle.patch` 声明补丁（[`packages/boot/app-boot/src/profile.ts:58-75`][profile-patch]）。补丁按层叠加，顺序是 bundle、profile、home、`--patch`（[`docs/architecture.md:27`][arch-profiles]）。`insert` 带 `id` 时追加到对应 group 的 `config` 里，不带 `id` 时追加到根列表（[`vendor/include/src/index.ts:76-124`][include-insert]）。
- 【推断】本仓 `dsh-bundle` 没有声明 `dsh.client`，所以不管哪个 profile，它都只在 Host 进程里运行。

### 官方远程接口与插件注册

- 【明说】`ctx.connection`（`/api` 之下，带鉴权）提供了下面这些注册入口，来源：[`packages/client/connection/src/rpc.ts:127-190`][conn-rpc]：

  ```ts
  ctx.connection.rpc.handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>
  ctx.connection.rpc.intercept('/api', matches: (endpoint: string) => boolean, handler): () => Promise<void>
  ctx.connection.fetch.register(route: ConnectionFetchRoute): () => Promise<void>
  type ConnectionRpcHandler = (endpoint, payload, signal: AbortSignal, peer: PeerScope) => Promise<…>
  ```

- 【明说】`ctx.webServer` 是 `dsh-host-webserver` 提供的，有 `register({ kind: 'exact'|'prefix', path, handler })`、`registerUpgrade`、`registerFallback` 三个方法，来源：[`packages/host/webserver/src/index.ts:166-200`][ws-api]。它本身 “carries no TLS, authentication, or origin policy of its own”，来源：[`packages/host/webserver/README.md:39`][ws-readme]。
- 【明说】Typert API Gateway 的用法是：Service 继承 `TypertRemoteService`，方法上加 `@Remote` 装饰器，然后通过 `POST /api/<namespace>/<method>` 调用，流式调用走 `/api/remote.mux` WebSocket。Client 只挂载构建时生成的 strict 描述符，“refuses to mount SRC descriptors”。来源：[`docs/api-gateway.md:58`][gw-58]、[`:123`][gw-123]、[`:139`][gw-139]、[`packages/typert/protocol/src/index.ts:166-180`][typert-remote]。
- 【明说】SDK 的 stdio JSON-RPC 用固定的 `switch` 分发，只认 `initialize`、`session/prompt`、`shutdown` 三个方法，其余一律抛 `unknown … method`，插件没法往里加方法。来源：[`packages/sdk/server/src/server.ts:248-259`][sdk-switch]。
- 【查不到】DSH 没有书面保证第三方插件注册的 SRC Remote 可以被外部稳定调用。查过的地方：`docs/api-gateway.md`、`packages/api/gateway/README.md`、`packages/typert/loader/README.md`。

### 鉴权模型

- 【明说】每个进程在启动时生成一个随机 launch token。这个 token 只能通过 `GET /?token=` 兑换一次，换成签名 Cookie（HttpOnly、SameSite=Strict，默认有效期 30 天）。系统不接受 Authorization 头。签名密钥存放在 `ctx.credentials` 里。来源：[`packages/client/connection/README.md:39-41`][conn-auth]。
- 【明说】Host 必须是 loopback 地址或者在 `trustedHosts` 里；请求带 Origin 时，Origin 必须与 Host 一致；`sec-fetch-site: cross-site` 的请求会被拒绝，返回 403，未认证返回 401。来源：[`packages/client/connection/README.md:43`][conn-trust]、[`src/api-request-trust.ts:91-118`][conn-trust-src]。
- 【明说】“Every admitted request speaks for one Peer, the operator”，也就是说没有按方法区分的权限层级。`ctx.connection.admit(request)` 可以供自建路由复用这套检查。来源：[`packages/client/connection/README.md:45`][conn-peer]。
- 【推断】走 `connection.rpc/fetch` 注册的处理器会自动继承鉴权；直接用 `webServer.register` 注册的路由，需要自己调用 `admit`。headless、sdk、acp 模式不开端口，靠进程边界隔离。

## 4. 先例

| 服务 | Service Definition | Provider | Consumer 的拿法 |
|---|---|---|---|
| `skills` | `dsh-skill`：`super(ctx, 'skills')`（[`skill/src/index.ts:373-377`][skill-ctor]） | `dsh-skill-filesystem`：`inject = ['skills']`，调用 `ctx.skills.registerProvider(...)`（[`skill-filesystem/src/index.ts:133-147`][fs-apply]） | `dsh-tool-skill`：`inject = ['agents','tools','skills']`，调用 `ctx.skills.list/get(name, { cwd, signal, scope: agent })`（[`tool-skill/src/index.ts:25`][ts-inject]、[`:131-141`][ts-call]） |
| `web` | `dsh-web`：`super(ctx, 'web')`，暴露 `registerSearchProvider` 和 `search`（[`web/web/src/index.ts:91-140`][web-svc]） | `dsh-web-search-exa`：`inject = ['web']`，调用 `ctx.web.registerSearchProvider(...)`（[`web-search-exa/src/index.ts:32-58`][web-exa]） | `dsh-tool-web`：`inject = ['tools','web','systemPrompt']`，调用 `ctx.web.search(...)`（[`tool-web/src/search.ts:237-246`][web-call]） |
| `workflowEngine` | `dsh-workflow`：抽象 `start(request): WorkflowRun`（[`workflow/src/index.ts:157-168`][wf-svc]） | `dsh-workflow-ptc`：`static inject = ['subagents','ptcRuntime','sandboxPolicy']`（[`workflow-ptc/src/index.ts:103`][wf-ptc]） | `dsh-tool-workflow`：调用 `ctx.workflowEngine.start({...})`（[`tool-workflow/src/index.ts:433-439`][wf-tool]） |
| `subagents` | `dsh-subagent`：`registerProvider` 和 `start(name, request)`（[`subagent/src/index.ts:512-559`][sa-svc]） | spawn/fork in-process、ACP、dsh-sdk 等 backend | `dsh-tool-subagent`：调用 `runtimeCtx.subagents.start(...)`（[`tool-subagent/src/index.ts:563`][sa-tool]） |

以上各行的内容，源码里都有明文（【明说】）。

- **workflow**
  - 【明说】脚本在 `vm.createContext({})` 里执行，能用的全局只有 `agent`、`parallel`、`pipeline`、`phase`、`log`、`args`（[`workflow-ptc/src/runtime.ts:83-98`][wf-globals]）。`agent()` 在宿主那一侧会落到 `this.subagents.start(...)`（[`workflow-ptc/src/host.ts:197-210`][wf-host]）。
  - 【推断】workflow 脚本拿不到 `ctx`，只能通过它启动的子 agent 调工具，间接用到服务。
- **subagent**
  - 【明说】in-process spawn 的做法是在 “runs each child as a fresh child Agent on the same cordis context”（[`subagent-spawn-in-process/src/index.ts:1-7`][sa-spawn]）。
  - 【明说】ACP backend 则 “shares no Cordis context… the ONE thing it reads off `request.parent` is the session's workspace cwd”（[`subagent-acp/src/index.ts:1-7`][sa-acp]）；dsh-sdk backend 的说法相同（[`subagent-dsh-sdk/src/index.ts:1-12`][sa-sdk]）。
  - 【推断】in-process 子 agent 可以直接用 root 上的全局服务，跨进程子 agent 一个服务都用不了。claude-code 和 codex backend 应该和 ACP 属于同一类，但我没有逐行核对。
- **服务之外的两种暴露方式**
  - 命令（【明说】）：`ctx.commands.register(definition: CommandDefinition): () => void`，其中 handler 的签名是 `(inv: CommandInvocation) => CommandResult | Promise<CommandResult>`（[`interaction/commands/src/index.ts:277-292`][cmd-register]）。命令只能由 UI 或用户触发，不经过模型。
  - 工具（【明说】）：`ctx.tools.register(definition: ToolDefinition): () => void`，面向模型（[`core/tools/src/index.ts:1057-1063`][tools-register]）。
- **本仓 bundle 用到的几个点**（【明说】）
  - `sessions`：[`core/session/src/index.ts:38-41`][sessions]。
  - `session/event`：[`:77`][session-event]。
  - `fs/observed`：在 `dsh-fs` 里声明，并且要求同步监听（[`fs/fs/src/index.ts:68-77`][fs-observed]）。
  - `commands`：见上一条。

## 来源

所有来源的查证日期都是 2026-09-27，都固定在提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。正文里的行号链接直接指向这个提交的对应行。按文件汇总如下：

- Cordis（vendored）：[`vendor/cordis/src/service.ts`][cordis-service]、[`reflect.ts`][cordis-reflect-provide]、[`registry.ts`][cordis-inject-type]、[`fiber.ts`][cordis-fiber]、[`context.ts`][cordis-isolate]；[`vendor/include/src/index.ts`][include-insert]
- 约定文档：[`AGENTS.md`][dsh-agents-138]、[`docs/glossary.md`][glossary]、[`docs/architecture.md`][arch-profiles]、[`docs/cordis-tutorial/03-services.md`][tut-services]、[`docs/cookbook/adding-a-package.md`][cookbook-pkg]、[`docs/capability-seams.md`][seams-doc]、[`.agents/notes/…/2026-06-13-capability-seams.md`][note-seams]、[`docs/api-gateway.md`][gw-58]
- Skill：[`packages/skill/skill/src/index.ts`][skill-api]、[`packages/skill/skill/README.md`][skill-readme-inv]、[`packages/skill/skill-filesystem/src/index.ts`][fs-apply]、[`packages/skill/skill-filesystem/README.md`][fs-readme-81]、[`packages/skill/tool-skill/src/index.ts`][ts-prestep]、[`packages/skill/tool-skill/README.md`][ts-readme]
- 拓扑与远程接口：[`packages/bundle/headless/README.md`][headless]、[`packages/sdk/server/src/server.ts`][sdk-switch]、[`packages/client/connection/src/rpc.ts`][conn-rpc]、[`packages/client/connection/README.md`][conn-auth]、[`packages/host/webserver/src/index.ts`][ws-api]、[`packages/boot/plugin-manager/README.md`][pm-readme]、[`apps/desktop/README.md`][desktop-readme]
- 先例：[`packages/web/web/src/index.ts`][web-svc]、[`packages/workflow/workflow-ptc/src/runtime.ts`][wf-globals]、[`packages/subagent/subagent-spawn-in-process/src/index.ts`][sa-spawn]、[`packages/subagent/subagent-acp/src/index.ts`][sa-acp]、[`packages/interaction/commands/src/index.ts`][cmd-register]
- npm 发布状态：执行 `npm view @deepseek-ai/dsh-skill dist-tags`（2026-09-27）得到的结果，见文首。

[cordis-service]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/service.ts#L32-L59
[cordis-reflect-provide]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/reflect.ts#L254-L305
[cordis-reflect-get]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/reflect.ts#L144-L166
[cordis-isolate]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/context.ts#L109-L125
[cordis-inject-type]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/registry.ts#L15-L19
[cordis-inject-norm]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/registry.ts#L71-L88
[cordis-ctx-inject]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/registry.ts#L300-L302
[cordis-fiber]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/fiber.ts#L597-L639
[shell-seam]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/shell/shell/src/index.ts#L30-L67
[tut-services]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/cordis-tutorial/03-services.md#L11-L42
[tut-pending]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/cordis-tutorial/03-services.md#L59-L76
[tut-optional]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/cordis-tutorial/03-services.md#L80-L90
[arch-145]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#L145
[arch-162]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#L162
[arch-profiles]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#L15-L27
[arch-launch]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#L45
[arch-seams]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#L129-L133
[arch-desktop]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#L55
[desktop-readme-5]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/README.md#L5
[preset-mount]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/src/mount.ts#L258-L267
[preset-readme-46]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/README.md#L46
[preset-readme-56]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/README.md#L56
[preset-readme-58]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/README.md#L58
[tool-bash]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/shell/tool-bash/src/index.ts#L34
[dsh-agents-138]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/AGENTS.md#L138
[glossary]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/glossary.md#L7-L9
[cookbook-pkg]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/cookbook/adding-a-package.md#L44-L50
[note-seams]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/.agents/notes/implemented/architecture/2026-06-13-capability-seams.md#L15-L25
[seams-doc]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/capability-seams.md#L1-L6
[seams-661]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/capability-seams.md#L661
[skill-ctx]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L283-L298
[skill-ctor]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L373-L377
[skill-api]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L390-L517
[skill-invalidate]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L621-L631
[skill-control]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L268-L275
[skill-rank]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L77-L84
[skill-source]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L39-L40
[skill-readme-inv]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/README.md#L99-L103
[skill-readme-138]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/README.md#L138
[fs-apply]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/src/index.ts#L133-L147
[fs-config]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/src/index.ts#L58-L62
[fs-watch]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/src/index.ts#L456-L506
[fs-coalesce]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/src/index.ts#L583-L592
[fs-roots]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/src/index.ts#L245-L265
[fs-list]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/src/index.ts#L187-L194
[fs-readme-81]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/README.md#L81
[ts-prestep]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/tool-skill/src/index.ts#L213-L251
[ts-digest]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/tool-skill/src/index.ts#L328-L335
[ts-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/tool-skill/README.md#L247-L248
[ts-inject]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/tool-skill/src/index.ts#L25
[ts-call]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/tool-skill/src/index.ts#L131-L141
[hooks-reload]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/hooks/hooks-claude-code/README.md#L175
[scope-key]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/scope/src/index.ts#L14-L15
[headless]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/bundle/headless/README.md#L12
[sdk-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/README.md#L12
[acp-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/bundle/acp-app/README.md#L12
[gw-faces]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/api-gateway.md#L99-L101
[webapp-patch]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/bundle/web-app/cordis.patch.yml#L42-L43
[desktop-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/README.md#L77-L79
[pm-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/plugin-manager/README.md#L31
[profile-patch]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts#L58-L75
[include-insert]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/include/src/index.ts#L76-L124
[conn-rpc]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/client/connection/src/rpc.ts#L127-L190
[ws-api]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/host/webserver/src/index.ts#L166-L200
[ws-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/host/webserver/README.md#L39
[gw-58]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/api-gateway.md#L58
[gw-123]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/api-gateway.md#L123
[gw-139]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/api-gateway.md#L139
[typert-remote]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/typert/protocol/src/index.ts#L166-L180
[sdk-switch]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/src/server.ts#L248-L259
[conn-auth]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/client/connection/README.md#L39-L41
[conn-trust]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/client/connection/README.md#L43
[conn-trust-src]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/client/connection/src/api-request-trust.ts#L91-L118
[conn-peer]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/client/connection/README.md#L45
[web-svc]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/web/web/src/index.ts#L91-L140
[web-exa]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/web/web-search-exa/src/index.ts#L32-L58
[web-call]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/web/tool-web/src/search.ts#L237-L246
[wf-svc]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow/src/index.ts#L157-L168
[wf-ptc]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/index.ts#L103
[wf-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/tool-workflow/src/index.ts#L433-L439
[wf-globals]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/runtime.ts#L83-L98
[wf-host]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/workflow/workflow-ptc/src/host.ts#L197-L210
[sa-svc]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/index.ts#L512-L559
[sa-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/tool-subagent/src/index.ts#L563
[sa-spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-spawn-in-process/src/index.ts#L1-L7
[sa-acp]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-acp/src/index.ts#L1-L7
[sa-sdk]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-dsh-sdk/src/index.ts#L1-L12
[cmd-register]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/interaction/commands/src/index.ts#L277-L292
[tools-register]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1057-L1063
[sessions]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/index.ts#L38-L41
[session-event]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/index.ts#L77
[fs-observed]: https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/fs/src/index.ts#L68-L77
