## Tasks

Tasks are ordered by dependency. A task may run in parallel with another task only when its listed dependencies are complete. Every task includes its requirements, changed modules, and objective acceptance evidence. Task 1 is the thinnest end-to-end tracer bullet.

### 1. Capture and redact one command attempt end to end

**Requirements:** R1, R2, R3, R17, R19

**Depends on:** none

**Files/modules:** `packages/skill-evolution/src/events.ts`, `packages/dsh-bundle/index.js`, their focused tests.

**Goal:** Centralize R1–R7 redaction in core, add bounded command/result summary mapping for bash/pwsh, and preserve old Observation parsing.

**Acceptance tests:**

- A fixture maps one failed command and one successful command with exit markers; resulting Observations contain the approved optional fields and no complete output.
- The six redaction probes plus URL query/fragment probes produce the ADR-0023 expected replacements, are idempotent, and cap command/error lengths.
- A fixture containing proxy user/password, authorization, token/password flags, and secret environment assignments finds none of those original values in serialized Observations.
- Existing bundle and core Observation tests pass.

### 2. Project ToolAttempts into Correction episodes and Experiences

**Requirements:** R4, R5, R6, R7, R18, R19

**Depends on:** 1

**Files/modules:** `packages/skill-evolution/src/correction.ts`, `experience.ts`, `projection.ts`, `state-root.ts`, `service.ts`, correction/projection tests.

**Goal:** Add ToolAttempt correlation, rule-1 recognition, structured error signatures, episode/Experience emission, derived stores, cursor judge versions, and injected recognizer fallback/reprojection.

**Acceptance tests:**

- One session with three exit-128/443 failures followed by proxy setup and success yields exactly one correction episode and one tool-attributed Experience without a loaded Skill; unrelated intent between retries does not reset the run.
- Missing command/result, invalid references, too-short drafts, and recognizer exceptions produce no episode and increment rejection/fallback metrics.
- Error signature includes exit code and normalized first line; changing recognizer version changes episodes/pattern inputs while Observation bytes remain unchanged.
- Stable Failure cluster references use the ADR-0022 earliest-case id.

### 3. Aggregate patterns and expose policy-aware reports

**Requirements:** R8, R9, R10, R17, R18

**Depends on:** 2

**Files/modules:** `packages/skill-evolution/src/correction.ts`, `metrics.ts`, `report.ts`, `service.ts`, state/policy/report tests.

**Goal:** Add patterns store, CorrectionPolicy defaults, pure `assessPattern`, promotion reset, in-progress blocking, and shared report/metrics rendering.

**Acceptance tests:**

- One recent session reports 1/K and is not a candidate; three distinct recent sessions report K/K and are candidates; a 31-day-old set is excluded; retry-only is excluded.
- After a promoted proposal, pre-promotion episodes no longer count and K post-promotion sessions become eligible again.
- Reports and metrics expose policy/recognizer versions, counts, `since`, candidate reason, and target; observe exposes episode/pattern counts.
- Injecting a policy version changes cursor/reprojection behavior without changing Observation facts.

### 4. Add pattern design, target selection, and create-skill absent Base

**Requirements:** R11, R12, R13, R17, R19

**Depends on:** 3 and the merged ProposalLedger implementation from SKIL-121/SKIL-123.

**Files/modules:** `packages/skill-evolution/src/types.ts`, `proposal.ts`, `operations.ts`, Designer integration, proposal tests.

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
