## Tasks

Tasks are ordered by dependency. Every task is sized for one builder run, includes its own acceptance evidence, and names the requirements it satisfies. Task 1 is the smallest end-to-end tracer bullet for the proposal-ledger invariant: transition a proposal, derive its persisted id, group the latest record, and resolve it again through the public helper.

### 1. Add the proposal-ledger pure functions and tracer-bullet tests

**Requirements:** R1, R2, R3, R4, R16

**Depends on:** none

**Files:** `packages/skill-evolution/src/proposal.ts`, `packages/skill-evolution/src/index.ts`, core proposal tests (existing or a focused new spec).

**Work:** Extract and export `PROPOSAL_TRANSITIONS`; add `canTransition`, `assertCanTransition`, `TERMINAL_STATUS_SUFFIXES`, `proposalRootId`, `ledgerRecordId`, `latestProposalsByRoot`, and `findProposalById`; make `transitionProposal` read the table. Preserve all historical suffixes and add typed `ambiguous`/`not-found`/`invalid-transition` errors.

**Acceptance:**

- A test performs draft -> proposed -> evaluating -> evaluated, formats each record id, groups the records, and resolves both the logical root and exact evaluated record to the expected latest records.
- Tests cover every transition table edge, all recognized suffixes, an id with no suffix, a bare prefix that matches multiple roots (`ambiguous`), and a missing reference (`not-found`). No lookup test or implementation uses `startsWith` for proposal resolution.
- `npm --prefix packages/skill-evolution run build` and the focused core test command pass.

### 2. Switch existing core call sites and guards to the ledger module

**Requirements:** R1, R2, R3, R4, R6, R16

**Depends on:** 1

**Files:** `packages/skill-evolution/src/service.ts`, `packages/skill-evolution/src/metrics.ts`, and core regression tests.

**Work:** Replace local root-id regexes, latest-state maps, suffix string templates, and service guard lists with the shared helpers. Keep the existing candidate directory naming unchanged.

**Acceptance:**

- `rg` finds no second `proposalRootId` implementation, no local proposal `startsWith` finder, and no independent service guard list for reject/defer/evaluate/accept/promote.
- Tests prove guards and `transitionProposal` agree, including `draft -> rejected`, `draft -> deferred`, and `accepted -> rejected`; an invalid edge reports `invalid-transition`.
- Rollback and metrics use `latestProposalsByRoot`, and all existing core tests pass with historical suffixed fixtures.

### 3. Centralize publication-scope and feedback-kind validation

**Requirements:** R5, R13

**Depends on:** 2

**Files:** `packages/skill-evolution/src/types.ts`, `packages/skill-evolution/src/lifecycle.ts`, `packages/skill-evolution/src/service.ts`, `packages/skill-evolution/src/index.ts`, plus CLI/bundle call sites and tests.

**Work:** Export `PublicationScope`, `PUBLICATION_SCOPES`, and `assertPublicationScope`; reuse a core validator for `FeedbackKind`; replace adapter literals and lifecycle/service unions with the shared definitions.

**Acceptance:**

- `explicit-only`, `project`, `user`, and `stable` are accepted in core, CLI, and bundle paths; `bogus` fails as `invalid-option` before a manifest or record is written.
- An unsupported feedback kind fails with the same typed code in both adapters, while the bundle's omitted kind still defaults to `other`.
- Core builds and existing core/bundle tests pass.

### 4. Make transition decisions single-write and idempotent

**Requirements:** R6

**Depends on:** 2

**Files:** `packages/skill-evolution/src/service.ts`, `packages/skill-evolution/src/metrics.ts`, core service/metrics tests.

**Work:** Remove bespoke evaluate/accept/promote decision appends, remove the timestamped accept id, retain the deterministic transition decision, and update metrics to count transition decisions while reading historical action records.

**Acceptance:**

- A lifecycle test evaluates, accepts, and promotes one proposal and finds exactly one transition decision for each of `evaluated`, `accepted`, and `promoted`; repeating an idempotent append does not increase the count.
- No new decision id matches `decision:evaluate:*`, `decision:accept:*`, or `decision:promote:*`; no accept decision id contains `Date.now()` output.
- Metrics report the same promoted/rejected/rolled-back counts before and after a repeated read, and legacy action-only decision fixtures remain countable.
- `npm --prefix packages/skill-evolution test` passes.

### 5. Implement the core maintenance operations and operation tests

**Requirements:** R7, R8, R9, R10, R11, R12, R13, R19

**Depends on:** 2, 3, 4

**Files:** new `packages/skill-evolution/src/operations.ts`, `packages/skill-evolution/src/index.ts`, core operation tests.

**Work:** Add `proposeSkillChange`, `evaluateProposal`, `reviewProposal`, `promoteProposal`, and `rollbackSkill` with parsed option types, structured results, typed errors, core-owned file persistence, latest-artifact fallback, and one shared promotion precheck.

