import { createContentHash } from './events.js'
import { correlateToolAttempts } from './correction.js'
import type { RuntimeObservation, ToolAttempt } from './types.js'

export interface SkillWindow {
  readonly id: string
  readonly sessionId: string
  readonly skillName: string
  readonly contentHash?: string
  readonly startObservationId: string
  readonly endObservationId?: string
  readonly endReason:
    | 'skill-loaded'
    | 'user-follow-up'
    | 'task-finished'
    | 'context-shadowed'
    | 'open'
  readonly endCertainty: 'observed' | 'uncertain'
  readonly stepObservationIds: readonly string[]
}
export interface StateShares {
  readonly none: number
  readonly skills: Readonly<Record<string, number>>
}
export interface SkillPosteriorParams {
  readonly stay: number
  readonly enterOnLoad: number
  readonly minShare: number
  readonly uncoveredShare: number
}
export interface PosteriorStep {
  readonly observationIds: readonly string[]
  readonly shares: StateShares
  readonly map: string | null
  readonly alignment?: {
    readonly skillName: string
    readonly skillStep: number
  }
}
export interface SkillPosterior {
  readonly id: string
  readonly sessionId: string
  readonly model: {
    readonly version: 'hmm-1'
    readonly params: SkillPosteriorParams
    readonly paramsHash: string
  }
  readonly emission: {
    readonly version: string
    readonly source: 'rule' | 'judge'
    readonly fallbackReason?: 'no-judge' | 'not-scored' | 'invalid-output'
    readonly inputHash: string
  }
  readonly skills: readonly {
    readonly skillName: string
    readonly contentHash?: string
    readonly profile: 'ok' | 'missing'
  }[]
  readonly unknownPrefix: boolean
  readonly steps: readonly PosteriorStep[]
  readonly distribution: StateShares
  readonly windows: readonly {
    readonly windowId: string
    readonly distribution: StateShares
    readonly skippedSkillSteps?: readonly number[]
  }[]
  readonly createdAt: string
}
export interface FailureAttribution {
  readonly id: string
  readonly subjectId: string
  readonly origin: string
  readonly sessionId?: string
  readonly source: string
  readonly shares: StateShares
  readonly margin: number
  readonly uncovered: boolean
  readonly contributingStepIds: readonly string[]
  readonly anchor: 'tool-call' | 'step' | 'correlation' | 'position' | 'session'
  readonly anchorObservationId?: string
  readonly posteriorId?: string
}
export interface EmissionStep {
  readonly toolName: string
  readonly command?: string
  readonly argKeys: readonly string[]
  readonly outcome: 'failure' | 'success' | 'unknown'
  readonly exitCode?: number
  readonly errorLine?: string
}
export interface EmissionSkill {
  readonly skillName: string
  readonly contentHash?: string
  readonly content?: string
}
export interface EmissionInput {
  readonly sessionId: string
  readonly steps: readonly EmissionStep[]
  readonly skills: readonly EmissionSkill[]
}
export interface EmissionOutput {
  readonly logRatios: readonly (readonly number[])[]
  readonly alignment?: readonly {
    readonly stepIndex: number
    readonly skillName: string
    readonly skillStep: number
  }[]
}
export interface EmissionMemoEntry {
  readonly id: string
  readonly version: string
  readonly sessionId: string
  readonly inputHash: string
  readonly logRatios: readonly (readonly number[])[]
  readonly alignment?: readonly {
    readonly stepIndex: number
    readonly skillName: string
    readonly skillStep: number
  }[]
  readonly createdAt: string
}
export function isEmissionMemoEntry(
  value: unknown,
): value is EmissionMemoEntry {
  const item = value as Record<string, unknown> | null
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    typeof item.version === 'string' &&
    typeof item.sessionId === 'string' &&
    typeof item.inputHash === 'string' &&
    Array.isArray(item.logRatios) &&
    typeof item.createdAt === 'string'
  )
}
export interface SkillEmissionJudge {
  readonly version: string
  judge(input: EmissionInput, signal: AbortSignal): Promise<EmissionOutput>
}
export interface SkillContentSource {
  readonly id: string
  read(contentHash: string, skillName: string): Promise<string | undefined>
}
export interface EmissionLookup {
  (sessionId: string, inputHash: string): EmissionMemoEntry | undefined
}
export const DEFAULT_POSTERIOR_PARAMS: SkillPosteriorParams = {
  stay: 0.9,
  enterOnLoad: 0.8,
  minShare: 0.1,
  uncoveredShare: 0.5,
}
export function emissionInputHash(input: EmissionInput): string {
  return createContentHash(JSON.stringify(input))
}

