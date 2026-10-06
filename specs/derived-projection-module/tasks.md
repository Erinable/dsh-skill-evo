## Builder tasks

Each task is one reviewable Builder ticket, ordered by implementation dependency. Task 1 is the thinnest end-to-end tracer bullet: a Follow-up intent flows through one failure decision to both Failure cases and metrics. Requirements refer to `requirements.md`; G1-G6 and R1/R2 are acceptance guard names, not extra tickets.

### Task 1 — Make failure intent classification single-source

- **Depends on:** none; merge before SKIL-163. It can run while SKIL-162/PR #113 is under review.
- **Requirements:** R-1, R-2, R-3, R-4, R-21.
- **Scope:** In `follow-up.ts`, add exhaustive `INTENT_OUTCOME`, derived `FAILURE_INTENTS`, and `isFailureIntent`; in `types.ts`, add the `FeedbackKind` subset compile check; replace all four literal lists in `experience.ts` and `metrics.ts`; export the public helpers from `index.ts`. Add G6 in `tests/derivation.spec.ts` or a focused intent test. Do not alter root-cause mapping or increment `INTENT_POLICY_VERSION` for this no-behavior-change migration.
- **Acceptance:** `npm --prefix packages/skill-evolution run build` and `npm --prefix packages/skill-evolution test` pass. A fixture with `incorrect` produces a Failure case and increments its intent-failure metric, while `satisfied` produces neither. All four former literal-list sites use the helper; a source search for the five-value list finds only the canonical vocabulary/outcome definitions. Temporarily adding a new `FEEDBACK_KINDS` value fails compilation until it is added to `FOLLOW_UP_INTENTS`, then fails until an outcome is assigned. G6's table/version snapshot passes without changing the existing policy version.

### Task 2 — Register and open all stores from one typed table

- **Depends on:** Task 1 and merged SKIL-162/PR #113. Do not begin against draft #113.
- **Requirements:** R-5.
- **Scope:** Add `store-registry.ts` with existing fact, memo, and derived stores including #113's `emissions`, `skill-posteriors`, and `failure-attributions`. Derive `StoreName`, `MemoKey`, `DerivedKey`, `RecordOf<K>`, and `DerivedRecords`; make `state-root.ts` layout and `service.ts` store construction use the registry. Keep service public store fields as references to opened instances. Do not move Projection computation yet.
- **Acceptance:** Core build/tests pass. The existing `tests/core.spec.ts` layout assertion passes without changing expected order/path/role/projection-input values. `StoreName` is no longer a handwritten union, and the service's public stores resolve to the same `openStores(layout)` instances. A compile-time type probe shows a newly registered derived key appears in `DerivedRecords`, while fact and memo keys do not. Existing JSONL files are still read under their previous names.

### Task 3 — Extract pure Projection steps and version sources

- **Depends on:** Task 2; merged SKIL-162/PR #113.
- **Requirements:** R-6, R-7, R-9, R-19.
- **Scope:** Add `projection-steps.ts` with `projectDerived`, context/records types, exhaustive `DerivationVersions` and `VERSION_SOURCES`. Extract `projectWorkflow` from `EvolutionWorkflow.snapshot()` without changing direct workflow output. Move the full-path calculation into pure steps, including #113 posterior/attribution and correction Experience merge. Export and register the known model, emission, and Skill-window `_VERSION` constants; make steps consume resolved versions. Keep the existing service full path temporarily for comparison.
- **Acceptance:** Core build/tests pass. Running `projectDerived` twice with identical context produces deep-equal records; a migration fixture produces deep-equal per-store output against the old `refreshDerivedUnlocked` full path, including correction and #113 records. Existing direct `EvolutionWorkflow` tests pass unchanged and `snapshot()` contains no correction Experience. G4 matches names and values in both directions; a temporary unregistered `_VERSION` export with the same value as `CORRECTION_RULES_VERSION` makes G4 fail, then is removed. The known `hmm-1`, `rule-1`, and `skill-windows-v1` projection literals are sourced from named constants.

