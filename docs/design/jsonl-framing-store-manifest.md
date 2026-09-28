> 状态：SKIL-111 设计提案（父 issue SKIL-110，来源：架构扫描第 3 期 SKIL-109 的编号 1、2）。决策见 ADR-0020（`proposed`）。
> 本文合并后冻结，不随代码更新；与现状不一致时以代码、ADR 和 spec 为准。

本文覆盖两件事：JSONL 分帧只有一处实现，崩溃留下的残行不再和下一条记录拼在一起；`service.ts` 的 store 清单只从 `layout.stores` 读。基线是 `origin/main` @ `35930ec`。本文只出设计，不写实现代码。

## 1. 现状

### 1.1 读了什么

- `packages/skill-evolution/src/`：`records.ts`、`store.ts`、`state-root.ts`、`events.ts`、`health.ts`、`repair.ts`、`service.ts`（全文），`retention.ts`、`index.ts`、`locking.ts`（相关段落）。
- 调用方：`packages/dsh-bundle/index.js:4,124,189,196-197`、`packages/skill-evolution/bin/dsh-skill-evolution.mjs:23,89,177,190`、`packages/dsh-adapter/src/adapter.ts`。
- 测试：`tests/core.spec.ts`、`tests/repair.spec.ts:95-112`、`tests/archive-health-repair.spec.ts:40-160`。
- 文档：`CONTEXT.md`、ADR-0002、0003、0006、0007、0016、0019，`docs/design/evolution-state-root.md`，`docs/governance/documentation.md`，`docs/agents/domain.md`。
- 基线：`npm run build` 通过，`npx vitest run tests` 输出 `Tests  111 passed (111)`。

### 1.2 分帧散在七处，规则各不相同

「一条记录是什么」目前在七个地方各写了一遍：

| 位置 | 对尾部 `\n` 之后字节的处理 |
|---|---|
| `records.ts:91-99`（`parseLines` / `completeLines`，`:63`、`:77` 另有两份循环） | 读时丢弃；append 时不管，直接接在后面写 |
| `store.ts:94-99`（`JsonlEventStore`） | 同上 |
| `state-root.ts:175,249-253`（`ObservationLog` 当前文件） | 同上 |
| `state-root.ts:164-167`（Archive segment） | 抛错 `unterminated line` |
| `state-root.ts:217-224`（`rotateFile`） | 隔离到 `<path>.invalid-<ms>-<pid>-<uuid>`，只归档完整部分 |
| `health.ts:22-39` | 按一行记录解析；能解析就计入 `completeRecords` |
| `repair.ts:54-79` | 能解析就封口保留；不能解析就隔离到 `<path>.invalid-<ms>-<hex>`，另一种命名 |

三个 append 入口（`records.ts:18`、`store.ts:30`、`state-root.ts:116`）都不检查文件是否以 `\n` 结尾。

### 1.3 复现（`35930ec`，build 之后用一次性脚本跑，脚本已删除）

**probe A**：`JsonlRecordStore` 的文件尾部有残行 `{"id":"b","torn":tr`。

```text
A append c -> true
A readAll throws: Unexpected token '{', ...","torn":tr{"id":"c"}" is not valid JSON
A append d throws: Unexpected token '{', ...","torn":tr{"id":"c"}" is not valid JSON
```

`c` 接在残行后面，和它拼成一行完整的非法行。之后 `readAll` 和 `append` 一直抛错，要等 repair 才能恢复，而 repair 会把 `c` 连同残行一起隔离。

**probe B**：`EvolutionService` 的 `observations.jsonl` 在 `e1` 之后留下 30 字节残行，然后 `recordObservation(e2)`。

```text
B obs append e2 -> true
B readAll throws: Expected ',' or '}' after property value in JSON at position 32 (line 1 column 3
B repair: 1 1 0
B after repair ids: [ 'e1' ]
```

`e2` 的 append 返回了 `true`，但 repair 之后它不在 Observation log 里了，违背 ADR-0002。

