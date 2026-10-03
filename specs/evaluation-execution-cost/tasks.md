## Delivery order

Tasks are ordered by dependency. Task 1 is the tracer bullet for the contract: a scriptable DSH adapter returns the new measurements and the core accepts one normalized schema 2 policy. Later tasks add analysis, repeated evaluation, persistence, and presentation. Each task is independently verifiable and maps directly to Builder-sized work.

### Task 1 — Establish the end-to-end measurement contract

- **Depends on:** none.
- **Requirements:** R-1, R-2, R-3, R-4, R-17, R-18, R-19.
- **Files:** `packages/skill-evolution/src/types.ts`, policy validation/normalization module, `packages/dsh-adapter/src/evaluator.ts`, `packages/dsh-adapter/src/fake-executor.ts`, and their focused tests.
- **Acceptance:** Add the optional core fields and evaluation context, schema 1/2 policy types plus normalization/validation, adapter forwarding with explicit exposure and undefined-on-error behavior, and the fake executor script. Tests assert normalized defaults, rejection of schema 2 mixed legacy fields before any runner call, adapter `CaseRunResult` forwarding of `toolCalls`/`modelTurns`, identical Base/Candidate content still follows explicit exposure, and executor failure leaves `toolCalls` undefined. Run the affected package build and tests.

### Task 2 — Implement pure context and execution-cost analysis

- **Depends on:** Task 1.
- **Requirements:** R-7, R-8, R-9, R-12, R-13.
- **Files:** `packages/skill-evolution/src/evaluation-cost.ts` and pure analysis tests.
- **Acceptance:** Add `evaluation-cost.ts` with `measureSkillContext` and `analyzeEvaluationCost`. Unit tests assert UTF-8/div-4 estimates, comparable passed-Sample filtering, summaries and no-data states, stable check ids/messages from `design.md`, exact 6-to-2 permutation p-value `1/252`, and alpha handling for both compound metrics. The sampled branch must use this fixed independent vector: hash `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`, category `original-failure`, metric `steps`, layers Base/Candidate `[6,6,6,6,6]`/`[2,2,2,2,2]` and `[4,4,4,4,4]`/`[3,3,3,3,3]`; `T = 5`, 63,504 permutations, 10,000 draws, tail count `0`, expected `pValue = 0.00009999000099990002`. The reference is computed independently with the ADR-0030 seed, SHA-256 block stream, rejection sampling, and Fisher-Yates steps stated in `design.md`; the test may not call the production permutation helper to derive the expected value.

### Task 3 — Wire repeated evaluation and gates

- **Depends on:** Tasks 1–2.
- **Requirements:** R-5, R-6, R-10, R-11, R-21, R-22.
- **Files:** `packages/skill-evolution/src/evaluator.ts` and evaluator/operation tests.
- **Acceptance:** `evaluateCandidate` runs interleaved R Samples, folds majority/unstable/unknown states, reuses Base boundary Samples, merges analyzer checks with hard constraints, and enforces original-failure and historical-success rules. Fixtures and assertions cover: original-failure Base/Candidate 5/5 at 6/2 steps passes with relative change about `-0.667` and `pValue = 1/252`; historical-success 4/5 steps to 5/5 (+25%) rejects; Candidate load increase above 4100 bytes and description increase by 300 bytes reject, and `cost.context` equals direct `measureSkillContext` output; 3/5 and 2/5 Candidate outcomes report `unstable` with pass rate 0.6/0.4; runner-without-cost rejects with the exact original-failure no-data reason; an original-failure Base-pass/Candidate-fail case is rejected as `original-failure case regressed: <id>` even when another case improves; and the 5/5-to-3/5 cost-path case fails with detail `k_b = 5`, `k_c = 3`, while the 5/5-to-5/5 control passes with `pValue = 1/252`. For schema 1, `evolution.spec.ts:149-159` retains today's `gateReasons`, high-boundary Base reuse makes runner calls exactly `2N`, and configuring `maxTokenIncreaseRatio` without token data produces `token cost: no data`. Run the affected package build and tests.

### Task 4 — Persist policy-bound artifacts and preserve compatibility

- **Depends on:** Task 3.
- **Requirements:** R-14, R-15, R-16, R-21, R-23.
- **Files:** `packages/skill-evolution/src/service.ts`, `packages/skill-evolution/src/operations.ts`, artifact/promotion and ledger tests.
- **Acceptance:** Schema 2 artifacts persist normalized policy, `schemaVersion: 2`, hash, Samples, and statistic id; schema 1 artifacts omit schema 2 fields. Promote tests prove: legacy artifact normalization under schema 1; a schema 2 threshold edit with unchanged version rejects on hash mismatch; schema 1 evidence without a hash rejects after switching to schema 2; a manually hash-stripped schema 2 artifact rejects with `evaluation-mismatch`; and an artifact evaluated under schema 2 with a hash, followed by switching to a current schema 1 policy with the same version, rejects unless its hash equals the current normalized schema 1 policy hash. A hashless artifact under schema 1 uses `policyVersion`; schema 1 policy normalization still computes a hash for this comparison. Tests also assert `policyHash` is written to `evaluated` and `promoted` DecisionRecords and compared by `sameArtifactEvidence`/`sameResultEvidence` when both sides provide it. Run the affected package build and tests.

### Task 5 — Render reports and CLI evaluation output

- **Depends on:** Task 4.
- **Requirements:** R-13, R-20, R-21.
- **Files:** `packages/skill-evolution/src/report.ts`, operation entry points, `packages/skill-evolution/bin/dsh-skill-evolution.mjs`, and CLI tests.
- **Acceptance:** `evaluate --policy` JSON exposes `cost.categories` with pass rates, `cost.context`, and every `cost.checks` id; the default content-check runner produces `no-data` for steps and tokens; Markdown exposes the cost table, exact `no data` messages, and `Execution cost: not recorded` for legacy results. Operation-level tests assert the 6-to-2 relative change/p-value and report visibility without adding a CLI runner-loading option. Run the affected package build and tests.

### Task 6 — Add metrics context aggregation

- **Depends on:** Task 2; may run in parallel with Tasks 3–5 after Task 2 passes.
- **Requirements:** R-12, R-20.
- **Files:** `packages/skill-evolution/src/metrics.ts`, `packages/skill-evolution/src/service.ts`, and metrics/CLI tests.
- **Acceptance:** `aggregateMetrics` and `service.metrics()` accept current Skill content, expose per-Skill `context` with catalog/load/exposure-weighted tokens, and expose top-level `skillContext`; CLI tests assert values equal `measureSkillContext` for the same content while preserving the existing top-level `contextCost`. Run the affected package build and tests.
