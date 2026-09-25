import { join } from 'node:path'
import { homedir } from 'node:os'
import { JsonlEventStore } from '@dsh-skill-evo/core'
import { DshEvolutionAdapter } from '@dsh-skill-evo/dsh-adapter'

export const name = 'dsh-skill-evo-bundle'
export const inject = ['sessions']

/**
 * Record committed DSH session events for later Skill-evolution projection.
 *
 * DSH event shapes vary by integration. Callers that have access to concrete
 * catalog/loader events can provide `config.mapEvent`; returning a valid
 * DshObservationInput preserves those facts without making this bundle infer
 * Skill impact from arbitrary session payloads.
 */
export function apply(ctx, config = {}) {
  const storePath = config.storePath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skill-evolution', 'events.jsonl')
  const adapter = new DshEvolutionAdapter(new JsonlEventStore(storePath))

  ctx.on('session/event', (session, event) => {
    const id = `${session.id}:${event.seq}`
    let mapped
    try {
      mapped = typeof config.mapEvent === 'function'
        ? config.mapEvent(session, event, { id })
        : undefined
    } catch (error) {
      ctx.logger.warn(`dsh-skill-evo: event mapper failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const input = mapped == null ? {
      id,
      kind: 'agent-step',
      occurredAt: new Date().toISOString(),
      sessionId: session.id,
      correlationIds: [],
      payload: {
        eventType: event.type,
        sessionSeq: event.seq,
      },
    } : {
      ...mapped,
      id: mapped.id ?? id,
      sessionId: mapped.sessionId ?? session.id,
      occurredAt: mapped.occurredAt ?? new Date().toISOString(),
    }
    void adapter.record(input).catch(error => {
      ctx.logger.warn(`dsh-skill-evo: failed to record session event ${id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}
