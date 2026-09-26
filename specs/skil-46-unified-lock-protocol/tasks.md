## Tasks

Tasks are ordered according to the five-step migration in `docs/design/unified-lock-protocol.md`. Each task is one Builder-sized change, can be merged independently after its dependencies, and includes objective acceptance tests. Task 1 is the end-to-end tracer bullet: a real `withLock` scope writes a complete owner, protects a concurrent critical section, and releases safely.

### 1. Implement the unified locking module and its protocol tests

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R14  
**Depends on:** none

**Goal:** Replace the implementation seam in `packages/skill-evolution/src/locking.ts` with `withLock`, `inspectLock`, `reclaimLock`, `sweepLocks`, `LockBusyError`, and the shared classifier. During this task only, compatibility wrappers `withFileLock` and `removeDeadLock` may remain internally so existing callers compile; they must delegate to the new protocol and be removed in Task 5.

**Files:** `packages/skill-evolution/src/locking.ts`, new `packages/skill-evolution/tests/locking.spec.ts`, and any focused type/build configuration needed for the module.

**Acceptance tests:**

- **L1–L2:** A normal scope writes a complete v1 owner containing `token`, `uptimeMs`, and `operation`, removes lock/tmp on success, and removes the lock while preserving the callback error.
- **L3–L4, L12–L14:** Dead v1/v0 owners are reclaimable; a v1 uptime one day ahead is `rebooted`; a v0 epoch `createdAt` is `rebooted`; a v1 live pid with epoch `createdAt` remains `held`.
- **L5–L8:** Unknown content inside the 10-minute default grace is retained and rejects zero-wait acquisition; the same content with old mtime is reclaimed; live owners time out as `held`; foreign hosts remain `foreign`.
- **L9:** Replacing the lock with a different token inside the callback leaves the replacement intact on release.
- **L10:** Eight concurrent child processes reclaim/enter a dead lock and a shared read-modify-write counter ends at 8 with no overlapping critical sections.
- **L11/L11b:** Temporary files never block acquisition, are swept by state, and a concurrent deleter cannot cause `ENOENT` failures across 200 repeated scopes.
- **L15:** A dead target plus stale `.reclaim` guard yields `LockBusyError.guard` and preserves the target; `sweepLocks` then removes the guard and acquisition succeeds.
- Build evidence: `npm --prefix packages/skill-evolution run build` succeeds and the focused locking tests pass.

### 2. Migrate JSONL, rotation, repair, and derived-refresh call sites

**Requirements:** R8, R9, R10, R12  
**Depends on:** 1

**Goal:** Replace every JSONL-facing `withFileLock` call with `withLock` and its explicit operation label, while preserving each caller's queue and read/write semantics.

**Files:** `packages/skill-evolution/src/store.ts`, `records.ts`, `retention.ts`, `repair.ts`, `service.ts`, and their existing tests.

**Acceptance tests:**

- `rg -n "withFileLock|removeDeadLock" packages/skill-evolution/src --glob '!locking.ts'` shows no remaining JSONL, retention, repair, or refresh call site; each call passes `append`, `read`, `replace`, `rotate`, `repair`, or `refresh`.
- Repair of a JSONL file with a dead owner lock succeeds and does not wait for the old fixed five-second behavior.
- Existing store, record, retention, and refresh tests pass; caller-owned write queues remain intact.

### 3. Migrate publication locking and preserve lifecycle semantics

**Requirements:** R4, R11, R14  
**Depends on:** 1

**Goal:** Change `SkillVersionStore.withMutationLock` to delegate to `withLock(..., {waitMs: 0})` at the existing lock path and preserve the domain error and recovery flow.

**Files:** `packages/skill-evolution/src/lifecycle.ts`, `packages/skill-evolution/tests/evolution.spec.ts`, plus lifecycle helper types if required.

**Acceptance tests:**

- **P1:** A SIGKILLed promote leaves the publication lock and journal; the next `readCurrent` automatically reclaims the dead lock, runs existing idempotent `recoverPublication`, deletes `.publish.json`, and keeps `current.json` on the new version.
- **P1b:** A manually completed version directory with stale journal/current state is repaired by the next `readCurrent` after reclaiming a dead publication lock.
- **P2:** A live publication owner makes promote fail fast with the existing already-in-progress message plus owner pid and operation; no live lock is reclaimed.
- **P3:** Concurrent promote/rollback on one store instance remains serialized by `mutationQueue`.
- Existing lifecycle tests pass, including the held/unknown lock regression.

### 4. Replace repair lock discovery with the sweep protocol and report field

**Requirements:** R5, R7, R8, R9, R10  
**Depends on:** 2, 3

**Goal:** Replace `removeOrphanLocks` with one `sweepLocks` call that covers root directories and explicit shared paths, and expose the complete artifact report.

**Files:** `packages/skill-evolution/src/repair.ts`, `packages/skill-evolution/src/service.ts` if report plumbing is needed, `packages/skill-evolution/tests/core.spec.ts`, and new/updated repair tests.

**Acceptance tests:**

- **R1:** A stale empty publication lock in `locks/` is removed and listed in `orphanLocksRemoved`; a subsequent promote succeeds.
- **R2:** Dead locks beside root JSONL files and beside an out-of-root observation file are reclaimed and appear as `artifact: 'lock'` entries in `locks`.
- **R3:** Live, foreign, and grace-period unknown locks remain, with matching `locksPreserved` and `locks[].state`.
- **R4:** Repair with an expired unknown JSONL lock completes without the former five-second busy failure.
- **R5:** Two roots repairing the same observation directory concurrently coordinate through its directory lock; a stale guard is removed once, the other run reports removal or skipped, and neither run fails.
- The legacy summary arrays contain only lock artifacts and all lock/guard/tmp records expose path, state, and removed flag.

### 5. Remove compatibility names, update documentation, and close the migration

**Requirements:** R13, R14  
**Depends on:** 1, 2, 3, 4

**Goal:** Delete `withFileLock` and `removeDeadLock`, verify no repository caller or package test imports them, and document the final protocol and accepted defaults.

**Files:** `packages/skill-evolution/src/locking.ts`, all remaining core call sites/tests, `packages/skill-evolution/README.md`, and generated declarations through the normal build.

**Acceptance tests:**

- `rg -n "withFileLock|removeDeadLock" packages/skill-evolution` returns no implementation or test references.
- `npm --prefix packages/skill-evolution run build` succeeds with the intended public exports and no DSH/bundle imports.
- `npm --prefix packages/skill-evolution test` and `npm --prefix packages/dsh-adapter test` pass.
- README documents same-host local-filesystem scope, v1 owner fields, v0 compatibility, the classification/reclaim table, 10-minute unknown grace, foreign/live preservation, and repair reporting.

## Cross-task test matrix

| Scenario family | Covered by | Required IDs |
|---|---|---|
| Lock module | Task 1 | L1–L15, L11b |
| Publication lock | Task 3 | P1–P3, P1b |
| Repair/report | Task 4 | R1–R5 |
| Final migration and docs | Task 5 | build, core test, adapter test, README review |
