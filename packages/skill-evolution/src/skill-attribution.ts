import { createContentHash } from './events.js'
import type { RuntimeObservation } from './types.js'

export interface SkillWindow {
  readonly id: string
  readonly sessionId: string
  readonly skillName: string
  readonly contentHash?: string
  readonly startObservationId: string
  readonly endObservationId?: string
  readonly endReason: 'skill-loaded' | 'user-follow-up' | 'task-finished' | 'context-shadowed' | 'open'
  readonly endCertainty: 'observed' | 'uncertain'
  readonly stepObservationIds: readonly string[]
}

export interface StateShares { readonly none: number; readonly skills: Readonly<Record<string, number>> }
export interface SkillPosteriorParams { readonly stay: number; readonly enterOnLoad: number; readonly minShare: number; readonly uncoveredShare: number }
export interface PosteriorStep { readonly observationIds: readonly string[]; readonly shares: StateShares; readonly map: string | null; readonly alignment?: { readonly skillName: string; readonly skillStep: number } }
export interface SkillPosterior {
  readonly id: string; readonly sessionId: string
  readonly model: { readonly version: 'hmm-1'; readonly params: SkillPosteriorParams; readonly paramsHash: string }
  readonly emission: { readonly version: string; readonly source: 'rule' | 'judge'; readonly fallbackReason?: 'no-judge' | 'not-scored' | 'invalid-output'; readonly inputHash: string }
  readonly skills: readonly { readonly skillName: string; readonly contentHash?: string; readonly profile: 'ok' | 'missing' }[]
  readonly unknownPrefix: boolean; readonly steps: readonly PosteriorStep[]; readonly distribution: StateShares
  readonly windows: readonly { readonly windowId: string; readonly distribution: StateShares }[]; readonly createdAt: string
}
export interface FailureAttribution { readonly id: string; readonly subjectId: string; readonly origin: string; readonly sessionId?: string; readonly source: string; readonly shares: StateShares; readonly margin: number; readonly uncovered: boolean; readonly contributingStepIds: readonly string[]; readonly anchor: string; readonly posteriorId?: string }
export interface EmissionLookup { (sessionId: string, inputHash: string): { readonly version: string; readonly logRatios: readonly (readonly number[])[] } | undefined }

export const DEFAULT_POSTERIOR_PARAMS: SkillPosteriorParams = { stay: 0.9, enterOnLoad: 0.8, minShare: 0.1, uncoveredShare: 0.5 }

export function orderSessionObservations(observations: readonly RuntimeObservation[]): RuntimeObservation[] {
  return [...observations].sort((a, b) => {
    const as = numberPayload(a, 'sessionSeq'); const bs = numberPayload(b, 'sessionSeq')
    if (as !== undefined && bs !== undefined && as !== bs) return as - bs
    if (as !== undefined && bs === undefined) return -1
    if (as === undefined && bs !== undefined) return 1
    return a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)
  })
}

