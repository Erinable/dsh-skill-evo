## Decision authority

The execution-cost definitions, policy schema, statistical method, artifact binding, and context estimator are accepted in ADR-0029, ADR-0030, and ADR-0031. Existing core/adapter boundaries remain governed by ADR-0014, and evaluation artifacts remain append-only facts under ADR-0016. This spec turns those decisions into an implementation contract; it does not reopen them.

## Architecture

The dependency direction is:

```text
packages/dsh-adapter  ->  EvaluationRunner / CaseRunResult  ->  packages/skill-evolution
                                                           ->  evaluation-cost.ts
packages/skill-evolution -> artifact, report, CLI, metrics
```

`packages/skill-evolution/src/evaluation-cost.ts` is a pure analysis seam. `measureSkillContext(content)` computes the ADR-0031 estimate. `analyzeEvaluationCost(input)` receives immutable cases, collected Samples, contents, candidate hash, and normalized policy; it performs summaries, comparable-case selection, permutation tests, context checks, and structured `cost.checks`. It does not call a runner, read files, or import DSH.

`evaluator.ts` owns orchestration and hard constraints: it runs the interleaved Samples, folds Sample results into majority case results, reuses Base boundary Samples, aggregates security/side-effect evidence, and combines hard-constraint and cost reasons. `dsh-adapter` owns DSH measurement extraction and error mapping. `service.ts`/`operations.ts` own policy normalization, artifact persistence, and promote evidence checks. `report.ts` and the CLI render the same result shape; they do not recompute statistics.

## Data flow

1. The caller supplies a schema 1 or schema 2 policy. Validation and normalization happen before any runner call; normalized defaults are the sole input to gates.
2. The evaluator invokes Base and Candidate in deterministic interleaved order with `{ exposure, sample }`. It stores raw Sample fields, including undefined measurements, and classifies each side by majority.
3. The cost analyzer receives the complete Sample set and content. It computes per-case and per-category `MetricSummary`/`MetricComparison`, pass rates, unstable markers, context deltas, and `cost.checks`.
4. The evaluator appends failed checks to `gateReasons`, preserving existing hard-constraint reasons. A failed cost check produces `needs-review`; boundary cases report cost but have no cost gate.
5. A schema 2 artifact stores `schemaVersion: 2`, normalized `policy`, canonical-JSON `policyHash`, raw Samples, and the statistic id. A schema 1 artifact deliberately keeps the legacy shape: it omits `schemaVersion: 2`, policy snapshot, and `policyHash`. This resolves the design draft's conflicting statements and makes acceptance case 15 explicit.
6. Promote compares schema 2 hashes, while schema 1 retains version-only behavior for both new legacy-shaped and old artifacts. Reports and CLI output read the stored result and show `no-data` rather than hiding it.

## Policy and statistics

Schema 2 contains sampling, significance, original-failure, historical-success, and context settings from ADR-0030. `null` disables an individual check; omitted fields use defaults. Original-failure cost improvement requires the per-comparable-case pass-count condition before a significant reduction can satisfy the alternate improvement path. Historical-success cost increases use point estimates. `relativeChange` is undefined when the Base mean is zero; both zero means pass, while a nonzero Candidate mean fails a historical-success increase check.

The analyzer uses passed Samples only and weights comparable cases equally when forming category means. It reports `ok`, `no-data`, or `not-applicable` for each metric. The `stratified-permutation-v1` implementation follows ADR-0030 exactly: exact enumeration up to 10,000 permutations, otherwise 10,000 seeded Fisher-Yates draws using the candidate hash/category/metric byte stream. The two metrics in `steps-or-tokens` use alpha/2; `steps-and-tokens` uses alpha for each test.

## Error handling and compatibility

Validation errors stop before execution. Executor failures and timeouts become unknown Samples with absent measurements. Unknown or failed Samples never lower a cost mean. Missing configured measurements yield a failed `no-data` check, while disabled checks are recorded as `disabled` and do not gate. Existing schema 1 global ratio checks retain their semantics, except configured missing/zero-baseline data is now explicit `no-data` failure. Existing artifacts without schema 2 fields remain readable under schema 1 policy and are rejected under schema 2 unless re-evaluated with a matching hash.

The adapter's context argument is optional so existing runners continue to compile. Without it, the adapter may retain its legacy exposure fallback; evaluator-created runs always pass explicit exposure. The fake executor's script is additive and leaves its current default behavior unchanged.

## Verification strategy

Unit tests for `evaluation-cost.ts` cover the 6-to-2 reduction, historical increase, context thresholds, unstable outcomes, no-data, deterministic exact and sampled permutations, alpha combinations, and the 5/5-to-3/5 guard. Evaluator tests cover interleaving, majority classification, boundary reuse, schema 1 no-data, and hard-gate composition. Adapter tests cover explicit exposure, measurement forwarding, script fixtures, and error-as-undefined. Artifact/promotion tests cover legacy reads, schema 2 hash mismatch, and the schema 1 artifact decision above. CLI tests assert JSON and Markdown field visibility for `evaluate` and `metrics`; existing package build/test commands remain the final regression check.

## Non-goals and current assumptions

- No CLI `--runner` injection is added; numerical fake-runner assertions live at the operation layer.
- `modelTurns` is report-only and never gates.
- `metrics.contextCost` keeps its existing host-reported meaning; `skillContext` is additive.
- No provider-rank selection, runtime event interpretation, or new Evaluation case category is introduced.
- The schema 1 artifact choice is a current compatibility decision, not an ADR change; members may revise it before implementation if they intentionally change the legacy contract.
