## Scope and source of truth

This spec implements the merged design in `docs/design/unified-lock-protocol.md` (upstream PR #16, merge `e12b334`). The design's interface, classification table, three-layer reclamation protocol, migration order, and test matrix are normative. The implementation scope is `packages/skill-evolution`; no DSH adapter or bundle import is introduced.

## Decisions

- **D1 (accepted default):** `unknownGraceMs` defaults to 600000 ms (10 minutes). This protects empty/corrupt v0 locks during mixed-version deployment.
- **D2 (accepted default):** delete `withFileLock` and `removeDeadLock`; repository callers migrate to `withLock`. The package is 0.1.0 and no repository call site uses those names after migration.
- **D3 (accepted default):** a `held` lock is never reclaimed because of age. Reclaiming a demonstrably live owner could permit concurrent JSONL writes or publication.
- **F1:** owner records are v1 `{v, token, pid, hostname, createdAt, uptimeMs, operation}`; v0 records lacking `v`, `token`, and `uptimeMs` remain readable.
- **F2:** lock paths remain `<resource>.lock` and `.skill-evolution/locks/<skill>.lock`.
- **F3:** `locking.ts` depends only on Node modules; lifecycle depends on it; no DSH dependency is added.
- **F4:** `EvolutionRepairReport.locks` is additive.
- **F5:** internal protocol artifacts are `<lock>.<token>.tmp`, `<lock>.reclaim`, and `<directory>/.lock-sweep.lock`.

## Interface contract

```ts
type LockState =
  | { readonly kind: 'free' }
  | { readonly kind: 'held'; readonly owner: LockOwner; readonly ageMs: number }
  | { readonly kind: 'foreign'; readonly owner: LockOwner; readonly ageMs: number }
  | { readonly kind: 'dead' | 'rebooted'; readonly owner: LockOwner; readonly ageMs: number }
  | { readonly kind: 'unknown'; readonly ageMs: number; readonly reclaimable: boolean }

interface LockOwner {
  readonly v?: 1
  readonly token?: string
  readonly pid: number
  readonly hostname: string
  readonly createdAt: string
  readonly uptimeMs?: number
  readonly operation?: string
}

interface LockOptions {
  readonly waitMs?: number
  readonly unknownGraceMs?: number
}

class LockBusyError extends Error {
  readonly path: string
  readonly state: LockState
  readonly guard?: string
}

interface SweptLock {
  readonly path: string
  readonly artifact: 'lock' | 'guard' | 'tmp'
  readonly state: LockState['kind'] | 'skipped'
  readonly operation?: string
  readonly ageMs?: number
  readonly removed: boolean
}

withLock<T>(path: string, operation: string, fn: () => Promise<T>, options?: LockOptions): Promise<T>
inspectLock(path: string, options?: Pick<LockOptions, 'unknownGraceMs'>): Promise<LockState>
reclaimLock(path: string, options?: Pick<LockOptions, 'unknownGraceMs'>):
  Promise<{ readonly state: LockState; readonly removed: boolean; readonly guard?: string }>
sweepLocks(
  target: { readonly directories: readonly string[]; readonly paths: readonly string[] },
  options?: Pick<LockOptions, 'unknownGraceMs'>,
): Promise<readonly SweptLock[]>
hasCode(error: unknown, code: string): boolean
```

`withLock`, `inspectLock`, `reclaimLock`, and `sweepLocks` call one internal classifier. `withLock` is scope-based and non-reentrant; caller write/mutation queues remain where they are. `LockBusyError.state` is the final observation and `guard` identifies an orphan reclaim guard so callers can direct operators to repair.

## Data flow and invariants

1. `withLock` serializes contenders by atomically linking a fully written owner tmp file into the requested lock path.
2. On `EEXIST`, it inspects the same path and can reclaim only `dead`, `rebooted`, or expired `unknown`; `held` and `foreign` remain protected.
3. Reclamation acquires `<path>.reclaim`, rechecks the target, removes only a still-reclaimable target, and releases the guard by token. Normal contenders never remove guards.
4. Repair acquires a per-directory sweep lock, removes eligible orphan guards, reclaims locks, and then removes eligible tmp files. Shared observation directories are handled by explicit paths so unrelated projects are not scanned. A stale guard for the directory lock itself prevents the sweep and is surfaced with its guard path for manual removal; it is not emitted as an ordinary artifact entry.
5. Scope release compares the acquired token before unlinking, so a replacement lock cannot be deleted by an old owner.
6. `repairEvolutionRoot` maps sweep results into additive legacy arrays and the new `locks` report field.
7. Publication recovery remains the existing `.publish.json` flow; only lock acquisition/reclaim behavior changes. Mutation queues and lock locations remain unchanged.

## Error handling

- Missing files classify as `free`.
- Malformed/empty/incomplete owner data classifies as `unknown`; the mtime grace rule is the only reclaim decision for unknown.
- Different hostname classifies as `foreign` and is retained.
- Process probe `ESRCH` classifies as `dead`; success/`EPERM` as `held`.
- Link, filesystem, and JSON errors outside the protocol's defined classification are surfaced with their original context.
- A live owner or orphan guard at the wait deadline produces `LockBusyError`; publication callers preserve their existing domain message and add owner operation/pid diagnostics.
- Token mismatch or missing path during release is a non-fatal cleanup condition.

## Testing strategy

Use real files and real processes; do not mock filesystem, clock, or process probing. Construct dead pids from exited child processes, live pids from the current process, rebooted v1 locks with `uptimeMs` one day ahead, v0 rebooted locks with epoch `createdAt`, foreign locks with another hostname, and unknown locks with mtime inside/outside the grace period. Test wall-clock jumps by pairing an old `createdAt` with a current v1 `uptimeMs`. Test crash recovery by SIGKILLing a child after `current.json` is written and before invalidate completes.

The complete required scenarios are listed in `tasks.md`: L1–L15 and L11b for the module, P1–P3 and P1b for publication locking, and R1–R5 for repair. Each task names its subset and exact acceptance evidence.

## Known accepted risks

- v0 and unknown classifications still depend on wall-clock mtime/createdAt during mixed-version operation.
- A reboot detected after current uptime passes the recorded v1 uptime can conservatively leave a pid-reused lock as held.
- Mixed old/new reclaimers can retain the documented race until all processes are upgraded.
- An orphan reclaim guard blocks normal acquisition until repair; a stale directory-lock guard is surfaced by the skipped sweep result and requires manual removal.
- Local filesystem and same-host scope is intentional.
