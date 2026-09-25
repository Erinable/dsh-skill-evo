import type {
  Attribution,
  Experience,
  ExperienceOutcome,
  FailureCluster,
  FailureSeverity,
  FailureStatus,
  RuntimeObservation,
  SkillRef,
  SkillDiagnosis,
  SkillFailureCase,
} from './types.js'

export interface ExperienceProjectionOptions {
  readonly now?: string
  readonly taskCluster?: (event: RuntimeObservation) => string
}

/** Compress one session's observations into a reviewable, evidence-linked experience. */
export function buildExperiences(
  events: readonly RuntimeObservation[],
  options: ExperienceProjectionOptions = {},
): Experience[] {
  const loadedBySession = loadedSkillsBySession(events)
  const groups = new Map<string, RuntimeObservation[]>()
  for (const originalEvent of events) {
    if (originalEvent.sessionId === undefined || !isExperienceEvent(originalEvent)) continue
    const event = withAttribution(originalEvent, loadedBySession)
    const loaded = loadedBySession.get(originalEvent.sessionId) ?? []
    const attributable = event.skill?.name
    if (attributable === undefined && !(event.kind === 'user-follow-up' || event.kind === 'task-finished') ) continue
    const key = `${event.sessionId}\u0000${attributable ?? (loaded.length > 1 ? 'unattributed' : 'unknown')}`
    if (attributable === undefined && loaded.length <= 1) continue
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }

  for (const [sessionId, loaded] of loadedBySession) {
    if (loaded.length <= 1) continue
    const key = `${sessionId}\u0000unattributed`
    const group = groups.get(key)
    if (group === undefined) continue
    const loadedEvents = events.filter(event => event.sessionId === sessionId && event.kind === 'skill-loaded')
    groups.set(key, [...loadedEvents, ...group.filter(event => !loadedEvents.some(loadedEvent => loadedEvent.id === event.id))])
  }

  return [...groups.entries()].map(([key, group]) => {
    const first = group[0]!
    const followUp = group.find(event => event.kind === 'user-follow-up')
    const failed = group.some(event => event.kind === 'skill-load-failed')
    const finished = group.find(event => event.kind === 'task-finished')
    const outcome = outcomeFor(group)
    const contextSummary = textPayload(followUp) ?? textPayload(first) ?? `session ${first.sessionId}`
    const versions = unique([
      ...group.flatMap(event => event.skill?.contentHash === undefined ? [] : [event.skill.contentHash]),
      ...loadedBySession.get(first.sessionId ?? '')?.flatMap(skill => skill.contentHash === undefined ? [] : [skill.contentHash]) ?? [],
    ])
    const evidenceEventIds = unique(group.map(event => event.id))
    const taskCluster = options.taskCluster?.(first) ?? first.taskId ?? first.sessionId ?? 'unknown'
    return {
      id: `experience:${key}`,
      taskCluster,
      contextSummary,
      relevantSkillVersions: versions,
      observedPattern: describePattern(group),
      evidenceEventIds,
      outcome,
      attribution: attributionFor(group),
      confidence: confidenceFor(group),
      createdAt: options.now ?? first.occurredAt,
    }
  })
}

