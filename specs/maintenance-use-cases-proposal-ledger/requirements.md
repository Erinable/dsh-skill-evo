## Requirements

R1. WHEN the core proposal module is built THE SYSTEM SHALL expose one `PROPOSAL_TRANSITIONS` table and make `transitionProposal`, `canTransition`, and `assertCanTransition` derive their answers from that table; an invalid transition SHALL carry error code `invalid-transition`.

R2. WHEN a proposal record id is normalized THE SYSTEM SHALL derive its root id from the statuses that are actually written as `:status` ledger records, preserve historical suffixes, and provide `ledgerRecordId(root, status)` for new records.

R3. WHEN proposal records are grouped or looked up THE SYSTEM SHALL use one `latestProposalsByRoot` algorithm that keeps the last record written for each root and one `findProposalById` algorithm that accepts an exact root or exact record id only.

R4. WHEN a lookup reference matches more than one proposal root or no proposal root THE SYSTEM SHALL raise a typed `ambiguous` or `not-found` error respectively, and SHALL never resolve a bare prefix with `startsWith` semantics.

R5. WHEN a publication scope or feedback kind enters core, CLI, or bundle maintenance flows THE SYSTEM SHALL validate it against the core named constants; an unsupported value SHALL be reported as `invalid-option` before any record or Skill file is written.

R6. WHEN evaluate, accept, or promote records a lifecycle transition THE SYSTEM SHALL append only the deterministic transition decision for that transition; repeating the same write SHALL not create a second decision, and metrics SHALL count promoted, rejected, and rolled-back proposals from transition decisions while remaining able to read historical decision records.

R7. WHEN a maintainer invokes a maintenance use case THE SYSTEM SHALL provide core operations for proposing, evaluating, reviewing, promoting, and rolling back that accept parsed options, return structured results, and expose typed errors from the set `not-found`, `ambiguous`, `invalid-option`, `stale-base`, `invalid-transition`, `evaluation-missing`, `evaluation-mismatch`, and `gate-failed`.

R8. WHEN `proposeSkillChange` receives base content that differs from the current Skill THE SYSTEM SHALL fail with `stale-base` without staging a candidate or writing a proposal report; with a matching base it SHALL stage the proposal and write a markdown report at the requested path or the default proposal path.

R9. WHEN `evaluateProposal` completes THE SYSTEM SHALL persist an evaluation artifact and report at the requested paths or at `.skill-evolution/evaluations/<root>.json` and the corresponding proposal report path, and SHALL return the evaluated record id and artifact data to every adapter.

R10. WHEN `reviewProposal` accepts, rejects, or defers a proposal THE SYSTEM SHALL apply the shared transition table and return the newly written record id, rather than echoing the input record id.

R11. WHEN `promoteProposal` is called with no explicit evaluation path THE SYSTEM SHALL select the latest unexpired artifact for the proposal root; when a path or in-memory result is supplied THE SYSTEM SHALL verify its proposal, base, candidate, case, policy, and expiry fields before proceeding.

R12. WHEN promotion is requested, both dry-run and real execution SHALL run the same checks for accepted status, valid scope, evaluation artifact, passing gate, current base, and valid candidate; dry-run SHALL skip only the version write, while real execution SHALL publish the version and append the promotion evidence.

R13. WHEN the CLI or bundle adapts a command THE SYSTEM SHALL delegate maintenance behavior to core operations and retain only argument/result mapping; the core package SHALL not import DSH or bundle modules.

R14. WHEN a bundle command contains `--intent "Add timeout diagnosis"` or a single-quoted equivalent THE SYSTEM SHALL pass the complete phrase as one option value, and typed core errors SHALL be returned by the bundle as `{ kind: 'error', ... }` results.

R15. WHEN a DSH bundle session runs propose, evaluate, accept, promote dry-run, and promote in order THE SYSTEM SHALL leave an evaluation artifact after evaluate, reject invalid dry-run inputs and invalid scopes, and publish a legal scoped manifest with the proposed version after the final promote.

R16. WHEN existing ledger data contains historical suffixed ids THE SYSTEM SHALL continue reading it; this change SHALL not rename existing `candidates/<id>` directories or change the state-root layout owned by SKIL-42.

R17. WHEN the migration is complete THE SYSTEM SHALL update bundle and architecture documentation so that the shared core operations, default artifact paths, accepted scopes, and DSH maintenance flow are documented consistently.
