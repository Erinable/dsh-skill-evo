Tasks are ordered by dependency. Each task is one Builder-sized unit with its own acceptance checks. The first task is the thinnest end-to-end tracer bullet: a real DSH event becomes the core shadowing vocabulary and is verified through the bundle mapper.

### Task 1 — Map context shadowing into core vocabulary

- **Depends on:** none.
- **Requirements:** R-1, R-2, R-3, R-7, R-40.
- **Scope:** Extend `ObservationKind`, bundle kind allow-list, and dsh-adapter kind types with `context-shadowed`; map compaction summary/prune ranges, replacement metadata, and `shadowTracked` exactly as ADR-0025 requires. Keep DSH event names out of core decision logic.
- **Acceptance:** Bundle tests feed the design §2.2 sequence and assert merged `shadowedSeqRanges`, mechanism/token count, `surfaceReplace` on replacement `tool/result`, no replacement pairing, and `shadowTracked` on both Skill-load paths. Core and adapter build/tests pass, and a core test proves it does not need `payload.eventType`.

### Task 2 — Build deterministic Skill windows and derived storage

- **Depends on:** Task 1.
- **Requirements:** R-4, R-5, R-6, R-7, R-8, R-9, R-22, R-23, R-40.
- **Scope:** Add SkillWindow types, deterministic session ordering, window segmentation, observed/uncertain/open endings, unknown-prefix handling, qualification interval calculation, `skill-windows` layout/store, and synchronous workflow/service projection wiring.
- **Acceptance:** Fixtures cover next Skill, same Skill reload, follow-up (including the explicit/no-`sessionSeq` exception), task-finished, context-shadowed, open log, absent `shadowTracked`, and session sequence starting above zero. Each asserts exact start/end ids, reason, certainty, excluded ending/replacement observations, and qualification behavior; repeated projection is byte-identical. Core build/tests pass.

### Task 3 — Implement ToolAttempt emission and HMM posterior projection

- **Depends on:** Task 2 and SKIL-128 S3 collection/ToolAttempt implementation.
- **Requirements:** R-10, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-18, R-19, R-21, R-22, R-23, R-40.
- **Scope:** Add the pure `inferSkillAttribution` module's window/qualification-compatible sequence model, `rule-1`, `SkillContentSource`, `skill-posteriors` store, cursor `judges`/`derivationKey` merge, emission validation/fallback, and posterior serialization. Do not call an injected judge from Projection.
- **Acceptance:** Commit the §3.6 clean, noisy, and withNone fixtures with both Skill bodies; noisy includes neutral commands and a cross-Skill command. They achieve MAP agreement >=0.90, >=0.90, and >=0.85 respectively. A judge returning +10 for every Skill still yields only eligible Skills with shares summing to 1 within 1e-6 across 200 randomly generated sessions varying loads, shadowing, and step counts. The shadowing fixture asserts that git-workflow is absent from shares after its load is shadowed. Missing content records `profile: 'missing'`; invalid/no-score/no-judge paths record the specified fallback; reorder with stable `sessionSeq` gives byte-identical posteriors. Core build/tests pass.

### Task 4 — Fan out weighted Failure cases and update proposal gates

- **Depends on:** Task 3 and SKIL-126 implementation (SKIL-134 is already on main).
- **Requirements:** R-24, R-25, R-26, R-27, R-28, R-29, R-30, R-30a, R-31, R-32, R-39, R-40.
- **Scope:** Add `failure-attributions`, `tool-failure`, nearby-step aggregation and explicit anchor lookup; extend Failure case/cluster types and IDs; pass attributions into Experiences and Failure construction; centralize dominant-only proposal gating in `isClusterReadyForProposal` and `workflow.propose()`.
- **Acceptance:** The design probe produces nonzero Failure cases with normalized weights, api-debugging dominant in the original ordering and git-workflow dominant when the follow-up moves. No `unattributed` Experience is produced. Explicit Skill feedback remains a share-one `failure:<id>` case despite an adversarial judge, and overrides retain their category. Uncovered none-only subjects produce no Skill case; unknown-prefix suppresses the uncovered flag. A minority high-severity case is visible but cannot pass its cluster gate: its Skill cluster has `occurrenceCount === 1`, `dominantOccurrence === 0`, and `workflow.propose()` throws `does not have enough evidence`; the dominant cluster passes. Diagnosis evidence uses `weightedOccurrence`: an equal-count all-minority cluster has no higher confidence than an all-dominant cluster, and `margin` never populates `attributionConfidence`. Explicit feedback resolves the referenced tool-call anchor with `anchorObservationId` equal to the call, `stepObservationIds` equal to that step plus its preceding two steps, git-workflow as the maximum share, unchanged window segmentation, and session-average fallback for an unknown id. Core build/tests pass.

