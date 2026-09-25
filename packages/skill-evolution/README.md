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
- `JsonlEventStore`: durable JSONL append/read/query with event-id idempotency.
- `buildExposureView`: derives catalog/load/follow-up exposure without claiming Skill impact.
- `validateAdoptionBase`: rejects candidates whose expected content hash is stale.
- `createContentHash`: binds observations and proposals to exact content snapshots.

Phase 2/3 APIs:

- `buildExperiences`, `buildFailureCases`, `clusterFailureCases`, and `diagnoseFailureCluster`.
- `EvolutionWorkflow` for evidence-linked Designer callbacks.
- `createProposal`, `evaluateCandidate`, and `JsonlRecordStore`.

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
- `repair` validates JSONL IDs, quarantines malformed lines, rebuilds the
  projection checkpoint, preserves live publication locks, and reports manifest
  hash mismatches. `rotate` archives oversized JSONL files with retention.
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
the same host and filesystem; network filesystems are not supported. `repair`
only removes dead local-owner locks and preserves unknown owners. User and feedback text is redacted for common
API keys, bearer credentials, passwords, tokens, and secrets before it becomes
durable evidence.
