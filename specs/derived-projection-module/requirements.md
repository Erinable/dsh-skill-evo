## Scope and authority

This spec turns `docs/design/derived-projection-module.md` into the SKIL-179 implementation contract. The design draft is background; accepted ADR-0016, ADR-0026, and ADR-0034 govern fact/memo boundaries and full Projection rebuilds. The baseline is `origin/main` after PR #116; PR #113 (SKIL-162) remains draft at spec time and must land before Tasks 2-5. No data-file format or public `EvolutionWorkflow` behavior change is authorized.

## Intent classification

- **R-1** — WHEN a `FollowUpIntent` is classified, THE SYSTEM SHALL use one exhaustive `INTENT_OUTCOME: Record<FollowUpIntent, IntentOutcome>` in `follow-up.ts`, with `incorrect`, `constraint`, `retry`, `dissatisfied`, and `other` classified as failure, `satisfied` as success, `goal-changed` as task-change, and `not-attributable` and `unknown` as neutral.
- **R-2** — WHEN `FOLLOW_UP_INTENTS` or `FEEDBACK_KINDS` gains a value, THE SYSTEM SHALL fail core TypeScript compilation until the feedback kind belongs to `FollowUpIntent` and every intent has an explicit outcome. `FAILURE_INTENTS` and `isFailureIntent()` SHALL derive from `INTENT_OUTCOME` rather than carry a second hand-maintained set.
- **R-3** — WHEN Failure cases, attribution, confidence, or intent metrics determine whether a follow-up is a failure, THE SYSTEM SHALL use the shared failure-intent definition in all four current call sites (`experience.ts` three, `metrics.ts` one); the existing classifications and `INTENT_POLICY_VERSION` SHALL remain unchanged in this migration.
- **R-4** — WHEN `INTENT_OUTCOME` changes in a later revision, THE SYSTEM SHALL require a matching `INTENT_POLICY_VERSION` change through a version-and-table snapshot guard; changing only the table SHALL fail that guard.

## Registry and pure Projection

- **R-5** — WHEN a store is opened or a layout is resolved, THE SYSTEM SHALL obtain its name, role, path, and projection-input marker from one typed `STORES` registration in `store-registry.ts`; the current store order, paths, roles, marker values, and public service store fields SHALL remain compatible.
- **R-6** — WHEN a derived store is added to `STORES`, THE SYSTEM SHALL require a corresponding key and record type in `projectDerived(ctx).records` at core compile time; `DerivedRecords` SHALL contain every derived registration and exclude fact and memo registrations.
- **R-7** — WHEN `projectDerived(ctx)` runs twice with the same Observations, memo records, exact-hash Skill contents, and versions, THE SYSTEM SHALL produce field-identical records and counters without reading I/O, wall time, or calling a classifier/judge. It SHALL include workflow, correction, Skill-window, posterior, and attribution steps available after SKIL-162.
- **R-8** — WHEN `EvolutionWorkflow.snapshot()` or `EvolutionWorkflow.propose()` is called directly, THE SYSTEM SHALL retain their current signatures and behavior: `WorkflowSnapshot` remains distinct, `snapshot()` excludes correction Experiences and correction episodes/patterns, and both paths reuse the extracted pure `projectWorkflow` / `proposeFromRecords` logic.
- **R-9** — WHEN derivation versions are resolved, THE SYSTEM SHALL resolve every `DerivationVersions` field from an exhaustive `VERSION_SOURCES` map of named exported constants or injected versions (`none` when absent); the existing window/correction version override options SHALL continue to force re-Projection without changing calculation inputs.

## Persistent Projection

- **R-10** — WHEN `DerivedProjection.refresh()` evaluates a cursor, THE SYSTEM SHALL compare Observation count, last id, fingerprint, and a derivation key hashing the complete versions record, every registered memo store's count/last id, and the sorted set of resolved Skill-content hashes. A missing or mismatched old key SHALL trigger a full rebuild.
- **R-11** — WHEN the cursor and derivation key match and `force` is false, THE SYSTEM SHALL read every registered derived store into `DerivedView.records`; WHEN `force` is true or either fingerprint differs, THE SYSTEM SHALL run `projectDerived`, invalidate any matching old cursor before replacing stores, replace every derived store, then write the final cursor last. It SHALL never replace a fact or memo store.
- **R-12** — WHEN a derived-store write or final cursor write fails, THE SYSTEM SHALL propagate the error and leave the cursor unable to validate a partial new Projection, including a forced rebuild over an already matching cursor; the next refresh SHALL rebuild all derived stores. `repair()` SHALL force a full rebuild and retain valid memo bytes, per ADR-0034.
- **R-13** — WHEN a correction classifier failure is recorded, THE SYSTEM SHALL increment only the cursor's `correctionClassifierFailures` under its lock. Full refresh and repair SHALL preserve that locked-in count; deleting the cursor SHALL reset it to zero. The counter SHALL remain visible through `metrics().corrections.classifierFailures`.
- **R-14** — WHEN `refreshDerived()` returns, THE SYSTEM SHALL return the complete stored `DerivedRecords` view, including `skillWindows`, `skillPosteriors`, and `failureAttributions` after SKIL-162, while preserving the five required `WorkflowSnapshot` fields and existing public service store references.
- **R-15** — WHEN `proposeChange(clusterId, designer)` runs, THE SYSTEM SHALL pass the one refreshed stored view's Experiences, cases, cluster, and Diagnosis to the Designer, and SHALL call the Designer after releasing the cursor lock. `proposePattern` SHALL read patterns and episodes from that same view.

## Acceptance guards

- **R-16 (G1)** — WHEN a fixture produces at least one record in every registered derived store, THE SYSTEM SHALL return deep-equal per-store records from a forced rebuild and the following fast-path refresh.
- **R-17 (G2)** — WHEN any one version named by `VERSION_SOURCES` changes, THE SYSTEM SHALL change the derivation key and rebuild on the next ordinary refresh; the test SHALL enumerate source keys so new version fields are covered.
- **R-18 (G3)** — WHEN a record is appended to any registered memo store, THE SYSTEM SHALL change the derivation key and rebuild; the test SHALL enumerate all memo registrations.
- **R-19 (G4)** — WHEN a projection-step module exports a string name ending `_VERSION`, THE SYSTEM SHALL match that export name and value bidirectionally to a constant entry in `VERSION_SOURCES`; an unregistered constant with the same value as another constant SHALL fail.
- **R-20 (G5)** — WHEN a source module other than `derivation.ts` calls `readCursor`/`writeCursor` or replaces a derived store, or a source module other than `workflow.ts` constructs `EvolutionWorkflow` after migration, THE SYSTEM SHALL fail the architecture guard; `state-root.ts` remains the cursor function definition site, and projection-step modules SHALL also fail on inline `version: '<literal>'` declarations.
- **R-21 (G6)** — WHEN the intent outcome table changes without a version change, THE SYSTEM SHALL fail the snapshot of `{ version: INTENT_POLICY_VERSION, table: INTENT_OUTCOME }`.
- **R-22 (R1)** — WHEN two ordinary and two correction Experiences are stored and `proposeChange` calls a Designer, THE SYSTEM SHALL pass Experiences deep-equal to `service.experiences.readAll()`, including at least one `experience:correction:` record.
- **R-23 (R2)** — WHEN a cluster id returned by `refreshDerived()` is passed to `proposeChange`, THE SYSTEM SHALL find that cluster and pass its stored cases and Diagnosis unchanged to the Designer, without `unknown failure cluster`.
