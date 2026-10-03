## Decision boundary

This spec is based on `docs/design/skill-window-posterior-attribution.md` sections 2–8 and accepted ADR-0025–0028. Those ADRs are the authority for the core vocabulary, derived-store boundary, weighted Failure case identity/gates, and emission judge contract. The existing SKIL-133 implementation on `origin/main` provides the compatibility shape: `Experience.confidence` and `SkillDiagnosis.confidence` are evidence-strength bands/scores, while explicit `attributionConfidence` remains separate. The new posterior `margin` follows that same rule and is not a probability, proposal gate, or weight until calibration is explicitly adopted.

The reversible defaults adopted here are W2 (window separate from qualification interval), ToolAttempt time steps, `rho = 0.9`, `lambda = 0.8`, scaled forward-backward marginal decoding, `rule-1`, explicit emission scoring with memo, one deep inference module, K=3 nearby steps, `minShare = 0.1`, `uncoveredShare = 0.5`, dominant-only proposal gates, refresh-before-metrics, and manual calibration adoption. Members may overturn these business judgments before implementation.

## Architecture and data flow

The dependency direction remains core-first:

```text
packages/dsh-bundle -> core Observation vocabulary
packages/skill-evolution -> inferSkillAttribution -> windows/posteriors/attributions
                       -> Experiences, Failure cases, clusters, diagnoses, metrics, reports
host / dsh-adapter -> SkillContentSource, SkillEmissionJudge, CounterfactualReplay
```

The bundle maps DSH compaction/pruning and replacement metadata into the vocabulary from ADR-0025. Core orders and pairs observations into SKIL-128 `ToolAttempt` values, creates SkillWindows, keeps a separate in-memory qualification interval for the HMM, resolves content by exact hash, chooses memo emission or `rule-1`, then runs the pure `inferSkillAttribution` module. Projection writes `skill-windows`, `skill-posteriors`, and `failure-attributions` as derived stores. It passes attributions into Experience and Failure-case construction; it never invokes an injected judge.

An explicit `scoreSkillEmissions({ signal, limit })` maintenance operation calls `SkillEmissionJudge` once per session, stores immutable `emissions` memo rows, and invalidates the projection cursor through the combined `judges`/`derivationKey` shape. The default `rule-1` path remains synchronous and deterministic. A `SkillContentSource` adapter reads exact content hashes from the Skill root; a host may provide a DSH-directory adapter. Missing content is a valid `profile: 'missing'` input, not an error.

`calibrateSkillPosteriors` is an optional maintenance seam. Core owns the `CounterfactualReplay` interface, while dsh-adapter implements it by adapting `DshEvaluationExecutor` to accept a Skill set and replay with one named Skill withheld. Per §15 of the design, this spec makes the operation accept `task` from the host; it does not add `payload.taskSummary` collection. The correction-episode routing point is specified as “以 SKIL-136 合并版为准” until that spec merges.

## Public records and interfaces

The implementation shall add these core records without writing back to Observation facts:

- `SkillWindow`: `window:<startObservationId>`, session/Skill/content hash, start/end ids, end reason/certainty, and step Observation ids.
- `SkillPosterior`: `posterior:<sessionId>`, `hmm-1` parameters/hash, emission version/source/fallback/input hash, Skill profiles, prefix flag, per-tool-step shares/MAP/alignment, trajectory shares, per-window shares, and evidence-time `createdAt`.
- `FailureAttribution`: `attribution:<subjectId>`, origin/session/source, state shares, uncalibrated margin, uncovered flag, anchor and contributing steps, and optional posterior id.

`inferSkillAttribution(observations, { emissions, contents, params })` is the single deep module. Its output is `{ windows, posteriors, attributions }`. `EmissionLookup` resolves a session/input hash to a validated memo `EmissionOutput` or no result. Window segmentation, qualification, forward-backward, and nearby-step attribution are internal seams tested through that function.

The emission seam is the accepted ADR-0028 shape:

```ts
type SkillEmissionJudge = DerivedJudge<EmissionInput, EmissionOutput>

interface SkillContentSource {
  readonly id: string
  read(contentHash: string, skillName: string): Promise<string | undefined>
}

interface CounterfactualReplay {
  readonly version: string
  replay(input: {
    readonly sessionId: string
    readonly task: string
    readonly skills: readonly EmissionSkill[]
    readonly withheld?: string
    readonly signal: AbortSignal
  }): Promise<{
    readonly steps: readonly EmissionStep[]
    readonly outcome: 'passed' | 'failed' | 'unknown'
  }>
}
```

`EmissionInput`, `EmissionOutput`, `EmissionStep`, `EmissionSkill`, `SkillPosteriorParams`, `StateShares`, and `PosteriorStep` use the exact field names and types in design §3.3 and §4.2. The implementation must preserve the SKIL-128 `ToolAttempt`/redaction contract rather than adding a second collector.

## State, cursor, and persistence

