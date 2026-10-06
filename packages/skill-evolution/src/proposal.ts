import { randomUUID } from 'node:crypto'
import { createContentHash } from './events.js'
import type { AdoptionBase, FailureCluster, SkillProposal, SkillDiagnosis, ProposalStatus, ProposalSurface, ProposalOperation, ProposalSource } from './types.js'

export interface ProposalInput {
  readonly id?: string
  readonly skillName: string
  readonly diagnosisId?: string
  readonly clusterId?: string
  readonly evidenceEventIds?: readonly string[]
  readonly baseVersion: string
  readonly baseContent?: string
  readonly expectedBase?: AdoptionBase
  readonly proposedVersion: string
  readonly candidateContent: string
  readonly intent: string
  readonly changedSurfaces?: readonly ProposalSurface[]
  readonly addressedExperienceIds?: readonly string[]
  readonly knownRisks?: readonly string[]
  readonly comparisonCaseIds?: readonly string[]
  readonly generatedBy?: 'designer' | 'human'
  readonly operation?: ProposalOperation
  readonly source?: ProposalSource
  readonly now?: string
}

export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
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

export type ProposalLedgerErrorCode = 'ambiguous' | 'not-found' | 'invalid-transition' | 'conflict'

export class ProposalLedgerError extends Error {
  constructor(readonly code: ProposalLedgerErrorCode, message: string) {
    super(message)
    this.name = 'ProposalLedgerError'
  }
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to)
}

export function assertCanTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!canTransition(from, to)) {
    throw new ProposalLedgerError('invalid-transition', `invalid proposal transition ${from} -> ${to}`)
  }
}

export type LedgerRecordStatus = Exclude<ProposalStatus, 'draft' | 'proposed' | 'reverted'>

const LEDGER_RECORD_TARGETS: readonly ProposalStatus[] = Object.values(PROPOSAL_TRANSITIONS).flat()

export const TERMINAL_STATUS_SUFFIXES: readonly LedgerRecordStatus[] = [
  ...new Set(LEDGER_RECORD_TARGETS.filter((status): status is LedgerRecordStatus => status !== 'proposed')),
]

const VALID_OCCURRENCE = '(?:[2-9]|[1-9]\\d+)'
const INVALID_OCCURRENCE = '(?:1|0\\d+)'

export function proposalRootId(id: string): string {
  let root = id
  while (true) {
    const separator = root.lastIndexOf(':')
    if (separator < 0) return root
    const suffix = root.slice(separator + 1)
    if (TERMINAL_STATUS_SUFFIXES.includes(suffix as LedgerRecordStatus)) {
      root = root.slice(0, separator)
      continue
    }
    if (new RegExp(`^${VALID_OCCURRENCE}$`).test(suffix)) {
      const statusSeparator = root.lastIndexOf(':', separator - 1)
      const status = statusSeparator < 0 ? '' : root.slice(statusSeparator + 1, separator)
      if (TERMINAL_STATUS_SUFFIXES.includes(status as LedgerRecordStatus)) {
        root = root.slice(0, statusSeparator)
        continue
      }
    }
    return root
  }
}

export function ledgerRecordId(root: string, status: LedgerRecordStatus, occurrence = 1): string {
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    throw new ProposalLedgerError('invalid-transition', `invalid ledger record occurrence: ${occurrence}`)
  }
  const base = `${proposalRootId(root)}:${status}`
  return occurrence === 1 ? base : `${base}:${occurrence}`
}

/** Return one exact ledger record; record ids are never resolved by prefix. */
export function findLedgerRecord(records: readonly SkillProposal[], id: string): SkillProposal {
  const invalidOccurrence = new RegExp(`:(?:${TERMINAL_STATUS_SUFFIXES.join('|')}):${INVALID_OCCURRENCE}$`)
  if (invalidOccurrence.test(id)) {
    throw new ProposalLedgerError('not-found', `proposal record not found: ${id}`)
  }
  const record = records.find(item => item.id === id)
  if (record === undefined) throw new ProposalLedgerError('not-found', `proposal record not found: ${id}`)
  return record
}

export function historyByRoot(proposals: readonly SkillProposal[], root: string): SkillProposal[] {
  const normalized = proposalRootId(root)
  return proposals.filter(proposal => proposalRootId(proposal.id) === normalized)
}

export function assertProposalRoot(root: string): string {
  const statusSuffix = new RegExp(`:(?:${TERMINAL_STATUS_SUFFIXES.join('|')})(?::(?:${VALID_OCCURRENCE}|${INVALID_OCCURRENCE}))?$`)
  if (proposalRootId(root) !== root || statusSuffix.test(root)) {
    throw new ProposalLedgerError('invalid-transition', `proposal root must not end with a ledger status suffix: ${root}`)
  }
  return root
}

export function latestProposalsByRoot(proposals: readonly SkillProposal[]): Map<string, SkillProposal> {
  const latest = new Map<string, SkillProposal>()
  for (const proposal of proposals) latest.set(proposalRootId(proposal.id), proposal)
  return latest
}

export function findProposalById(proposals: readonly SkillProposal[], id: string): SkillProposal {
  const latest = latestProposalsByRoot(proposals)
  const exactRoot = latest.get(id)
  if (exactRoot !== undefined) return exactRoot

  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    if (proposals[index]!.id === id) return latest.get(proposalRootId(id))!
  }

  const segments = id.split(':')
  const matchingRoots = [...latest.keys()].filter(root => {
    const rootSegments = root.split(':')
    return segments.length < rootSegments.length && segments.every((segment, index) => segment === rootSegments[index])
  })
  if (matchingRoots.length > 1) throw new ProposalLedgerError('ambiguous', `ambiguous proposal reference: ${id}`)
  throw new ProposalLedgerError('not-found', `proposal not found: ${id}`)
}

/** Build a reviewable candidate without touching the production Skill file. */
export function createProposal(input: ProposalInput): SkillProposal {
  const now = input.now ?? new Date().toISOString()
  const baseContent = input.baseContent ?? ''
  const expectedBase: AdoptionBase = input.expectedBase ?? {
    name: input.skillName,
    contentHash: createContentHash(baseContent),
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
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.source === undefined ? {} : { source: input.source }),
    candidateContent: input.candidateContent,
    diff: createUnifiedDiff(baseContent, input.candidateContent),
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
  assertCanTransition(proposal.status, status)
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
    case 'create-skill': return ['description', 'trigger', 'procedure']
  }
}
