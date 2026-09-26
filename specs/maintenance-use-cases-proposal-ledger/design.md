## Scope and Goal

This change moves the maintenance use cases and proposal-ledger rules into `@dsh-skill-evo/core`. The CLI and DSH bundle remain adapters: they parse their input, call core operations, and render the returned result. The goal is to make proposal ids, latest-state selection, state transitions, validation, and evaluation-to-promotion behavior single-source and identical across both adapters.

The design does not change the state-root layout or candidate directory key owned by SKIL-42, and it does not add DSH dependencies to core. The manual DSH check in task 9 is acceptance evidence, not a new runtime integration contract.

## Decisions and Assumptions

The upstream design and review settled these defaults. They are recorded here so a builder does not reopen them:

| ID | Decision | Boundary or risk |
| --- | --- | --- |
| D1 | Keep `:status` suffixes in persisted proposal record ids. | Reads remain compatible with historical JSONL. |
| D2 | Resolve only an exact root or exact record id. | A bare prefix now returns `ambiguous`; this is an intentional bug fix. |
| D3 | Evaluation defaults to `.skill-evolution/evaluations/<root>.json`; promote may omit `--evaluation`. | The final state-root provider remains SKIL-42's responsibility. |
| D4 | Remove bespoke evaluate/accept/promote decisions and the timestamped accept id; count lifecycle metrics from deterministic transition decisions. | Historical bespoke records remain readable. |
| D5 | Use a quote-aware bundle tokenizer for single- and double-quoted values. | This changes the slash-command input grammar to match the documented examples. |
| D6 | Do not rename `candidates/<proposal-id>` directories in this change. | A suffixed directory key is deferred to SKIL-42. |
| D7 | `operations.ts` and ledger helpers import only core modules. | No DSH or bundle import may point inward to core. |
| D8 | Add operations and ledger helpers to `src/index.ts` without removing existing exports. | Existing consumers keep their imports. |
| D9 | The transition table is authoritative, so `draft -> rejected`, `draft -> deferred`, and `accepted -> rejected` become valid. | If policy changes, edit the table; do not add a second guard list. |

## Module Boundaries

### Proposal ledger (`packages/skill-evolution/src/proposal.ts`)

Extend the existing module with pure functions and one exported table:

- `PROPOSAL_TRANSITIONS` is the only state machine definition; `transitionProposal` reads it.
- `canTransition` and `assertCanTransition` expose boolean and typed-throw forms.
- `TERMINAL_STATUS_SUFFIXES` is derived from transition targets that are written to records. It includes `evaluating`, `evaluated`, `accepted`, `promoted`, `rolled-back`, `replayed`, `observed`, `rejected`, and `deferred`; `draft`, `proposed`, and `reverted` are not record suffixes.
- `proposalRootId` strips one or more recognized suffixes, `ledgerRecordId` formats a root/status pair, and `latestProposalsByRoot` keeps the last occurrence per root.
- `findProposalById` first resolves an exact root or exact record id and throws `ambiguous` or `not-found` typed errors as appropriate. It must not use a bare prefix match.

`metrics.ts`, `EvolutionService`, the CLI, and the bundle import these helpers. No adapter keeps a local root-id regex, latest algorithm, or proposal finder.

### Maintenance operations (`packages/skill-evolution/src/operations.ts`)

Add a core-only function set:

- `proposeSkillChange(service, options)` reads or receives base and candidate content, checks the current base, stages a proposal, and writes a markdown report.
- `evaluateProposal(service, options)` resolves the proposal, validates the transition, invokes `service.evaluate`, and writes the evaluation artifact and report. Its default artifact path uses the logical root, never a suffixed record id.
- `reviewProposal(service, options)` dispatches accept/reject/defer through the service and returns the new record.
- `promoteProposal(service, options)` validates scope and selects or loads the latest artifact, then runs one precheck for both dry-run and real execution. It skips only `versions.promote` for dry-run.
- `rollbackSkill(service, options)` delegates rollback and accepts an optional reason.

Each operation accepts already parsed options, returns a structured result, and converts expected domain failures to the typed error codes in R7. File reads and writes remain in core so the evaluation-file invariant cannot diverge between adapters.

### Shared validation and decisions

Export `PublicationScope`, `PUBLICATION_SCOPES`, and `assertPublicationScope` from core. Reuse the same pattern for `FeedbackKind` validation. `EvolutionService` retains ownership of append-only records and the `recordDecision` helper; the operations module does not create a second stateful ledger.

Every transition decision id is `decision:transition:<root>:<to>:<updatedAt>`, where `updatedAt` comes from the transition record. Evaluate, accept, and promote remove their bespoke decision appends. Metrics use `toStatus`/transition decisions for promoted, rejected, and rolled-back counts and still accept historical action records.

## Data Flow

1. An adapter creates `EvolutionService` for the current root and parses argv/raw input into operation options.
2. An operation resolves the proposal through `findProposalById`, reads current content and cases as needed, and performs the core transition/evaluation logic.
3. Core writes proposal/evaluation reports through the operation, and append-only proposal, evaluation, observation, and decision records through `EvolutionService`.
4. The operation returns ids, paths, artifact data, or publication metadata. The CLI renders JSON/text and exit status; the bundle renders a command result.

For promotion, the precheck sequence is: validate scope; resolve accepted proposal; select or load artifact; validate artifact identity, expiry, policy, base and candidate hashes; check `passedGate`; read current Skill and validate its base; validate the candidate document/change. Only after this succeeds does real execution call `versions.promote`, append adoption evidence, and append the promoted ledger record.

## Error Handling

Expected domain errors carry one of `not-found`, `ambiguous`, `invalid-option`, `stale-base`, `invalid-transition`, `evaluation-missing`, `evaluation-mismatch`, or `gate-failed`. File-system and JSON parse failures remain ordinary errors with their original context. The CLI reports a non-zero exit and message; the bundle returns `{ kind: 'error', text, code }` (or the equivalent structured error fields) and does not write partial success output.

Errors must be raised before mutation where possible: invalid scope and transition before records, stale base before candidate/report, and all promotion checks before publishing. A failed dry-run therefore has the same observable validation behavior as a failed real promotion and never writes a version.

## Compatibility

The suffix parser continues to recognize all historical status records. Existing suffixed test fixtures and JSONL data remain readable. The intentional D2 change affects callers that passed a bare prefix; those callers must pass the logical root or exact record id. Candidate directory names and SKIL-42 path ownership are explicitly out of scope.

## Verification Strategy

- Ledger tests cover every transition table edge, root parsing with and without suffixes, exact root/id lookup, ambiguous bare prefixes, missing ids, and deterministic record ids.
- Core service tests prove all guards use the table, including the previously inconsistent draft/accepted reject/defer paths, and prove one deterministic decision per evaluate/accept/promote transition plus metrics counts.
- Operation tests use temporary roots to prove stale-base handling, report/artifact persistence, typed errors, latest-artifact selection, and the four dry-run failure cases: fake artifact, unaccepted proposal, failed gate, and invalid scope.
- Bundle tests cover quote-aware `--intent`, typed error mapping, no local prefix finder, and a node:test propose -> evaluate -> accept -> dry-run -> promote flow that asserts the artifact file and final manifest.
- Run `npm --prefix packages/skill-evolution test` and `npm --prefix packages/dsh-bundle test` after the corresponding tasks. Task 9 repeats the flow through a real DSH web/desktop session as non-blocking acceptance evidence.

## Non-goals

- No change to SKIL-42 state-root layout or candidate directory naming.
- No new HTTP/MCP adapter.
- No implementation code in this spec branch beyond the spec files.
