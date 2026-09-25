import { join } from 'node:path'
import { homedir } from 'node:os'
import { JsonlEventStore } from '@dsh-skill-evo/core'
import { DshEvolutionAdapter } from '@dsh-skill-evo/dsh-adapter'

export const name = 'dsh-skill-evo-bundle'
export const inject = ['sessions']

/** Record committed DSH session events for later Skill-evolution projection. */
export function apply(ctx, config = {}) {
  const storePath = config.storePath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skill-evolution', 'events.jsonl')
  const adapter = new DshEvolutionAdapter(new JsonlEventStore(storePath))

  ctx.on('session/event', (session, event) => {
    const id = `${session.id}:${event.seq}`
    void adapter.record({
      id,
      kind: 'agent-step',
      occurredAt: new Date().toISOString(),
      sessionId: session.id,
      correlationIds: [],
      payload: {
        eventType: event.type,
        sessionSeq: event.seq,
      },
    }).catch(error => {
      ctx.logger.warn(`dsh-skill-evo: failed to record session event ${id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}
