# @dsh-skill-evo/core

Independent Phase 1 primitives for DSH Skill evolution.

This package records runtime observations and derives a minimal exposure view. It does not modify DSH's agent loop, Skill registry, or production Skill files. A future DSH adapter can translate `ctx.skills`, catalog, loader, session, and tool events into the package's `RuntimeObservation` records.

## Install locally

From a DSH checkout or another Node project:

```bash
pnpm add /absolute/path/to/dsh-skill-evo/packages/skill-evolution
```

The package is intentionally independent of the DeepSeek Harness repository. Integration belongs in a separate adapter that owns the DSH-specific event translation and plugin wiring.

## Phase 1 surface

- `RuntimeObservation`: append-only facts with stable event IDs.
- `JsonlEventStore`: durable JSONL append/read/query with event-id idempotency.
- `buildExposureView`: derives catalog/load/follow-up exposure without claiming Skill impact.
- `validateAdoptionBase`: rejects candidates whose expected content hash is stale.
- `createContentHash`: binds observations and proposals to exact content snapshots.

No automatic Designer, automatic publishing, or agent-loop changes are included.
