import { createHash } from 'node:crypto'
import { redactSensitiveText } from './events.js'
import { FEEDBACK_KINDS, FOLLOW_UP_INTENTS, type Attribution, type ClassificationMemoEntry, type FollowUpClassificationInput, type FollowUpIntent, type FollowUpResolution, type ObservationDigest, type RuntimeObservation } from './types.js'
export type { FollowUpResolution } from './types.js'

export const FOLLOW_UP_RULES_VERSION = 'follow-up-rules-v1'
export const INTENT_POLICY_VERSION = 'intent-policy-v1'

export function isFollowUpClassification(value: unknown): value is Pick<ClassificationMemoEntry, 'intent' | 'confidence' | 'rationale'> {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.intent === 'string' && row.intent !== 'other' && (FOLLOW_UP_INTENTS as readonly string[]).includes(row.intent)
    && typeof row.confidence === 'number' && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1
    && (row.rationale === undefined || typeof row.rationale === 'string')
}

export function isClassificationMemoEntry(value: unknown): value is ClassificationMemoEntry {
  if (typeof value === 'object' && value !== null && (value as Record<string, unknown>).judge === 'correction') {
    const row = value as Record<string, unknown>
    return typeof row.id === 'string' && typeof row.classifierVersion === 'string' && typeof row.inputHash === 'string' && row.id === `classification:correction:${row.classifierVersion}:${row.inputHash}` && typeof row.sessionId === 'string' && Array.isArray(row.drafts) && typeof row.createdAt === 'string'
  }
  if (!isFollowUpClassification(value)) return false
  const row = value as unknown as Record<string, unknown>
  return typeof row.classifierVersion === 'string' && typeof row.inputHash === 'string'
    && row.id === `classification:${row.classifierVersion}:${row.inputHash}`
    && typeof row.observationId === 'string' && typeof row.createdAt === 'string'
}