### Task 4 — Let DerivedProjection own cursor and persistence

- **Depends on:** Task 3; merged SKIL-162/PR #113.
- **Requirements:** R-10, R-11, R-12, R-13, R-14, R-16, R-17, R-18.
- **Scope:** Add `derivation.ts` with `DerivedProjection.refresh({ force? })` and `recordClassifierFailure()`. Read memo stores and derived stores by registry; compute the complete context key; invalidate an old matching cursor before derived writes, then replace only derived stores before the final cursor write. Delegate service refresh, metrics counters, and classifier-failure counting to it. Remove obsolete service Projection path and private counter fields while retaining the public service methods. Implement G1-G3 and G5 except the `new EvolutionWorkflow` restriction, which Task 5 completes.
- **Acceptance:** Core build/tests pass, including correction and archive health/repair suites. G1 fixture emits at least one row per derived store and shows forced/fast views equal. G2 individually changes every `VERSION_SOURCES` key; G3 appends to every memo store; both cause a key change and a full `replaceAll` cycle. An old cursor forces one rebuild then uses fast path. Simulated derived-write and final-cursor-write failures, including `force: true` over a matching old cursor, leave an invalid cursor and cause the next refresh to rebuild. `repair()` preserves memo bytes and `correctionClassifierFailures`, while deleting the cursor resets that count. `refreshDerived()` returns Skill windows, posteriors, and attributions; G5 restricts cursor calls and derived writes to the designated module.

### Task 5 — Feed proposals from the stored Derived view

- **Depends on:** Task 4; merge before SKIL-163 and its downstream SKIL-165/166.
- **Requirements:** R-8, R-15, R-20, R-22, R-23.
- **Scope:** Extract `proposeFromRecords` in `workflow.ts` with the four common snapshot fields. Make `EvolutionWorkflow.propose()` delegate to it; make `service.proposeChange()` call it with one refreshed stored view; make `proposePattern()` take patterns/episodes from that view. Add R1 in `tests/correction.spec.ts`, R2 in `tests/core.spec.ts`, and finish G5's constructor guard. Keep the Designer outside the cursor lock and preserve direct workflow proposal rules.
- **Acceptance:** Core build/tests pass, including `tests/pattern-design.spec.ts`. R1 passes with two ordinary and two correction Experiences and Designer input deep-equal to stored Experiences. R2 accepts a cluster id from `refreshDerived()` and passes stored cases/Diagnosis unchanged; no unknown-cluster error occurs. Direct `EvolutionWorkflow.snapshot()` and `propose()` retain their previous outputs/thresholds, with no correction Experience in the direct snapshot. A slow fake Designer runs after cursor lock release. G5 finds no `new EvolutionWorkflow` outside `workflow.ts`. SKIL-163's later dominant-only gate changes `proposeFromRecords`, not a separate service path.

## Cross-issue merge order and conflicts

T1 lands before SKIL-163 because both touch `experience.ts` failure filtering. SKIL-162/PR #113 lands before T2-T5 because it changes the same `service.ts` Projection region and supplies three stores/memo-version inputs. T2 → T3 → T4 → T5 is serial; each task merges before the next starts. SKIL-163, SKIL-165, and SKIL-166 start after T5; SKIL-163 puts its weighted proposal gate in `proposeFromRecords`. SKIL-164 must be narrowed against #113's emission memo implementation: it owns remaining judge replacement/explicit scoring behavior, and uses `DerivationVersions.emission` instead of editing a second key/cursor path; Mika resolves its ticket scope. SKIL-167 may run alongside T2-T5 after SKIL-162; its calibration report stays outside Derived stores and `derivationKey`, and its posterior read adapts to the T4 return view. SKIL-173 adds adapter flow and no new Projection, so it may run in parallel; any `service.ts` text collision is reconciled by the branch merged later. These are reversible scheduling defaults: 采用默认答案，成员可推翻。
