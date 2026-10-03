## Builder tasks

Tasks are ordered by dependency. Each task is one independently reviewable Builder unit and includes its own acceptance checks. The first task is the thinnest end-to-end tracer bullet: one Observation stream reaches a deterministic rule resolution, Failure case, cluster, and Diagnosis.

### Task 1 — Resolve follow-up intent and project rule-only failures

- **Depends on:** none.
- **Requirements:** R-1, R-2, R-3, R-4, R-5, R-6, R-7, R-8, R-9, R-10.
- **Scope:** Add the core intent vocabulary and pure follow-up resolver (new `packages/skill-evolution/src/follow-up.ts` plus `types.ts` exports); implement normalization, fixed rule table, attribution target/tool corrections, explicit priority, and resolution records. Update `experience.ts` and `workflow.ts` so Failure cases, clusters, Diagnoses, and Markdown/JSON failure output consume resolutions, preserve PR #79 origins, and use evidence time for Diagnosis `createdAt`. Update the focused evolution tests, including the two intentional PR #79 behavior changes.
- **Acceptance:** Core build and tests pass. A single Skill session containing `谢谢`, `好的`, and `继续` yields three rule resolutions and zero Failure cases. `不对，应该…` and each required `Please correct ...` example yield an `incorrect` rule resolution and a medium content Failure case. Marked topic change yields no case; a follow-up before any Skill load yields no case; explicit `satisfied` without `skill` yields no case; explicit `incorrect` remains high. Diagnosis root cause never depends on a text substring, and two projections over unchanged events produce identical Diagnosis timestamps and ids.

### Task 2 — Add classifier, memo, cursor invalidation, and metrics

- **Depends on:** Task 1.
- **Requirements:** R-11, R-12, R-13, R-14, R-15, R-16.
- **Scope:** Add `FollowUpClassifier`, classification input closure/hash, `EvolutionServiceOptions` injection, `classifyFollowUps` Maintenance operation, `classifications.jsonl` memo and `follow-ups.jsonl` derived store, memo-aware synchronous Projection, `derivationKey` cursor invalidation, repair preservation, and `followUpIntents` metrics. Keep classifier calls out of Projection, repair, `failures`, `metrics`, and worker refresh paths.
- **Acceptance:** Core build and tests pass. A fake versioned classifier (including a `goal-changed` result) changes a follow-up's resolution and Failure output only after `classifyFollowUps`; a new service without the classifier returns the original rule result, including after `vi.setSystemTime` moves the clock. The operation skips explicit and pending rows, caps context digests at 20, reports per-item timeout/error/invalid-output failures, and writes no memo for failures. Missing classifier returns `classifier-unavailable`. `repair()` never calls the classifier and leaves `classifications.jsonl` bytes unchanged while isolating malformed rows; cursor `derivationKey` changes when classifier version/memo changes; metrics expose explicit/classifier/rule totals, failures, and intents.

### Task 3 — Record preceding tool activity in the bundle mapper

- **Depends on:** none (may land in parallel with Task 1 and Task 2).
- **Requirements:** R-17, R-18.
- **Scope:** Update `packages/dsh-bundle/index.js` session mapper state in `mapUserMessage`, `mapToolCall`, and `mapToolResult` to emit optional `precedingToolKind` and `precedingToolFailed` using only core Observation kinds. Add bundle mapping tests and preserve the legacy offline inference path for old records and custom mappers. Do not add a real classifier backend or CLI command.
- **Acceptance:** Bundle tests pass. Each new human turn clears prior tool state; a subsequent follow-up records the last skill-load or tool-result kind and failure bit exactly once; a follow-up with no relevant preceding activity omits both fields; no mapper path invokes a classifier. The existing bundle tests for `Please correct timeout diagnosis.` and explicit feedback remain green.
