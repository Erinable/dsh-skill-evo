import { createHash } from 'node:crypto'
import { createContentHash } from './events.js'
import type { CorrectionEpisode, CorrectionPattern, EpisodeDraft, RuntimeObservation, ToolAttempt } from './types.js'

export const CORRECTION_RULES_VERSION = 'rule-1'
export const CORRECTION_POLICY_VERSION = 'correction-policy-v1'
export interface CorrectionPolicy { readonly version: string; readonly minFailures: number; readonly minSessions: number; readonly windowDays: number; readonly maxAttemptsToSuccess: number; readonly allowedScopes: readonly string[] }
export const DEFAULT_CORRECTION_POLICY: CorrectionPolicy = { version: CORRECTION_POLICY_VERSION, minFailures: 2, minSessions: 3, windowDays: 30, maxAttemptsToSuccess: 20, allowedScopes: ['project', 'user'] }

export function correlateToolAttempts(events: readonly RuntimeObservation[]): ToolAttempt[] {
  const calls = new Map<string, RuntimeObservation>()
  const results = new Map<string, RuntimeObservation>()
  for (const event of events) {
    if (event.sessionId === undefined) continue
    if (event.kind === 'agent-step' && typeof event.payload.toolName === 'string') calls.set(event.id, event)
    if (event.kind === 'tool-result') for (const id of event.correlationIds) results.set(id, event)
  }
  const output: ToolAttempt[] = []
  for (const call of calls.values()) {
    const result = results.get(call.id)
    const payload = result?.payload ?? {}
    const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : undefined
    const failed = payload.failed === true || exitCode !== undefined && exitCode !== 0 || typeof payload.signal === 'string' || payload.timedOut === true
    const outcome = result === undefined ? 'unknown' : failed ? 'failure' : 'success'
    output.push({ sessionId: call.sessionId!, callObservationId: call.id, ...(result === undefined ? {} : { resultObservationId: result.id }), occurredAt: result?.occurredAt ?? call.occurredAt, toolName: String(call.payload.toolName), ...(typeof call.payload.command === 'string' ? { command: call.payload.command } : {}), argKeys: Array.isArray(call.payload.argKeys) ? call.payload.argKeys.filter((v): v is string => typeof v === 'string') : [], outcome, ...(exitCode === undefined ? {} : { exitCode }), ...(typeof payload.signal === 'string' ? { signal: payload.signal } : {}), ...(payload.timedOut === true ? { timedOut: true } : {}), ...(typeof payload.errorLine === 'string' ? { errorLine: payload.errorLine } : {}), ...(typeof call.payload.sessionSeq === 'number' ? { sessionSeq: call.payload.sessionSeq } : {}) })
  }
  return output.sort((a, b) => (a.sessionSeq ?? 0) - (b.sessionSeq ?? 0) || a.occurredAt.localeCompare(b.occurredAt) || a.callObservationId.localeCompare(b.callObservationId))
}

function intent(command: string): string {
  const part = command.split(/&&|\|\||[;|]/).at(-1)!.trim()
  const tokens = part.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  while (tokens.length && /^(?:[A-Za-z_][\w]*=.*|sudo|env|command|time)$/.test(tokens[0]!)) tokens.shift()
  if (!tokens.length) return ''
  const program = tokens.shift()!.replace(/^.*[\\/]/, '')
  const skip = new Set(['-C', '-c', '--prefix', '--context'])
  let arg: string | undefined
  for (const token of tokens) { if (skip.has(token)) { tokens.shift(); continue } if (!token.startsWith('-')) { arg = token; break } }
  return [program, arg && !arg.includes('=') ? arg : undefined].filter(Boolean).join(' ')
}

function normalizeError(attempt: ToolAttempt): string {
  let line = (attempt.errorLine ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  line = line.replace(/(['"]).*?\1/g, '<q>').replace(/\b\d{4}-\d\d-\d\d[T ][^ ]+/g, '<time>').replace(/\b[0-9a-f]{7,}\b/gi, '<hex>').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<uuid>').replace(/after \d+(?:\.\d+)? ms/g, 'after <n> ms')
  line = line.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^/\s]+)(?:[^\s]*)/gi, '$1://$2')
  return `exit:${attempt.exitCode ?? (attempt.signal ? `signal:${attempt.signal}` : 'unknown')}|${line}`.slice(0, 160)
}

function actions(failure: ToolAttempt, success: ToolAttempt, between: readonly ToolAttempt[]): string[] {
  const result = new Set<string>(); const f = failure.command ?? ''; const s = success.command ?? ''
  for (const token of s.split(/\s+/)) if (/^[A-Za-z_][\w]*=/.test(token) && !f.includes(token.split('=')[0]! + '=')) result.add(`set-env:${token.split('=')[0]!.toLowerCase()}`)
  for (const token of s.split(/\s+/)) if (token.startsWith('--') && !f.includes(token)) result.add(`flag:${token.split('=')[0]}`)
  for (const attempt of between) if (attempt.command) result.add(`run:${intent(attempt.command)}`)
  return [...result].sort()
}

