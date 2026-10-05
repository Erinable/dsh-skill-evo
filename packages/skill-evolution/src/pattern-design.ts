import { redactSensitiveText } from './events.js'
import type { CorrectionPattern, ProposalOperation, SkillProposal } from './types.js'
import { createProposal, type ProposalInput } from './proposal.js'
import type { PatternDesignerInput } from './workflow.js'

export interface PatternTargetSelectionInput {
  readonly explicitSkill?: string
  readonly promotedTarget?: string
  readonly loadedSkills?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  readonly similarities?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
}

export interface PatternTargetSelection {
  readonly target?: string
  readonly reason: 'promoted' | 'explicit' | 'majority-loaded' | 'similarity' | 'create-skill' | 'ambiguous'
  readonly candidates?: readonly string[]
}

/** Apply the documented target order, including explicit ambiguity for similarity ties. */
export function selectPatternTarget(input: PatternTargetSelectionInput): PatternTargetSelection {
  if (input.promotedTarget !== undefined) return { target: input.promotedTarget, reason: 'promoted' }
  if (input.explicitSkill !== undefined) return { target: input.explicitSkill, reason: 'explicit' }
  const loaded = entries(input.loadedSkills)
  if (loaded.length > 0) {
    const max = Math.max(...loaded.map(([, count]) => count))
    const candidates = loaded.filter(([, count]) => count === max).map(([name]) => name).sort()
    if (candidates.length === 1) return { target: candidates[0], reason: 'majority-loaded' }
  }
  const similarities = entries(input.similarities).filter(([, score]) => score >= 0.5).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (similarities.length > 0) {
    const best = similarities[0]![1]
    const tied = similarities.filter(([, score]) => score === best).map(([name]) => name)
    if (tied.length > 1) return { reason: 'ambiguous', candidates: tied }
    return { target: tied[0], reason: 'similarity' }
  }
  return { reason: 'create-skill' }
}

function entries(value: ReadonlyMap<string, number> | Readonly<Record<string, number>> | undefined): [string, number][] {
  if (value === undefined) return []
  return value instanceof Map ? [...value.entries()] : Object.entries(value)
}

const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u
const USERINFO = /https?:\/\/[^\s/]+:[^\s/@]+@/iu
const REDACTED = /\[REDACTED\]/u

/** Reject machine-specific values before a proposal or case file is written. */
export function validateEnvironmentNeutralCandidate(candidate: string, observedValues: readonly string[] = []): { readonly valid: boolean; readonly errors: readonly string[] } {
  const errors: string[] = []
  if (REDACTED.test(candidate)) errors.push('candidate contains [REDACTED]')
  if (IP.test(candidate)) errors.push('candidate contains an IP address')
  if (USERINFO.test(candidate)) errors.push('candidate contains URL userinfo')
  for (const value of observedValues.filter(item => item.length > 0)) if (candidate.includes(value)) errors.push('candidate contains an observed machine value')
  return { valid: errors.length === 0, errors }
}

export interface PatternProposalInput {
  readonly pattern: CorrectionPattern
  readonly skillName?: string
  readonly proposedVersion: string
  readonly candidateContent: string
  readonly baseVersion?: string
  readonly baseContent?: string
  readonly evidenceEventIds?: readonly string[]
  readonly episodeIds?: readonly string[]
  readonly generatedBy?: 'designer' | 'human'
  readonly now?: string
  readonly targetReason?: PatternTargetSelection['reason']
  readonly targetCandidates?: readonly string[]
}

/** Construct pattern metadata without exposing the full observation stream to a Designer. */
export function createPatternProposal(input: PatternProposalInput): SkillProposal {
  const seed = `${input.pattern.intent}-${input.pattern.signatureKey}-${input.pattern.id}`
  const slug = seed.toLowerCase().replace(/[^a-z0-9]+/gu, '-').slice(0, 48).replace(/^-+|-+$/gu, '') || 'generated'
  const target = input.skillName ?? `pattern-${slug}`
  const createSkill = input.baseContent === undefined
  const proposalInput: ProposalInput = {
    skillName: target,
    baseVersion: input.baseVersion ?? (createSkill ? 'absent' : 'unversioned'),
    ...(createSkill ? {} : { baseContent: input.baseContent }),
    ...(createSkill ? { expectedBase: { name: target, contentHash: 'absent' } } : {}),
    proposedVersion: input.proposedVersion,
    candidateContent: redactSensitiveText(input.candidateContent),
    intent: input.pattern.intent,
    generatedBy: input.generatedBy ?? 'designer',
    operation: createSkill ? 'create-skill' : 'patch-content',
    source: {
      kind: 'pattern',
      patternId: input.pattern.id,
      signatureKey: input.pattern.signatureKey,
      episodeIds: [...input.episodeIds ?? input.pattern.occurrences.map(item => item.episodeId)],
      evidenceEventIds: [...input.evidenceEventIds ?? []],
      ...(input.targetReason === undefined ? {} : { targetReason: input.targetReason }),
      ...(input.targetCandidates === undefined ? {} : { targetCandidates: [...input.targetCandidates] }),
    },
    now: input.now,
  }
  return createProposal(proposalInput)
}

export function patternDesignerInput(pattern: CorrectionPattern, evidenceByEpisode: ReadonlyMap<string, readonly string[]> = new Map()): PatternDesignerInput {
  return {
    id: pattern.id,
    signatureKey: pattern.signatureKey,
    intent: redactSensitiveText(pattern.intent).slice(0, 240),
    errorSignature: redactSensitiveText(pattern.errorSignature).slice(0, 240),
    correction: pattern.correction.map(item => redactSensitiveText(item).slice(0, 120)).slice(0, 16),
    environmental: pattern.environmental,
    retryOnly: pattern.retryOnly,
    episodes: [...pattern.occurrences].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20).map(item => ({ id: item.episodeId, sessionId: item.sessionId, occurredAt: item.occurredAt, evidenceEventIds: [...evidenceByEpisode.get(item.episodeId) ?? []].slice(0, 32) })),
  }
}
