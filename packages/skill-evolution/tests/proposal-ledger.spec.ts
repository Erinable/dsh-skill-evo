import { describe, expect, it } from 'vitest'
import {
  PROPOSAL_TRANSITIONS,
  TERMINAL_STATUS_SUFFIXES,
  ProposalLedgerError,
  assertCanTransition,
  canTransition,
  createProposal,
  findProposalById,
  latestProposalsByRoot,
  ledgerRecordId,
  proposalRootId,
  transitionProposal,
  type ProposalStatus,
  type SkillProposal,
} from '../src/index.js'

function draft(id: string): SkillProposal {
  return createProposal({
    id,
    skillName: 'example',
    baseVersion: '1.0.0',
    baseContent: 'before',
    proposedVersion: '1.1.0',
    candidateContent: 'after',
    intent: 'Improve example',
    now: '2026-09-26T00:00:00.000Z',
  })
}

describe('proposal ledger', () => {
  it('transitions, records, groups, and resolves a proposal through evaluation', () => {
    const root = 'proposal:123'
    const initial = draft(root)
    const proposed = transitionProposal(initial, 'proposed')
    const evaluating = transitionProposal(proposed, 'evaluating')
    const evaluated = transitionProposal(evaluating, 'evaluated')
    const records = [
      initial,
      proposed,
      { ...evaluating, id: ledgerRecordId(root, 'evaluating') },
      { ...evaluated, id: ledgerRecordId(root, 'evaluated') },
    ]

    expect(records.map(record => record.id)).toEqual([root, root, `${root}:evaluating`, `${root}:evaluated`])
    expect(latestProposalsByRoot(records).get(root)).toEqual(records[3])
    expect(findProposalById(records, root)).toEqual(records[3])
    expect(findProposalById(records, `${root}:evaluated`)).toEqual(records[3])
    expect(findProposalById(records.slice(0, 3), `${root}:evaluating`)).toEqual(records[2])
  })

  it('uses every transition table edge and rejects every other edge with a typed error', () => {
    const statuses = Object.keys(PROPOSAL_TRANSITIONS) as ProposalStatus[]
    for (const from of statuses) {
      for (const to of statuses) {
        const allowed = PROPOSAL_TRANSITIONS[from].includes(to)
        expect(canTransition(from, to)).toBe(allowed)
        if (allowed) {
          expect(() => assertCanTransition(from, to)).not.toThrow()
          expect(transitionProposal({ ...draft('proposal:edge'), status: from }, to).status).toBe(to)
        } else {
          expect(() => assertCanTransition(from, to)).toThrowError(ProposalLedgerError)
          if (from === to) {
            const proposal = { ...draft('proposal:edge'), status: from }
            expect(transitionProposal(proposal, to)).toBe(proposal)
          } else {
            expect(() => transitionProposal({ ...draft('proposal:edge'), status: from }, to)).toThrowError(
              expect.objectContaining({ code: 'invalid-transition' }),
            )
          }
        }
      }
    }
  })

  it('preserves every historical suffix, strips repeated suffixes, and leaves other ids intact', () => {
    expect(new Set(TERMINAL_STATUS_SUFFIXES)).toEqual(new Set([
      'evaluating', 'evaluated', 'accepted', 'promoted', 'rolled-back',
      'replayed', 'observed', 'rejected', 'deferred',
    ]))
    for (const suffix of TERMINAL_STATUS_SUFFIXES) {
      expect(proposalRootId(`proposal:123:${suffix}`)).toBe('proposal:123')
      expect(ledgerRecordId('proposal:123', suffix)).toBe(`proposal:123:${suffix}`)
    }
    expect(proposalRootId('proposal:123:evaluated:accepted')).toBe('proposal:123')
    expect(proposalRootId('proposal:123')).toBe('proposal:123')
    expect(proposalRootId('proposal:123:proposed')).toBe('proposal:123:proposed')
  })

  it('reports ambiguous bare prefixes and missing references without selecting a root', () => {
    const records = [draft('proposal:first'), draft('proposal:second')]
    expect(() => findProposalById(records, 'proposal')).toThrowError(
      expect.objectContaining({ code: 'ambiguous' }),
    )
    expect(() => findProposalById(records, 'proposal:missing')).toThrowError(
      expect.objectContaining({ code: 'not-found' }),
    )
    expect(() => findProposalById([records[0]], 'proposal')).toThrowError(
      expect.objectContaining({ code: 'not-found' }),
    )
  })
})
