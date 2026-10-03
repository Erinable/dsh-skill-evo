import type { DecisionRecord, RuntimeObservation, SkillProposal, FollowUpResolution } from './types.js'
import { latestProposalsByRoot, proposalRootId } from './proposal.js'

export interface SkillUsageMetric {
  readonly skillName: string
  readonly exposed: number
  readonly loadRequested: number
  readonly loadSucceeded: number
  readonly loadFailed: number
  readonly followUps: number
  readonly exposureToLoadRate: number
  readonly loadFailureRate: number
  readonly followUpRate: number
  readonly followUpIntents: Readonly<Record<'explicit' | 'classifier' | 'rule', { readonly total: number; readonly failures: number; readonly byIntent: Readonly<Record<string, number>> }>>
}

export interface EvolutionMetrics {
  readonly observations: number
  readonly sessions: number
  readonly skills: readonly SkillUsageMetric[]
  readonly proposals: { readonly total: number; readonly promoted: number; readonly rejected: number; readonly rolledBack: number }
  readonly contextCost: number
  readonly followUpIntents: Readonly<Record<'explicit' | 'classifier' | 'rule', Readonly<Record<string, number>>>>
  readonly followUpFailures: number
}

/** Aggregate exportable operational metrics without assigning causal credit. */
export function aggregateMetrics(
  events: readonly RuntimeObservation[],
  proposals: readonly SkillProposal[] = [],
  decisions: readonly DecisionRecord[] = [],
  resolutions: readonly FollowUpResolution[] = [],
): EvolutionMetrics {
  const bySkill = new Map<string, { exposed: Set<string>; requested: Set<string>; succeeded: Set<string>; failed: Set<string>; followUps: Set<string>; resolutions: FollowUpResolution[] }>()
  const sessions = new Set<string>()
  const followUpIntents = { explicit: {} as Record<string, number>, classifier: {} as Record<string, number>, rule: {} as Record<string, number> }
  let contextCost = 0
  for (const event of events) {
    if (event.sessionId !== undefined) sessions.add(event.sessionId)
    const name = event.skill?.name
    if (name === undefined) continue
    const metric = bySkill.get(name) ?? { exposed: new Set(), requested: new Set(), succeeded: new Set(), failed: new Set(), followUps: new Set(), resolutions: [] }
    if (event.sessionId !== undefined) {
      if (event.kind === 'catalog-visible') metric.exposed.add(event.sessionId)
      if (event.kind === 'skill-load-requested') metric.requested.add(event.sessionId)
      if (event.kind === 'skill-loaded') metric.succeeded.add(event.sessionId)
      if (event.kind === 'skill-load-failed') metric.failed.add(event.sessionId)
      if (event.kind === 'user-follow-up') metric.followUps.add(event.sessionId)
    }
    const tokens = event.payload.inputTokens
    if (typeof tokens === 'number' && Number.isFinite(tokens)) contextCost += tokens
    bySkill.set(name, metric)
  }
  for (const resolution of resolutions) {
    if (resolution.skillName === undefined) continue
    const metric = bySkill.get(resolution.skillName) ?? { exposed: new Set(), requested: new Set(), succeeded: new Set(), failed: new Set(), followUps: new Set(), resolutions: [] }
    metric.resolutions.push(resolution)
    bySkill.set(resolution.skillName, metric)
  }
  for (const resolution of resolutions) {
    const source = followUpIntents[resolution.source]
    source[resolution.intent] = (source[resolution.intent] ?? 0) + 1
  }
  const followUpFailures = resolutions.filter(item => ['incorrect', 'constraint', 'retry', 'dissatisfied', 'other'].includes(item.intent)).length
  const skills = [...bySkill.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([skillName, metric]) => ({
    skillName,
    exposed: metric.exposed.size,
    loadRequested: metric.requested.size,
    loadSucceeded: metric.succeeded.size,
    loadFailed: metric.failed.size,
    followUps: metric.followUps.size,
    exposureToLoadRate: rate(metric.requested.size, metric.exposed.size),
    loadFailureRate: rate(metric.failed.size, metric.requested.size),
    followUpRate: rate(metric.followUps.size, metric.succeeded.size),
    followUpIntents: intentMetrics(metric.resolutions),
  }))
  const latestProposals = latestProposalsByRoot(proposals)
  const promoted = decisionKeys(decisions, 'promoted', 'promoted')
  const rejected = decisionKeys(decisions, 'rejected', 'rejected')
  const rolledBack = decisionKeys(decisions, 'rolled-back', 'rollback', 'reverted')
  return {
    observations: events.length,
    sessions: sessions.size,
    skills,
    proposals: {
      total: latestProposals.size,
      promoted: promoted.size,
      rejected: rejected.size,
      rolledBack: rolledBack.size,
    },
    contextCost,
    followUpIntents,
    followUpFailures,
  }
}

function intentMetrics(resolutions: readonly FollowUpResolution[]): SkillUsageMetric['followUpIntents'] {
  const result = { explicit: { total: 0, failures: 0, byIntent: {} as Record<string, number> }, classifier: { total: 0, failures: 0, byIntent: {} as Record<string, number> }, rule: { total: 0, failures: 0, byIntent: {} as Record<string, number> } }
  for (const resolution of resolutions) {
    const item = result[resolution.source]
    item.total += 1
    item.byIntent[resolution.intent] = (item.byIntent[resolution.intent] ?? 0) + 1
    if (['incorrect', 'constraint', 'retry', 'dissatisfied', 'other'].includes(resolution.intent)) item.failures += 1
  }
  return result
}

/** Count transition decisions while retaining compatibility with action-only history. */
function decisionKeys(
  decisions: readonly DecisionRecord[],
  status: DecisionRecord['toStatus'],
  ...legacyActions: DecisionRecord['action'][]
): Set<string> {
  return new Set(decisions
    .filter(decision => decision.toStatus === status || (decision.toStatus === undefined && legacyActions.includes(decision.action)))
    .map(decision => decision.proposalId === undefined ? legacyDecisionKey(decision) : proposalRootId(decision.proposalId)))
}

function legacyDecisionKey(decision: DecisionRecord): string {
  const prefixes = [`decision:${decision.action}:`]
  if (decision.action === 'promoted') prefixes.push('decision:promote:')
  if (decision.action === 'rejected') prefixes.push('decision:reject:')
  if (decision.action === 'rollback' || decision.action === 'reverted') prefixes.push('decision:rollback:')
  const prefix = prefixes.find(candidate => decision.id.startsWith(candidate))
  return prefix === undefined ? decision.id : decision.id.slice(prefix.length)
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4))
}