const boundary = (value: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}_])${value}(?=$|[^\\p{L}\\p{N}_])`, 'u')
const rules: Array<{ id: string; markers: string[]; intent: FollowUpIntent; confidence: number }> = [
  { id: 'empty', markers: [], intent: 'unknown', confidence: 0 },
  { id: 'correction', markers: ['不对', '错了', '不正确', '应该是', 'wrong', 'incorrect', 'should be', 'please correct'], intent: 'incorrect', confidence: 0.6 },
  { id: 'constraint', markers: ['还要', '别忘了', '必须', '不要', 'make sure', 'must', "don't"], intent: 'constraint', confidence: 0.5 },
  { id: 'retry', markers: ['再试', '重试', '重新来', 'try again', 'retry', 'redo'], intent: 'retry', confidence: 0.6 },
  { id: 'goal-changed', markers: ['换个话题', '另一个问题', '顺便问', 'by the way', 'new task'], intent: 'goal-changed', confidence: 0.6 },
]

function normalize(text: unknown): string { return typeof text === 'string' ? text.normalize('NFKC').toLocaleLowerCase().trim() : '' }
function matches(text: string, marker: string): boolean {
  if (/^[a-z]/i.test(marker)) return boundary(marker).test(text)
  return text.includes(marker)
}
function ruleFor(text: unknown): { id: string; intent: FollowUpIntent; confidence: number } {
  const normalized = normalize(text)
  if (normalized.length === 0) return rules[0]!
  for (const rule of rules.slice(1)) if (rule.markers.some(marker => matches(normalized, marker))) return rule
  if (/^(?:谢谢|好的|收到|ok|thanks|great)(?:[\s\p{P}]+)?$/u.test(normalized)) return { id: 'acknowledgement', intent: 'satisfied', confidence: 0.7 }
  if (/^(?:继续|接着|下一步|go on|continue|next)(?=$|[\s\p{P}])/u.test(normalized)) return { id: 'continue', intent: 'not-attributable', confidence: 0.6 }
  return { id: 'no-match', intent: 'unknown', confidence: 0.2 }
}

function attribution(value: unknown): value is Attribution {
  return value === 'routing' || value === 'content' || value === 'composition' || value === 'model' || value === 'tool' || value === 'task-change' || value === 'not-attributable' || value === 'unknown'
}
function digest(event: RuntimeObservation): ObservationDigest {
  const failed = event.payload.failed === true || event.kind === 'skill-load-failed' || (event.kind === 'tool-result' && event.payload.ok === false)
  return { kind: event.kind, ...(event.skill?.name === undefined ? {} : { skillName: event.skill.name }), ...(typeof event.payload.toolName === 'string' ? { toolName: event.payload.toolName } : {}), ...(failed ? { failed: true as const } : {}) }
}
export function classificationInputFor(events: readonly RuntimeObservation[], observationId: string): { input: FollowUpClassificationInput; pending: boolean; inputHash: string } {
  const index = events.findIndex(event => event.id === observationId)
  const event = events[index]
  if (event === undefined || event.kind !== 'user-follow-up') throw new Error(`unknown follow-up ${observationId}`)
  const session = events.filter(candidate => candidate.sessionId === event.sessionId)
  const position = session.findIndex(candidate => candidate.id === event.id)
  const before = session.slice(Math.max(0, position - 20), position).filter(candidate => candidate.kind !== 'user-follow-up').slice(-20).map(digest)
  const tail: RuntimeObservation[] = []
  let pending = true
  for (const candidate of session.slice(position + 1)) {
    if (candidate.kind === 'user-follow-up') { pending = false; break }
    if (candidate.kind === 'task-finished') { tail.push(candidate); pending = false; break }
    tail.push(candidate)
    if (tail.length >= 20) { pending = false; break }
  }
  if (session.length === position + 1) pending = true
  const loaded = session.slice(0, position).filter(candidate => candidate.kind === 'skill-loaded' && candidate.skill?.name !== undefined).map(candidate => candidate.skill!.name)
  const unique = [...new Set(loaded)]
  const input: FollowUpClassificationInput = { observationId, ...(typeof event.payload.text === 'string' ? { text: redactSensitiveText(event.payload.text) } : {}), ...(unique.length === 1 ? { skillName: unique[0] } : {}), before, after: tail.slice(0, 20).map(digest) }
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return { input, pending, inputHash }
}

export function resolveFollowUps(events: readonly RuntimeObservation[], options: { readonly memo?: ReadonlyMap<string, ClassificationMemoEntry>; readonly classifierVersion?: string } = {}): FollowUpResolution[] {
  const result: FollowUpResolution[] = []
  for (const event of events) {
    if (event.kind !== 'user-follow-up') continue
    const explicit = event.payload.explicit === true
    const eventIndex = events.indexOf(event)
    const loadedBefore = event.sessionId === undefined ? [] : events.slice(0, eventIndex)
      .filter(candidate => candidate.sessionId === event.sessionId && candidate.kind === 'skill-loaded' && candidate.skill !== undefined)
      .map(candidate => candidate.skill!.name)
    const uniqueLoadedBefore = [...new Set(loadedBefore)]
    const target = event.skill?.name ?? (uniqueLoadedBefore.length === 1 ? uniqueLoadedBefore[0] : undefined)
    const override = attribution(event.payload.attributionOverride) ? event.payload.attributionOverride : undefined
    let intent: FollowUpIntent; let confidence: number; let source: FollowUpResolution['source']; let version: string; let ruleId: string | undefined; let fallbackReason: FollowUpResolution['fallbackReason']; let inputHash: string | undefined
    if (explicit) { intent = (FEEDBACK_KINDS as readonly string[]).includes(String(event.payload.feedbackKind)) ? event.payload.feedbackKind as FollowUpIntent : 'other'; confidence = 1; source = 'explicit'; version = 'explicit' }
    else {
      const classified = classificationInputFor(events, event.id)
      inputHash = classified.inputHash
      const memo = options.memo?.get(`classification:${options.classifierVersion}:${inputHash}`)
      if (memo && !classified.pending) { intent = memo.intent; confidence = memo.confidence; source = 'classifier'; version = memo.classifierVersion }
      else { const rule = ruleFor(event.payload.text); intent = rule.intent; confidence = rule.confidence; source = 'rule'; version = FOLLOW_UP_RULES_VERSION; ruleId = rule.id; fallbackReason = options.classifierVersion ? 'not-classified' : 'no-classifier' }
    }
    const hasPayloadToolKind = Object.prototype.hasOwnProperty.call(event.payload, 'precedingToolKind')
    const hasPayloadToolFailed = Object.prototype.hasOwnProperty.call(event.payload, 'precedingToolFailed')
    let prior: RuntimeObservation | undefined
    if (event.sessionId !== undefined && !explicit && (!hasPayloadToolKind || !hasPayloadToolFailed)) {
      for (const candidate of events.slice(0, eventIndex).reverse()) {
        if (candidate.sessionId !== event.sessionId) continue
        if (candidate.kind === 'user-follow-up' && candidate.payload.explicit !== true) break
        if (['skill-load-requested', 'skill-loaded', 'skill-load-failed', 'tool-result'].includes(candidate.kind)) { prior = candidate; break }
      }
    }
    const toolKind = hasPayloadToolKind ? event.payload.precedingToolKind : prior?.kind
    const toolFailed = hasPayloadToolFailed ? event.payload.precedingToolFailed === true : prior?.kind === 'skill-load-failed' || (prior?.kind === 'tool-result' && prior.payload.failed === true)
    let resolvedAttribution: Attribution = override ?? (intent === 'incorrect' || intent === 'constraint' ? 'content' : intent === 'goal-changed' ? 'task-change' : intent === 'not-attributable' ? 'not-attributable' : 'unknown')
    let attributionSource: FollowUpResolution['attributionSource'] = override ? 'override' : 'intent'
    const evidence = [event.id]
    if (!explicit && !override && toolFailed && toolKind === 'skill-load-failed') { resolvedAttribution = 'composition'; attributionSource = 'tool'; evidence.push(prior?.id ?? '') }
    else if (!explicit && !override && toolFailed && toolKind === 'tool-result') { resolvedAttribution = 'tool'; attributionSource = 'tool'; evidence.push(prior?.id ?? ''); confidence = Math.min(confidence, 0.5) }
    result.push({ id: `follow-up:${event.id}`, observationId: event.id, ...(event.sessionId ? { sessionId: event.sessionId } : {}), ...(target ? { skillName: target } : {}), intent, confidence, source, version, ...(ruleId ? { ruleId } : {}), ...(fallbackReason ? { fallbackReason } : {}), ...(inputHash && source === 'classifier' ? { inputHash } : {}), attribution: resolvedAttribution, attributionSource, policyVersion: INTENT_POLICY_VERSION, evidenceEventIds: evidence.filter(Boolean) })
  }
  return result
}
