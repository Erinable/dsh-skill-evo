# Builder 任务（按阻塞依赖排序）

每条任务是一张可独立合并的 Builder 票；在前置任务合并后开始，完成时都能单独编译和测试。第一条是贯穿“写事实 → rotate → 读完整流 → refresh 派生”的最薄 tracer bullet。Mika 按这些任务原样拆票；本 spec 不创建实现票。

## Task 1 — 贯通 observation 轮转后的投影

- **Depends on:** none。
- **Requirements:** R-1, R-2, R-3, R-4, R-6, R-8, R-9。
- **实现范围:** 新增并导出 `state-root.ts` 的 `resolveLayout`、九个 descriptor 和最小可用的 `ObservationLog`（含 `appendMany`、`query`、严格归档解析、同锁 rotate）；`EvolutionService` 的 observations 和其余八个 store 路径改由 layout 构造，refresh 直接读取完整事实流。先以每次扫描完整归档保证判重正确，Task 2 再优化 append。保留现有 cursor 实现直到 Task 5；`ObservationLog.rotate` 可复用现有轮转底层逻辑，本任务不改变 retention 缺省值。
- **验收:** core `build`、`test` 通过。新增测试在临时 root 追加能产生 failure/cluster 的 observations，refresh 后 rotate，再 refresh，断言四个派生集合及 cluster/diagnosis id 前后相同；新实例追加已归档 id 返回 `false`，不同 basename 的 archive 不计入读/判重，覆盖 store 路径的 archive 位于覆盖文件旁；坏归档使 readAll/append 带路径失败。现有 `JsonlEventStore` 测试仍通过。

## Task 2 — 缓存归档 id，保持 append 成本可控

- **Depends on:** Task 1。
- **Requirements:** R-4, R-5, R-9。
- **实现范围:** `ObservationLog` 按归档段文件名缓存 id，并在同一实例的每次 append 前仅加载新增或已变化的段，删除消失段的缓存；当前文件每次重新读取。修复/轮转后的段变化必须能通过文件身份/元数据或显式失效被检测。保持 Task 1 的读取顺序与首现去重。
- **验收:** core `build`/`test` 通过。使用受控文件读取计数或等价测试证明连续 append 不重读未变归档内容，仍刷新当前文件；新增、原子修复同名段、删除段以及新进程重启后判重结果正确；两个进程并发追加同 id 最终只留一份。

## Task 3 — 接通 CLI、bundle 与 retention

- **Depends on:** Task 2。
- **Requirements:** R-1, R-4, R-6, R-7, R-15, R-16。
- **实现范围:** `retention.ts` 的 `rotateJsonl` 与 `ObservationLog.rotate` 共用命名/锁/retention 实现，缺省删除由 30 天改为关闭；CLI `rotate` 默认路径来自 layout 的 observation descriptor，`--store`/`--file` 优先级明确，删除 CLI 隐式传入的 30 天；bundle 的实时 adapter 改用 `ObservationLog`，维护 service 与它使用相同覆盖路径；CLI 和 bundle 的 proposal/evaluation 报告目录从 layout 取。保留 `JsonlEventStore`、`rotateJsonl` 导出与签名，并更新 `dsh-adapter/README.md` 示例为 `ObservationLog`、注明旧类当前文件语义。
- **验收:** core `build`/`test`、adapter `build`/`test`、bundle `test` 通过。CLI 临时目录测试证明 `--store` 默认轮转该文件、`--file` 可覆盖、缺省不删旧归档而显式 `--retention-days` 只删本 store 过期段；bundle 测试先归档再重放相同 id，断言实时观察文件未增加重复行。`rotateJsonl` 旧调用仍能工作，README 示例的导入存在。

## Task 4 — 让归档损坏可诊断、可修复

- **Depends on:** Task 2。
- **Requirements:** R-3, R-5, R-9, R-10, R-11。
- **实现范围:** `health.ts`、`service.health`/`healthReport` 和 `service.repair` 枚举与 `ObservationLog` 相同的匹配段；归档 health 校验 observation schema 与完整换行，repair 对每段执行 schema 校验、隔离坏行、报告每段结果。确定当前锁和段锁的顺序，修复期间不让 append/rotate 看见半修复段；修复后使既有实例的缓存失效。保留九个当前 store 的原有报告。
- **验收:** core `build`/`test` 通过。用混合好的/坏的 observation 归档和无关 basename 归档测试：坏 JSON、无效 schema、未换行残行均出现在 health 且 `readable: false`；readAll/append 在修复前报段路径；repair 报告对应 `JsonlRepairResult.path` 与 quarantine，修复后同实例/新实例 readAll 成功且有效记录保留；无关文件原字节不变。无 archive 目录的 health/repair 正常完成。

## Task 5 — 统一 cursor 写入者并修正 repair 报告

- **Depends on:** Task 4。
- **Requirements:** R-2, R-8, R-12, R-13, R-14。
- **实现范围:** `state-root.ts` 增加并导出 `readCursor`、原子 `writeCursor`、`fingerprintOf`；`service.refreshDerived` 支持内部 `force`，四个派生 store 写完再写 cursor；`service.repair` 删除 `{}` 覆盖并强制重投影；`repairEvolutionRoot` 保留导出和签名，但删掉独立 cursor 重建/删除与尾行 JSON.parse，报告 `projectionCursorRebuilt: false`；service 成功强制写 cursor 后报告 `true`。
- **验收:** core `build`/`test` 通过。测试先污染派生文件一行且保留匹配旧 cursor，调用 `service.repair()` 后派生数量/内容恢复、cursor 的 count/lastId/fingerprint 与完整事实流匹配且不是 `{}`；独立 `repairEvolutionRoot` 保持 cursor 字节不变、尾部残行不抛 cursor 解析异常、返回 false；注入重投影/写 cursor 失败时 `service.repair()` 抛错。旧版仅含当前段的 cursor 在首次 refresh 自愈。

## Task 6 — 收口剩余路径并同步文档

- **Depends on:** Task 3, Task 5。
- **Requirements:** R-1, R-14, R-15, R-17。
- **实现范围:** `lifecycle.ts` 的 candidates、publication locks、skill versions 和 `repair.ts` 的 orphan lock 目录改取 layout，保持磁盘位置；清理 service、CLI、bundle 中剩余状态路径字面量。更新 `docs/architecture-design-zh.md` §4.3 与 core/bundle README：集中目录、bundle 覆盖 store、归档属于事实、retention 缺省关闭、repair/cursor 报告新语义、旧已删归档的恢复限制。核对 `dsh-adapter/README.md` 与公开兼容 API 文案一致。
- **验收:** core `build`/`test`、adapter `build`/`test`、bundle `test` 通过。现有 lifecycle/锁/报告目录测试保持相同路径，新增或调整路径断言验证 `resolveLayout` 与旧磁盘布局逐项相等；搜索 `packages/skill-evolution/src`、core CLI、bundle 的 `.skill-evolution` 字面量，仅 `state-root.ts` 的布局定义可保留（文档/测试除外），宿主 `DSH_HOME/skill-evolution` 不受此约束。README 和架构图不再宣称每个 Skill 旁置 `evolution/` 是已实现布局。
