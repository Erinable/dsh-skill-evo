## Scope and decisions

This spec turns the accepted design in `docs/design/tool-correction-create-skill.md` into implementation contracts. ADR-0023 fixes the Observation fields and redaction rules; ADR-0024 fixes the `absent` Base sentinel and the separate `episodes` and `patterns` Derived stores. ADR-0021 governs repeated ledger status ids and ADR-0022 governs structured Failure origins and stable cluster ids. No new ADR is required.

The runtime loop remains append-only and non-blocking. The maintenance loop performs all interpretation, projection, aggregation, design, evaluation, and publication. Core remains independent of DSH internals (ADR-0014); the bundle only maps DSH command formats and exit markers.

## Module boundaries

- **Collection seam:** `packages/dsh-bundle/index.js` maps ordinary tool calls/results. Command mapping is explicit for `bash` and `pwsh`; exit markers are parsed in the bundle. Core owns the shared redactor and summary contracts.
- **Projection seam:** new correction projection code belongs in `packages/skill-evolution/src/correction.ts`. It consumes ToolAttempt values and exposes a `DerivedJudge<Input, Output>` shape aligned with SKIL-125 and the pending SKIL-126 follow-up classifier; if SKIL-126 later chooses a different common shape, this implementation must adapt without changing Observation facts.
- **State seam:** `state-root.ts` adds derived stores `episodes` and `patterns`. The projection cursor records correction recognizer and policy versions. Derived records may be deleted and rebuilt; Observations are never rewritten.
- **Proposal seam:** `types.ts`, `proposal.ts`, `operations.ts`, `service.ts`, `lifecycle.ts`, and `evaluator.ts` add the create-skill operation, absent Base handling, pattern source metadata, target selection, scope gate, and empty-Base evaluation. The transfer table remains the single source of truth (ADR-0004), and record ids follow ADR-0021.
- **Adapter seam:** CLI/bundle design flows accept `--pattern` and preserve existing cluster flows. Designer input is a discriminated source union; pattern inputs contain only bounded, redacted attempts and recent episodes.

## Data flow

1. Bundle maps tool call/result payloads, redacts once before tokenization/truncation, and appends optional fields. It never blocks on recognition and never stores complete output.
2. Projection correlates call/result Observations into ToolAttempt values, classifies outcome from `failed`, exit code, signal, timeout, and missing result, then invokes the configured recognizer once per session. Rule recognizer `rule-1` is the deterministic fallback.
3. Valid EpisodeDrafts become Correction episodes and one tool-attributed Experience each. Invalid references, too-short failure runs, or overlong fields are rejected and counted. Episodes are grouped by signature into patterns.
4. Pattern assessment is a pure read-time function. It applies `now`, D, promotion reset, K, retry-only exclusion, and proposal blocking; reports and metrics call this same function.
5. Human-triggered design selects a target, invokes the Designer, validates the Skill document and environment neutrality, writes a proposal and case draft, then stops at `proposed`. The Designer cannot mutate lifecycle state.
6. Evaluation replays original-failure, historical-success, and boundary cases. With absent Base, the baseline runner receives an empty Skill and still executes boundary cases. Human accept is required; promote performs the same precheck in dry-run and real mode and then publishes only an allowed scope.

The structured failure/error signature is part of the correction signature and any Failure-cluster reference. It consists of exit code plus normalized error first line; volatile durations, timestamps, long hex strings, UUIDs, and quoted values are normalized, while meaningful host/port and exit-code distinctions remain. When a Failure cluster is referenced, its identity is the earliest case id per ADR-0022, never the mutable display signature.

## Collection and redaction contract

The exact field list, caps, extraction order, and R1–R7 patterns are normative in ADR-0023 and design §3: `argKeys`; command token cap of 16 tokens, 64 characters per token and 240 characters total; `commandTruncated`; result `exitCode`, `signal`, `timedOut`; and `errorLine` capped at 200 characters. Redaction precedes tokenization and truncation. Structured DSH results are preferred; compatible exit-marker parsing is the fallback. Full stdout/stderr, descriptions, workdir, query, and fragment are excluded.

## Recognition and aggregation contract

The default rule recognizer normalizes intent by removing assignments and shell wrappers, groups attempts by session order, allows unrelated intents between retries, and compares the final failure with the later success to derive named actions such as `set-env:<name>`, `flag:<name>`, and `run:<intent>`; empty corrections become retry-only. Known parser limits (`bash -c`, `sh -c`, `eval`, and package-wrapper forms) are documented and covered as non-goals of `rule-1`, not silently generalized.

The recognizer output is validated against the session input. Correction episode ids are deterministic from session and first failure Observation. Pattern records contain signature, occurrences, session counts, first/last seen times, and policy version, but no cached window candidate decision or target Skill. `assessPattern` is the sole implementation of K/N/D, promotion reset, in-progress blocking, and candidate status.

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

Use focused unit tests for redaction probes, field caps, exit-marker parsing, intent/signature normalization, recognizer validation, stable ids, and policy assessment. Use projection tests for one-session versus K-session behavior, stale windows, promotion reset, recognizer-version reprojection, and no Observation mutation. Use proposal/lifecycle tests for absent Base, target selection, environment-neutral candidate rejection, empty-Base boundary evaluation, accept gate, stable-scope rejection, dry-run parity, and ledger idempotence. Add one adapter fixture that writes the 3-failure-then-proxy-success sequence, checks all state files for credentials, and exercises design/evaluate/accept/promote. Run the package tests for every touched package plus focused tests named by each task.

## Assumptions and adopted defaults

- SKIL-126 is not merged; this spec follows the design's `DerivedJudge` shape and will adapt if the shared classifier seam is later finalized.
- DSH structured result metadata may be unavailable; marker parsing is the required fallback.
- `user` scope remains a manifest label until a separate issue changes the physical write path.
- The Skill/memory/workflow boundary, N/K/D defaults, target rules, post-promotion reset, absent-Base retirement behavior, and pattern-only accept gate are business judgments recorded as “采用默认答案，成员可推翻”.

