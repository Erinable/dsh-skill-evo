# @dsh-skill-evo/dsh-adapter

Adapter boundary for connecting DeepSeek Harness runtime facts to `@dsh-skill-evo/core`.

The adapter intentionally does not import DeepSeek Harness internals. A DSH integration layer maps its concrete catalog, loader, session, tool, and filesystem callbacks to `DshObservationInput`, then passes a core `JsonlEventStore` as the writer.

## Example

```ts
import { JsonlEventStore } from '@dsh-skill-evo/core'
import { DshEvolutionAdapter } from '@dsh-skill-evo/dsh-adapter'

const store = new JsonlEventStore('/tmp/dsh-skill-evo/events.jsonl')
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

The caller must provide stable event IDs. Retrying the same DSH callback with the same ID is idempotent in the core store. Catalog snapshots expand to one event per Skill; an empty catalog is retained as a replacement snapshot. The adapter only translates facts; Experience projection, proposals, evaluation, and version publication belong to the core evolution service.
