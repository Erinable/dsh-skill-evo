## Scope and decisions

This spec turns the accepted design in `docs/design/tool-correction-create-skill.md` into implementation contracts. ADR-0023 fixes the Observation fields and redaction rules; ADR-0024 fixes the `absent` Base sentinel and the separate `episodes` and `patterns` Derived stores. ADR-0021 governs repeated ledger status ids and ADR-0022 governs structured Failure origins and stable cluster ids. ADR-0034 governs classifier memos and deterministic projection; ADR-0035 governs the versioned classifier object shape. No new ADR is required.

The runtime loop remains append-only and non-blocking. The maintenance loop performs all interpretation, projection, aggregation, design, evaluation, and publication. Core remains independent of DSH internals (ADR-0014); the bundle only maps DSH command formats and exit markers.

## Glossary additions

- **ToolAttempt:** one correlated tool-call and tool-result pair used as projection input; it carries bounded, redacted summaries and Observation ids, not complete output.
- **Correction episode:** a Derived record for one session's repeated same-intent failures followed by success, including the failure, correction, and success evidence.
- **Correction pattern:** a Derived record grouping episodes with one signature key across sessions. Its stable identity is based on the earliest episode id; the signature key is for grouping and display.
- **Correction policy:** the versioned rules for failure/session/time-window thresholds and allowed publication scopes.
- **Derived judge:** a versioned, injectable classifier or pure rule that produces Derived output. Model output is memoized before Projection consumes it.
- **Absent Base:** the explicit Base state used when the targeted Skill does not exist; it is represented by the `absent` sentinel and is distinct from an omitted Base.

## Module boundaries

- **Collection seam:** `packages/dsh-bundle/index.js` maps ordinary tool calls/results. Command mapping is explicit for `bash` and `pwsh`; exit markers are parsed in the bundle. Core owns the shared redactor and summary contracts.
- **Projection seam:** new correction projection code belongs in `packages/skill-evolution/src/correction.ts`. The injected correction classifier adopts ADR-0035's versioned object shape, `classify(input, signal)`, with correction-specific input, signal, and `EpisodeDraft[]` output. The deterministic `rule-1` implementation is pure and may run directly in projection; a future model classifier is invoked outside projection and its output is written to the Classification memo first. Projection never calls a classifier (ADR-0034).
- **State seam:** `state-root.ts` adds derived stores `episodes` and `patterns` plus ADR-0034's `classifications.jsonl` store with role `memo` for classifier outputs. The cursor contains one `derivationKey`, computed from rules version, correction policy version, classifier version (or `none`), and memo fingerprint. It does not add a separate `judges` field. Derived records may be deleted and rebuilt; Observations and Classification memos are never rewritten or deleted by projection.
- **Proposal seam:** `types.ts`, `proposal.ts`, `operations.ts`, `service.ts`, `lifecycle.ts`, and `evaluator.ts` add the create-skill operation, absent Base handling, pattern source metadata, target selection, scope gate, and empty-Base evaluation. The transfer table remains the single source of truth (ADR-0004), and record ids follow ADR-0021.
- **Adapter seam:** CLI/bundle design flows accept `--pattern` and preserve existing cluster flows. Designer input is a discriminated source union; pattern inputs contain only bounded, redacted attempts and recent episodes.

## Data flow

1. Bundle maps tool call/result payloads, redacts once before tokenization/truncation, and appends optional fields. It never blocks on recognition and never stores complete output.
2. Projection correlates call/result Observations into ToolAttempt values and classifies outcome from `failed`, exit code, signal, timeout, and missing result. Rule recognizer `rule-1` runs as a deterministic pure function. A model correction classifier is run by a maintenance caller using ADR-0035's `classify(input, signal)` contract; the caller stores its output in the Classification memo, and projection consumes that memo rather than invoking the classifier.
3. Valid EpisodeDrafts become Correction episodes and one tool-attributed Experience each. Invalid references, too-short failure runs, or overlong fields are rejected and counted. Episodes are grouped by signature into patterns.
4. Pattern assessment is a pure read-time function. It applies `now`, D, promotion reset, K, retry-only exclusion, and proposal blocking; reports and metrics call this same function.
5. Human-triggered design selects a target, invokes the Designer, validates the Skill document and environment neutrality, writes a proposal and case draft, then stops at `proposed`. The Designer cannot mutate lifecycle state.
6. Evaluation replays original-failure, historical-success, and boundary cases. With absent Base, the baseline runner receives an empty Skill and still executes boundary cases. Human accept is required; promote performs the same precheck in dry-run and real mode and then publishes only an allowed scope.

The structured failure/error signature is part of the correction signature and any Failure-cluster reference. It consists of exit code plus normalized error first line; volatile durations, timestamps, long hex strings, UUIDs, and quoted values are normalized, while meaningful host/port and exit-code distinctions remain. When a Failure cluster is referenced, its identity is the earliest case id per ADR-0022, never the mutable display signature.

**Flag ADR-0022 conflict:** the accepted design's §5.3 `pattern:<signatureKey prefix>` identity repeats the signature-derived identity that ADR-0022 rejects for Failure clusters. This spec resolves the conflict for correction patterns by using `pattern:<episodeId>` where the episode is the earliest member after stable `(occurredAt, episodeId)` ordering. `signatureKey` remains the grouping and display key. A recognizer or normalization-version change therefore preserves the pattern id when the same episodes remain grouped, so Proposal source references and post-promotion target decisions remain resolvable.

## Collection and redaction contract

