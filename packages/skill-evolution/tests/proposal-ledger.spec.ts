import { describe, expect, it } from 'vitest'
import {
  PROPOSAL_TRANSITIONS,
  TERMINAL_STATUS_SUFFIXES,
  ProposalLedgerError,
  assertCanTransition,
  canTransition,
  createProposal,
  assertProposalRoot,
  findLedgerRecord,
  findProposalById,
  historyByRoot,
  latestProposalsByRoot,
  ledgerRecordId,
  proposalRootId,
  transitionProposal,
  FEEDBACK_KINDS,
  PUBLICATION_SCOPES,
  assertFeedbackKind,
  assertPublicationScope,
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
  it('centralizes publication scopes and feedback kinds with typed invalid-option errors', () => {
    expect(PUBLICATION_SCOPES).toEqual(['explicit-only', 'project', 'user', 'stable'])
    expect(FEEDBACK_KINDS).toContain('other')
    for (const scope of PUBLICATION_SCOPES) expect(assertPublicationScope(scope)).toBe(scope)
    for (const kind of FEEDBACK_KINDS) expect(assertFeedbackKind(kind)).toBe(kind)
    expect(() => assertPublicationScope('bogus')).toThrowError(expect.objectContaining({ code: 'invalid-option' }))
    expect(() => assertFeedbackKind('bogus')).toThrowError(expect.objectContaining({ code: 'invalid-option' }))
  })

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

  it('traces repeated evaluated records by exact id while keeping one root', () => {
    const root = 'proposal:trace'
    const initial = draft(root)
    const proposed = transitionProposal(initial, 'proposed')
    const evaluating = { ...transitionProposal(proposed, 'evaluating'), id: ledgerRecordId(root, 'evaluating') }
    const evaluated = { ...transitionProposal(evaluating, 'evaluated'), id: ledgerRecordId(root, 'evaluated') }
    const secondEvaluated = { ...transitionProposal({ ...evaluated, status: 'observed' }, 'evaluated'), id: ledgerRecordId(root, 'evaluated', 2) }
    const records = [initial, proposed, evaluating, evaluated, secondEvaluated]

    expect(historyByRoot(records, root)).toEqual(records)
    expect(latestProposalsByRoot(records).get(root)).toEqual(secondEvaluated)
    expect(findProposalById(records, `${root}:evaluated`)).toEqual(secondEvaluated)
    expect(findLedgerRecord(records, `${root}:evaluated`)).toEqual(evaluated)
    expect(findLedgerRecord(records, `${root}:evaluated:2`)).toEqual(secondEvaluated)
  })

  it('round-trips large occurrences and preserves custom numeric roots', () => {
    for (const occurrence of [9, 10, 11, 100]) {
      const id = ledgerRecordId('proposal:abc', 'evaluated', occurrence)
      expect(proposalRootId(id)).toBe('proposal:abc')
    }
    expect(proposalRootId('proposal:abc:2')).toBe('proposal:abc:2')
    expect(() => findLedgerRecord([draft('proposal:abc:evaluated')], 'proposal:abc:evaluated:1')).toThrowError(
      expect.objectContaining({ code: 'not-found' }),
    )
    expect(() => findLedgerRecord([draft('proposal:abc:evaluated')], 'proposal:abc:evaluated:02')).toThrowError(
      expect.objectContaining({ code: 'not-found' }),
    )
  })

  it('accepts plain roots and rejects status-suffixed roots', () => {
    expect(assertProposalRoot('proposal:plain')).toBe('proposal:plain')
    expect(() => assertProposalRoot('proposal:plain:evaluated')).toThrowError(ProposalLedgerError)
    expect(() => assertProposalRoot('proposal:plain:evaluated:2')).toThrowError(ProposalLedgerError)
  })
})
