## Requirements

### Core contract and policy

- **R-1 Types stay DSH-independent.** WHEN the core evaluates a proposal THE SYSTEM SHALL obtain `toolCalls`, `modelTurns`, `tokenCost`, and `contextCost` through the optional `CaseRunResult` fields and SHALL keep DSH event or executor types outside `packages/skill-evolution`.
- **R-2 Schema 2 is explicit.** WHEN a policy has `schema: 2` THE SYSTEM SHALL normalize `sampling.runs` to 5, `significance.alpha` to 0.05, and the documented original-failure, historical-success, and context defaults, while accepting runs only as integers from 1 through 20 and alpha only in `(0, 0.5]`.
- **R-3 Schema 1 remains compatible.** WHEN a policy has no `schema` field THE SYSTEM SHALL execute schema 1 semantics with one run, the existing pass-count original-failure rule, and the existing global token/context ratios.
- **R-4 Invalid mixed policy fields are rejected.** WHEN a schema 2 policy contains schema 1 cost fields or an invalid value THE SYSTEM SHALL return policy validation errors before running an evaluation.

### Sampling and execution cost

- **R-5 Samples are collected deterministically.** WHEN an evaluation has `R` runs THE SYSTEM SHALL execute each case in the order `base#0, candidate#0, ... base#R-1, candidate#R-1`, pass `exposure` and `sample` in the run context, and reuse the base Sample for high-boundary checks.
- **R-6 Sample outcomes use majority semantics.** WHEN a side has `R` Samples THE SYSTEM SHALL mark the case passed only when `2 * passedSamples > R`, mark a side unstable when `0 < passedSamples < R`, and classify a non-majority side as `unknown` when at least half its Samples are unknown.
- **R-7 Execution cost uses the accepted definitions.** WHEN a Sample reports cost THE SYSTEM SHALL treat `toolCalls` as steps including failed and retried calls, treat `tokenCost` as input plus output tokens including cache hits, and leave missing values `undefined` rather than treating them as zero.
- **R-8 Cost comparisons are scoped.** WHEN the system compares steps or tokens THE SYSTEM SHALL use only passed Samples from case-level comparable cases where both sides pass, and SHALL report `no-data` when a required metric is absent.
- **R-9 Statistical output is reproducible.** WHEN the system analyzes the same Samples, category, content hash, and policy twice THE SYSTEM SHALL produce byte-identical summaries using `stratified-permutation-v1`, including its exact-enumeration or seeded 10,000-draw algorithm and the specified alpha handling for `steps-or-tokens` and `steps-and-tokens`.

### Gates and context

- **R-10 Original-failure cost improvement preserves pass probability.** WHEN schema 2 requires original-failure improvement THE SYSTEM SHALL pass if either Candidate pass count increases, or every comparable case has Candidate Sample pass count at least Base and the configured cost metric meets its reduction and significance thresholds; otherwise it SHALL fail with a structured reason naming the failing case or no-data condition.
- **R-11 Historical-success regressions are gated.** WHEN a historical-success case or category exceeds `maxPassRateDrop`, `maxStepIncrease`, or `maxTokenIncrease` THE SYSTEM SHALL fail the gate with the corresponding reason and set the decision to `needs-review`.
- **R-12 Context cost is content-derived.** WHEN the system evaluates or aggregates a Skill THE SYSTEM SHALL compute catalog tokens from frontmatter `name` and `description`, load tokens from the full UTF-8 content, use estimator `utf8-bytes-div4-v1`, and apply schema 2 absolute catalog/load increase thresholds.
- **R-13 Missing data is visible and blocking where configured.** WHEN a configured schema 1 or schema 2 cost check lacks required data THE SYSTEM SHALL report `no-data` in `cost.checks`, render it in reports, and fail that configured check rather than silently passing it, except that the original-failure improvement path SHALL still pass when path (a), Candidate pass count greater than Base, succeeds; original-failure no-data fails only when path (a) is false and path (b2) needs the missing metric.

### Persistence, adapters, and interfaces

- **R-14 Schema 2 artifacts bind evidence to policy.** WHEN schema 2 evaluation completes THE SYSTEM SHALL persist normalized policy, `schemaVersion: 2`, `policyHash`, raw Samples, and `stratified-permutation-v1`; promote SHALL require the hash to equal the current schema 2 policy hash.
- **R-15 Schema 1 artifact shape is retained.** WHEN schema 1 evaluation completes THE SYSTEM SHALL omit `schemaVersion: 2`, the policy snapshot, and `policyHash` (an absent schema version remains legacy schema 1); during promote, an artifact that carries `policyHash` SHALL require an equal current hash, while an artifact without a hash SHALL use the existing `policyVersion` comparison.
- **R-16 Legacy artifacts remain readable.** WHEN an artifact has no schema 2 fields THE SYSTEM SHALL normalize and read it, and schema 1 policy SHALL still allow promote when its existing evidence matches.
- **R-17 The DSH adapter forwards measurements.** WHEN `createDshEvaluationRunner` receives a run context THE SYSTEM SHALL forward `exposure`, `sample`, `toolCalls`, and `modelTurns`, and SHALL use explicit exposure even when Base and Candidate content is identical.
- **R-18 Adapter failures do not fabricate cost.** WHEN a DSH execution errors or times out THE SYSTEM SHALL leave `toolCalls` undefined, classify the Sample as unknown, and exclude it from cost statistics.
- **R-19 Fake execution is scriptable.** WHEN tests provide a fake executor script THE SYSTEM SHALL be able to return per-case, per-exposure, and per-sample pass, step, token, and context values while preserving existing defaults when no script is supplied.
- **R-20 CLI surfaces the contract.** WHEN `evaluate --policy` runs with schema 2 THE SYSTEM SHALL expose cost categories, context, checks, pass rates, and report tables in JSON/Markdown; WHEN `metrics` reads current Skills THE SYSTEM SHALL expose per-Skill context and top-level `skillContext` using the same estimator.
- **R-22 Original-failure regressions are explicit.** WHEN a schema 2 original-failure case passes on Base and fails on Candidate THE SYSTEM SHALL add `original-failure case regressed: <id>` to `gateReasons`, even when another original-failure case improves.
- **R-23 Policy hashes identify evidence.** WHEN an artifact or result has a `policyHash` THE SYSTEM SHALL include it in `evaluated` and `promoted` DecisionRecords and SHALL compare it in `sameArtifactEvidence` and `sameResultEvidence` whenever both sides provide a hash.

### Required acceptance scenarios

- **R-21 End-to-end gates cover the design cases.** WHEN the fake executor supplies the design's fixtures THE SYSTEM SHALL pass original-failure 6-to-2 step reduction, reject historical-success step increase, reject context increases, report unstable R-of-N outcomes, report no data, prevent a 5/5-to-3/5 cost-path bypass, and reject schema 1 evidence after switching to schema 2 even when the version string is unchanged.
