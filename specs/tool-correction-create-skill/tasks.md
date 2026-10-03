## Tasks

Tasks are ordered by dependency. A task may run in parallel with another task only when its listed dependencies are complete. Every task includes its requirements, changed modules, and objective acceptance evidence. Task 1 is the thinnest end-to-end tracer bullet.

### 1. Capture and redact one command attempt end to end

**Requirements:** R1, R2, R3, R17, R19

**Depends on:** none

**Files/modules:** `packages/skill-evolution/src/events.ts`, `packages/dsh-bundle/index.js`, their focused tests.

**Goal:** Centralize R1–R7 redaction in core, add bounded command/result summary mapping for bash/pwsh, and preserve old Observation parsing.

**Acceptance tests:**

- A fixture maps one failed command and one successful command with exit markers; resulting Observations contain the approved optional fields and no complete output.
- The six redaction probes plus URL query/fragment probes produce the ADR-0023 expected replacements, are idempotent, cap command/error lengths, cap `argKeys` at 16 entries with 64 characters per key, and cap `signal` at 32 characters.
- A fixture containing proxy user/password, authorization, token/password flags, and secret environment assignments finds none of those original values in serialized Observations.
- Existing bundle and core Observation tests pass.

### 2. Project ToolAttempts into Correction episodes and Experiences

**Requirements:** R4, R5, R6, R7, R18, R19

**Depends on:** 1

**Files/modules:** `packages/skill-evolution/src/correction.ts`, `experience.ts`, `projection.ts`, `operations.ts`, `state-root.ts`, `service.ts`, `records.ts` and `classifications.jsonl` (ADR-0034 memo role), correction/projection tests.

**Goal:** Add ToolAttempt correlation, rule-1 recognition, structured error signatures, episode/Experience emission, derived stores, the `classifyCorrections(service, { signal, limit })` maintenance operation, ADR-0034 namespaced Classification memo reads, the composite `derivationKey`, and the ADR-0035-shaped injected classifier seam. Projection must never call the injected classifier.

**Acceptance tests:**

- One session with three exit-128/443 failures followed by proxy setup and success yields exactly one correction episode and one tool-attributed Experience without a loaded Skill; unrelated intent between retries does not reset the run.
- Missing command/result, invalid references, and too-short drafts produce no episode. Memo misses and open sessions produce no classifier call; a memo miss falls back to `rule-1` with `fallbackReason: 'not-classified'`. Classifier exceptions produce no memo and increment `classifyCorrections.failed` and the correction-classifier failure metric.
- A closed-session fixture with a fake classifier first projects rule result R, then runs `classifyCorrections` and projects a different memo-backed result, then removes the classifier and projects back to a deep-equal R; no Projection call invokes the classifier.
- Error signature includes exit code and normalized first line. An existing follow-up memo using `classification:<version>:<inputHash>` is still found; a correction entry using `classification:correction:<version>:<inputHash>` passes `isClassificationMemoEntry` and repair without quarantine. Reprojecting after a correction-rule or classifier-version change updates the composite `derivationKey` and Derived outputs without changing Observation or existing memo bytes; changing only `windowRules`, or only the correction classifier version, also changes the same key while preserving the other judge's memo entries. A later `classifyCorrections` run may append a new versioned correction memo by its explicit contract.
- Stable Failure cluster references use the ADR-0022 earliest-case id, and classifier-version reprojection of the same grouped episodes preserves the `pattern:<earliest episode id>` and leaves a Proposal source reference resolvable.

### 3. Aggregate patterns and expose policy-aware reports

**Requirements:** R8, R9, R10, R17, R18

**Depends on:** 2

**Files/modules:** `packages/skill-evolution/src/correction.ts`, `metrics.ts`, `report.ts`, `service.ts`, state/policy/report tests.

**Goal:** Add patterns store, stable earliest-episode pattern ids, CorrectionPolicy defaults, pure `assessPattern`, promotion reset, in-progress blocking, and shared report/metrics rendering.

**Acceptance tests:**