**probe C**：尾部是一条能解析、只缺 `\n` 的记录 `{"id":"a"}\n{"id":"b"}`。三个读取方给出三种答案：

```text
C health valid-json tail: {...,"completeRecords":2,"trailingPartial":true}
C readAll ids: [ 'a' ]
C repair: {"validRecords":2,...,"truncatedTrailingBytes":0} "{\"id\":\"a\"}\n{\"id\":\"b\"}\n"
```

另外，残行里的 UTF-8 被截断时，`repair.ts:83` 会把它按字符串写进隔离文件，原始字节就丢了。

### 1.4 store 清单有三份

`resolveLayout`（`state-root.ts:50-61`）是唯一的 store 清单，`service.ts` 却另外手写了两份：

- 构造：`service.ts:62-71`，按名字从 `layout.stores` 取路径，逐个 `new`。
- `health()`：`service.ts:138`，手写 9 个 `filePath`，顺序和 `layout.stores` 不同。当前 observation 文件没有传 schema 校验，Archive segment 传了（`:140-141`）。
- `repair()`：`service.ts:150`，手写 8 个，observations 和它的 Archive segment 在 `:153-158` 单独处理。

以后加一个 store（扫描编号 4 的 Promote / Rollback 可恢复很可能要加一个），在 `resolveLayout` 和构造里加上之后，漏改 `health()` / `repair()` 编译器也不会报错。结果是新文件从不做健康检查，也不会被修复。

## 2. 设计问题与选项

### 2.1 残行怎么处理（磁盘格式，ADR-0020）

| 选项 | 做法 | 取舍 |
|---|---|---|
| A 封口 | append 前补 `\n` | 改动最小，但残行会变成一整行非法记录：`JsonlRecordStore` 仍然卡住（probe A 的形态不变），Observation 那边要等 repair，而 repair 会把它隔离 |
| B 截断 | append 前截断到最后一个 `\n` | 读写都简单，但会悄悄丢字节，和 Rotation、repair「保留非法输入」的惯例冲突 |
| **C 隔离再截断** | 写入方持锁，先把残行原样写进 `<path>.invalid-…`，再截断，然后写 | 比 B 多一次写文件，残行字节可以追溯；读取方只需跳过残行 |
| D 按可否解析区分 | 能解析就封口保留，否则隔离（今天 `repair.ts` 的做法） | 「是不是记录」由解析器决定，三个读取方会继续不一致（probe C） |

**推荐 C。** 理由和被否选项写在 ADR-0020。

规则的两侧：

- **读取**（`readAll`、`query`、去重时的 `refreshKnownIds`、`ObservationLog.readFacts` 的当前文件）：只处理最后一个 `\n` 之前的完整行。空行和只含空白的行跳过。残行跳过，不改文件。完整行解析失败就抛错，和今天一样，因为这是真正的损坏，要交给 repair 处理。
- **Archive segment**：只读。残行抛错（保持 `state-root.ts:164` 的行为），只有 repair 隔离它。
- **写入**（三个 append 入口、`rotateFile`、repair）：持 `<path>.lock`。有残行就先隔离再截断，然后写入。`replaceAll` 和 repair 的整文件改写本来就是临时文件加 `rename`，不会留下残行。
- **health**：只读，不持锁。`trailingPartial` 如实报告；`completeRecords` 不计残行。当前文件有残行不算不可读（可能只是有写入正在进行）；Archive segment 有残行算不可读（沿用 `requireTrailingNewline`）。

### 2.2 分帧放在哪个 module、interface 什么形状