/** Convert explicit load failures and unambiguous follow-ups into failure cases. */
export function buildFailureCases(events: readonly RuntimeObservation[]): SkillFailureCase[] {
  const loadedBySession = new Map<string, Set<string>>()
  for (const event of events) {
    if (event.kind === 'skill-loaded' && event.sessionId !== undefined && event.skill !== undefined) {
      const skills = loadedBySession.get(event.sessionId) ?? new Set<string>()
      skills.add(event.skill.name)
      loadedBySession.set(event.sessionId, skills)
    }
  }

  const cases: SkillFailureCase[] = []
  for (const event of events) {
    if (event.kind === 'user-follow-up' && event.payload.explicit === true && event.skill !== undefined) {
      const feedbackKind = event.payload.feedbackKind
      if (feedbackKind === 'satisfied') continue
      cases.push({
        id: `failure:${event.id}`,
        skillName: event.skill.name,
        task: taskText(event),
        failure: textPayload(event) ?? `Explicit feedback: ${String(feedbackKind ?? 'other')}`,
        evidenceEventIds: [event.id],
        severity: feedbackKind === 'incorrect' ? 'high' : feedbackKind === 'dissatisfied' || feedbackKind === 'retry' ? 'medium' : 'low',
        createdAt: event.occurredAt,
        status: 'open',
      })
      continue
    }
    if (event.kind === 'skill-load-failed' && event.skill !== undefined) {
      cases.push({
        id: `failure:${event.id}`,
        skillName: event.skill.name,
        ...(event.skill.contentHash === undefined ? {} : { skillVersion: event.skill.contentHash }),
        task: taskText(event),
        failure: textPayload(event) ?? 'Skill load failed',
        evidenceEventIds: [event.id, ...event.correlationIds],
        severity: 'high',
        createdAt: event.occurredAt,
        status: 'open',
      })
      continue
    }

    if (event.kind === 'user-follow-up' && event.sessionId !== undefined) {
      const skills = [...loadedBySession.get(event.sessionId) ?? []]
      if (skills.length !== 1) continue
      cases.push({
        id: `failure:${event.id}`,
        skillName: skills[0]!,
        task: taskText(event),
        failure: textPayload(event) ?? 'User follow-up after Skill use',
        evidenceEventIds: [event.id],
        severity: 'medium',
        createdAt: event.occurredAt,
        status: 'open',
      })
    }
  }
  return cases
}

export interface FailureClusterOptions {
  readonly similarity?: number
  readonly now?: string
}

/** Group same-Skill failures by token similarity while retaining every case ID. */
export function clusterFailureCases(
  cases: readonly SkillFailureCase[],
  options: FailureClusterOptions = {},
): FailureCluster[] {
  const threshold = options.similarity ?? 0.6
  const clusters: Array<{ skillName: string; signature: string; cases: SkillFailureCase[] }> = []
  for (const failure of cases) {
    const tokens = tokenSet(failure.failure)
    const existing = clusters.find(cluster => cluster.skillName === failure.skillName
      && similarity(tokens, tokenSet(cluster.signature)) >= threshold)
    if (existing === undefined) {
      clusters.push({ skillName: failure.skillName, signature: failure.failure, cases: [failure] })
    } else {
      existing.cases.push(failure)
      if (failure.failure.length > existing.signature.length) existing.signature = failure.failure
    }
  }
  return clusters.map(cluster => ({
    id: `cluster:${cluster.skillName}:${signatureOf(cluster.signature)}`,
    skillName: cluster.skillName,
    signature: cluster.signature,
    caseIds: cluster.cases.map(failure => failure.id),
    occurrenceCount: cluster.cases.length,
    createdAt: options.now ?? cluster.cases[0]!.createdAt,
    status: 'open',
  }))
}

/** Produce a conservative diagnosis; uncertain and non-Skill causes remain first-class. */
export function diagnoseFailureCluster(
  cluster: FailureCluster,
  cases: readonly SkillFailureCase[],
  experiences: readonly Experience[] = [],
  now = new Date().toISOString(),
): SkillDiagnosis {
  const selected = cases.filter(failure => cluster.caseIds.includes(failure.id))
  const hasLoadFailure = selected.some(failure => failure.failure.toLowerCase().includes('load'))
  const hasFollowUp = selected.some(failure => failure.failure.toLowerCase().includes('follow-up'))
  const rootCause = hasLoadFailure ? 'composition' : hasFollowUp ? 'content' : 'uncertain'
  const proposedOperation = rootCause === 'content' ? 'patch-content' : rootCause === 'composition' ? 'edit-metadata' : 'observe-only'
  const supportingExperienceIds = experiences
    .filter(experience => experience.evidenceEventIds.some(id => selected.some(failure => failure.evidenceEventIds.includes(id))))
    .map(experience => experience.id)
  return {
    id: `diagnosis:${cluster.id}`,
    clusterId: cluster.id,
    rootCause,
    hypothesis: rootCause === 'content'
      ? 'The loaded Skill was followed by a user correction; inspect its procedure and completion boundaries.'
      : rootCause === 'composition'
        ? 'The Skill could not be loaded; inspect catalog visibility, provider composition, and loader availability.'
        : 'The available evidence does not isolate a Skill-owned cause yet.',
    supportingExperienceIds,
    counterEvidence: [],
    proposedOperation,
    confidence: rootCause === 'uncertain' ? 'low' : cluster.occurrenceCount >= 2 ? 'medium' : 'low',
    createdAt: now,
  }
}

