## Scope

This spec defines the single core operation for Proposal ledger transitions and the record identity needed when a Proposal enters the same status more than once. It covers the four implementation seams in the merged design: record-id helpers, lock-aware computed append, the `ProposalLedger` operation, and migration of all eight service call sites.

The decisions in ADR-0004, ADR-0016, ADR-0020, and ADR-0021 are authoritative. ADR-0021 replaces ADR-0005 for record ids. The spec does not cover recoverable Promote/Rollback (SKIL-122), automatic repair, or implementation code outside the named seams.

## Requirements

R1. WHEN a Proposal root enters a status for the first time THE SYSTEM SHALL assign the Ledger record id `<root>:<status>`, and WHEN it enters that same status on the n-th time where n is at least 2 THE SYSTEM SHALL assign `<root>:<status>:<n>`, with n equal to the count of existing records for that root and status plus one.

R2. WHEN a new Ledger record is written THE SYSTEM SHALL set `previousRecordId` to the exact id of the source record, and WHEN a decision is written for that Ledger record THE SYSTEM SHALL use id `decision:ledger:<recordId>` and include `recordId`, `fromStatus`, and `toStatus`.

R3. WHEN a record id is parsed THE SYSTEM SHALL recognize a status suffix and an optional occurrence suffix using the ADR-0021 grammar, resolve `<root>:<status>:<n>` to `<root>`, reject occurrence `1` and zero-padded occurrences as record ids, and leave a custom root such as `proposal:abc:2` unchanged when its preceding segment is not a status.

R4. WHEN a caller requests a ledger record by root or record id THE SYSTEM SHALL provide exact-root/latest, exact-record, and root-history queries; it SHALL never resolve a bare prefix, and an ambiguous or missing reference SHALL raise the typed `ambiguous` or `not-found` error.

R5. WHEN `appendComputed` is called THE SYSTEM SHALL hold the store lock while it reads complete JSONL frames, isolates and truncates any trailing residual bytes according to ADR-0020, invokes the builder against the complete records, rejects an occupied id with `DuplicateRecordError`, appends exactly one frame, and returns the written record.

R6. WHEN `ProposalLedger.transition(from, to, input)` is called THE SYSTEM SHALL perform the following under the Proposal store lock in order: detect an existing record with the same `previousRecordId` and target status; validate the ADR-0004 transition table; require `from.id` to be the latest record id when the root already exists; compute and append the new record. A repeated call for the same source and target SHALL return the existing record with `replayed: true` without appending another Ledger record.

R7. WHEN a transition is invalid, stale, or collides with an occupied id THE SYSTEM SHALL write neither a Ledger record nor a decision and SHALL raise `ProposalLedgerError('invalid-transition')`, `ProposalLedgerError('conflict')`, or `DuplicateRecordError` respectively. WHEN lock acquisition or Ledger I/O fails THE SYSTEM SHALL propagate the original error and SHALL NOT report success.

R8. WHEN a Ledger record append succeeds but its decision append fails THE SYSTEM SHALL propagate the decision error while retaining the Ledger record; retrying the same transition SHALL replay that record and append the missing deterministic decision. A missing decision SHALL never cause a duplicate Ledger record.

R9. WHEN any service method performs one of the eight Proposal transitions (stage, evaluate-to-evaluating, evaluate-to-evaluated, accept, promote, rollback, reject, or defer) THE SYSTEM SHALL call the single `ProposalLedger.transition` write seam; no other source file may append to the Proposal store directly. Transition methods that expose a Proposal record SHALL return the actual newly persisted record id.

R10. WHEN a service or operation maps a transition failure THE SYSTEM SHALL preserve `conflict` as a typed operation error, while internal `DuplicateRecordError` and filesystem failures SHALL retain their original error identity and message.

R11. WHEN historical ADR-0005 records lack `previousRecordId` and use unsuffixed first-entry ids THE SYSTEM SHALL read and query them without rewriting or migrating them. New entries after such data SHALL use ADR-0021 ids, and metrics and decision readers SHALL continue to count legacy transition and action-only decisions.

R12. WHEN the rejected → observed → evaluated path is executed twice through the core transition seam THE SYSTEM SHALL persist two distinct `evaluated` records (the second with an occurrence suffix), link each decision to its record, and return the latest record for a root query while returning the requested entry for an exact record-id query.

R13. WHEN a caller supplies an object whose id equals an existing record id but whose status or content is stale, including a `draft` object for an already staged root, THE SYSTEM SHALL raise `conflict` and SHALL leave both Ledger and decision counts unchanged.