export function orderSessionObservations(
  xs: readonly RuntimeObservation[],
): RuntimeObservation[] {
  return [...xs].sort((a, b) => {
    const as = num(a, 'sessionSeq'),
      bs = num(b, 'sessionSeq')
    if (as !== undefined && bs !== undefined && as !== bs) return as - bs
    if (as !== undefined && bs === undefined) return -1
    if (as === undefined && bs !== undefined) return 1
    return a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)
  })
}
export function buildSkillWindows(
  observations: readonly RuntimeObservation[],
): SkillWindow[] {
  const out: SkillWindow[] = []
  for (const [sessionId, raw] of sessions(observations)) {
    const es = orderSessionObservations(raw)
    for (let i = 0; i < es.length; i++) {
      const load = es[i]!
      if (load.kind !== 'skill-loaded' || !load.skill) continue
      let end: RuntimeObservation | undefined
      for (let j = i + 1; j < es.length; j++) {
        const e = es[j]!
        if (e.kind === 'context-shadowed' && !shadows(e, load)) continue
        if (
          e.kind === 'skill-loaded' ||
          e.kind === 'task-finished' ||
          e.kind === 'context-shadowed' ||
          (e.kind === 'user-follow-up' &&
            !(
              e.payload.explicit === true && num(e, 'sessionSeq') === undefined
            ))
        ) {
          end = e
          break
        }
      }
      const ei = end === undefined ? es.length : es.indexOf(end)
      out.push({
        id: `window:${load.id}`,
        sessionId,
        skillName: load.skill.name,
        ...(load.skill.contentHash === undefined
          ? {}
          : { contentHash: load.skill.contentHash }),
        startObservationId: load.id,
        ...(end === undefined ? {} : { endObservationId: end.id }),
        endReason:
          end === undefined ? 'open' : (end.kind as SkillWindow['endReason']),
        endCertainty:
          end === undefined || load.payload.shadowTracked !== true
            ? 'uncertain'
            : 'observed',
        stepObservationIds: es
          .slice(i + 1, ei)
          .filter((e) => e.payload.surfaceReplace !== true)
          .map((e) => e.id),
      })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function inferSkillAttribution(
  observations: readonly RuntimeObservation[],
  inputs: {
    readonly emissions?: EmissionLookup
    readonly contents?: ReadonlyMap<string, string>
    readonly params?: SkillPosteriorParams
    readonly emissionVersion?: string
  } = {},
): {
  windows: SkillWindow[]
  posteriors: SkillPosterior[]
  attributions: FailureAttribution[]
} {
  const p = inputs.params ?? DEFAULT_POSTERIOR_PARAMS,
    windows = buildSkillWindows(observations),
    posteriors: SkillPosterior[] = []
  for (const [sessionId, raw] of sessions(observations)) {
    const es = orderSessionObservations(raw),
      sw = windows.filter((w) => w.sessionId === sessionId),
      attempts = correlateToolAttempts(es).filter(
        (a) =>
          a.toolName !== 'skill' &&
          !es.find((e) => e.id === a.callObservationId)?.payload.surfaceReplace,
      ),
      names = [...new Set(sw.map((w) => w.skillName))],
      ints = qualification(es),
      unknownPrefix = (num(es[0]!, 'sessionSeq') ?? 0) > 0,
      stepsIn = attempts.map(toEmissionStep),
      input = makeEmissionInput(sessionId, stepsIn, sw, inputs.contents),
      inputHash = emissionInputHash(input),
      memo = inputs.emissions?.(sessionId, inputHash),
      rule = ruleEmission(stepsIn, sw, inputs.contents)
    let matrix = memo?.logRatios ?? rule.logRatios
    let source: 'rule' | 'judge' = memo ? 'judge' : 'rule',
      fallbackReason: SkillPosterior['emission']['fallbackReason'] = memo
        ? undefined
        : inputs.emissionVersion === undefined
          ? 'no-judge'
          : 'not-scored'
    if (
      !valid(matrix, attempts.length, names.length) ||
      memo?.alignment?.some(
        (item) =>
          item.stepIndex < 0 ||
          item.stepIndex >= attempts.length ||
          !names.includes(item.skillName) ||
          !Number.isInteger(item.skillStep) ||
          item.skillStep < 1,
      )
    ) {
      matrix = rule.logRatios
      source = 'rule'
      fallbackReason = 'invalid-output'
    }
    const marg = forwardBackward(attempts, es, names, ints, matrix, p),
      steps = marg.map((shares, i) => {
        const map = Object.entries({
          ...shares.skills,
          none: shares.none,
        }).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
        return {
          observationIds: [
            attempts[i]!.callObservationId,
            ...(attempts[i]!.resultObservationId
              ? [attempts[i]!.resultObservationId!]
              : []),
          ],
          shares,
          map: map === 'none' ? null : map,
        }
      }),
      skills = names.map((skillName) => {
        const w = sw.find((x) => x.skillName === skillName)
        return {
          skillName,
          ...(w?.contentHash === undefined
            ? {}
            : { contentHash: w.contentHash }),
          profile:
            w?.contentHash !== undefined && inputs.contents?.has(w.contentHash)
              ? ('ok' as const)
              : ('missing' as const),
        }
      })
    posteriors.push({
      id: `posterior:${sessionId}`,
      sessionId,
      model: {
        version: 'hmm-1',
        params: p,
        paramsHash: createContentHash(JSON.stringify(p)),
      },
      emission: {
        version: memo?.version ?? 'rule-1',
        source,
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
        inputHash,
      },
      skills,
      unknownPrefix,
      steps,
      distribution: average(steps.map((s) => s.shares)),
      windows: sw.map((w) => ({
        windowId: w.id,
        distribution: average(
          steps
            .filter((s) =>
              w.stepObservationIds.some((id) => s.observationIds.includes(id)),
            )
            .map((s) => s.shares),
        ),
        ...(memo?.alignment === undefined
          ? {}
          : { skippedSkillSteps: skippedSteps(memo.alignment, w.skillName) }),
      })),
      createdAt: es.at(-1)?.occurredAt ?? '',
    })
  }
  const attributions: FailureAttribution[] = []
  for (const e of observations)
    if (
      e.sessionId &&
      (e.kind === 'user-follow-up' || e.kind === 'skill-load-failed')
    ) {
      const po = posteriors.find((x) => x.sessionId === e.sessionId)
      if (!po) continue
      const vals = Object.entries(po.distribution.skills).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        ),
        top = vals[0]?.[1] ?? 0
      attributions.push({
        id: `attribution:${e.id}`,
        subjectId: e.id,
        origin:
          e.kind === 'skill-load-failed'
            ? 'load-failure'
            : 'implicit-follow-up',
        sessionId: e.sessionId,
        source: 'posterior',
        shares: po.distribution,
        margin: top - (vals[1]?.[1] ?? po.distribution.none),
        uncovered:
          !po.unknownPrefix && po.distribution.none >= p.uncoveredShare,
        contributingStepIds: po.steps.flatMap((s) => s.observationIds),
        anchor: 'position',
        posteriorId: po.id,
      })
    }
  return {
    windows,
    posteriors: posteriors.sort((a, b) => a.id.localeCompare(b.id)),
    attributions: attributions.sort((a, b) => a.id.localeCompare(b.id)),
  }
}
function sessions(
  es: readonly RuntimeObservation[],
): Map<string, RuntimeObservation[]> {
  const m = new Map<string, RuntimeObservation[]>()
  for (const e of es)
    if (e.sessionId) m.set(e.sessionId, [...(m.get(e.sessionId) ?? []), e])
  return m
}
function num(e: RuntimeObservation, key: string): number | undefined {
  const v = e.payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function shadows(s: RuntimeObservation, l: RuntimeObservation): boolean {
  const n = num(l, 'sessionSeq'),
    r = s.payload.shadowedSeqRanges
  return (
    n !== undefined &&
    Array.isArray(r) &&
    r.some((x) => Array.isArray(x) && Number(x[0]) <= n && n <= Number(x[1]))
  )
}
function qualification(
  es: readonly RuntimeObservation[],
): { skillName: string; start: number; end: number }[] {
  const out: { skillName: string; start: number; end: number }[] = []
  for (let i = 0; i < es.length; i++) {
    const l = es[i]!
    if (l.kind !== 'skill-loaded' || !l.skill) continue
    let end = es.length
    for (let j = i + 1; j < es.length; j++) {
      const e = es[j]!
      if (
        (e.kind === 'context-shadowed' && shadows(e, l)) ||
        (e.kind === 'skill-loaded' && l.payload.shadowTracked === true)
      ) {
        end = j
        break
      }
    }
    out.push({ skillName: l.skill.name, start: i, end })
  }
  return out
}
function toEmissionStep(a: ToolAttempt): EmissionStep {
  return {
    toolName: a.toolName,
    ...(a.command === undefined ? {} : { command: a.command }),
    argKeys: a.argKeys,
    outcome: a.outcome,
    ...(a.exitCode === undefined ? {} : { exitCode: a.exitCode }),
    ...(a.errorLine === undefined ? {} : { errorLine: a.errorLine }),
  }
}
export function makeEmissionInput(
  sessionId: string,
  steps: readonly EmissionStep[],
  windows: readonly SkillWindow[],
  contents?: ReadonlyMap<string, string>,
): EmissionInput {
  return {
    sessionId,
    steps,
    skills: [
      ...new Map(
        windows.map((window) => [
          window.skillName,
          {
            skillName: window.skillName,
            ...(window.contentHash === undefined
              ? {}
              : { contentHash: window.contentHash }),
            ...(window.contentHash === undefined ||
            contents?.get(window.contentHash) === undefined
              ? {}
              : { content: contents.get(window.contentHash) }),
          },
        ]),
      ).values(),
    ],
  }
}
function ruleEmission(
  steps: readonly EmissionStep[],
  ws: readonly SkillWindow[],
  contents?: ReadonlyMap<string, string>,
): { logRatios: number[][] } {
  const unique = [...new Map(ws.map((w) => [w.skillName, w])).values()]
  return {
    logRatios: steps.map((s) =>
      unique.map((w) =>
        score(
          s,
          w.skillName,
          w.contentHash ? contents?.get(w.contentHash) : undefined,
        ),
      ),
    ),
  }
}
function score(s: EmissionStep, name: string, content?: string): number {
  if (!content) return 0
  const t = content.toLowerCase(),
    c = s.command?.toLowerCase()
  if (!c) return t.includes(s.toolName.toLowerCase()) ? 1 : 0
  const intent = c
    .split(/&&|\|\||[;|]/)
    .at(-1)!
    .trim()
    .split(/\s+/)[0]!
    .replace(/^.*\//, '')
  if (
    t.includes(c) ||
    (t.includes(intent) &&
      (t.includes(name.toLowerCase()) || t.includes('skill')))
  )
    return 2
  if (t.includes(intent)) return 1
  return -0.5
}
function valid(
  m: readonly (readonly number[])[],
  r: number,
  c: number,
): boolean {
  return (
    m.length === r && m.every((x) => x.length === c && x.every(Number.isFinite))
  )
}
function skippedSteps(
  alignment: readonly {
    readonly skillName: string
    readonly skillStep: number
  }[],
  skillName: string,
): number[] {
  const values = alignment
    .filter((item) => item.skillName === skillName)
    .map((item) => item.skillStep)
  const max = Math.max(0, ...values)
  const present = new Set(values)
  return Array.from({ length: max }, (_, index) => index + 1).filter(
    (step) => !present.has(step),
  )
}
function clamp(value: number): number {
  return Math.max(-10, Math.min(10, value))
}
function transition(
  from: string,
  to: string,
  states: readonly string[],
  params: SkillPosteriorParams,
): number {
  if (from === 'none' && to !== 'none')
    return (1 - params.stay) / Math.max(1, states.length - 1)
  if (from === 'none' && to === 'none')
    return states.length > 1 ? params.stay : 1
  return from === to
    ? params.stay
    : (1 - params.stay) / Math.max(1, states.length - 1)
}
function forwardBackward(
  attempts: readonly ToolAttempt[],
  es: readonly RuntimeObservation[],
  names: readonly string[],
  ints: readonly { skillName: string; start: number; end: number }[],
  matrix: readonly (readonly number[])[],
  p: SkillPosteriorParams,
): StateShares[] {
  const n = attempts.length
  if (!n) return []
  const states = (i: number) => [
    'none',
    ...names.filter((name) =>
      ints.some(
        (x) =>
          x.skillName === name &&
          es.findIndex((e) => e.id === attempts[i]!.callObservationId) >
            x.start &&
          es.findIndex((e) => e.id === attempts[i]!.callObservationId) < x.end,
      ),
    ),
  ]
  const a: Record<string, number>[] = []
  const stateSets = attempts.map((_, i) => states(i))
  for (let i = 0; i < n; i++) {
    const s = stateSets[i]!,
      prev = a[i - 1],
      cur: Record<string, number> = {}
    for (const k of s) {
      const prior =
        i === 0
          ? s.length === 1
            ? 1
            : k === 'none'
              ? 1 - p.enterOnLoad
              : p.enterOnLoad / (s.length - 1)
          : Object.entries(prev ?? {}).reduce(
              (sum, [from, value]) => sum + value * transition(from, k, s, p),
              0,
            )
      cur[k] =
        Math.exp(k === 'none' ? 0 : clamp(matrix[i]?.[names.indexOf(k)] ?? 0)) *
        prior
    }
    const z = Object.values(cur).reduce((x, y) => x + y, 0) || 1
    for (const k of Object.keys(cur)) cur[k] /= z
    a.push(cur)
  }
  const beta: Record<string, number>[] = Array.from({ length: n }, () => ({}))
  beta[n - 1] = Object.fromEntries(stateSets[n - 1]!.map((state) => [state, 1]))
  for (let i = n - 2; i >= 0; i--) {
    const next = stateSets[i + 1]!
    beta[i] = normalizeBeta(
      Object.fromEntries(
        stateSets[i]!.map((from) => [
          from,
          next.reduce(
            (sum, to) =>
              sum +
              transition(from, to, next, p) *
                (beta[i + 1]![to] ?? 0) *
                Math.exp(
                  to === 'none'
                    ? 0
                    : clamp(matrix[i + 1]?.[names.indexOf(to)] ?? 0),
                ),
            0,
          ),
        ]),
      ),
    )
  }
  const out: Array<StateShares> = []
  for (let i = 0; i < n; i++) {
    const s = stateSets[i]!,
      v = s.map((k) => (a[i]![k] ?? 0) * (beta[i]![k] ?? 1)),
      z = v.reduce((x, y) => x + y, 0) || 1
    const skills: Record<string, number> = {}
    let none = 0
    s.forEach((k, j) => {
      const q = round(v[j]! / z)
      if (k === 'none') none = q
      else skills[k] = q
    })
    out.push({ none, skills })
  }
  return out
}
function average(v: readonly StateShares[]): StateShares {
  if (!v.length) return { none: 1, skills: {} }
  const ns = new Set(v.flatMap((x) => Object.keys(x.skills))),
    skills: Record<string, number> = {}
  for (const n of ns)
    skills[n] = round(v.reduce((s, x) => s + (x.skills[n] ?? 0), 0) / v.length)
  return { none: round(v.reduce((s, x) => s + x.none, 0) / v.length), skills }
}
function normalizeBeta(values: Record<string, number>): Record<string, number> {
  const total =
    Object.values(values).reduce((sum, value) => sum + value, 0) || 1
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value / total]),
  )
}
function round(v: number): number {
  return Math.round(v * 1e6) / 1e6
}
