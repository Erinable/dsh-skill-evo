import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { createContentHash, JsonlEventStore } from '@dsh-skill-evo/core'
import { DshEvolutionAdapter } from '@dsh-skill-evo/dsh-adapter'

export const name = 'dsh-skill-evo-bundle'
export const inject = ['sessions']

/**
 * Create the built-in mapper for DSH's durable session event vocabulary.
 *
 * The mapper deliberately uses facts already committed to the session log:
 * catalog messages, skill tool calls/results, explicit user skill invocations,
 * and later user messages. Unknown events remain generic agent-step records.
 */
export function createDefaultEventMapper() {
  const sessions = new Map()
  const toolCalls = new Map()

  return (session, event, { id }) => {
    const sessionId = String(session.id)
    const base = {
      id,
      kind: 'agent-step',
      occurredAt: occurredAt(event),
      sessionId,
      correlationIds: [],
      payload: {
        eventType: event.type,
        sessionSeq: event.seq,
      },
      source: 'runtime',
    }

    if (event.type === 'user/message') {
      return mapUserMessage(base, event, sessions)
    }

    if (event.type === 'tool/call') {
      return mapToolCall(base, event, sessionId, toolCalls)
    }

    if (event.type === 'tool/result') {
      return mapToolResult(base, event, sessionId, toolCalls)
    }

    if (event.type === 'turn/end') {
      return mapTurnEnd(base, event)
    }

    return base
  }
}

/** Map DSH's synchronous filesystem observation into a Skill file fact. */
export function mapFileObservation(target, observation, { id } = {}) {
  const path = typeof target?.displayPath === 'string' ? target.displayPath : undefined
  const skill = path === undefined ? undefined : skillFromPath(path)
  if (skill === undefined) return undefined
  const observationId = id ?? `file:${target.targetKey ?? path}:${observation?.version ?? observation?.kind ?? 'unknown'}`
  return {
    id: observationId,
    kind: 'skill-file-observed',
    occurredAt: new Date().toISOString(),
    skill: {
      name: skill.name,
      provider: 'filesystem',
      source: skill.source,
      path,
      ...(observation?.version === undefined ? {} : { resourceHash: String(observation.version) }),
    },
    correlationIds: [],
    payload: {
      path,
      observationKind: observation?.kind ?? 'unknown',
    },
    source: 'filesystem',
  }
}

