## Scope and decisions

This spec implements the merged design in `docs/design/proposal-ledger-transition.md`. The public seam is a new `ProposalLedger` module. The eight service call sites become callers of that seam; they do not reproduce id generation, latest-state checks, or decision writes.

The following are fixed decisions:

- **ADR-0004:** `PROPOSAL_TRANSITIONS` is the only transition authority; `assertCanTransition` runs in the ledger operation.
- **ADR-0021:** the first entry into a status uses `<root>:<status>`; later entries use `<root>:<status>:<n>`; new records carry `previousRecordId`; each record has decision id `decision:ledger:<recordId>`.
- **ADR-0016:** Ledger and Decision records are append-only facts. Existing facts are never rewritten.
- **ADR-0020:** JSONL framing, residual-byte isolation, and lock ownership remain in `JsonlRecordStore`.

Business defaults that are reversible are recorded here as adopted defaults and may be superseded by members: the ledger module is a separate class rather than a private service helper; roots that have never appeared in the ledger do not undergo a latest-record comparison; replay is identified only by `previousRecordId` plus target status.

## Module boundaries

### Record store extension

Add `JsonlRecordStore.appendComputed(build)`. The store owns lock acquisition, frame parsing, residual isolation, id collision detection, and the final append. The builder receives only complete records observed while the lock is held. It returns a candidate whose id must be free; the store throws `DuplicateRecordError` rather than returning false for this path.

### ProposalLedger

Create `packages/skill-evolution/src/ledger.ts` with:

- `ProposalLedger(proposals, decisions, actor)`;
- `transition(from, to, input): Promise<LedgerTransition>`;
- `latest(reference)`, `record(recordId)`, and `history(root)` read methods;
- `TransitionInput` fields `action?`, `reason`, `evidenceIds?`, `policyVersion?`, and `comparisonCaseIds?`;
- `LedgerTransition` fields `record`, `decisionId`, and `replayed`.

The transition algorithm is one lock-scoped read/decision/write sequence for the Proposal store:

1. Read complete records and identify the root history.
2. If a record already has `previousRecordId === from.id` and `status === to`, return it as a replay.
3. Run `assertCanTransition(from.status, to)` from ADR-0004.
4. If the root exists, require `from.id` to equal the latest record id; otherwise raise `conflict`. A root absent from the ledger has no latest id to compare.
5. Count prior entries for `to`, allocate the ADR-0021 id, and while that candidate is occupied increment the occurrence until the next-free id is found; set `previousRecordId` and append with `appendComputed`. `DuplicateRecordError` remains the store-level guard if the candidate handed to `appendComputed` is still occupied after this allocation.
6. After the Proposal lock is released, append the deterministic decision. Decision append returning false means the decision already exists and is success.

Decision append is deliberately after the Ledger append. A decision failure leaves a real record that a retry can replay and repair. Health/repair reporting for this intermediate state is outside this issue.

### Root and record queries

Update `proposalRootId`, `ledgerRecordId`, and add `findLedgerRecord` so status-plus-occurrence suffixes are parsed exactly. `latest` follows the existing `findProposalById` behavior: an exact root or any exact record id resolves to the latest record for that root. `record` is exact-id only. `history` preserves append order. No query uses prefix matching.

### Service integration

Route stage, evaluating, evaluated, accept, promote, rollback, reject, and defer through `this.ledger.transition`. Before stage can append, require `proposalRootId(root) === root`; roots ending in a recognized status suffix or status-plus-occurrence are rejected with no write. Preserve stage's existing early return for an already present identical proposed record; it is a read/idempotency path, not a second write seam. Return the persisted transition record from methods that expose a Proposal record. Evaluate must pass the record returned by its first transition into the next transition. Remove the old service-level `recordDecision` writes and the record-id reconstruction in `operations.ts`. Add `conflict` to operation error mapping. Keep the skill-level rollback decision outside this issue's Ledger transition scope.

### Compatibility risks and boundaries

During a rolling deployment, an old process that does not understand `:<n>` can treat `root:evaluated:2` as a different root and can still silently drop repeated entries. The CLI, bundle, adapter, and core must be upgraded as one compatible batch; T4 carries this deployment risk. A custom root ending in `<status>` or `<status>:<n>` is rejected during staging after T1; T1 carries this naming risk.

Old unsuffixed records and old decision ids remain readable. No migration or backfill is attempted for historical records that were previously dropped because an id collided. Candidate directories and state-root layout remain unchanged. Promote/Rollback recovery, health, and repair belong to SKIL-122.

## Data flow

A service constructs one `ProposalLedger` with the Proposal and Decision stores. A transition caller passes its current record, destination status, and decision input. The ledger reads and appends the Proposal record while holding the Proposal lock, then appends the linked decision. The returned record id flows back through service and operations to CLI, bundle, and adapter consumers. Query consumers use root/latest, exact-record, or ordered-history methods.

## Failure and consistency behavior

- Invalid transition: no writes; `invalid-transition`.
- Stale source or same-id stale object: no writes; `conflict`.
- A candidate id still occupied when handed to `appendComputed` (after next-free allocation): no writes; `DuplicateRecordError`. A historical occupied suffix is otherwise skipped by incrementing the occurrence.
- Lock or Proposal I/O failure: original error; no success value.
- Decision I/O failure after Ledger success: original error; Ledger remains; replay retries only the decision.
- A replay never creates another record or decision.

The operation does not add an `fsync`; `appendFrames` return remains the persistence boundary defined by ADR-0020.

## Verification strategy

The focused core suite must cover the design cases:

- **V1 replay path:** stage a root, evaluate, reject, observe, evaluate again; assert two `evaluated` records, both decision `recordId` values, latest-by-root, and exact-id lookup.
- **V2 repeated rejection:** after V1 reject again and assert `<root>:rejected:2` plus its linked decision. Also pre-seed an occupied `<root>:evaluated:2` without a corresponding second entry, then assert the next evaluated transition selects `<root>:evaluated:3`.
- **V2 staging guard:** attempt to stage roots ending in `<status>` and `<status>:<n>`, assert a domain error and unchanged Ledger contents.
- **V3 idempotent replay:** call the same transition twice and assert `replayed: true` on the second call with unchanged record and decision counts.
- **V4 conflict:** reuse an old record, and separately reuse a same-id stale `draft`, asserting `conflict` and unchanged counts.
- **V5 write failures:** force Proposal append failure and occupied-id failure; assert the original error and unchanged decision count.
- **V6 decision repair:** force the first decision append to fail, retry with the same source, and assert one Ledger record plus one decision.
- **V7 legacy read:** load origin/main-format records without `previousRecordId`, continue to a second evaluated entry, and assert metrics remain compatible.
- **V8 write seam guard:** grep `packages/skill-evolution/src` and assert only `ledger.ts` contains Proposal-store append calls.

Run `npm --prefix packages/skill-evolution run build` for each Builder task that changes TypeScript and `npm --prefix packages/skill-evolution test` for the completed seam. Tests must assert both root-based and exact-record queries; a passing decision alone is insufficient evidence that the Ledger write succeeded.
