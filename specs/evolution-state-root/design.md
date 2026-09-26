# 设计：状态布局、事实流与 cursor

## 已确认决定与当前假设

**决定**（SKIL-47 票面记录的成员回复）：A1 不搬目录；A2 archive 是权威 observation 事实；A3 缺省不删 archive。采纳合并设计 `docs/design/evolution-state-root.md` §3 的 `state-root.ts`、§4 的三项修法、§5 的零迁移路径。公开的 `JsonlEventStore`、`rotateJsonl`、`repairEvolutionRoot` 均保留并标记旧用法，避免破坏依赖。`EvolutionRepairReport.projectionCursorRebuilt` 保持 boolean 字段但改成“本次调用确实完成重投影并写入 cursor”的含义。

**当前假设**（可由 Builder 读代码验证，不是待成员拍板）：归档命名、mtime retention、`JsonlHealth` 结构以及本机文件锁沿用现有实现；不存在需要迁移的另一套线上布局。旧版已删除的归档无法恢复，发布说明需说明此限制。`retentionDays` 是显式请求删除历史事实，调用方承担数据缩减后派生变化的结果。

## 模块边界与接口

`packages/skill-evolution/src/state-root.ts` 是状态路径和 observation 逻辑流的 owner，并从 `src/index.ts` 导出：

```ts
type StoreRole = 'fact' | 'derived'
type StoreName = 'observations' | 'proposals' | 'decisions' | 'feedback' | 'evaluations'
  | 'experiences' | 'failures' | 'clusters' | 'diagnoses'
interface StoreDescriptor {
  readonly name: StoreName
  readonly path: string
  readonly role: StoreRole
  readonly projectionInput: boolean
}
interface EvolutionLayout {
  readonly root: string
  readonly stateDir: string
  readonly cursorPath: string
  readonly locksDir: string
  readonly candidatesDir: string
  readonly proposalReportsDir: string
  readonly evaluationReportsDir: string
  readonly stores: readonly StoreDescriptor[]
  readonly observations: StoreDescriptor
  skillVersionsDir(skillName: string): string
}
function resolveLayout(options: { readonly root: string; readonly observationStore?: string }): EvolutionLayout
interface ProjectionCursor { readonly count: number; readonly lastId?: string; readonly fingerprint?: string }
function readCursor(path: string): Promise<ProjectionCursor | undefined>
function writeCursor(path: string, cursor: ProjectionCursor): Promise<void>
function fingerprintOf(ids: readonly string[]): string
class ObservationLog {
  constructor(readonly filePath: string)
  append(event: RuntimeObservation): Promise<boolean>
  appendMany(events: readonly RuntimeObservation[]): Promise<number>
  readAll(): Promise<RuntimeObservation[]>
  query(query?: ObservationQuery): Promise<RuntimeObservation[]>
  rotate(options: { readonly maxBytes: number; readonly retentionDays?: number }): Promise<RetentionResult>
}
```

`ObservationLog.filePath` 保持 service 现有调用形状；`currentPath` 可作为同值别名。`resolveLayout` 只拼路径，不创建目录。九个 descriptor 依次覆盖五个 fact 和四个 derived；`observationStore` 仅替换 observations 的 `path`。`archive/` 相对于 `ObservationLog.filePath` 计算，不相对于 `stateDir`。报告目录和 `skillVersionsDir` 也从 layout 取，消掉 CLI、bundle 和 lifecycle 对 `.skill-evolution` 的重复认识。`JsonlRecordStore` 仍管理其余八个文件，不将它们的 archive 当作投影事实。

## 事实流与热路径

所有 observation 操作沿用 `${filePath}.lock`；rotate 与 append 使用同一把锁。枚举仅接受属于当前 basename 且符合现有 rotate 名称约定的普通文件，按文件名排序，随后读取当前文件。跨段重复 id 按首现保留原始顺序，不重写历史。`query` 在这个逻辑流上使用现有 `ObservationQuery` 过滤。归档是只读段；只有显式 `repair`（先隔离无效内容）或带 `retentionDays` 的 rotate 可以修改或删除归档。

每个 `ObservationLog` 实例维护 `Map<段文件名, {ino, size, mtimeMs, ids}>`。每次 append 在当前文件锁内先列出匹配段及元数据：新段读一次，签名变化的段重读，消失的段删缓存；未变的段不读内容。然后仅刷新当前文件的 id，作跨历史判重，最后追加。`repairJsonlFile` 用临时文件加 `rename` 原子替换归档，inode 随之改变；其他长驻进程也会在下次扫描时发现该签名变化，无需进程内通知。新进程从文件扫描构建缓存。这样一次 append 的归档内容读取成本为“新增/变化段”，当前文件仍按旧实现每次重读；归档文件的目录枚举和 stat 成本随段数增长，不承诺常数时间。

旧归档中的完整坏行、无效 schema、未换行尾部残行都使 archive 读取和 append 带路径失败，避免把残缺事实当成完整流。当前文件保留现有 `parseLines` 的尾部残行容忍行为；repair 可隔离它。health 必须把 archive 的 schema 错误和残行都判为不可读；可以扩展 `inspectJsonlHealth` 的可选校验器，保持 `JsonlHealth` 返回结构。缺失 `archive/` 正常，权限或 I/O 错误向调用方报告/抛出，不能伪装为空历史。

## rotate、retention 与兼容 API

