import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { assertFeedbackKind, createContentHash, EvolutionService, ObservationLog, OperationError, redactSensitiveText, renderFailuresMarkdown, proposeSkillChange, evaluateProposal, reviewProposal, promoteProposal, rollbackSkill } from '@dsh-skill-evo/core'
import { DshEvolutionAdapter } from '@dsh-skill-evo/dsh-adapter'

export const name = 'dsh-skill-evo-bundle'
export const inject = ['sessions', 'commands']

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
    const now = Date.now()
    cleanupMapperState(sessions, toolCalls, now)
    const sessionState = sessions.get(sessionId) ?? { userMessages: 0, lastSeen: now }
    sessionState.lastSeen = now
    sessions.set(sessionId, sessionState)
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
      return mapToolCall(base, event, sessionId, toolCalls, sessions)
    }

    if (event.type === 'tool/result') {
      return mapToolResult(base, event, sessionId, toolCalls, sessions)
    }

    if (event.type === 'turn/end') {
      clearToolCalls(toolCalls, sessionId)
      return mapTurnEnd(base, event)
    }

    if (event.type === 'session/end' || event.type === 'session/close') {
      clearSession(sessions, toolCalls, sessionId)
      return base
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
  const adapter = new DshEvolutionAdapter(new ObservationLog(storePath))
  const defaultMapper = createDefaultEventMapper()
  let writeQueue = Promise.resolve()

  ctx.on('session/event', (session, event) => {
    const id = `${session.id}:${event.seq}`
    let mapped
    try {
      mapped = typeof config.mapEvent === 'function'
        ? config.mapEvent(session, event, { id })
        : defaultMapper(session, event, { id })
      if (mapped !== undefined && !isObservationInput(mapped)) throw new Error('event mapper returned an invalid observation')
    } catch (error) {
      mapped = undefined
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
    input.payload = redactRecord(input.payload)
    writeQueue = writeQueue.then(() => adapter.record(input)).catch(error => {
      ctx.logger.warn(`dsh-skill-evo: failed to record session event ${id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  ctx.on('fs/observed', (target, observation) => {
    const mapped = mapFileObservation(target, observation)
    if (mapped === undefined) return
    writeQueue = writeQueue.then(() => enrichFileObservation(mapped).then(event => adapter.record(event))).catch(error => {
      ctx.logger.warn(`dsh-skill-evo: failed to record Skill file observation ${mapped.id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  if (ctx.commands?.register !== undefined) {
    const register = () => ctx.commands.register({
      name: 'skill-evolution',
      description: 'inspect and maintain Skill-evolution evidence',
      input: { hint: '[observe|failures|feedback ...]' },
      recordInput: false,
      handler: invocation => executeMaintenanceCommand(invocation, config),
    })
    if (ctx.effect !== undefined) ctx.effect(register, 'dsh-skill-evo: maintenance command')
    else register()
  }
}

async function executeMaintenanceCommand(invocation, config) {
  try {
    const words = tokenize(invocation.rawInput)
    const action = words.shift() ?? 'observe'
    const root = invocation.agent?.session?.header?.cwd ?? process.cwd()
    const storePath = config.storePath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skill-evolution', 'events.jsonl')
    const service = new EvolutionService({ root, store: storePath, ...(config.invalidate === undefined ? {} : { invalidate: config.invalidate }) })
    if (action === 'observe') {
      const snapshot = await service.refreshDerived()
      return { kind: 'success', text: JSON.stringify({ observations: (await service.observations.readAll()).length, experiences: snapshot.experiences.length, failures: snapshot.failures.length, clusters: snapshot.clusters.length }, null, 2) }
    }
    if (action === 'failures') return { kind: 'success', text: renderFailuresMarkdown(await service.listFailures()) }
    if (action === 'metrics') return { kind: 'success', text: JSON.stringify(await service.metrics(), null, 2) }
    if (action === 'health') return { kind: 'success', text: JSON.stringify(await service.healthReport(), null, 2) }
    if (action === 'repair') return { kind: 'success', text: JSON.stringify(await service.repair(), null, 2) }
    if (action === 'propose') {
      const flags = parseFlags(words)
      const result = await proposeSkillChange(service, {
        root,
        skillName: requiredFlag(flags, 'skill'),
        baseFile: resolve(requiredFlag(flags, 'base-file')),
        candidateFile: resolve(requiredFlag(flags, 'candidate-file')),
        proposedVersion: requiredFlag(flags, 'proposed-version'),
        intent: requiredFlag(flags, 'intent'),
        ...(flags.id === undefined ? {} : { id: flags.id }),
        ...(flags['base-version'] === undefined ? {} : { baseVersion: flags['base-version'] }),
        ...(flags.output === undefined ? {} : { reportPath: resolve(flags.output) }),
      })
      return { kind: 'success', text: JSON.stringify({ proposalId: result.proposal.id, status: result.proposal.status, report: result.reportPath }, null, 2) }
    }
    if (action === 'evaluate') {
      const flags = parseFlags(words)
      const result = await evaluateProposal(service, {
        root,
        proposalRef: requiredFlag(flags, 'proposal'),
        casesFile: resolve(requiredFlag(flags, 'cases')),
        ...(flags.output === undefined ? {} : { evaluationPath: resolve(flags.output) }),
        ...(flags.report === undefined ? {} : { reportPath: resolve(flags.report) }),
      })
      return { kind: 'success', text: JSON.stringify({ proposalId: result.recordId, evaluation: result.result, evaluationPath: result.evaluationPath }, null, 2) }
    }
    if (action === 'accept' || action === 'reject' || action === 'defer') {
      const flags = parseFlags(words)
      const result = await reviewProposal(service, { proposalRef: requiredFlag(flags, 'proposal'), decision: action, reason: requiredFlag(flags, 'reason') })
      return { kind: 'success', text: JSON.stringify({ proposalId: result.recordId, status: result.proposal.status }, null, 2) }
    }
    if (action === 'promote') {
      const flags = parseFlags(words)
      const result = await promoteProposal(service, {
        proposalRef: requiredFlag(flags, 'proposal'),
        scope: flags.scope ?? 'project',
        dryRun: parseBooleanFlag(flags['dry-run'], 'dry-run'),
        ...(flags.evaluation === undefined ? {} : { evaluationPath: resolve(flags.evaluation) }),
        ...(flags.reason === undefined ? {} : { reason: flags.reason }),
      })
      return { kind: 'success', text: JSON.stringify(result, null, 2) }
    }
    if (action === 'rollback') {
      const flags = parseFlags(words)
      const result = await rollbackSkill(service, { skillName: requiredFlag(flags, 'skill'), version: requiredFlag(flags, 'version'), reason: flags.reason })
      return { kind: 'success', text: JSON.stringify({ ...result, status: 'rolled-back' }, null, 2) }
    }
    if (action === 'feedback') {
      const flags = parseFlags(words)
      const record = await service.recordFeedback({ sessionId: flags.session ?? String(invocation.agent.session.id), skillName: flags.skill, kind: assertFeedbackKind(flags.kind ?? 'other'), note: flags.note ?? words.join(' '), source: 'user' })
      return { kind: 'success', text: `Feedback recorded: ${record.id}` }
    }
    return { kind: 'error', text: 'Usage: /skill-evolution observe | failures | metrics | health | repair | feedback | propose | evaluate | accept | reject | defer | promote | rollback' }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    return { kind: 'error', ...(code === undefined ? {} : { code }), text: error instanceof Error ? error.message : String(error) }
  }
}

function requiredFlag(flags, name) {
  if (typeof flags[name] !== 'string' || flags[name].length === 0) throw new Error(`missing --${name}`)
  return flags[name]
}

function parseBooleanFlag(value, name) {
  if (value === undefined) return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new OperationError('invalid-option', `--${name} must be true or false`)
}

function parseFlags(words) {
  const flags = {}
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (!word.startsWith('--')) continue
    const key = word.slice(2)
    const value = words[index + 1]
    if (value !== undefined && !value.startsWith('--')) { flags[key] = value; index += 1 }
    else flags[key] = 'true'
  }
  return flags
}

export function tokenize(input) {
  const words = []
  let word = ''
  let quote = undefined
  const source = String(input ?? '').trim()
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else if (character === '\\' && quote === '"' && (next === '"' || next === '\\')) { word += next; index += 1 }
      else word += character
      continue
    }
    if (character === '\\' && (next === '"' || next === "'" || next === '\\')) { word += next; index += 1; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) {
      if (word.length > 0) { words.push(word); word = '' }
    } else word += character
  }
  if (word.length > 0) words.push(word)
  return words
}

function redactRecord(value, depth = 0) {
  if (depth > 4) return '[REDACTED_NESTED_VALUE]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(item => redactRecord(item, depth + 1))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactRecord(item, depth + 1)]))
  return value
}

function redactText(value) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[REDACTED_AUTH]')
    .replace(/\b(password|passwd|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function isObservationInput(value) {
  const kinds = new Set(['catalog-visible', 'skill-load-requested', 'skill-loaded', 'skill-load-failed', 'agent-step', 'tool-result', 'user-follow-up', 'task-finished', 'skill-file-observed', 'adoption-applied'])
  return value !== null && typeof value === 'object'
    && kinds.has(value.kind)
    && typeof value.occurredAt === 'string'
    && Number.isFinite(Date.parse(value.occurredAt))
    && (value.correlationIds === undefined || Array.isArray(value.correlationIds) && value.correlationIds.every(item => typeof item === 'string'))
    && (value.payload === undefined || value.payload !== null && typeof value.payload === 'object' && !Array.isArray(value.payload))
    && (value.skill === undefined || value.skill !== null && typeof value.skill === 'object' && typeof value.skill.name === 'string')
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
    const precedingToolKind = state.lastToolKind
    const precedingToolFailed = state.lastToolFailed
    state.lastToolKind = undefined
    state.lastToolFailed = undefined
    sessions.set(base.sessionId, state)
    if (isFollowUp) {
      const text = textFromContent(data.content)
      return {
        ...base,
        kind: 'user-follow-up',
        source: 'user',
        payload: {
          ...base.payload,
          ...(text === undefined ? {} : { text: redactSensitiveText(text) }),
          ...(precedingToolKind === undefined ? {} : { precedingToolKind }),
          ...(precedingToolFailed === undefined ? {} : { precedingToolFailed }),
        },
      }
    }
  }

  return base
}

function mapToolCall(base, event, sessionId, toolCalls, sessions) {
  const data = asRecord(event.data)
  const callId = stringValue(data?.callId)
  const toolName = stringValue(data?.name)
  const args = parseJsonRecord(data?.arguments)
  const skillName = toolName === 'skill' ? stringValue(args?.name) : undefined
  const call = { toolName, skillName, observationId: base.id, lastSeen: Date.now() }
  if (callId !== undefined) toolCalls.set(`${sessionId}:${callId}`, call)

  if (toolName === 'skill' && skillName !== undefined) {
    const state = sessions.get(sessionId); if (state) { state.lastToolKind = 'skill-load-requested'; state.lastToolFailed = undefined }
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

function mapToolResult(base, event, sessionId, toolCalls, sessions) {
  const data = asRecord(event.data)
  const callId = stringValue(data?.callId) ?? stringValue(asRecord(data?.message)?.source?.callId)
  const call = callId === undefined ? undefined : toolCalls.get(`${sessionId}:${callId}`)
  if (callId !== undefined) toolCalls.delete(`${sessionId}:${callId}`)

  const failed = toolResultFailed(data)
  const state = sessions.get(sessionId); if (state) { state.lastToolKind = call?.toolName === 'skill' ? (failed ? 'skill-load-failed' : 'skill-loaded') : 'tool-result'; state.lastToolFailed = failed }
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

function clearToolCalls(toolCalls, sessionId) {
  for (const key of toolCalls.keys()) if (key.startsWith(`${sessionId}:`)) toolCalls.delete(key)
}

function clearSession(sessions, toolCalls, sessionId) {
  sessions.delete(sessionId)
  clearToolCalls(toolCalls, sessionId)
}

function cleanupMapperState(sessions, toolCalls, now) {
  const cutoff = now - 30 * 60 * 1000
  for (const [sessionId, state] of sessions) if (state.lastSeen < cutoff) sessions.delete(sessionId)
  for (const [key, state] of toolCalls) if (state.lastSeen < cutoff) toolCalls.delete(key)
  while (sessions.size > 1000) sessions.delete(sessions.keys().next().value)
  while (toolCalls.size > 10000) toolCalls.delete(toolCalls.keys().next().value)
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