export function buildSkillWindows(observations: readonly RuntimeObservation[]): SkillWindow[] {
  const out: SkillWindow[] = []
  const sessions = new Map<string, RuntimeObservation[]>()
  for (const event of observations) if (event.sessionId) (sessions.get(event.sessionId) ?? (sessions.set(event.sessionId, []), sessions.get(event.sessionId)!)).push(event)
  for (const [sessionId, raw] of sessions) {
    const events = orderSessionObservations(raw)
    for (let i = 0; i < events.length; i++) {
      const load = events[i]
      if (load.kind !== 'skill-loaded' || load.skill === undefined) continue
      let end: RuntimeObservation | undefined
      for (let j = i + 1; j < events.length; j++) {
        const candidate = events[j]
        if (candidate.kind === 'skill-loaded' || candidate.kind === 'task-finished' || candidate.kind === 'context-shadowed' || (candidate.kind === 'user-follow-up' && !(candidate.payload.explicit === true && numberPayload(candidate, 'sessionSeq') === undefined))) {
          if (candidate.kind === 'context-shadowed' && !shadowsLoad(candidate, load)) continue
          end = candidate; break
        }
      }
      const endIndex = end === undefined ? events.length : events.indexOf(end)
      const steps = events.slice(i + 1, endIndex).filter(event => event.payload.surfaceReplace !== true).map(event => event.id)
      const endReason: SkillWindow['endReason'] = end === undefined ? 'open' : end.kind as SkillWindow['endReason']
      out.push({ id: `window:${load.id}`, sessionId, skillName: load.skill.name, ...(load.skill.contentHash === undefined ? {} : { contentHash: load.skill.contentHash }), startObservationId: load.id, ...(end === undefined ? {} : { endObservationId: end.id }), endReason, endCertainty: end === undefined || load.payload.shadowTracked !== true ? 'uncertain' : 'observed', stepObservationIds: steps })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function inferSkillAttribution(observations: readonly RuntimeObservation[], inputs: { readonly emissions?: EmissionLookup; readonly contents?: ReadonlyMap<string, string>; readonly params?: SkillPosteriorParams } = {}): { windows: SkillWindow[]; posteriors: SkillPosterior[]; attributions: FailureAttribution[] } {
  const params = inputs.params ?? DEFAULT_POSTERIOR_PARAMS
  const windows = buildSkillWindows(observations)
  const posteriors: SkillPosterior[] = []
  const sessions = new Map<string, RuntimeObservation[]>()
  for (const event of observations) if (event.sessionId) (sessions.get(event.sessionId) ?? (sessions.set(event.sessionId, []), sessions.get(event.sessionId)!)).push(event)
  for (const [sessionId, raw] of sessions) {
    const events = orderSessionObservations(raw)
    const sessionWindows = windows.filter(window => window.sessionId === sessionId)
    const skills = unique(sessionWindows.map(window => window.skillName))
    const steps = toolSteps(events)
    const unknownPrefix = numberPayload(events[0]!, 'sessionSeq') !== undefined && (numberPayload(events[0]!, 'sessionSeq') ?? 0) > 0
    const posteriorSteps = steps.map(step => {
      const eligible = sessionWindows.filter(window => window.stepObservationIds.includes(step.id)).map(window => window.skillName)
      const scores = new Map<string, number>([['none', 0]])
      for (const skill of eligible) scores.set(skill, scoreStep(step, skill, inputs.contents))
      const max = Math.max(...scores.values()); const exps = [...scores.entries()].map(([name, value]) => [name, Math.exp(value - max)] as const); const total = exps.reduce((sum, [, value]) => sum + value, 0)
      const shares: Record<string, number> = {}; let none = 0
      for (const [name, value] of exps) { const probability = round(value / total); if (name === 'none') none = probability; else shares[name] = probability }
      const map = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
      return { observationIds: step.ids, shares: { none, skills: shares }, map: map === 'none' ? null : map }
    })
    const distribution = averageShares(posteriorSteps.map(step => step.shares))
    const createdAt = events.at(-1)?.occurredAt ?? ''
    posteriors.push({ id: `posterior:${sessionId}`, sessionId, model: { version: 'hmm-1', params, paramsHash: createContentHash(JSON.stringify(params)) }, emission: { version: 'rule-1', source: 'rule', fallbackReason: 'no-judge', inputHash: createContentHash(JSON.stringify(steps.map(step => step.ids))) }, skills: skills.map(skillName => ({ skillName, profile: sessionWindows.find(window => window.skillName === skillName)?.contentHash && inputs.contents?.has(sessionWindows.find(window => window.skillName === skillName)!.contentHash!) ? 'ok' as const : 'missing' as const, ...(sessionWindows.find(window => window.skillName === skillName)?.contentHash === undefined ? {} : { contentHash: sessionWindows.find(window => window.skillName === skillName)!.contentHash }) })), unknownPrefix, steps: posteriorSteps, distribution, windows: sessionWindows.map(window => ({ windowId: window.id, distribution: averageShares(posteriorSteps.filter(step => window.stepObservationIds.some(id => step.observationIds.includes(id))).map(step => step.shares)) })), createdAt })
  }
  const attributions: FailureAttribution[] = []
  for (const event of observations) {
    if (event.sessionId === undefined || (event.kind !== 'user-follow-up' && event.kind !== 'skill-load-failed')) continue
    const posterior = posteriors.find(item => item.sessionId === event.sessionId)
    if (posterior === undefined) continue
    const shares = posterior.distribution
    const values = Object.entries(shares.skills).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const max = values[0]?.[1] ?? 0
    attributions.push({ id: `attribution:${event.id}`, subjectId: event.id, origin: event.kind === 'skill-load-failed' ? 'load-failure' : 'implicit-follow-up', sessionId: event.sessionId, source: 'posterior', shares, margin: Math.max(0, max - (values[1]?.[1] ?? shares.none)), uncovered: !posterior.unknownPrefix && shares.none >= params.uncoveredShare, contributingStepIds: posterior.steps.flatMap(step => step.observationIds), anchor: 'position', posteriorId: posterior.id })
  }
  return { windows, posteriors: posteriors.sort((a, b) => a.id.localeCompare(b.id)), attributions: attributions.sort((a, b) => a.id.localeCompare(b.id)) }
}

interface ToolStep { readonly id: string; readonly ids: readonly string[]; readonly command?: string; readonly toolName?: string }
function toolSteps(events: readonly RuntimeObservation[]): ToolStep[] { return events.filter(event => event.kind === 'agent-step' && (typeof event.payload.toolName === 'string' || typeof event.payload.command === 'string')).map(event => ({ id: event.id, ids: [event.id], ...(typeof event.payload.command === 'string' ? { command: event.payload.command } : {}), ...(typeof event.payload.toolName === 'string' ? { toolName: event.payload.toolName } : {}) })).filter(step => step.toolName !== 'skill' && !events.find(event => event.id === step.id)?.payload.surfaceReplace) }
function scoreStep(step: ToolStep, skill: string, contents?: ReadonlyMap<string, string>): number { const body = [...(contents?.values() ?? [])].find(value => value.toLowerCase().includes(skill.toLowerCase())) ?? ''; const command = step.command?.toLowerCase() ?? ''; return body && command && body.toLowerCase().includes(command.split(/\s+/)[0]!) ? 2 : command.includes(skill.toLowerCase().split('-')[0]!) ? 1 : command ? -0.5 : 0 }
function averageShares(values: readonly StateShares[]): StateShares { if (!values.length) return { none: 1, skills: {} }; const skills = new Set(values.flatMap(value => Object.keys(value.skills))); const out: Record<string, number> = {}; for (const skill of skills) out[skill] = round(values.reduce((sum, value) => sum + (value.skills[skill] ?? 0), 0) / values.length); return { none: round(values.reduce((sum, value) => sum + value.none, 0) / values.length), skills: out } }
function shadowsLoad(shadow: RuntimeObservation, load: RuntimeObservation): boolean { const seq = numberPayload(load, 'sessionSeq'); const ranges = shadow.payload.shadowedSeqRanges; return seq !== undefined && Array.isArray(ranges) && ranges.some(range => Array.isArray(range) && Number(range[0]) <= seq && seq <= Number(range[1])) }
function numberPayload(event: RuntimeObservation, key: string): number | undefined { const value = event.payload[key]; return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function unique(values: readonly string[]): string[] { return [...new Set(values)].sort() }
function round(value: number): number { return Math.round(value * 1e6) / 1e6 }
