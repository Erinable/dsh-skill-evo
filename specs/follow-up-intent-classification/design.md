## Design

### Outcome and boundaries

The implementation adds deterministic follow-up intent resolution to the core maintenance loop. Runtime mapping remains synchronous and append-only. A Follow-up resolution is a Derived record for every `user-follow-up`; Failure cases, clusters, Diagnoses, and metrics consume that record instead of re-reading follow-up text. The only model boundary is the explicit `classifyFollowUps` Maintenance operation. A real backend and a classification CLI are outside this spec (R-18).

The accepted irreversible decisions are already recorded in ADR-0033 (preceding tool fields), ADR-0034 (Classification memo and deterministic Projection), and ADR-0035 (intent vocabulary and versioned classifier). ADR-0014 keeps DSH imports out of core; ADR-0016 keeps model judgments out of the Observation log; ADR-0022 supplies structured Failure origins and stable cluster identity. These decisions are referenced here rather than restated.

### Data flow

1. `packages/dsh-bundle/index.js` tracks the last relevant core Observation kind and failure bit for the current session turn. On a follow-up it writes `precedingToolKind` and `precedingToolFailed` when present, then clears the turn state on the next human message.
2. Core reads the Observation log and calls the pure resolver in a new follow-up module. Resolution priority is explicit payload, matching Classification memo entry, then the versioned rule table. The resolver also computes the unique earlier Skill target, tool-based attribution correction, confidence, evidence ids, and the stable policy/rules version.
3. `EvolutionWorkflow.snapshot()` receives memo entries and classifier version as options but remains synchronous. It exposes `followUps`, then passes those resolutions to `buildFailureCases`, `clusterFailureCases`, `diagnoseFailureCluster`, and `aggregateMetrics`. No projection function performs I/O or invokes a classifier.
4. `classifyFollowUps` reads observations, skips explicit and pending entries, builds a closed `FollowUpClassificationInput`, and calls the injected `FollowUpClassifier`. Valid results append to `classifications.jsonl`; failures are returned per observation and leave no memo row. A later Projection sees the memo by version and input hash.
5. `EvolutionService.refreshDerived` reads the Observation log and memo, writes `follow-ups.jsonl` plus the existing derived stores, and updates the cursor only after all derived writes succeed. `derivationKey` includes rules version, policy version, classifier version (or `none`), and memo count/last id. A mismatch forces a full rebuild.

### Core interfaces and records

The public names may follow repository conventions, but their shape and invariants are fixed:

```ts
type FollowUpIntent = typeof FOLLOW_UP_INTENTS[number]

interface FollowUpClassifier {
  readonly version: string
  classify(input: FollowUpClassificationInput, signal: AbortSignal): Promise<{
    readonly intent: Exclude<FollowUpIntent, 'other'>
    readonly confidence: number
    readonly rationale?: string
  }>
}

interface FollowUpClassificationInput {
  readonly observationId: string
  readonly text?: string
  readonly skillName?: string
  readonly before: readonly ObservationDigest[] // max 20
  readonly after: readonly ObservationDigest[]  // max 20
}

interface FollowUpResolution {
  readonly id: string // follow-up:<observationId>
  readonly observationId: string
  readonly sessionId?: string
  readonly skillName?: string
  readonly intent: FollowUpIntent
  readonly confidence: number
  readonly source: 'explicit' | 'classifier' | 'rule'
  readonly version: string
  readonly ruleId?: string
  readonly fallbackReason?: 'no-classifier' | 'not-classified'
  readonly inputHash?: string
  readonly attribution: Attribution
  readonly attributionSource: 'override' | 'tool' | 'intent'
  readonly policyVersion: string
  readonly evidenceEventIds: readonly string[]
}
```

`SkillFailureCase` keeps the accepted `origin`, `FailureOrigin`, and `feedbackKind` fields from PR #79. It gains optional `followUpId`, inferred `intent`, `intentSource`, and derived `attribution`/`attributionSource` fields. `feedbackKind` remains the user's explicit value; inferred intent is stored separately. Existing failure ids and cluster ordering remain stable except for the documented one-time changes caused by removing non-failure follow-ups.

