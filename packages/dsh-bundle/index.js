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

    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      return mapContextShadowed(base, event)
    }

    if (event.type === 'user/message') {
      return markSurfaceReplacement(mapUserMessage(base, event, sessions), event)
    }

    if (event.type === 'tool/call') {
      return markSurfaceReplacement(mapToolCall(base, event, sessionId, toolCalls, sessions), event)
    }

    if (event.type === 'tool/result') {
      if (isSurfaceReplacement(event)) return mapReplacementToolResult(base, event)
      return mapToolResult(base, event, sessionId, toolCalls, sessions)
    }

    if (event.type === 'turn/end') {
      clearToolCalls(toolCalls, sessionId)
      return markSurfaceReplacement(mapTurnEnd(base, event), event)
    }

    if (event.type === 'session/end' || event.type === 'session/close') {
      clearSession(sessions, toolCalls, sessionId)
      return markSurfaceReplacement(base, event)
    }

    return markSurfaceReplacement(base, event)
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

function mapContextShadowed(base, event) {
  const data = asRecord(event.data)
  const mechanism = event.type === 'compaction/summary' ? 'summary' : 'prune'
  const seqs = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs : undefined
  const ranges = mergeSeqRanges(seqs, data?.shadowedRange)
  return {
    ...base,
    kind: 'context-shadowed',
    payload: {
      ...base.payload,
      shadowedSeqRanges: ranges,
      ...(Number.isFinite(data?.shadowedTokenCount) ? { shadowedTokenCount: data.shadowedTokenCount } : {}),
      mechanism,
    },
  }
}

function mergeSeqRanges(seqs, range) {
  const values = Array.isArray(seqs) ? seqs.filter(value => Number.isInteger(value)).map(Number) : []
  if (values.length === 0) {
    if (Array.isArray(range) && range.length === 2 && range.every(Number.isInteger)) return [[range[0], range[1]]]
    if (range && typeof range === 'object' && Number.isInteger(range.start) && Number.isInteger(range.end)) return [[range.start, range.end]]
  }
  values.sort((left, right) => left - right)
  const result = []
  for (const value of values) {
    const last = result.at(-1)
    if (last && value <= last[1] + 1) last[1] = Math.max(last[1], value)
    else result.push([value, value])
  }
  return result
}

function isSurfaceReplacement(event) {
  const data = asRecord(event.data)
  const surfaceOp = asRecord(data?.surfaceOp) ?? asRecord(event.surfaceOp)
  return surfaceOp?.op === 'replace'
}

function markSurfaceReplacement(mapped, event) {
  return isSurfaceReplacement(event)
    ? { ...mapped, payload: { ...mapped.payload, surfaceReplace: true } }
    : mapped
}

function mapReplacementToolResult(base, event) {
  const data = asRecord(event.data)
  const callId = stringValue(data?.callId) ?? stringValue(asRecord(data?.message)?.source?.callId)
  return {
    ...base,
    kind: 'tool-result',
    payload: {
      ...base.payload,
      ...(callId === undefined ? {} : { toolCallId: callId }),
      surfaceReplace: true,
    },
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
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map(item => redactRecord(item, depth + 1))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactRecord(item, depth + 1)]))
  return value
}

function isObservationInput(value) {
  const kinds = new Set(['catalog-visible', 'skill-load-requested', 'skill-loaded', 'skill-load-failed', 'agent-step', 'tool-result', 'context-shadowed', 'user-follow-up', 'task-finished', 'skill-file-observed', 'adoption-applied'])
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
    clearPrecedingToolState(sessions, base.sessionId)
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
        shadowTracked: true,
      },
    }
  }

  if (source?.kind === 'user') {
    const state = sessions.get(base.sessionId) ?? { userMessages: 0 }
    const isFollowUp = state.userMessages > 0
    state.userMessages += 1
    const preceding = isFollowUp
      ? {
          ...(state.precedingToolKind === undefined ? {} : { precedingToolKind: state.precedingToolKind }),
          ...(state.precedingToolFailed === true ? { precedingToolFailed: true } : {}),
        }
      : {}
    clearPrecedingToolState(sessions, base.sessionId)
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
          ...preceding,
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
    setPrecedingToolState(sessions, sessionId, 'skill-load-requested', false)
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
      ...toolSummary(toolName, args),
    },
  }
}