export function recognizeCorrections(sessionId: string, attempts: readonly ToolAttempt[], policy: CorrectionPolicy = DEFAULT_CORRECTION_POLICY): EpisodeDraft[] {
  const result: EpisodeDraft[] = []
  const commandAttempts = attempts.filter(a => a.command && a.outcome !== 'unknown')
  for (let i = 0; i < commandAttempts.length; i++) {
    const first = commandAttempts[i]!; if (first.outcome !== 'failure') continue
    const key = intent(first.command!); if (!key) continue
    const failures = [first]; let j = i + 1
    while (j < commandAttempts.length && failures.length < policy.minFailures) { const a = commandAttempts[j]!; if (intent(a.command!) === key && a.outcome === 'failure') failures.push(a); j++ }
    if (failures.length < policy.minFailures) continue
    let successIndex = -1
    for (let k = j; k < Math.min(commandAttempts.length, j + policy.maxAttemptsToSuccess); k++) if (intent(commandAttempts[k]!.command!) === key && commandAttempts[k]!.outcome === 'success') { successIndex = k; break }
    if (successIndex < 0) continue
    const success = commandAttempts[successIndex]!; const correction = actions(failures.at(-1)!, success, commandAttempts.slice(j, successIndex))
    result.push({ intent: key, errorSignature: normalizeError(failures.at(-1)!), correction, failureObservationIds: failures.map(a => a.resultObservationId ?? a.callObservationId), correctionObservationIds: commandAttempts.slice(j, successIndex).map(a => a.resultObservationId ?? a.callObservationId), successObservationId: success.resultObservationId ?? success.callObservationId })
    i = successIndex
  }
  return result
}

export function inputHash(attempts: readonly ToolAttempt[]): string { return createHash('sha256').update(JSON.stringify(attempts)).digest('hex') }
export function episodeFromDraft(sessionId: string, draft: EpisodeDraft, attempts: readonly ToolAttempt[], events: readonly RuntimeObservation[], recognizerVersion = CORRECTION_RULES_VERSION, fallbackReason?: 'not-classified'): CorrectionEpisode {
  const first = draft.failureObservationIds[0]!; const referenced = new Set([...draft.failureObservationIds, ...draft.correctionObservationIds, draft.successObservationId]); const success = attempts.find(a => (a.resultObservationId ?? a.callObservationId) === draft.successObservationId)
  const loadedSkills = [...new Set(events.filter(e => e.sessionId === sessionId && e.kind === 'skill-loaded' && e.skill?.name).map(e => e.skill!.name))]
  const environmental = draft.correction.some(a => a.startsWith('set-env:') || /proxy/.test(a))
  return { ...draft, id: `episode:${sessionId}:${first}`, sessionId, ...(events.find(e => e.sessionId === sessionId && e.taskId)?.taskId ? { taskId: events.find(e => e.sessionId === sessionId)!.taskId } : {}), signatureKey: createContentHash(JSON.stringify([draft.intent, draft.errorSignature, draft.correction])), environmental, retryOnly: draft.correction.length === 0 || draft.correction.every(a => a === 'retry'), loadedSkills, occurredAt: success?.occurredAt ?? events.find(e => e.id === draft.successObservationId)?.occurredAt ?? new Date(0).toISOString(), recognizerVersion, ...(fallbackReason ? { fallbackReason } : {}), inputHash: inputHash(attempts), createdAt: events.find(e => e.id === first)?.occurredAt ?? new Date(0).toISOString(), ...(referenced.size === 0 ? {} : {}) }
}

export function groupPatterns(episodes: readonly CorrectionEpisode[], policy = DEFAULT_CORRECTION_POLICY): CorrectionPattern[] {
  const groups = new Map<string, CorrectionEpisode[]>(); for (const ep of episodes) groups.set(ep.signatureKey, [...groups.get(ep.signatureKey) ?? [], ep])
  return [...groups.values()].map(items => { const sorted = [...items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)); const first = sorted[0]!; const occurrences = sorted.map(ep => ({ episodeId: ep.id, sessionId: ep.sessionId, occurredAt: ep.occurredAt })); return { id: `pattern:${first.id}`, signatureKey: first.signatureKey, intent: first.intent, errorSignature: first.errorSignature, correction: first.correction, environmental: first.environmental, retryOnly: first.retryOnly, occurrences, totalSessionCount: new Set(occurrences.map(o => o.sessionId)).size, firstSeenAt: first.occurredAt, lastSeenAt: sorted.at(-1)!.occurredAt, policyVersion: policy.version } })
}

export function assessPattern(input: { pattern: CorrectionPattern; policy?: CorrectionPolicy; now: string; proposals?: readonly { skillName?: string; status: string; updatedAt?: string; source?: { kind?: string; patternId?: string } }[] }) {
  const policy = input.policy ?? DEFAULT_CORRECTION_POLICY; const sinceDate = new Date(input.now).getTime() - policy.windowDays * 86_400_000; const related = (input.proposals ?? []).filter(p => p.source?.patternId === input.pattern.id); const promoted = related.filter(p => p.status === 'promoted').sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]; const since = promoted?.updatedAt && new Date(promoted.updatedAt).getTime() > sinceDate ? promoted.updatedAt : new Date(sinceDate).toISOString(); const sessions = new Set(input.pattern.occurrences.filter(o => o.occurredAt >= since).map(o => o.sessionId)); const pending = related.find(p => !['rejected', 'rolled-back', 'reverted', 'promoted'].includes(p.status)); return { since, windowSessionCount: sessions.size, candidate: !input.pattern.retryOnly && pending === undefined && sessions.size >= policy.minSessions, ...(pending ? { blockedBy: { proposalId: pending.skillName ?? '', status: pending.status } } : {}), ...(promoted?.skillName ? { promotedSkill: promoted.skillName } : {}) }
}