The resolver's policy table is the single source for severity, failure eligibility, attribution, and diagnosis mapping. Inferred failures are capped at medium severity; explicit `incorrect` remains high. A `constraint` is content attribution for Experience but boundary root cause for Diagnosis. `goal-changed` is task-change and never creates a Failure case. The resolver records `fallbackReason` as `no-classifier` or `not-classified` when rules are used.

### Memo, cursor, and store layout

`classifications.jsonl` is a `memo` role store. Each row is immutable and keyed by classifier version plus canonical input hash; rationale is redacted and capped at 500 characters. `follow-ups.jsonl` is a `derived` role store and may be replaced during Projection. The memo is never used as evidence, never included in Observation ids, and is not deleted or rewritten by Projection, repair, or retention.

The cursor extends the existing Observation fingerprint with `derivationKey`. Old cursors lacking this field are treated as mismatches. The cursor is written atomically only after all derived stores are successfully written. A memo version change, rules/policy version change, input change, or classifier injection/removal therefore cannot return stale Derived records.

### Error handling and concurrency

`classifyFollowUps` uses a composed caller/timeout `AbortSignal`, with a 10-second default timeout. An individual throw, timeout, abort, or invalid result (`intent` outside the allowed values or non-finite confidence outside [0,1]) is returned as `failed` and does not block other items. Caller abort stops new work while preserving memo rows already written. Missing classifier raises `classifier-unavailable` before any model call. Projection, repair, `failures`, `metrics`, and `MaintenanceWorker.runOnce` never call the classifier, so the projection lock remains short and synchronous.

Repair validates memo framing and isolates malformed rows using existing JSONL repair rules. It preserves valid memo bytes and does not call the classifier. A forced Projection reads the surviving memo and rewrites only derived stores. Explicit attribution overrides are checked before tool corrections and intent policy.

### Test strategy

Core tests cover the fixed normalization/ordering table with positive and negative examples, explicit feedback without `skill`, unique earlier Skill attribution, both preceding-tool corrections, structured diagnosis precedence, deterministic diagnosis timestamps, and additive JSON/Markdown output. Existing tests named in design §5.1 remain green; the two listed PR #79 cases are updated only for the intentional `goal-changed` and `unknown` behavior changes.

The migration matrix is explicit: keep `packages/dsh-bundle/tests/bundle.spec.mjs:298-330`, `packages/skill-evolution/tests/evolution.spec.ts:49-62` and its current equivalent of the `:683-697` assertions, and `packages/skill-evolution/tests/core.spec.ts:213-230` passing. In the PR #79 coverage around `evolution.spec.ts:89-200`, keep the five non-goal-changed feedback mappings unchanged, change `goal-changed` to produce no case while retaining a direct diagnosis mapping test, and replace the implicit `upload this again` fixture with a correction-marked sentence so the structured-origin assertion still tests a failure. The `still wrong` evidence-strength and hand-written clustering tests remain unchanged.

The acceptance suite exercises all five parent cases:

- `谢谢`, `好的`, and `继续` resolve to non-failure intents and produce no Failure case.
- `不对，应该…` produces an `implicit-follow-up` content Failure case with rule source.
- A marked and classifier-returned topic change resolve to `goal-changed` without a Failure case.
- An explicit `satisfied` without `skill` is not overridden; explicit `incorrect` remains high; an explicit tool attribution remains tool-attributed; the operation reports skipped explicit items.
- A fake classifier changes Projection output after memo classification; a new service without the classifier returns the original rule output, even after the system clock moves; repair does not invoke the classifier and memo bytes remain unchanged.

Bundle tests assert the two preceding-tool fields, per-turn reset, and the offline legacy inference path. Core build/test, adapter build/test, and bundle tests are the required validation commands for the implementation PR.

### Defaults and assumptions

The following reversible business judgments are adopted by default and may be overturned by a member: A3 explicit classification operation; 10-second timeout; inferred severity capped at medium; unique earlier Skill as the attribution target; the exact §2.4 rule vocabulary and ordering; existing `followUps`/`followUpRate` semantics; F2 field alignment with PR #79; evidence-time Diagnosis timestamps; and no DSH backend or CLI command in this scope. No unresolved permission, spending, or irreversible question remains for this spec because the irreversible decisions are already accepted in ADR-0033–0035.