function isExperienceEvent(event: RuntimeObservation): boolean {
  return event.kind === 'skill-load-requested'
    || event.kind === 'skill-loaded'
    || event.kind === 'skill-load-failed'
    || event.kind === 'user-follow-up'
    || event.kind === 'task-finished'
}

function loadedSkillsBySession(events: readonly RuntimeObservation[]): Map<string, SkillRef[]> {
  const loaded = new Map<string, SkillRef[]>()
  for (const event of events) {
    if (event.kind !== 'skill-loaded' || event.sessionId === undefined || event.skill === undefined) continue
    const skills = loaded.get(event.sessionId) ?? []
    if (!skills.some(skill => skill.name === event.skill!.name && skill.contentHash === event.skill!.contentHash)) skills.push(event.skill)
    loaded.set(event.sessionId, skills)
  }
  return loaded
}

function withAttribution(event: RuntimeObservation, loaded: Map<string, SkillRef[]>): RuntimeObservation {
  if (event.skill !== undefined || event.sessionId === undefined) return event
  const skills = loaded.get(event.sessionId) ?? []
  if (skills.length !== 1) return event
  return { ...event, skill: skills[0] }
}

function outcomeFor(events: readonly RuntimeObservation[]): ExperienceOutcome {
  const finished = events.find(event => event.kind === 'task-finished')
  const value = finished?.payload.outcome
  if (value === 'success' || value === 'helpful' || value === 'completed') return 'helpful'
  if (value === 'failure' || value === 'harmful' || value === 'regressed') return 'harmful'
  if (events.some(event => event.kind === 'skill-load-failed')) return 'harmful'
  return 'unknown'
}

function attributionFor(events: readonly RuntimeObservation[]): Attribution {
  const override = events.find(event => isAttribution(event.payload.attributionOverride))?.payload.attributionOverride
  if (isAttribution(override)) return override
  if (events.some(event => event.kind === 'skill-load-failed')) return 'composition'
  if (events.some(event => event.kind === 'user-follow-up')
    && new Set(events.flatMap(event => event.skill?.name === undefined ? [] : [event.skill.name])).size > 1) return 'not-attributable'
  if (events.every(event => event.skill === undefined)) return 'not-attributable'
  if (events.some(event => event.kind === 'user-follow-up')) return 'unknown'
  return 'unknown'
}

function isAttribution(value: unknown): value is Attribution {
  return value === 'routing' || value === 'content' || value === 'composition' || value === 'model'
    || value === 'tool' || value === 'task-change' || value === 'not-attributable' || value === 'unknown'
}

function confidenceFor(events: readonly RuntimeObservation[]): number {
  if (events.some(event => event.kind === 'task-finished')) return 0.5
  if (events.some(event => event.kind === 'user-follow-up')) return 0.35
  return 0.2
}

function describePattern(events: readonly RuntimeObservation[]): string {
  return events.map(event => event.kind).join(' → ')
}

function taskText(event: RuntimeObservation): string {
  return typeof event.payload.taskSummary === 'string'
    ? event.payload.taskSummary
    : event.taskId ?? event.sessionId ?? 'unknown task'
}

function textPayload(event: RuntimeObservation | undefined): string | undefined {
  const text = event?.payload.text
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(token => token.length > 1))
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return left.size === right.size ? 1 : 0
  const intersection = [...left].filter(token => right.has(token)).length
  return intersection / new Set([...left, ...right]).size
}

function signatureOf(value: string): string {
  return [...tokenSet(value)].sort().join('-') || 'unknown'
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