`StoreName`/layout gains `skill-windows`, `skill-posteriors`, `failure-attributions`, and `emissions`; the first three are derived stores and `emissions` is a `memo` role. Projection may replace only derived stores. Memo rows are append-only and survive repair. The cursor's readable `judges` record contains emission, posterior-model, posterior-params, and Skill-content keys; `derivationKey` hashes that record plus emission memo count/last id and resolved content hashes. A changed judge version, memo, model parameter, or content profile forces full re-projection. Removing a judge restores `rule-1` output.

Posterior probabilities serialize to six decimal places and are normalized within `1e-6`. Ineligible Skills are absent from `StateShares` and therefore mean zero. Derived `createdAt` values come from evidence, never wall-clock time, so unchanged input plus memo produces byte-identical output and stable ids.

## Failure and downstream behavior

Failure priority is explicit Skill, attribution override, single loaded Skill, no loaded Skill, then posterior. Posterior attribution uses the nearest three same-task steps and explicit feedback anchors in `toolCallId`, `stepId`, `correlationIds`, session fallback order. Fan-out emits weighted per-Skill cases, records `noneShare`/`uncovered`, and marks one dominant case deterministically. `occurrenceCount` remains the case count; dominant and weighted counts are additive. Diagnosis evidence uses `weightedOccurrence`, falling back to `occurrenceCount` for legacy clusters; `margin` remains outside `attributionConfidence`. Proposal gating has one implementation in `isClusterReadyForProposal`, and only dominant cases count.

Experiences replace the old multi-Skill `unattributed` grouping with MAP/attribution-share groups, while explicit overrides retain their category. Reports and metrics expose window certainty, eligible/dominant/expected steps, weighted and dominant failures, uncovered subjects, and none steps. `metrics()` refreshes first so it agrees with `failures()`. SKIL-130 supplies step/token definitions; the posterior supplies only the allocation.

Correction episodes remain Experiences/episodes rather than Failure cases. Their target routing applies SKIL-128 rule 0, then explicit `--skill` rule 1, then posterior shares across referenced steps: majority uncovered selects `create-skill`, majority dominant Skill selects `patch-content`, followed by rules 3 and 4. Episodes without posterior data use the original `loadedSkills` rule-2 input. Until SKIL-136 is merged, the implementation must align its correction-episode branch to the SKIL-136 merged version.

## Error handling and compatibility

Malformed bundle payload metadata is ignored or treated as absent through existing core validation; unknown legacy records use uncertain windows and session-end qualification. Invalid judge matrices fall back for the whole session and record the reason. Missing memo rows fall back to `rule-1`; a judge is never called implicitly by `failures`, `metrics`, worker refresh, repair, or Projection. Missing content is a normal zero-evidence profile. Aborted or failed calibration leaves existing derived stores unchanged and reports skipped/failed replay inputs.

Existing JSON fields, ids, Failure origins, cluster ordering, and SKIL-126/SKIL-134 compatibility remain additive. The new `tool-failure` origin diagnoses as uncertain/observe-only unless existing structured evidence selects another cause. Runtime behavior, Provider rank, full replay, task-summary collection, DSH backend changes, and a real model backend are outside this spec.

## Seams

| seam | adapter(s) | boundary |
|---|---|---|
| `SkillEmissionJudge` | deterministic `rule-1`, host judge, test fake | Projection consumes validated memo/output; model calls stay in `scoreSkillEmissions` |
| `SkillContentSource` | Skill-root reader, DSH directory reader, test map | Exact content-hash lookup; missing content is a valid profile |
| `CounterfactualReplay` | dsh-adapter `DshEvaluationExecutor`, test fake | Accepts a Skill set and can replay with one named Skill withheld; receives host `task` |
| bundle shadowing mapper | current dsh-bundle mapper | Converts DSH replacement/shadowing metadata to core vocabulary |

Transition parameters, window segmentation, and nearby-step aggregation remain internal to `inferSkillAttribution`; they are not independently injected seams.

## Verification strategy

Tests should be centered on the pure module and mapper, with focused service/store tests for memo and cursor behavior. The required acceptance fixtures are the design §9 scenarios: single-window end reasons and downgrade; clean/noisy/withNone posterior MAP rates of at least 0.9/0.9/0.85; hard zero for unloaded or shadowed Skills; multi-Skill weighted attribution; explicit and override precedence; judge replacement and restoration; shadowing mapping; deterministic reorder/projection; uncovered suppression with unknown prefix; metrics arithmetic; dominant-only proposal gates; and explicit feedback anchor lookup/fallback. Core, bundle, adapter, and affected package build/test commands are the final checks.

## Non-goals and assumptions

No new DSH event is required. Fork-seed Skill loads remain represented by `unknownPrefix`; process-restart follow-up gaps remain with SKIL-126/SKIL-128. The optional calibration operation receives its task from the host; collecting `taskSummary` is a separate privacy-scoped requirement. The cursor merge shape is assigned to the first implementation task that changes it, and later tasks add keys without inventing another cursor contract.
