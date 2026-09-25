import { randomUUID } from 'node:crypto'
import { createContentHash } from './events.js'
import type { AdoptionBase, FailureCluster, SkillProposal, SkillDiagnosis, ProposalStatus, ProposalSurface } from './types.js'

export interface ProposalInput {
  readonly id?: string
  readonly skillName: string
  readonly diagnosisId?: string
  readonly clusterId?: string
  readonly evidenceEventIds?: readonly string[]
  readonly baseVersion: string
  readonly baseContent: string
  readonly proposedVersion: string
  readonly candidateContent: string
  readonly intent: string
  readonly changedSurfaces?: readonly ProposalSurface[]
  readonly addressedExperienceIds?: readonly string[]
  readonly knownRisks?: readonly string[]
  readonly comparisonCaseIds?: readonly string[]
  readonly generatedBy?: 'designer' | 'human'
  readonly now?: string
}

/** Build a reviewable candidate without touching the production Skill file. */
export function createProposal(input: ProposalInput): SkillProposal {
  const now = input.now ?? new Date().toISOString()
  const expectedBase: AdoptionBase = {
    name: input.skillName,
    contentHash: createContentHash(input.baseContent),
  }
  return {
    id: input.id ?? `proposal:${randomUUID()}`,
    skillName: input.skillName,
    ...(input.diagnosisId === undefined ? {} : { diagnosisId: input.diagnosisId }),
    ...(input.clusterId === undefined ? {} : { clusterId: input.clusterId }),
    ...(input.evidenceEventIds === undefined ? {} : { evidenceEventIds: [...input.evidenceEventIds] }),
    baseVersion: input.baseVersion,
    expectedBase,
    proposedVersion: input.proposedVersion,
    candidateContent: input.candidateContent,
    diff: createUnifiedDiff(input.baseContent, input.candidateContent),
    intent: input.intent,
    changedSurfaces: [...input.changedSurfaces ?? ['procedure']],
    addressedExperienceIds: [...input.addressedExperienceIds ?? []],
    knownRisks: [...input.knownRisks ?? []],
    comparisonCaseIds: [...input.comparisonCaseIds ?? []],
    generatedBy: input.generatedBy ?? 'human',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  }
}

/** A proposal can only move forward through explicit review states. */
export function transitionProposal(proposal: SkillProposal, status: ProposalStatus, now = new Date().toISOString()): SkillProposal {
  if (proposal.status === status) return proposal
  const allowed: Record<ProposalStatus, readonly ProposalStatus[]> = {
    draft: ['proposed', 'replayed', 'observed', 'rejected', 'deferred'],
    proposed: ['evaluating', 'rejected', 'deferred'],
    evaluating: ['evaluated', 'rejected', 'deferred'],
    evaluated: ['accepted', 'rejected', 'deferred'],
    replayed: ['observed', 'evaluated', 'accepted', 'rejected', 'deferred'],
    observed: ['evaluated', 'accepted', 'rejected', 'deferred'],
    accepted: ['promoted', 'rejected'],
    promoted: ['rolled-back'],
    'rolled-back': [],
    rejected: ['observed'],
    deferred: ['observed', 'rejected'],
    reverted: [],
  }
  if (!allowed[proposal.status].includes(status)) {
    throw new Error(`invalid proposal transition ${proposal.status} -> ${status}`)
  }
  return { ...proposal, status, updatedAt: now }
}

/** Require repeated evidence before an automatic Designer pass is considered. */
export function isClusterReadyForProposal(
  cluster: FailureCluster,
  cases: readonly { readonly severity: 'low' | 'medium' | 'high' }[],
): boolean {
  return cluster.occurrenceCount >= 2 || cases.some(item => item.severity === 'high')
}

/** Create a compact line diff suitable for review and durable decision records. */
export function createUnifiedDiff(before: string, after: string): string {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  if (removed.length === 0 && added.length === 0) return ''
  return [
    '--- a/SKILL.md',
    '+++ b/SKILL.md',
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
  ].join('\n')
}

/** Build a proposal from a diagnosis while leaving content generation explicit. */
export function proposalFromDiagnosis(
  diagnosis: SkillDiagnosis,
  input: Omit<ProposalInput, 'intent' | 'addressedExperienceIds'>,
): SkillProposal {
  return createProposal({
    ...input,
    intent: diagnosis.hypothesis,
    addressedExperienceIds: diagnosis.supportingExperienceIds,
    changedSurfaces: changedSurfacesFor(diagnosis.proposedOperation),
  })
}

function changedSurfacesFor(operation: SkillDiagnosis['proposedOperation']): ProposalSurface[] {
  switch (operation) {
    case 'edit-metadata': return ['description', 'trigger']
    case 'patch-content': return ['procedure']
    case 'split': return ['composition', 'procedure']
    case 'merge': return ['composition', 'procedure']
    case 'retire': return ['composition']
    case 'observe-only': return []
  }
}
