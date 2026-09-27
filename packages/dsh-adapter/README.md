# @dsh-skill-evo/dsh-adapter

Adapter boundary for connecting DeepSeek Harness runtime facts to `@dsh-skill-evo/core`.

The adapter intentionally does not import DeepSeek Harness internals. A DSH integration layer maps its concrete catalog, loader, session, tool, and filesystem callbacks to `DshObservationInput`, then passes a core `ObservationLog` as the writer.

## Example

```ts
import { ObservationLog } from '@dsh-skill-evo/core'
import { DshEvolutionAdapter } from '@dsh-skill-evo/dsh-adapter'

const store = new ObservationLog('/tmp/dsh-skill-evo/events.jsonl')
const adapter = new DshEvolutionAdapter(store)

await adapter.record({
  id: 'catalog-session-1-1',
  kind: 'catalog-visible',
  occurredAt: new Date().toISOString(),
  sessionId: 'session-1',
  skills: [{
    name: 'api-debugging',
    provider: 'filesystem',
    source: 'project-dsh',
    contentHash: 'sha256:...',
  }],
})
```

The caller must provide stable event IDs. Retrying the same DSH callback with the same ID is idempotent across the current observation file and its archive segments. Catalog snapshots expand to one event per Skill; an empty catalog is retained as a replacement snapshot. The adapter only translates facts; Experience projection, proposals, evaluation, and version publication belong to the core evolution service.

`JsonlEventStore` remains available for legacy generic JSONL use, but it only reads the current file and does not provide the archive-aware observation stream. New observation integrations should use `ObservationLog`.

The adapter's public compatibility surface is limited to translating
`DshObservationInput` into core observations. It accepts any explicit
`ObservationLog` path, including a user-level store override, and does not
assume per-Skill `evolution/` directories or a particular core maintenance
layout.

`runDshComparison()` is the DSH evaluation boundary. It runs base and
candidate Skill contents in separate temporary workspaces, aborts timed-out
cases, and preserves tool-call count, token cost, side effects, security
violations, user feedback, and evidence returned by the injected DSH executor.
The executor is intentionally injected so a deployment can bind it to its
isolated agent-loop runner without making the adapter depend on one DSH
profile composition.

The package also exports `createReferenceExecutor()` for deterministic local
checks, `createFakeDshExecutor()` for fast tests, and
`createReferenceDshExecutor()` for a real `dsh --profile headless` process.
The process adapter passes the isolated workspace and Skill content through to
DSH, captures stdout/stderr and tool-call markers, and terminates on abort.
`createDshEvaluationRunner()` adapts the comparison protocol to the core
evaluator gate. The process adapter does not infer task success from exit code
or output text: production runs need a deployment-provided `judge` that returns
measured evidence, cost, feedback, and effects. Temporary workspaces are removed
after settlement; abandoned directories older than 24 hours are reclaimed on
the next comparison call. Network or global system side effects still require
the deployment runner's OS-level sandbox.
