import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { assertFeedbackKind, assertPublicationScope, createContentHash, createProposal, EvolutionService, ObservationLog, redactSensitiveText, renderFailuresMarkdown, renderProposalMarkdown } from '@dsh-skill-evo/core'
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
      return mapToolCall(base, event, sessionId, toolCalls)
    }

    if (event.type === 'tool/result') {
      return mapToolResult(base, event, sessionId, toolCalls)
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
  const words = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
  const action = words.shift() ?? 'observe'
  const root = invocation.agent?.session?.header?.cwd ?? process.cwd()
  const storePath = config.storePath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skill-evolution', 'events.jsonl')
  const service = new EvolutionService({ root, store: storePath, ...(config.invalidate === undefined ? {} : { invalidate: config.invalidate }) })
  if (action === 'observe') {
    const snapshot = await service.refreshDerived()
    return { kind: 'success', text: JSON.stringify({ observations: (await service.observations.readAll()).length, experiences: snapshot.experiences.length, failures: snapshot.failures.length, clusters: snapshot.clusters.length }, null, 2) }
  }
  if (action === 'failures') {
    return { kind: 'success', text: renderFailuresMarkdown(await service.listFailures()) }
  }
  if (action === 'metrics') {
    return { kind: 'success', text: JSON.stringify(await service.metrics(), null, 2) }
  }
  if (action === 'health') {
    return { kind: 'success', text: JSON.stringify(await service.healthReport(), null, 2) }
  }
  if (action === 'repair') {
    return { kind: 'success', text: JSON.stringify(await service.repair(), null, 2) }
  }
  if (action === 'propose') {
    const flags = parseFlags(words)
    const skillName = requiredFlag(flags, 'skill')
    const current = await service.versions.readCurrent(skillName)
    if (current === undefined) throw new Error(`current Skill not found: ${skillName}`)
    const baseContent = await readFile(resolve(requiredFlag(flags, 'base-file')), 'utf8')
    const candidateContent = await readFile(resolve(requiredFlag(flags, 'candidate-file')), 'utf8')
    if (baseContent !== current.content) throw new Error('base file does not match current Skill content')
    const proposal = await service.stageProposal(createProposal({
      id: flags.id,
      skillName,
      baseVersion: flags['base-version'] ?? current.manifest.version,
      baseContent,
      proposedVersion: requiredFlag(flags, 'proposed-version'),
      candidateContent,
      intent: requiredFlag(flags, 'intent'),
      generatedBy: 'human',
    }))
    const report = resolve(flags.output ?? join(service.layout.proposalReportsDir, `${proposal.id}.md`))
    const snapshot = await service.refreshDerived()
    await mkdir(dirname(report), { recursive: true })
    await writeFile(report, renderProposalMarkdown({ proposal, failures: snapshot.failures, clusters: snapshot.clusters, diagnosis: snapshot.diagnoses.find(item => item.id === proposal.diagnosisId) }), 'utf8')
    return { kind: 'success', text: JSON.stringify({ proposalId: proposal.id, status: proposal.status, report }, null, 2) }
  }
  if (action === 'evaluate') {
    const flags = parseFlags(words)
    const proposal = await findProposal(service, requiredFlag(flags, 'proposal'))
    const cases = JSON.parse(await readFile(resolve(requiredFlag(flags, 'cases')), 'utf8'))
    const result = await service.evaluate(proposal, cases)
    return { kind: 'success', text: JSON.stringify({ proposalId: proposal.id, evaluation: result }, null, 2) }
  }
  if (action === 'accept' || action === 'reject' || action === 'defer') {
    const flags = parseFlags(words)
    const proposal = await findProposal(service, requiredFlag(flags, 'proposal'))
    const reason = requiredFlag(flags, 'reason')
    const result = action === 'accept' ? await service.acceptProposal(proposal, reason) : action === 'reject' ? await service.rejectProposal(proposal, reason) : await service.deferProposal(proposal, reason)
    return { kind: 'success', text: JSON.stringify({ proposalId: result.id, status: result.status }, null, 2) }
  }
  if (action === 'promote') {
    const flags = parseFlags(words)
    const proposal = await findProposal(service, requiredFlag(flags, 'proposal'))
    const evaluation = JSON.parse(await readFile(resolve(requiredFlag(flags, 'evaluation')), 'utf8'))
    const scope = assertPublicationScope(flags.scope ?? 'project')
    if (flags['dry-run'] === 'true') return { kind: 'success', text: JSON.stringify({ dryRun: true, proposal, evaluation, scope }, null, 2) }
    await service.promote(proposal, evaluation, scope)
    return { kind: 'success', text: JSON.stringify({ proposalId: proposal.id, status: 'promoted' }, null, 2) }
  }
  if (action === 'rollback') {
    const flags = parseFlags(words)
    await service.rollback(requiredFlag(flags, 'skill'), requiredFlag(flags, 'version'), flags.reason ?? 'manual rollback')
    return { kind: 'success', text: JSON.stringify({ skill: flags.skill, version: flags.version, status: 'rolled-back' }, null, 2) }
  }
  if (action === 'feedback') {
    const flags = parseFlags(words)
    const record = await service.recordFeedback({ sessionId: flags.session ?? String(invocation.agent.session.id), skillName: flags.skill, kind: assertFeedbackKind(flags.kind ?? 'other'), note: flags.note ?? words.join(' '), source: 'user' })
    return { kind: 'success', text: `Feedback recorded: ${record.id}` }
  }
  return { kind: 'error', text: 'Usage: /skill-evolution observe | failures | metrics | health | repair | feedback | propose | evaluate | accept | reject | defer | promote | rollback' }
}

async function findProposal(service, id) {
  const records = await service.proposals.readAll()
  const matches = records.filter(record => record.id === id || record.id.startsWith(`${id}:`))
  const proposal = matches.at(-1)
  if (proposal === undefined) throw new Error(`proposal not found: ${id}`)
  return proposal
}

function requiredFlag(flags, name) {
  if (typeof flags[name] !== 'string' || flags[name].length === 0) throw new Error(`missing --${name}`)
  return flags[name]
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
  const call = { toolName, skillName, observationId: base.id, lastSeen: Date.now() }
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