### Task 5 — Add emission memo operation and judge replacement

- **Depends on:** Task 3 and SKIL-126 memo infrastructure.
- **Requirements:** R-14, R-15, R-16, R-20, R-21, R-39, R-40.
- **Scope:** Implement `SkillEmissionJudge` injection in service options, `emissions` memo records, `scoreSkillEmissions({ signal, limit })`, memo validation/repair behavior, and cursor invalidation/restoration. Keep Projection/failures/metrics/worker/repair free of model calls.
- **Acceptance:** A fake `version: 'fake-2'` judge changes posterior/failure output only after the explicit operation and records `emission.version === 'fake-2'`; removing the judge restores the original byte-identical `rule-1` output. Failed or aborted scoring leaves prior valid memo rows intact and reports per-session failures. Core build/tests pass.

### Task 6 — Wire metrics and reports

- **Depends on:** Task 4.
- **Requirements:** R-33, R-34, R-39, R-40.
- **Scope:** Extend `failures`/`metrics` JSON and Markdown, refresh before `metrics()`, and add per-Skill windows/step/failure figures and uncovered output.
- **Acceptance:** The probe's hand-computed windows, dominantStepShare, attributedFailures, weightedFailures, expectedSteps, and noneExpectedSteps match output; expected Skill plus none steps equal total tool steps. Reports include case weights/sources and an uncovered section, and `metrics()` refreshes before reading derived stores. Existing metrics/report tests remain green.

### Task 7 — Allocate execution cost and route correction episodes

- **Depends on:** Task 4; SKIL-129/SKIL-130 implementation; SKIL-128 S3 correction episode implementation. The correction branch is **以 SKIL-136 合并版为准** until that spec merges.
- **Requirements:** R-35, R-36, R-39, R-40.
- **Scope:** Allocate SKIL-130 step/token costs and implement posterior-aware SKIL-128 §6.2 correction routing, preserving the explicit rule-0/rule-1 precedence and legacy `loadedSkills` fallback.
- **Acceptance:** Cost allocation uses expected posterior steps and adjacent token-step rules. Correction patterns route majority uncovered to create-skill and majority dominant Skill to patch-content while preserving rules 0/1/3/4; a pattern with explicit `--skill` remains on that Skill even when posterior 2a/2b disagree, and legacy/no-posterior episodes use `loadedSkills`.

### Task 8 — Add optional counterfactual calibration seam

- **Depends on:** Task 3.
- **Requirements:** R-37, R-38, R-40.
- **Scope:** Add `calibrateSkillPosteriors` and the core `CounterfactualReplay` interface, deterministic session sampling, full/withheld replay comparison, calibration report persistence, a test fake, and the dsh-adapter `DshEvaluationExecutor` adapter that accepts a Skill set and can replay with one Skill withheld. The operation accepts host-supplied `task`; it does not collect `taskSummary`.
- **Acceptance:** A fake replay and the dsh-adapter adapter receive full and withheld Skill sets and host task text, produce deterministic bins/delta/rank/Brier/Platt report fields with adapter/model/parameter/seed metadata, count skipped sessions without task, and leave derived stores, proposal gates, weights, and `derivationKey` unchanged. No default projection path invokes replay. Core and adapter build/tests pass.