- One recent session reports 1/K and is not a candidate; three distinct recent sessions report K/K and are candidates; a 31-day-old set is excluded; retry-only is excluded.
- After a promoted proposal, pre-promotion episodes no longer count and K post-promotion sessions become eligible again.
- Reports and metrics expose policy/recognizer versions, counts, `since`, candidate reason, and target; observe exposes episode/pattern counts.
- Reprojecting after a policy or classifier-version change changes only `derivationKey`/Derived outputs; Observation and existing Classification memo facts remain unchanged. Reprojecting the same grouped episodes keeps the pattern id stable and keeps its Proposal source reference resolvable.

### 4. Add pattern design, target selection, and create-skill absent Base

**Requirements:** R11, R12, R13, R17, R19

**Depends on:** 3 and SKIL-135 (spec PR #86, merged on `origin/main`). Consume the merged ProposalLedger implementation specified by ADR-0021 and `specs/proposal-ledger-transition/` §2.1/§2.4, anchored at `packages/skill-evolution/src/ledger.ts` with its `types.ts`/`index.ts` exports and service call-site migration.

**Files/modules:** `packages/skill-evolution/src/types.ts`, `proposal.ts`, `operations.ts`, `service.ts`, `packages/skill-evolution/src/ledger.ts`, Designer integration in `packages/skill-evolution/src/operations.ts` and `packages/skill-evolution/bin/dsh-skill-evolution.mjs`, proposal tests.

**Goal:** Add pattern-source Designer input, ordered target selection, environment-neutral validation, create-skill operation metadata, absent Base checks, and ADR-0021 ledger ids without changing the transition table.

**Acceptance tests:**

- K-session fixture with no loaded Skill creates a proposed create-skill Proposal whose operation and both Base hashes are `absent`, source includes pattern/signature/episode/evidence ids, and record id follows ADR-0021.
- Explicit skill, majority loaded skill, prior promoted target, similarity, tie, and no-match cases select the documented result.
- Designer input contains only redacted bounded summaries; candidates containing observed proxy host/IP/userinfo/`[REDACTED]` are rejected before any Proposal or case file is written.
- Existing cluster design remains compatible and transfer-table tests pass.

### 5. Evaluate, accept, and promote pattern proposals safely

**Requirements:** R14, R15, R16, R17, R19

**Depends on:** 4

**Files/modules:** `packages/skill-evolution/src/evaluator.ts`, `service.ts`, `lifecycle.ts`, `operations.ts`, `packages/dsh-adapter/src/evaluator.ts`, lifecycle/evaluation tests.

**Goal:** Implement empty-Base baseline evaluation, original-failure/boundary cases, pattern-only accept gate, scope policy, dry-run parity, and human-only lifecycle constraints.

**Acceptance tests:**

- An absent-Base candidate runs real baseline and candidate evaluations, including high boundary cases; invocation policy remains unchanged.
- A pattern Proposal with failed gate cannot accept or promote; no accepted state is written.
- create-skill/environmental patch stable scope is rejected in dry-run and real mode with no version/record writes, while project/user can proceed only after explicit accept.
- Recognizer/Designer modules cannot import lifecycle mutation modules, and no automated path can call accept/promote.

### 6. Wire adapter flows and the five acceptance scenarios

**Requirements:** R10, R11, R12, R13, R14, R15, R16, R17, R18, R19

**Depends on:** 1, 3, 4, 5

**Files/modules:** `packages/dsh-bundle/index.js`, CLI entrypoints, adapter tests, package docs only where needed.

**Goal:** Expose `design --pattern`, preserve typed error mapping and quote-aware arguments, and run one end-to-end fixture through projection, design, evaluate, accept, and promote.

**Acceptance tests:**

- One session yields Experience only; three sessions yield create-skill candidate; all state, reports, case drafts, proposals, and candidate content omit proxy credentials.
- Stable promotion is rejected, promotion before accept is rejected, and project/user promotion succeeds only after human accept and passing gate.
- Reprojection with a different recognizer changes episodes/patterns/metrics and leaves the Observation log unchanged.
- CLI/bundle maintenance delegates to core and keeps the existing cluster flow and outputs compatible; touched package tests pass.