The exact field list, caps, extraction order, and R1–R7 patterns are normative in ADR-0023 and design §3: `argKeys`; command token cap of 16 tokens, 64 characters per token and 240 characters total; `commandTruncated`; result `exitCode`, `signal`, `timedOut`; and `errorLine` capped at 200 characters. Redaction precedes tokenization and truncation. Structured DSH results are preferred; compatible exit-marker parsing is the fallback. Full stdout/stderr, descriptions, workdir, query, and fragment are excluded.

## Recognition and aggregation contract

The default rule recognizer normalizes intent by removing assignments and shell wrappers, groups attempts by session order, allows unrelated intents between retries, and compares the final failure with the later success to derive named actions such as `set-env:<name>`, `flag:<name>`, and `run:<intent>`; empty corrections become retry-only. Known parser limits (`bash -c`, `sh -c`, `eval`, and package-wrapper forms) are documented and covered as non-goals of `rule-1`, not silently generalized.

The recognizer output is validated against the session input. Correction episode ids are deterministic from session and first failure Observation. Pattern records contain the stable earliest-episode id, signature, occurrences, session counts, first/last seen times, and policy version, but no cached window candidate decision or target Skill. `assessPattern` is the sole implementation of K/N/D, promotion reset, in-progress blocking, and candidate status.

Defaults are adopted business judgments and may be overturned by members: N=2, K=3, D=30 days, max 20 attempts, retry-only never candidate, and no memory channel for environment facts. Environment facts belong in project/user configuration; Skill content contains conditional procedures only.

## Proposal and lifecycle contract

Pattern design uses `/skill-evolution design --pattern <id> --proposed-version <v> [--skill <name>]` (cluster input remains available). Target selection order is: previously promoted target, explicit skill, majority loaded Skill, portfolio similarity >=0.5 with ties reported as ambiguous, then create-skill. The Proposal records source pattern metadata and evidence ids. A create-skill Proposal uses operation `create-skill` and literal `absent` in both Base fields; all design, evaluate, artifact, precheck, and promote Base checks require current absence. A promoted create-skill cannot roll back to nonexistence; retirement is the supported removal path. These are adopted business judgments and may be overturned.

Create-skill and environmental pattern patches default to scopes project/user; stable and any other scope not in the policy are rejected before mutation. Scope rejection applies equally to dry-run. Candidate validation rejects observed machine values, IP literals, userinfo, and `[REDACTED]`; conditional instructions are enforced by Designer guidance, boundary cases, and human review.

Pattern-derived proposals keep the existing transition table and ledger transfer table, use ADR-0021 ids, and cannot be accepted when their latest evaluation artifact has `passedGate=false`. Other proposal sources retain existing acceptance behavior.

## Error handling and invariants

Expected domain failures use existing typed codes plus `insufficient-evidence`, `already-proposed`, `ambiguous-target`, `scope-not-allowed`, and `designer-failed`. Validation occurs before mutation: insufficient evidence, blocked proposal, invalid target, stale absent Base, non-neutral candidate, failed gate, and invalid scope produce no proposal, candidate, version, or transition record. Runtime collection errors do not block the user task; malformed or unavailable results become unknown attempts and cannot form episodes.

The following invariants must hold:

- Observation facts are append-only, backward-readable, bounded, redacted, and contain no complete output.
- Episode/pattern stores are fully rebuildable and never written back into Observations.
- Every pattern candidate decision is recomputed from one pure assessment function using explicit `now`.
- `create-skill` iff operation is create-skill and expected Base hash is `absent`.
- Human accept and promote remain the only lifecycle mutation paths; recognizer and Designer are data-only seams.
- Core imports no DSH/bundle module; bundle and CLI do not reimplement projection or proposal rules.
- Stable Failure cluster ids remain anchored by earliest case id even when display signatures change.

## Verification strategy

Use focused unit tests for redaction probes, field caps, exit-marker parsing, intent/signature normalization, recognizer validation, stable ids, and policy assessment. Use projection tests for one-session versus K-session behavior, stale windows, promotion reset, memo-backed classifier output, one `derivationKey`, stable pattern ids across recognizer-version reprojection, and no Observation mutation. Use proposal/lifecycle tests for absent Base, target selection, environment-neutral candidate rejection, empty-Base boundary evaluation, accept gate, stable-scope rejection, dry-run parity, and ledger idempotence. Add one adapter fixture that writes the 3-failure-then-proxy-success sequence, checks all state files for credentials, and exercises design/evaluate/accept/promote. Run the package tests for every touched package plus focused tests named by each task.

## Assumptions and adopted defaults

- SKIL-126 is merged as ADR-0034/0035. This spec adopts ADR-0035's `{ version, classify(input, signal) }` classifier object shape for any injected correction classifier, while keeping `rule-1` as a pure projection function. It adopts ADR-0034's memo-backed model path and single `derivationKey`; this explicitly supersedes the accepted design's `judges` cursor field and in-projection classifier call. The correction classifier's input/signal/output types remain correction-specific, so follow-up intent values are not reused as correction episode values.
- The ProposalLedger implementation described by ADR-0021 and `docs/design/proposal-ledger-transition.md` is not present on `origin/main` yet. Task 4 is blocked on that prerequisite landing as `packages/skill-evolution/src/ledger.ts` (plus its `types.ts`/`index.ts` exports and service call-site migration); this spec does not invent a second ledger implementation.
- DSH structured result metadata may be unavailable; marker parsing is the required fallback.
- `user` scope remains a manifest label until a separate issue changes the physical write path.
- The Skill/memory/workflow boundary, N/K/D defaults, target rules, post-promotion reset, absent-Base retirement behavior, and pattern-only accept gate are business judgments recorded as “采用默认答案，成员可推翻”.