| 选项 | 做法 | 复杂度 | 可测性 | 可逆性 | 迁移成本 |
|---|---|---|---|---|---|
| **A 新 module `jsonl.ts`**，只管分帧，不持锁、不解析 schema | 纯函数 `splitFrames` 加一个带 IO 的 `appendFrames`，调用方持锁并解析 | 低 | 纯函数可以直接喂 `Buffer` 测；`appendFrames` 用真文件测 | 高：内部 module，不从 `index.ts` 导出 | 七处调用点逐个替换，每处都很小 |
| B 统一成一个泛型 store 类，`JsonlEventStore` 和 `JsonlRecordStore` 合并 | 类里包含锁、队列、去重和分帧 | 中 | 只能经由整个 store 来测 | 中：`JsonlEventStore` 是导出类 | 需要处理 `ObservationLog` 的跨归档逻辑。ADR-0003 要求去重留在 observation log 类里，所以它合并不进来，最后还是两套 |
| C 放进 `events.ts` | 和 `serializeObservation` / `parseObservation` 并列 | 低 | 同 A | 高 | `events.ts` 管的是 Observation 的 schema，派生 store 也要依赖它，职责混在一起 |

**推荐 A。** 锁由调用方持有：`ObservationLog` 在一把锁里要读多个 Archive segment 和当前文件，repair 也有 `repairJsonlFileUnlocked` 这种由调用方持锁的路径。分帧 module 如果自己拿锁，就会和这两处打架。B 可以留作以后的深化，本票不做。

Interface 草图（名字留给 Spec Writer 定，语义以此为准）：

```ts
// jsonl.ts — 分帧规则的唯一实现（ADR-0020）。只依赖 node:*。
// 所有带 IO 的函数都要求调用方已持有 `${path}.lock`。

/** 纯函数：切出完整行（不含 '\n'，已去掉空白行）和最后一个 '\n' 之后的原始字节。 */
export function splitFrames(bytes: Buffer): { readonly lines: readonly string[]; readonly tail: Buffer }

/** 读取文件并分帧；文件不存在时返回空结果。 */
export function readFrames(path: string): Promise<{ readonly lines: readonly string[]; readonly tail: Buffer }>

/**
 * 追加若干条已序列化的记录（不含 '\n'）。有残行时先原样写入 quarantinePath(path)，
 * 再截断到最后一个 '\n'，然后一次写入 `lines.join('\n') + '\n'`。
 * 隔离失败时抛错，什么都不写。
 */
export function appendFrames(path: string, lines: readonly string[]): Promise<{ readonly quarantined?: string }>

/** 隔离文件的唯一命名：`${path}.invalid-${ms}-${pid}-${uuid}`。 */
export function quarantinePath(path: string): string
```

各调用点的收敛方式：

| 调用点 | 改成 |
|---|---|
| `records.ts:13-21,59-82,91-99` | 读用 `readFrames` 再逐行 `JSON.parse`；append 用 `appendFrames`；删掉 `parseLines` / `completeLines` |
| `store.ts:25-33,70-99` | 同上，逐行用 `parseObservation` |
| `state-root.ts:111-118,174-175,249-253` | 当前文件用 `readFrames`，append 用 `appendFrames`；删掉 `completeLines` |
| `state-root.ts:163-167`（Archive segment） | `readFrames`，`tail.length > 0` 时抛错，错误消息不变 |
| `state-root.ts:217-224`（`rotateFile`） | `splitFrames` 加 `quarantinePath` |
| `health.ts:21-39` | `splitFrames`；`trailingPartial = tail.length > 0`；`completeRecords` 只数 `lines` |
| `repair.ts:54-85` | `splitFrames` 用 `Buffer` 读。残行不论能否解析，都原样写进隔离文件并计入 `removedInvalidLines`；`truncatedTrailingBytes = tail.length`；隔离文件名用 `quarantinePath` |
| `events.ts` | 保留逐行的 `serializeObservation` / `parseObservation`。新增导出 `isObservationValue`，替换 `service.ts:215-217` 和 `repair.ts:105-107` 的两份重复实现 |

`repair.ts` 今天把隔离内容当字符串写（`:83`），截断的 UTF-8 因此会丢字节。改为 `Buffer` 后，隔离文件的内容是「非法完整行用 `\n` 连接、末尾加 `\n`，后面接残行的原始字节」。

### 2.3 store 清单怎样只从 `layout.stores` 读

