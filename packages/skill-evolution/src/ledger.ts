import { JsonlRecordStore } from './records.js'
import {
  assertCanTransition,
  findLedgerRecord,
  ledgerRecordId,
  proposalRootId,
  ProposalLedgerError,
} from './proposal.js'
import { createContentHash } from './events.js'
import type { DecisionAction, DecisionRecord, ProposalStatus, SkillProposal } from './types.js'

export interface TransitionInput {
  readonly action?: DecisionAction
  readonly reason: string
  readonly evidenceIds?: readonly string[]
  readonly policyVersion?: string
  readonly policyHash?: string
  readonly comparisonCaseIds?: readonly string[]
}

export interface LedgerTransition {
  readonly record: SkillProposal
  readonly decisionId: string
  readonly replayed: boolean
}

class ReplayTransition extends Error {
  constructor(readonly record: SkillProposal) { super('replayed transition') }
}

/** The single append seam for Proposal status transitions. */
export class ProposalLedger {
  constructor(
    readonly proposals: JsonlRecordStore<SkillProposal>,
    readonly decisions: JsonlRecordStore<DecisionRecord>,
    readonly actor = 'maintainer',
  ) {}

  async transition(from: SkillProposal, to: ProposalStatus, input: TransitionInput): Promise<LedgerTransition> {
    let replayed = false
    let record: SkillProposal
    try {
      record = await this.proposals.appendComputed(records => {
        const root = proposalRootId(from.id)
        const rootRecords = records.filter(item => proposalRootId(item.id) === root && isConsistentRecord(item, root))
        const latest = rootRecords.at(-1)
        const replay = records.find(item => item.previousRecordId === from.id && item.status === to)
        if (replay !== undefined) throw new ReplayTransition(replay)
        const source = records.find(item => item.id === from.id)
        if (source !== undefined && JSON.stringify(source) !== JSON.stringify(from)) {
          throw new ProposalLedgerError('conflict', `proposal ${from.id} does not match the stored record`)
        }
        assertCanTransition(from.status, to)
        if (latest !== undefined && latest.id !== from.id) {
          throw new ProposalLedgerError('conflict', `proposal ${root} is stale: expected ${latest.id}, got ${from.id}`)
        }
        const next = transitionRecord(from, to, input)
        const count = records.filter(item => proposalRootId(item.id) === root && item.status === to).length
        const candidateId = to === 'proposed'
          ? root
          : nextFreeId(records, root, to as Exclude<ProposalStatus, 'draft' | 'proposed' | 'reverted'>, count + 1)
        return { ...next, id: candidateId, previousRecordId: from.id }
      })
    } catch (error) {
      if (!(error instanceof ReplayTransition)) throw error
      record = error.record
      replayed = true
    }

    const decisionId = `decision:ledger:${record.id}`
    await this.decisions.append({
      id: decisionId,
      recordId: record.id,
      proposalId: proposalRootId(record.id),
      skillName: record.skillName,
      action: input.action ?? to as DecisionAction,
      reason: input.reason,
      evidenceIds: [...input.evidenceIds ?? []],
      actor: this.actor,
      fromStatus: from.status,
      toStatus: to,
      baseContentHash: record.expectedBase.contentHash,
      candidateContentHash: createContentHash(record.candidateContent),
      ...(input.policyVersion === undefined ? {} : { policyVersion: input.policyVersion }),
      ...(input.policyHash === undefined ? {} : { policyHash: input.policyHash }),
      createdAt: new Date().toISOString(),
    })
    return { record, decisionId, replayed }
  }

  async latest(reference: string): Promise<SkillProposal> {
    const records = await this.proposals.readAll()
    const exact = records.find(item => item.id === reference)
    const roots = new Set(records.map(item => proposalRootId(item.id)))
    const root = exact === undefined && roots.has(reference) ? reference : exact === undefined ? undefined : proposalRootId(reference)
    if (root === undefined) {
      const prefixMatches = [...roots].filter(candidate => candidate.startsWith(`${reference}:`))
      if (prefixMatches.length > 1) throw new ProposalLedgerError('ambiguous', `ambiguous proposal reference: ${reference}`)
      throw new ProposalLedgerError('not-found', `proposal not found: ${reference}`)
    }
    const matches = records.filter(item => proposalRootId(item.id) === root && isConsistentRecord(item, root))
    return matches[matches.length - 1]!
  }

  async record(recordId: string): Promise<SkillProposal> {
    return findLedgerRecord(await this.proposals.readAll(), recordId)
  }

  async history(root: string): Promise<readonly SkillProposal[]> {
    const normalized = proposalRootId(root)
    const records = (await this.proposals.readAll()).filter(item => proposalRootId(item.id) === normalized)
    if (records.length === 0) throw new ProposalLedgerError('not-found', `proposal not found: ${root}`)
    return records
  }
}

function transitionRecord(from: SkillProposal, to: ProposalStatus, input: TransitionInput): SkillProposal {
  const now = new Date().toISOString()
  return {
    ...from,
    status: to,
    updatedAt: now,
    ...(to === 'evaluated' && input.comparisonCaseIds !== undefined ? { comparisonCaseIds: [...input.comparisonCaseIds] } : {}),
  }
}

function nextFreeId(records: readonly SkillProposal[], root: string, status: Exclude<ProposalStatus, 'draft' | 'proposed' | 'reverted'>, occurrence: number): string {
  let n = occurrence
  while (true) {
    const id = ledgerRecordId(root, status, n)
    if (!records.some(item => item.id === id)) return id
    n += 1
  }
}

function isConsistentRecord(record: SkillProposal, root: string): boolean {
  if (record.id === root) return true
  const segments = record.id.split(':')
  const suffix = /^\d+$/.test(segments.at(-1) ?? '') ? segments.at(-2) : segments.at(-1)
  return suffix === record.status
}
