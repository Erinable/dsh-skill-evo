import type { DecisionRecord, RuntimeObservation, SkillProposal } from './types.js'
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
}

export interface EvolutionMetrics {
  readonly observations: number
  readonly sessions: number
  readonly skills: readonly SkillUsageMetric[]
  readonly proposals: { readonly total: number; readonly promoted: number; readonly rejected: number; readonly rolledBack: number }
  readonly contextCost: number
}

/** Aggregate exportable operational metrics without assigning causal credit. */
export function aggregateMetrics(
  events: readonly RuntimeObservation[],
  proposals: readonly SkillProposal[] = [],
  decisions: readonly DecisionRecord[] = [],
): EvolutionMetrics {
  const bySkill = new Map<string, { exposed: Set<string>; requested: Set<string>; succeeded: Set<string>; failed: Set<string>; followUps: Set<string> }>()
  const sessions = new Set<string>()
  let contextCost = 0
  for (const event of events) {
    if (event.sessionId !== undefined) sessions.add(event.sessionId)
    const name = event.skill?.name
    if (name === undefined) continue
    const metric = bySkill.get(name) ?? { exposed: new Set(), requested: new Set(), succeeded: new Set(), failed: new Set(), followUps: new Set() }
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
  }
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