| 选项 | 做法 | 取舍 |
|---|---|---|
| **A `health()` / `repair()` 遍历 `layout.stores`** | 构造仍然按名字取路径，保留公开的类型化字段；`health()` 和 `repair()` 不再手写路径 | 改动只在 `service.ts`。加 store 时，只要改了 `resolveLayout`，health 和 repair 就自动覆盖 |
| B service 用 `Map<StoreName, store>` 持有全部 store，字段改成 getter | 构造也遍历 layout | 要维护一张 `StoreName → 记录类型` 的类型映射，公开字段从属性变成 getter，改动比 A 大，但修的是同一个问题 |
| C 保留三份清单，加一致性测试 | 测试断言三份相同 | 最便宜，但三份仍然在，这类做法以前被否过（ADR-0004 否掉「双份 + 一致性测试」） |
| D `EvolutionLayout` 加 `storesByName: Record<StoreName, StoreDescriptor>` | 构造改用 `layout.storesByName.proposals.path`，漏配时编译期报错 | 公开 interface 只做加法，和 A 可以叠加。本票不需要，留给以后按需要加 |

**推荐 A。** 具体做法：

- `health()`：对 `layout.stores` 里的每个 store 调 `inspectJsonlHealth`。observations 传 `parse: isObservationValue`，它的 Archive segment 继续传 `parse` 和 `requireTrailingNewline`。输出顺序改为 `layout.stores` 的顺序，后面接 Archive segment。当前 observation 文件今天没做 schema 校验，改后会校验，health 和 `readAll` 的判断从此一致。
- `repair()`：`jsonlPaths = layout.stores.filter(s => s !== layout.observations).map(s => s.path)`，observations 和它的 Archive segment 仍然在 observations 的锁里单独修（`service.ts:153-158` 不变）。`repairEvolutionRoot` 的签名不变。
- 构造：`service.ts:62` 的 `find(...)!` 保留。它在构造时就会失败，不会带病运行。

### 2.4 这两条 seam 将来会被什么拉扯

- **`jsonl.ts`**：持久性策略（append 后要不要 `fsync`，隔离文件要不要先 `fsync` 再截断）；将来帧格式升级到 v2（长度前缀或校验和），会整体换掉这个 module，调用方不用动；`appendMany` 要求原子批量写时，`appendFrames(path, lines[])` 已经能接住。
- **`layout.stores`**：扫描编号 4（Promote / Rollback 可恢复）很可能加一个意图日志 store；每个 store 要有自己的 schema 校验时，可以给 `StoreDescriptor` 加一个 `parse`；按 store 做 Retention。这些都只改 `resolveLayout` 这一处。

## 3. 推荐方案小结

新增 `jsonl.ts`，这是分帧规则（ADR-0020）的唯一实现：写入方持锁时先隔离残行、再截断、然后写入，读取方跳过残行，Archive segment 遇到残行报错。七处分帧代码都改用它，Observation 的 schema 校验收进 `events.ts`。`service.ts` 的 `health()` / `repair()` 改为遍历 `layout.stores`。

依赖方向：`records.ts`、`store.ts`、`state-root.ts`、`health.ts`、`repair.ts` → `jsonl.ts` → `node:*`。这是新增的叶子 module，不产生环，也不触碰 ADR-0014（core 不依赖 DSH 内部）。

### 与已有 ADR 的关系（Flag ADR conflicts）

- **ADR-0016**（事实 append-only）：_字面上有张力。写入方会截断事实文件的尾部，但没有被推翻。_ 截断的只是没有确认写入的残行，它不是记录，字节也原样保存在隔离文件里。ADR-0020 把这个解释写明了。
- **ADR-0002、ADR-0003**：不冲突。本方案补上的正是 ADR-0002 在 probe B 里被打破的保证。去重仍然在 `ObservationLog` 里做。
- **ADR-0006**：不冲突。repair 和 health 仍然是 core 的维护用例，CLI 和 bundle 的调用方式不变。

## 4. Builder task 边界与迁移顺序

每一步都可以单独合并，合并后三个包的测试都要保持全绿。

