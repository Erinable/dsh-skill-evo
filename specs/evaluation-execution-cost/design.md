## Decision authority

The execution-cost definitions, policy schema, statistical method, artifact binding, and context estimator are accepted in ADR-0029, ADR-0030, and ADR-0031. Existing core/adapter boundaries remain governed by ADR-0014, and evaluation artifacts remain append-only facts under ADR-0016. This spec turns `docs/design/evaluation-execution-cost.md` §2–§10 and those ADRs into an implementation contract; it does not reopen them.

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
6. Promote compares schema 2 hashes. Under schema 1, an artifact carrying `policyHash` must match the current hash; an artifact without a hash uses the existing `policyVersion` comparison. `sameArtifactEvidence` and `sameResultEvidence` compare hashes when both sides provide one, and `evaluated`/`promoted` DecisionRecords copy the hash when present. Reports and CLI output read the stored result and show `no-data` rather than hiding it.

## Gate identifiers and messages

The analyzer and evaluator use these stable identifiers and exact messages. A `<metric>` placeholder is `steps` or `tokens`; `<id>` is the case id. `cost.checks` always records the stated `status` and `detail`; only `failed` checks contribute a `gateReasons` string. A disabled check records `disabled` and `disabled by policy` and contributes no gate reason.

| Check id | Failed / no-data `gateReasons` | `detail` format |
| --- | --- | --- |
| `original-failure-improvement` | `original-failure did not improve` | `path (a) pass count did not increase; path (b1) <case id>: k_b = <n>, k_c = <n>; path (b2) <metric>: relativeChange = <x>, pValue = <p>` |
| `original-failure-regressed` | `original-failure case regressed: <id>` | `Base passed; Candidate passed samples = <k_c> of <R>` |
| `original-failure-<metric>-no-data` | `original-failure <metric>: no data` | `no comparable passed Sample contains <metric>` |
| `historical-success-pass-rate` | `historical-success pass rate regressed by more than five points` | `base = <x>, candidate = <y>, drop = <d>` |
| `historical-success-steps` | `historical-success steps increase exceeded policy` | `relativeChange = <x>, limit = <y>` |
| `historical-success-tokens` | `historical-success tokens increase exceeded policy` | `relativeChange = <x>, limit = <y>` |
| `historical-success-<metric>-no-data` | `historical-success <metric>: no data` | `no comparable passed Sample contains <metric>` |
| `catalog-context` | `catalog context increase exceeded policy` | `delta = <n>, limit = <m>` |
| `load-context` | `load context increase exceeded policy` | `delta = <n>, limit = <m>` |
| `schema1-token-cost-no-data` | `token cost: no data` | `configured ratio has no Base/Candidate token data` |
| `schema1-context-cost-no-data` | `context cost: no data` | `configured ratio has no Base/Candidate context data` |

For original-failure, a successful path (a) suppresses the no-data check for path (b2); the structured check remains `passed` with detail `path (a) pass count increased`. This is the only no-data exception.

## Policy and statistics

Schema 2 contains sampling, significance, original-failure, historical-success, and context settings from ADR-0030. `null` disables an individual check; omitted fields use defaults. Original-failure cost improvement requires the per-comparable-case pass-count condition before a significant reduction can satisfy the alternate improvement path. Historical-success cost increases use point estimates. `relativeChange` is undefined when the Base mean is zero; both zero means pass, while a nonzero Candidate mean fails a historical-success increase check.

The analyzer uses passed Samples only and weights comparable cases equally when forming category means. It reports `ok`, `no-data`, or `not-applicable` for each metric. The `stratified-permutation-v1` implementation follows ADR-0030 exactly: exact enumeration up to 10,000 permutations, otherwise 10,000 seeded Fisher-Yates draws using the candidate hash/category/metric byte stream. The two metrics in `steps-or-tokens` use alpha/2; `steps-and-tokens` uses alpha for each test.

The required independent reference vector for the sampled branch is fixed here. Use `candidateContentHash = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`, `category = original-failure`, and `metric = steps`. There are two layers, each with five passed Base and five passed Candidate Samples: layer 1 Base `[6,6,6,6,6]`, Candidate `[2,2,2,2,2]`; layer 2 Base `[4,4,4,4,4]`, Candidate `[3,3,3,3,3]`. The observed statistic is `T = 5`; the permutation space is `C(10,5)^2 = 63,504`, so the implementation must use the sampled branch. Independently applying `seed = sha256(candidateContentHash + "\\n" + category + "\\n" + metric)`, blocks `sha256(seed || uint32be(j))`, big-endian uint32 rejection sampling, and per-layer Fisher-Yates over `[base, candidate]` for 10,000 draws gives tail count `0` and reference `pValue = 1/10001 = 0.00009999000099990002`. Any change to this algorithm requires a new statistic id.

## Error handling and compatibility

Validation errors stop before execution. Executor failures and timeouts become unknown Samples with absent measurements. Unknown or failed Samples never lower a cost mean. Missing configured measurements yield a failed `no-data` check, while disabled checks are recorded as `disabled` and do not gate. Existing schema 1 global ratio checks retain their semantics, except configured missing/zero-baseline data is now explicit `no-data` failure. Existing artifacts without schema 2 fields remain readable under schema 1 policy and are rejected under schema 2 unless re-evaluated with a matching hash. A schema 1 artifact that does carry a hash is checked against the current schema 1 hash; only a hashless artifact uses version-only comparison.

The adapter's context argument is optional so existing runners continue to compile. Without it, the adapter may retain its legacy exposure fallback; evaluator-created runs always pass explicit exposure. The fake executor's script is additive and leaves its current default behavior unchanged.

## Verification strategy

Unit tests for `evaluation-cost.ts` cover the 6-to-2 reduction, historical increase, context thresholds, unstable outcomes, no-data, deterministic exact and sampled permutations, alpha combinations, and the 5/5-to-3/5 guard. Evaluator tests cover interleaving, majority classification, boundary reuse, schema 1 no-data, and hard-gate composition. Adapter tests cover explicit exposure, measurement forwarding, script fixtures, and error-as-undefined. Artifact/promotion tests cover legacy reads, schema 2 hash mismatch, and the schema 1 artifact decision above. CLI tests assert JSON and Markdown field visibility for `evaluate` and `metrics`; existing package build/test commands remain the final regression check.

## Non-goals and current assumptions

- No CLI `--runner` injection is added; numerical fake-runner assertions live at the operation layer.
- `modelTurns` is report-only and never gates.
- `metrics.contextCost` keeps its existing host-reported meaning; `skillContext` is additive.
- No provider-rank selection, runtime event interpretation, or new Evaluation case category is introduced.
- The schema 1 artifact choice is a current compatibility decision, not an ADR change; members may revise it before implementation if they intentionally change the legacy contract.