**Acceptance:**

- A temporary-root test proves stale base fails before candidate/report mutation; matching base writes the proposal report.
- `evaluateProposal` writes `.skill-evolution/evaluations/<root>.json` and its report, returns the evaluated record id, and does so without adapter-specific code.
- `reviewProposal` accept returns the new `:accepted` record id.
- `promoteProposal` rejects, with distinct typed codes, a fake/missing artifact (`evaluation-missing` or `evaluation-mismatch`), an unaccepted proposal (`invalid-transition`), a failed gate (`gate-failed`), and `scope: bogus` (`invalid-option`) in dry-run and real mode; none writes a version.
- With a valid accepted proposal and artifact, dry-run returns metadata without changing the manifest, while real mode publishes the version and adoption evidence; omitting the evaluation path selects the latest unexpired artifact.
- `operations.ts` has no import from `dsh-adapter`, `dsh-bundle`, or DSH-specific runtime modules.

### 6. Slim the CLI adapter and add CLI smoke coverage

**Requirements:** R7, R8, R9, R10, R11, R12, R13, R16

**Depends on:** 5

**Files:** `packages/skill-evolution/bin/dsh-skill-evolution.mjs`, CLI smoke tests, and any package test configuration needed to run them.

**Work:** Remove the CLI's local proposal finder, suffix regex, and dry-run verification branch; map command arguments to operations, make `--evaluation` optional for promote, preserve JSON/text output, and pass `--reason` to rollback.

**Acceptance:**

- CLI source contains no local proposal lookup or status-suffix regex and each maintenance action delegates to an operation.
- A smoke test runs propose/evaluate/accept/promote and observes the default root-based evaluation artifact; a dry-run with fake artifact, unaccepted status, failed gate, and invalid scope exits non-zero with the corresponding typed error.
- Existing CLI output modes remain parseable, and rollback accepts an explicit reason.

### 7. Slim the bundle, fix tokenizer/error mapping, and add DSH command e2e coverage

**Requirements:** R4, R5, R7, R9, R10, R11, R12, R14, R15

**Depends on:** 5, 6

**Files:** `packages/dsh-bundle/index.js`, `packages/dsh-bundle/tests/bundle.spec.mjs`, and bundle package metadata only if required.

**Work:** Replace bundle maintenance orchestration with operation calls, remove its local `findProposal`, add quote-aware tokenization, map typed failures to `{kind:'error'}`, validate feedback kind, and keep the existing observation behavior intact.

**Acceptance:**

- A tokenizer test shows `--intent "Add timeout diagnosis"` and the single-quoted form each arrive as the complete phrase; the old split value is impossible.
- A test proves a bare `proposal` reference cannot accidentally select `proposal:<uuid>` records and receives `ambiguous` when appropriate.
- Bundle tests prove dry-run validates a fake artifact, unaccepted proposal, failed gate, and invalid scope instead of returning success; evaluate always leaves the artifact file; accept returns the new record id; invalid core errors return `{ kind: 'error' }`.
- The node:test end-to-end command handler runs propose -> evaluate -> accept -> promote dry-run -> promote in one temporary DSH context, asserts the evaluation file, legal manifest scope, incremented version, and no version write during dry-run.
- `npm --prefix packages/dsh-bundle test` passes.

### 8. Update user and architecture documentation

**Requirements:** R13, R14, R15, R17

**Depends on:** 7

**Files:** `packages/dsh-bundle/README.md`, `docs/architecture-design-zh.md` §2.5/§4.1, and any directly referenced command examples.

**Work:** Document that CLI and bundle share core operations, show the root-based evaluation artifact default and optional promote evaluation, list legal scopes, and describe the DSH evaluate -> promote flow and quote-aware intent examples.

**Acceptance:**

- README no longer claims the full proposal lifecycle is CLI-only and contains commands that match the implemented defaults.
- Architecture documentation names the operations seam, single transition table, deterministic decisions, and adapter boundary without contradicting D1-D9.
- Documentation examples include a quoted multi-word intent and the bundle end-to-end sequence.

### 9. Run the real DSH web/desktop acceptance flow

**Requirements:** R5, R9, R12, R15

**Depends on:** 7, 8

**Work:** In a web/desktop DSH profile, install the local bundle link and run `/skill-evolution propose`, `evaluate`, `accept`, `promote --dry-run`, and `promote` against a Skill layout supported by the current `SkillVersionStore`.

**Acceptance:**

- The session shows an evaluation artifact after evaluate, rejects fake/invalid dry-run inputs and `--scope bogus`, and publishes a legal scoped manifest with an incremented version after promote.
- Record the exact command sequence and observed outputs in the issue or PR as non-blocking acceptance evidence. Headless command dispatch is out of scope; use the documented remote/web route when needed.