`ObservationLog.rotate` 在当前文件锁内轮转。达到阈值时先检查当前文件最后一个换行符：之后如有字节，先原样写到 `${path}.invalid-*`；写入失败则保持当前文件原样并抛带路径的错误。隔离成功后原子地把当前文件替换为“截至最后一个换行符的完整前缀”，再按原命名约定将该前缀归档、建立空当前文件。若整个文件都没有换行符，前缀为空，仍创建空归档段；返回值新增可选 `invalidQuarantine` 告知隔离路径。中途崩溃时，完整前缀留在当前或归档之一，尾部原始字节留在当前或隔离文件，不能静默丢弃。尾部残行在轮转前不属于可读取的事实；轮转后完整事实流可读且新 append 可写。

公有 `rotateJsonl(path, options)` 保持参数签名，和 `ObservationLog.rotate` 共用上述尾部隔离、归档命名和锁实现，避免双重获取同一把锁；其通用 JSONL 文件也按最后一个换行符处理，不解析 observation schema。显式 `retentionDays` 才枚举并删除本 basename 的过期段；缺省 `deleted: []`，不删除。CLI 无 `--file` 时用 `resolveLayout({root, observationStore: --store}).observations.path`；`--file` 仍可轮转指定的通用 JSONL 文件。bundle 的默认 `DSH_HOME/skill-evolution/events.jsonl` 和 `config.storePath` 都通过 `observationStore` 覆盖传给 layout；实时 adapter、维护 service 使用同一路径。`JsonlEventStore` 保留原来的仅当前文件行为供既有用户过渡，README 明确建议新的 observation 集成改用 `ObservationLog`；不将其包装成完整流并误导调用方。

## health、repair 与 cursor 数据流

`service.health()` 用 layout 的九个当前文件加上匹配 observation 归档段，逐个产生原有 `JsonlHealth`。`healthReport()` 保持 `{ jsonl, skillIssues }`。`service.repair()` 用同一清单修复；归档 observation 段与当前 observation 都调用 observation schema 校验，其他八个 store 保持现有校验行为。`JsonlRepairResult.path` 标识每一段，坏行保存在该段旁边的 `.invalid-*` 文件。修 observation 当前文件和归档段时统一先持有 `${observationsPath}.lock`，在锁内调用不再自行获取该锁或段锁的 repair helper；其余八个 store 沿用各自的文件锁。这个顺序使 append/rotate/readAll 不会看到半修复段，也没有当前锁与段锁的循环等待。跨段重复只在逻辑读取时按首现过滤，本次修复不跨段改写有效事实。

`repairEvolutionRoot` 保持现有 `root + options` 签名、锁清理和 manifest 检查；它不再从 observations 猜测派生新鲜度，既不写也不删 cursor，单独调用时 `projectionCursorRebuilt` 为 `false`。`observationsPath` 兼容接受，可标记 deprecated。`service.repair()` 修好 JSONL 后强制调用 `refreshDerived({ force: true })`；该方法复用 cursor 锁，跳过 fingerprint 命中捷径，从 `ObservationLog.readAll()` 重建四个派生文件，全部成功后由 `writeCursor` 原子写入 cursor，再返回 `projectionCursorRebuilt: true`。`fingerprintOf` 仍使用现有 `createContentHash(ids.join('\n'))` 算法；同一个函数供 refresh 使用，repair 不另算。若事实读取、派生写入或 cursor 写入失败，repair 抛错，不返回成功报告；下次 refresh 因旧/坏 cursor 可重试。无需把 cursor 写成 `{}`，也不能仅删除该覆盖而保留独立 repair 的虚假重建。

## 迁移、失败与回滚

没有文件搬迁或 schema 迁移。升级后完整归档加入 fingerprint，旧 cursor 不匹配时触发一次重投影；旧版本清空的派生在归档仍在时能恢复，确定性 cluster/diagnosis id 不变。若历史归档已被旧默认 30 天策略删除，只能从剩余事实恢复；这需要写进维护文档。回滚旧代码不会修改文件，但旧代码只读当前段，三个旧问题会重新出现。显式 retention 删除段后，同一进程缓存失效，后续 refresh 以剩余事实为准。文件锁只承诺现有单机本地文件系统语义。

## 验证策略与风险边界

- 核心测试覆盖现有路径和覆盖路径、混杂归档过滤、按序首现去重、跨进程重复 append、轮转前后四类派生和 proposal 引用 id、旧 cursor 自愈。
- 用可观测的文件读取次数或受控文件访问桩证明第二次 append 不重读未变归档；修复、轮转、新进程和删除后重新判重各有断言。
- 当前文件只有未换行尾部、或“完整 observation 行 + 未换行尾部”时分别 rotate：断言原始尾部字节可从 `invalidQuarantine` 找回，归档无残行，`readAll` 返回原有完整记录，后续 append 成功；公有 `rotateJsonl` 使用同一规则。
- 归档损坏测试覆盖完整坏行、schema 错误、残行：`readAll`/append 报路径，health 标红，repair 隔离后恢复读取；不匹配归档不受影响。
- 派生文件坏行测试覆盖 repair 强制重投影、cursor 的 `count/lastId/fingerprint` 真值、独立 `repairEvolutionRoot` 不碰 cursor，以及写入失败时不报告成功。
- 分别运行 core 的 `build`/`test`、adapter 的 `build`/`test`、bundle 的 `test`。CLI 用临时目录验证 `--store`/`--file`/缺省 retention；文档核对路径字面量只在 `state-root.ts`（DSH 宿主默认 store 路径除外）。