function mapTurnEnd(base, event) {
  const data = asRecord(event.data)
  const reason = asRecord(data?.reason)
  const outcome = reason?.kind === 'completed'
    ? 'completed'
    : reason?.kind === 'cancelled' || reason?.kind === 'aborted'
      ? 'cancelled'
      : reason?.kind === 'failed' || reason?.kind === 'error'
        ? 'failure'
        : 'unknown'
  return {
    ...base,
    kind: 'task-finished',
    payload: {
      ...base.payload,
      outcome,
      ...(reason?.kind === undefined ? {} : { reason: reason.kind }),
    },
  }
}

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
  const defaultMapper = createDefaultEventMapper()

  ctx.on('session/event', (session, event) => {
    const id = `${session.id}:${event.seq}`
    let mapped
    try {
      mapped = typeof config.mapEvent === 'function'
        ? config.mapEvent(session, event, { id })
        : defaultMapper(session, event, { id })
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

  ctx.on('fs/observed', (target, observation) => {
    const mapped = mapFileObservation(target, observation)
    if (mapped === undefined) return
    void enrichFileObservation(mapped).then(event => adapter.record(event)).catch(error => {
      ctx.logger.warn(`dsh-skill-evo: failed to record Skill file observation ${mapped.id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}

async function enrichFileObservation(event) {
  const path = event.skill?.path
  if (event.payload.observationKind !== 'present' || typeof path !== 'string') return event
  try {
    const content = await readFile(path, 'utf8')
    return { ...event, skill: { ...event.skill, contentHash: createContentHash(content) } }
  } catch {
    return event
  }
}

function mapUserMessage(base, event, sessions) {
  const data = asRecord(event.data)
  const source = asRecord(data?.source)

  if (source?.kind === 'skill-catalog') {
    const entries = Array.isArray(source.entries)
      ? source.entries.filter(isCatalogEntry)
      : []
    return {
      ...base,
      kind: 'catalog-visible',
      skills: entries.map(entry => skillRef(entry.name)),
      payload: {
        ...base.payload,
        catalogUpdate: source.update === true,
        catalogSize: entries.length,
      },
    }
  }

  if (source?.kind === 'skill-invocation' && typeof source.name === 'string') {
    const text = textFromContent(data.content)
    const contentHash = skillContentHash(text)
    return {
      ...base,
      kind: 'skill-loaded',
      source: 'user',
      skill: skillRef(source.name, contentHash),
      payload: {
        ...base.payload,
        invocation: 'user',
      },
    }
  }

  if (source?.kind === 'user') {
    const state = sessions.get(base.sessionId) ?? { userMessages: 0 }
    const isFollowUp = state.userMessages > 0
    state.userMessages += 1
    sessions.set(base.sessionId, state)
    if (isFollowUp) {
      const text = textFromContent(data.content)
      return {
        ...base,
        kind: 'user-follow-up',
        source: 'user',
        payload: {
          ...base.payload,
          ...(text === undefined ? {} : { text }),
        },
      }
    }
  }

  return base
}

function mapToolCall(base, event, sessionId, toolCalls) {
  const data = asRecord(event.data)
  const callId = stringValue(data?.callId)
  const toolName = stringValue(data?.name)
  const args = parseJsonRecord(data?.arguments)
  const skillName = toolName === 'skill' ? stringValue(args?.name) : undefined
  const call = { toolName, skillName, observationId: base.id }
  if (callId !== undefined) toolCalls.set(`${sessionId}:${callId}`, call)

  if (toolName === 'skill' && skillName !== undefined) {
    return {
      ...base,
      kind: 'skill-load-requested',
      skill: skillRef(skillName),
      payload: {
        ...base.payload,
        ...(callId === undefined ? {} : { toolCallId: callId }),
      },
    }
  }

  return {
    ...base,
    payload: {
      ...base.payload,
      ...(callId === undefined ? {} : { toolCallId: callId }),
      ...(toolName === undefined ? {} : { toolName }),
    },
  }
}

function mapToolResult(base, event, sessionId, toolCalls) {
  const data = asRecord(event.data)
  const callId = stringValue(data?.callId) ?? stringValue(asRecord(data?.message)?.source?.callId)
  const call = callId === undefined ? undefined : toolCalls.get(`${sessionId}:${callId}`)
  if (callId !== undefined) toolCalls.delete(`${sessionId}:${callId}`)

  const failed = toolResultFailed(data)
  const payload = {
    ...base.payload,
    ...(callId === undefined ? {} : { toolCallId: callId }),
    ...(call?.toolName === undefined ? {} : { toolName: call.toolName }),
    ...(failed ? { failed: true } : {}),
  }
  const correlationIds = call === undefined ? [] : [call.observationId]

  if (call?.toolName === 'skill' && call.skillName !== undefined) {
    const text = textFromToolResult(data)
    const contentHash = failed ? undefined : skillContentHash(text)
    return {
      ...base,
      kind: failed ? 'skill-load-failed' : 'skill-loaded',
      correlationIds,
      skill: skillRef(call.skillName, contentHash),
      payload,
    }
  }

  return {
    ...base,
    kind: 'tool-result',
    correlationIds,
    payload,
  }
}

function skillRef(name, contentHash) {
  return {
    name,
    provider: 'unknown',
    source: 'unknown',
    ...(contentHash === undefined ? {} : { contentHash }),
  }
}

function isCatalogEntry(value) {
  const entry = asRecord(value)
  return typeof entry?.name === 'string' && typeof entry.description === 'string'
}

function occurredAt(event) {
  return typeof event.time === 'number' && Number.isFinite(event.time)
    ? new Date(event.time).toISOString()
    : new Date().toISOString()
}

function textFromToolResult(data) {
  const message = asRecord(data?.message)
  const blocks = Array.isArray(message?.content) ? message.content : []
  const result = blocks.find(block => asRecord(block)?.type === 'tool-result')
  const content = asRecord(result)?.content
  return textFromContent(content)
}

function textFromContent(content) {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(block => asRecord(block))
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text.length === 0 ? undefined : text
}

function skillContentHash(text) {
  if (text === undefined) return undefined
  const startMarker = '<skill_instructions>'
  const endMarker = '</skill_instructions>'
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker)
  if (start < 0 || end <= start) return undefined
  const content = text.slice(start + startMarker.length, end).replace(/^\n/, '').replace(/\n$/, '')
  return createContentHash(content)
}

function toolResultFailed(data) {
  if (data?.error !== undefined) return true
  const message = asRecord(data?.message)
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.some(block => {
    const result = asRecord(block)
    return result?.type === 'tool-result' && result.isError === true
  })
}

function parseJsonRecord(value) {
  if (typeof value !== 'string') return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

function stringValue(value) {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function skillFromPath(path) {
  const normalized = path.replaceAll('\\', '/')
  const skillFile = normalized.match(/(?:^|\/)(?:\.dsh\/skills|\.agents\/skills|skills)\/([^/]+)\/SKILL\.md$/i)
  if (skillFile !== null) {
    const name = skillFile[1]
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      return { name, source: sourceFromPath(normalized) }
    }
  }
  return undefined
}

function sourceFromPath(path) {
  if (path.includes('/.dsh/skills/')) return 'project-dsh'
  if (path.includes('/.agents/skills/')) return 'project-agents'
  if (path.includes('/.dsh/')) return 'user-dsh'
  if (path.includes('/.agents/')) return 'user-agents'
  return 'filesystem'
}
