# @dsh-skill-evo/core

Core primitives for the complete DSH Skill-evolution loop.

The package records runtime observations, projects Experiences and failure
clusters, creates isolated proposals, evaluates deterministic regression cases,
and promotes or rolls back versioned Skill files. It does not modify DSH's
agent loop or registry. Production changes go through `SkillVersionStore` and
its expected content-hash check.

## Install locally

From a DSH checkout or another Node project:

```bash
pnpm add /absolute/path/to/dsh-skill-evo/packages/skill-evolution
```

The package is intentionally independent of the DeepSeek Harness repository. Integration belongs in a separate adapter that owns the DSH-specific event translation and plugin wiring.

## Surface by phase

- `RuntimeObservation`: append-only facts with stable event IDs.
- `ObservationLog`: archive-aware durable observation stream with event-id
  idempotency across the current file and archive segments.
- `JsonlEventStore`: legacy current-file-only JSONL append/read/query; it does
  not provide the logical fact stream across archives. New observation
  integrations should use `ObservationLog`.
- `buildExposureView`: derives catalog/load/follow-up exposure without claiming Skill impact.
- `validateAdoptionBase`: rejects candidates whose expected content hash is stale.
- `createContentHash`: binds observations and proposals to exact content snapshots.

Phase 2/3 APIs:

- `buildExperiences`, `buildFailureCases`, `clusterFailureCases`, and `diagnoseFailureCluster`.
- `EvolutionWorkflow` for evidence-linked Designer callbacks.
- `createProposal`, `evaluateCandidate`, and `JsonlRecordStore`.

Failure cases carry a structured `origin`: `load-failure`, `implicit-follow-up`, or
`explicit-feedback`; explicit feedback also carries its `feedbackKind` and any
provided `attributionConfidence`. Clustering sorts cases by `createdAt` and `id`,
uses CJK character bigrams, and derives each cluster id from its earliest case id,
so projection output is independent of observation input order. Existing derived
records are rebuilt with the new ids; consumers must resolve old cluster ids by
reprojecting rather than treating them as durable identifiers.

`Experience.confidence` and diagnosis confidence are evidence-strength scores,
not calibrated probabilities. They combine occurrence count, distinct sessions,
explicit feedback and counter-evidence. The score is informational until a
separate calibration policy exists and is not used as a publication gate.

Phase 4 APIs:

- `SkillVersionStore` for candidate isolation, atomic file publication, version history,
  optimistic base checks, invalidation callbacks, and rollback.
- `EvolutionService` for the maintainer-facing observe/evaluate/promote loop.

`SkillVersionStore` receives the root directory that owns a Skill's
`SKILL.md` (for example a project `.dsh/skills` directory); it never edits a
DSH registry or agent session directly.

Phase 5 APIs:

- `analyzePortfolio`, `transitionPortfolio`, `mergePortfolioEntries`,
  `splitPortfolioEntry`, and `portfolioDecision` for overlap, context-cost,
  dormant/retired signals, reversible portfolio edits, and durable curator
  decisions.

Operational reporting:

- `aggregateMetrics` and `EvolutionService.metrics()` export exposure, load,
  failure, follow-up, proposal, rollback, and context-cost metrics.
- The `dsh-skill-evolution` binary provides maintenance commands and writes
  Markdown proposal artifacts under `.skill-evolution/proposals/` by default.
- `repairEvolutionRoot` validates JSONL IDs, quarantines malformed lines,
  preserves live publication locks, and reports manifest hash mismatches. It is
  the standalone repair primitive and returns `projectionCursorRebuilt: false`;
  it does not touch the cursor. `EvolutionService.repair()` is the service,
  CLI, and bundle operation: after successful re-projection it returns
  `projectionCursorRebuilt: true`, while a failed re-projection throws.
  Both only see archive segments that still exist. Explicit retention deletes
  archives permanently; before this layout was introduced, the old default
  30-day retention may already have deleted segments, so recovery is limited
  to the facts that remain. `rotateJsonl` is the legacy current-file rotation
  helper; new observation integrations should use `ObservationLog.rotate`,
  which leaves retention disabled unless `retentionDays` is explicitly supplied.
- `health` is a read-only readiness probe for file existence, permissions,
  malformed records, byte size, and trailing partial lines.
- Proposal transitions are recorded with actor, status pair, evidence, hashes,
  and evaluation policy version; `accept`, `reject`, and `defer` are explicit
  review operations.
- Pass `--root project` and optionally `--store events.jsonl`; pass a JSON policy
  with `--policy policy.json` to the CLI `evaluate` command;
  the same `EvaluationPolicy` is available through `EvolutionServiceOptions`.

Designer generation remains an injected callback so model-generated changes stay
reviewable and cannot write production files implicitly.

The JSONL writer uses per-file local-filesystem locks for reads, appends,
repairs, rotations, and projection replacement. Locks coordinate processes on
the same host and filesystem; network filesystems are not supported. `withLock`
is the single locking API and always records the operation that owns the lock.

## Lock protocol

Lock files are created atomically through a temporary file and hard link. A v1
owner record contains `v`, `token`, `pid`, `hostname`, `createdAt`, `uptimeMs`,
and `operation`. The token is checked before release so a callback cannot remove
a replacement lock. Older v0 records without `v`, `token`, or `uptimeMs` remain
readable during migration; their reboot check falls back to `createdAt`.

`inspectLock` classifies a lock using the following rules:

| State | Classification | Reclaimed by `withLock`/`repair` |
| --- | --- | --- |
| `free` | Lock file is absent | N/A |
| `unknown` | Empty, malformed, or missing required owner fields | Only after the default 10-minute mtime grace period |
| `foreign` | Owner hostname differs from the current host | Never automatically |
| `rebooted` | Local v1 uptime is from a previous boot, or v0 `createdAt` predates the current boot | Yes |
| `dead` | Local owner PID no longer exists | Yes |
| `held` | Local owner PID is live (including `EPERM`) | Never automatically |

Live and foreign owners are preserved regardless of age. An unknown lock inside
the 10-minute grace period is also preserved, protecting the write window of
older v0 clients. `LockBusyError` reports the final state and, when an abandoned
reclaim guard blocks progress, its guard path for manual repair.

`repair` calls `sweepLocks` for root directories and explicitly shared paths.
Its `locks` report includes every lock, reclaim guard, and temporary artifact with
`path`, `artifact`, `state`, and `removed`; directory-sweep contention is reported
as `skipped`. The compatibility summary arrays `orphanLocksRemoved` and
`locksPreserved` contain lock artifact paths only. Repair removes only artifacts
classified as reclaimable and leaves foreign, live, and grace-period unknown
owners intact.

User and feedback text is redacted for common API keys, bearer credentials,
passwords, tokens, and secrets before it becomes durable evidence.
