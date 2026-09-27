## Scope

This specification makes the merged unified lock protocol in `docs/design/unified-lock-protocol.md` independently verifiable for `packages/skill-evolution`. The scope is the locking module, its existing core call sites, publication locking, repair coverage and lock reporting. It does not change `dsh-adapter`, `dsh-bundle`, state-root layout, or the caller-owned in-process queues.

## Requirements

### R1. Lock acquisition writes a complete owner record atomically

WHEN `withLock(path, operation, fn, options?)` acquires a lock THE SYSTEM SHALL create the lock at the requested path using a same-directory tokenized temporary file and an atomic `link()`, and the lock content SHALL be JSON with `v: 1`, a UUID `token`, positive integer `pid`, local `hostname`, ISO `createdAt`, integer `uptimeMs`, and the caller's `operation`; a successful scope SHALL remove its temporary file and release its lock after `fn` settles.

### R2. Lock inspection exposes the single classification table

WHEN `inspectLock(path, options?)` reads a lock THE SYSTEM SHALL classify it as exactly one of `free`, `unknown`, `foreign`, `rebooted`, `dead`, or `held` using the ordered rules in the design: missing path is `free`; empty, malformed, incomplete, or non-positive-pid content is `unknown`; a different hostname is `foreign`; a v1 uptime that is more than 5 seconds ahead of current uptime is `rebooted`; a v0 `createdAt` before the current boot time with 60 seconds tolerance is `rebooted`; `ESRCH` is `dead`; and successful or `EPERM` process probing is `held`.

### R3. Reclaimability and grace-period behavior are deterministic

WHEN a lock is `unknown` THE SYSTEM SHALL set `reclaimable` only when its mtime is older than `unknownGraceMs`, whose default SHALL be 600000 milliseconds; WHEN a lock is `held` or `foreign` THE SYSTEM SHALL never reclaim it because of age; WHEN a lock is `dead` or `rebooted` THE SYSTEM SHALL mark it reclaimable immediately.

### R4. With-lock contention self-heals only through the shared protocol

WHEN `withLock` encounters an existing path THE SYSTEM SHALL inspect and, if reclaimable, reclaim it and retry within the `waitMs` budget (default 5000 ms; `0` means one attempt plus one reclaim); otherwise it SHALL wait and finally throw `LockBusyError` containing the path and the last `LockState`; it SHALL not delete an existing reclaim guard.

### R5. Reclaim is guarded against replacement races

WHEN `reclaimLock(path)` removes a reclaimable lock THE SYSTEM SHALL first acquire `<path>.reclaim` with a zero-wait tokenized lock, re-read and reclassify the target, unlink it only if still reclaimable, and release the guard by matching its token; WHEN a guard already exists, reclaim SHALL leave both target and guard untouched and return `removed: false` with the guard path when applicable.

### R6. Release is identity-safe and non-throwing

WHEN a lock scope finishes THE SYSTEM SHALL unlink the lock only if the on-disk owner token matches the token acquired by that scope; if the path is absent or the token differs, the scope SHALL leave the replacement lock intact, record at most a warning, and preserve the callback's result or error.

### R7. Temporary files follow the same owner rules without participating in mutual exclusion

WHEN a tokenized temporary file `<lock>.<token>.tmp` is encountered THE SYSTEM SHALL classify and sweep it with the same owner rules as a lock, SHALL never let another contender delete it, SHALL retry its own link after an `ENOENT` deletion within the same wait budget, and SHALL treat an `ENOENT` cleanup race as success.

### R8. Repair sweeps locks, guards, and temporary files by directory

WHEN `sweepLocks({directories, paths}, options?)` runs THE SYSTEM SHALL process each directory under `<dirname>/.lock-sweep.lock`, first eligible orphan guards, then locks through `reclaimLock`, then eligible temporary files; it SHALL skip a directory whose directory lock is unavailable and report `state: 'skipped'`; if the directory lock's own stale reclaim guard blocks the sweep, the skipped result SHALL include that guard path for manual removal; the directory lock and its own guard/tmp are excluded from ordinary artifact entries.

### R9. Repair covers both root-owned and shared observation lock paths

WHEN `repairEvolutionRoot` runs THE SYSTEM SHALL sweep `.skill-evolution/locks/` and `.skill-evolution/` as directories and process each configured JSONL and observation path's `.lock` through the path list, including observation files outside the root without scanning unrelated files.

### R10. Repair reports are additive and preserve legacy summaries

WHEN repair completes THE SYSTEM SHALL return `locks: readonly SweptLock[]` with artifact kind (`lock`, `guard`, or `tmp`), state, path, optional operation/age, and removal flag; `orphanLocksRemoved` and `locksPreserved` SHALL remain present and SHALL count only `artifact: 'lock'` entries.

### R11. Publication locking uses the unified protocol without changing lock paths

WHEN `readCurrent`, `promote`, or `rollback` enters its mutation lock THE SYSTEM SHALL call `withLock` on the existing `.skill-evolution/locks/<skill>.lock` path with operation `read-current`, `promote`, or `rollback` and `waitMs: 0`; a reclaimable owner SHALL be recovered automatically, while a live owner SHALL preserve the existing already-in-progress error semantics and include owner diagnostics.

### R12. Existing JSONL operations use explicit operation labels

WHEN a JSONL store, rotation, repair, or derived-refresh path acquires a lock THE SYSTEM SHALL use `withLock` with operation `append`, `read`, `replace`, `rotate`, `repair`, or `refresh` as appropriate, preserving caller-owned write queues and read behavior.

### R13. Public compatibility and cleanup follow the accepted defaults

WHEN the migration is complete THE SYSTEM SHALL remove `withFileLock` and `removeDeadLock` from the implementation, retain `hasCode`, preserve lock file locations and v0 reads, and update the README's local-filesystem/recovery contract to document the classification table, grace period, and non-reclamation of foreign/live owners; package version remains `0.1.0`.

### R14. Default decisions are normative

WHEN an implementation needs the unresolved design choices THE SYSTEM SHALL use the accepted defaults: D1 `unknownGraceMs = 10 minutes`; D2 delete `withFileLock` and `removeDeadLock`; D3 never time out a provably live `held` owner. These defaults are part of this spec and do not require another member decision.

## Scope boundary

The protocol is valid only for same-host local filesystems. `link()` failures are surfaced. Cross-host leases, heartbeat ownership, boot-id based pid reuse, caller-owned in-process queue semantics, and SKIL-38 directory-layout changes are out of scope.