function mapToolResult(base, event, sessionId, toolCalls, sessions) {
  const data = asRecord(event.data)
  const callId = stringValue(data?.callId) ?? stringValue(asRecord(data?.message)?.source?.callId)
  const call = callId === undefined ? undefined : toolCalls.get(`${sessionId}:${callId}`)
  if (callId !== undefined) toolCalls.delete(`${sessionId}:${callId}`)

  const failed = toolResultFailed(data)
  const resultSummary = commandResultSummary(call?.toolName, data)
  const payload = {
    ...base.payload,
    ...(callId === undefined ? {} : { toolCallId: callId }),
    ...(call?.toolName === undefined ? {} : { toolName: call.toolName }),
    ...(failed ? { failed: true } : {}),
    ...resultSummary,
  }
  const correlationIds = call === undefined ? [] : [call.observationId]

  if (call?.toolName === 'skill' && call.skillName !== undefined) {
    const text = textFromToolResult(data)
    const contentHash = failed ? undefined : skillContentHash(text)
    setPrecedingToolState(sessions, sessionId, failed ? 'skill-load-failed' : 'skill-loaded', failed)
    return {
      ...base,
      kind: failed ? 'skill-load-failed' : 'skill-loaded',
      correlationIds,
      skill: skillRef(call.skillName, contentHash),
      payload: failed ? payload : { ...payload, shadowTracked: true },
    }
  }

  setPrecedingToolState(sessions, sessionId, 'tool-result', failed)
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

const COMMAND_TOOLS = new Set(['bash', 'pwsh'])

function toolSummary(toolName, args) {
  const argKeys = args === undefined ? [] : Object.keys(args).slice(0, 16).map(key => key.slice(0, 64))
  const summary = argKeys.length === 0 ? {} : { argKeys }
  if (!COMMAND_TOOLS.has(toolName)) return summary
  const command = typeof args?.command === 'string' ? args.command : typeof args?.script === 'string' ? args.script : undefined
  if (command === undefined) return summary
  const redacted = redactSensitiveText(command)
  const tokens = tokenize(redacted).slice(0, 16).map(token => token.slice(0, 64))
  const joined = tokens.join(' ')
  const bounded = joined.slice(0, 240)
  return { ...summary, command: bounded, ...(tokens.length < tokenize(redacted).length || joined.length > 240 ? { commandTruncated: true } : {}) }
}

function commandResultSummary(toolName, data) {
  if (!COMMAND_TOOLS.has(toolName)) return {}
  const structured = findResultMetadata(data)
  const text = textFromToolResult(data) ?? textFromAny(data)
  const marker = parseExitMarkers(text)
  const exitCode = Number.isInteger(structured.exitCode) ? structured.exitCode : marker.exitCode
  const signal = typeof structured.signal === 'string' ? structured.signal : marker.signal
  const timedOut = structured.timedOut === true || marker.timedOut === true
  const failed = toolResultFailed(data)
  const summary = {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal: redactSensitiveText(signal).slice(0, 32) }),
    ...(timedOut ? { timedOut: true } : {}),
  }
  if (failed || exitCode !== undefined && exitCode !== 0 || signal !== undefined || timedOut) {
    const line = errorLine(data, text)
    if (line !== undefined) summary.errorLine = redactSensitiveText(line).replace(/\s+/g, ' ').slice(0, 200)
  }
  return summary
}

function findResultMetadata(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return {}
  if (!Array.isArray(value)) {
    const result = {}
    if (Number.isInteger(value.exitCode)) result.exitCode = value.exitCode
    if (typeof value.signal === 'string') result.signal = value.signal
    if (value.timedOut === true) result.timedOut = true
    for (const child of Object.values(value)) {
      const nested = findResultMetadata(child, depth + 1)
      Object.assign(result, nested)
    }
    return result
  }
  return value.reduce((result, child) => Object.assign(result, findResultMetadata(child, depth + 1)), {})
}

function parseExitMarkers(text) {
  if (typeof text !== 'string') return {}
  const exit = text.match(/\[exit code:\s*(-?\d+)\]\s*$/i)
  const signal = text.match(/\[killed by signal:\s*([^\]]+)\]\s*$/i)
  return {
    ...(exit === null ? {} : { exitCode: Number(exit[1]) }),
    ...(signal === null ? {} : { signal: signal[1].trim() }),
    ...( /\[timed out after [^\]]+\]\s*$/i.test(text) ? { timedOut: true } : {}),
  }
}

function errorLine(data, text) {
  const candidates = []
  const source = typeof text === 'string' ? text : textFromAny(data)
  if (typeof source !== 'string') return undefined
  const stderr = source.match(/\[stderr\]([\s\S]*?)(?=\n\[(?:stdout|exit code|killed by signal|timed out)|$)/i)?.[1]
  const stdout = source.match(/\[stdout\]([\s\S]*?)(?=\n\[(?:stderr|exit code|killed by signal|timed out)|$)/i)?.[1]
  for (const block of [stderr, stdout, source]) {
    if (typeof block !== 'string') continue
    const lines = block.split(/\r?\n/).filter(line => line.trim()).slice(-64)
    candidates.push(...lines.filter(line => /error|fatal|failed|denied|refused|timed out|could not|unable|not found/i.test(line)))
    if (candidates.length === 0) candidates.push(...lines.slice(0, 1))
    if (candidates.length > 0) return candidates[0]
  }
  return undefined
}

function textFromAny(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => textFromAny(item, depth + 1)).filter(Boolean).join('\n') || undefined
  for (const [key, child] of Object.entries(value)) {
    if (key === 'text' && typeof child === 'string') return child
    const text = textFromAny(child, depth + 1)
    if (text !== undefined) return text
  }
  return undefined
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

function clearPrecedingToolState(sessions, sessionId) {
  const state = sessions.get(sessionId)
  if (state === undefined) return
  delete state.precedingToolKind
  delete state.precedingToolFailed
}

function setPrecedingToolState(sessions, sessionId, kind, failed) {
  const state = sessions.get(sessionId) ?? { userMessages: 0, lastSeen: Date.now() }
  state.precedingToolKind = kind
  if (failed === true) state.precedingToolFailed = true
  else delete state.precedingToolFailed
  state.lastSeen = Date.now()
  sessions.set(sessionId, state)
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
