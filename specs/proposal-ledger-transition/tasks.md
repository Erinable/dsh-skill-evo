## Tasks

Tasks are ordered by dependency. T1 and T2 may be implemented in parallel; T3 depends on both; T4 depends on T3. Each task is sized for one Builder run and includes objective acceptance evidence. Task 1 is the thinnest tracer bullet: it exercises the id/parse/query path end to end before the write seam is centralized.

### T1. Implement ADR-0021 record-id helpers and exact queries

**Requirements:** R1, R3, R4, R11, R12

**Depends on:** none

**Files:** `packages/skill-evolution/src/proposal.ts`, `packages/skill-evolution/src/index.ts`, focused proposal tests.

**Work:** Add occurrence-aware `ledgerRecordId`, status-plus-occurrence parsing in `proposalRootId`, exact `findLedgerRecord`, and root/latest/history helpers. Preserve historical suffixes and reject invalid `:1` and zero-padded occurrences. Keep existing callers compatible with the first-entry id form.

**Acceptance:**

- A focused tracer test builds records for draft → proposed → evaluating → evaluated, adds a second evaluated entry, groups by root, resolves the latest by root and exact `<root>:evaluated`, and resolves the second entry by exact `<root>:evaluated:2`.
- Tests prove `proposal:abc:2` remains a custom root, `<root>:evaluated:1` and `:02` are not valid record ids, a missing reference is `not-found`, and a bare prefix matching multiple roots is `ambiguous`.
- No lookup path uses `startsWith`; `npm --prefix packages/skill-evolution run build` and the focused tests pass.

### T2. Add lock-aware computed JSONL append

**Requirements:** R5, R7, R11

**Depends on:** none

**Files:** `packages/skill-evolution/src/records.ts`, record-store tests.

**Work:** Add `appendComputed(build)` that reads complete frames and isolates residual bytes while holding the existing lock, rejects duplicate ids with `DuplicateRecordError`, and returns the appended record. Do not change the existing `append` contract used by unrelated stores.

**Acceptance:**

- Two independent store instances concurrently number records without duplicate ids or lost frames.
- A trailing residual is isolated before the new frame and is excluded from the builder's count.
- An occupied computed id throws `DuplicateRecordError` and leaves the data file unchanged; a forced I/O or lock error reaches the caller unchanged.
- `npm --prefix packages/skill-evolution run build` and record-store tests pass.

### T3. Implement ProposalLedger and its failure semantics

**Requirements:** R1, R2, R4, R5, R6, R7, R8, R11, R12, R13

**Depends on:** T1, T2

**Files:** new `packages/skill-evolution/src/ledger.ts`, `packages/skill-evolution/src/types.ts`, `packages/skill-evolution/src/index.ts`, ledger tests.

**Work:** Implement `ProposalLedger.transition`, `latest`, `record`, and `history`; add `previousRecordId`, `DecisionRecord.recordId`, and typed `conflict`. Use the five-step algorithm, deterministic decision ids, replay detection, latest-record conflict checks, and post-record decision append.

**Acceptance:**

- V1 rejected → observed → evaluated creates two evaluated records and two linked decisions; root/latest and exact-id queries return the expected entries.
- V2 repeated rejection creates `<root>:rejected:2` and `decision:ledger:<root>:rejected:2`.
- V3 repeating one transition returns `replayed: true` and does not change Ledger or decision counts.
- V4 old-record and same-id stale-draft sources raise `conflict` with unchanged counts.
- V5 Proposal write failure or occupied id raises the original error with no decision; V6 a decision write failure is repaired by retry with one record and one decision.
- Legacy records without `previousRecordId` remain readable and new writes use the new ids. Core build and focused ledger tests pass.

### T4. Route all eight service call sites through the ledger seam

**Requirements:** R2, R6, R7, R8, R9, R10, R11, R12, R13

**Depends on:** T3

**Files:** `packages/skill-evolution/src/service.ts`, `packages/skill-evolution/src/operations.ts`, `packages/skill-evolution/src/index.ts`, `CONTEXT.md`, service/operations/regression tests.

**Work:** Replace all eight `proposals.append` sites with `this.ledger.transition`, remove the old transition decision helper and operation-level id reconstruction, preserve stage's identical-record early return, pass the first evaluating record into the evaluated transition, return persisted records, and map `conflict` without swallowing write errors. Update the CONTEXT Ledger record definition to include occurrence.

**Acceptance:**

- `rg` finds no Proposal-store append call in `packages/skill-evolution/src` outside `ledger.ts`; all eight transitions are routed through the same method.
- Service tests cover rejected → observed → evaluated with two evaluated records, root and exact-id lookup, same-id stale-draft conflict, and write failures reaching callers while decision counts remain unchanged.
- Legacy fixtures are readable; metrics preserve old counts; V8 seam guard passes.
- `npm --prefix packages/skill-evolution test` passes, and the task branch contains only the specified Markdown/context and implementation files.