| # | 内容 | 依赖 | 验证 |
|---|---|---|---|
| T1 | 新增 `jsonl.ts` 和 `tests/jsonl.spec.ts`，不改调用方 | 无 | `splitFrames`：无尾、有尾、能解析的尾、截断的 UTF-8 尾、空白行、空文件；`appendFrames`：无尾时直接追加；有尾时隔离文件的字节和原尾逐字节相同，追加后文件是「完整部分 + 新行」；隔离失败时（如目录只读）文件不变 |
| T2 | `JsonlRecordStore`、`JsonlEventStore` 改用 T1 | T1 | **probe A** 写成测试：残行之后 `append(c)` 为 `true`，`readAll` 返回 `[a, c]`，`append(d)` 成功，残行出现在一个 `.invalid-` 文件里；`JsonlEventStore` 做同样的测试 |
| T3 | `ObservationLog`（当前文件读写、Archive segment 读取）和 `rotateFile` 改用 T1 | T1 | **probe B** 写成测试：`EvolutionService` 的 observations 在 `e1` 之后留 30 字节残行，`recordObservation(e2)` 为 `true`，`readAll` 返回 `[e1, e2]`；`repair()` 之后仍是 `[e1, e2]`，observations 那一项 `removedInvalidLines` 为 `0`。再测：同一 id 在截断之后重投递，只出现一次（ADR-0003）；Rotation 的隔离文件名用的是 `quarantinePath` |
| T4 | `health.ts`、`repair.ts` 改用 T1，`isObservationValue` 收进 `events.ts` | T1 | **probe C** 写成测试：同一个带「能解析的尾」的文件，`readAll` 数 1 条，health 的 `completeRecords` 也是 1，repair 的 `validRecords` 也是 1，`truncatedTrailingBytes` 等于尾部字节数；截断 UTF-8 的尾部原样进隔离文件；现有 `repair.spec.ts:104-112` 和 `archive-health-repair.spec.ts:40-67` 仍然通过 |
| T5 | `service.ts` 的 `health()` / `repair()` 改为遍历 `layout.stores` | 无，可以和 T1 并行 | `health()` 的路径集合 = `layout.stores` 的路径 ∪ Archive segment；`repair().jsonl` 的路径集合同样如此；当前 observation 文件里有一条 schema 非法的记录时，health 报 `readable: false` |

顺序：T5 和 T1 可以同时开始；T2、T3、T4 都只依赖 T1，互相独立。T3 是修复 Observation 丢失的关键一步，建议排在 T2 之后、T4 之前，这样 probe B 先落地。

兼容性风险（Spec Writer 需要在对应 task 里标注）：

- **R-mixed**：部署期间旧版进程追加时不先隔离，仍然可能把残行和新记录拼成一行。所有进程都升级之后，这个风险才消失。
- **R-foreign-tail**：外部工具写出的 JSONL 如果最后一条记录没有 `\n`，第一次 append 时这条记录会被隔离。能从隔离文件里找回，但不会自动恢复。
- **R-double-quarantine**：写完隔离文件之后、截断之前如果崩溃，下一次 append 会再隔离一次，留下两份内容相同的隔离文件。只是多占空间，不会丢数据。
- health 输出顺序改变（T5），CLI 和 bundle 的 `health` JSON 里数组顺序会变。仓库内的测试都按路径 `find`，不依赖顺序。

验收时要跑的命令：

```bash
cd packages/skill-evolution && npm test
cd ../dsh-adapter && npm test
cd ../dsh-bundle && npm test
```

## 5. 不可逆决策

- **ADR-0020**：JSONL 记录以 `\n` 结尾；残行不是记录，持锁的写入方先把残行隔离到 `<path>.invalid-<ms>-<pid>-<uuid>` 再截断，然后写入；读取方跳过残行，Archive segment 遇到残行报错。**待成员确认**，ADR 当前为 `proposed`。

以下取舍可逆，采用默认答案，成员可推翻：`jsonl.ts` 作为内部 module，不从 `index.ts` 导出（§2.2 A）；store 清单按 §2.3 A 处理，不改 `EvolutionLayout`；health 对当前 observation 文件加 schema 校验，输出顺序跟随 `layout.stores`。
