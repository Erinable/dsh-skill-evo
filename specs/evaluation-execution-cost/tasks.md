## Delivery order

Tasks are ordered by dependency. Task 1 is the tracer bullet: one schema 2 evaluation can travel from a scriptable DSH adapter through core policy normalization and produce a visible cost result. Each task is independently verifiable and maps directly to Builder-sized work.

### Task 1 — Establish the end-to-end measurement contract

- **Depends on:** none.
- **Requirements:** R-1, R-2, R-3, R-17, R-18, R-19, R-20.
- **Acceptance:** Add the optional core fields and evaluation context, schema 1/2 policy types plus normalization/validation, adapter forwarding with explicit exposure and undefined-on-error behavior, and the fake executor script. A focused operation test runs one schema 2 case with a scripted `toolCalls`/`tokenCost` result and asserts the JSON result contains the raw measurements and normalized policy without importing DSH types into core.

### Task 2 — Implement pure context and execution-cost analysis

- **Depends on:** Task 1.
- **Requirements:** R-7, R-8, R-9, R-12, R-13.
- **Acceptance:** Add `evaluation-cost.ts` with `measureSkillContext` and `analyzeEvaluationCost`. Unit tests assert UTF-8/div-4 estimates, comparable passed-Sample filtering, summaries and no-data states, exact 6-to-2 permutation p-value `1/252`, deterministic seeded sampling above 10,000 permutations, and alpha handling for both compound metrics.

### Task 3 — Wire repeated evaluation and gates

- **Depends on:** Tasks 1–2.
- **Requirements:** R-5, R-6, R-10, R-11, R-21.
- **Acceptance:** `evaluateCandidate` runs interleaved R Samples, folds majority/unstable/unknown states, reuses Base boundary Samples, merges analyzer checks with hard constraints, and enforces original-failure and historical-success rules. Tests cover the 6-to-2 pass, historical step rejection, context rejection, unstable 3/5 and 2/5 outcomes, no-data rejection, and 5/5-to-3/5 cost-path rejection.

### Task 4 — Persist policy-bound artifacts and preserve compatibility

- **Depends on:** Task 3.
- **Requirements:** R-14, R-15, R-16, R-21.
- **Acceptance:** Schema 2 artifacts persist normalized policy, `schemaVersion: 2`, hash, Samples, and statistic id; schema 1 artifacts omit schema 2 fields and retain version-only promote behavior. Tests prove legacy artifact normalization, schema 2 threshold edits with unchanged version reject on hash mismatch, and schema 1 evidence without a hash rejects after switching to schema 2.

### Task 5 — Render reports and CLI evaluation output

- **Depends on:** Task 4.
- **Requirements:** R-13, R-20, R-21.
- **Acceptance:** `evaluate --policy` JSON exposes `cost.categories`, pass rates, context, and checks; Markdown exposes the cost table and `no data`. Operation-level tests assert the 6-to-2 relative change/p-value and the no-data report without adding a CLI runner-loading option.

### Task 6 — Add metrics context aggregation

- **Depends on:** Task 2; may run in parallel with Tasks 3–5 after Task 2 passes.
- **Requirements:** R-12, R-20.
- **Acceptance:** `aggregateMetrics` and `service.metrics()` accept current Skill content, expose per-Skill `context` with catalog/load/exposure-weighted tokens, and expose top-level `skillContext`; CLI tests assert values equal `measureSkillContext` for the same content while preserving the existing top-level `contextCost`.
