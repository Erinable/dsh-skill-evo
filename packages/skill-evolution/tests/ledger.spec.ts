import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DuplicateRecordError,
  JsonlRecordStore,
  ProposalLedger,
  ProposalLedgerError,
  createProposal,
  type DecisionRecord,
  type SkillProposal,
} from '../src/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proposal-ledger-'))
  roots.push(root)
  const proposals = new JsonlRecordStore<SkillProposal>(join(root, 'proposals.jsonl'))
  const decisions = new JsonlRecordStore<DecisionRecord>(join(root, 'decisions.jsonl'))
  const ledger = new ProposalLedger(proposals, decisions, 'test')
  const draft = createProposal({ id: 'proposal:test', skillName: 'example', baseVersion: '1', baseContent: 'before', proposedVersion: '2', candidateContent: 'after', intent: 'test', now: '2026-01-01T00:00:00.000Z' })
  return { ledger, proposals, decisions, draft }
}

async function transitionPath() {
  const f = await fixture()
  const proposed = (await f.ledger.transition(f.draft, 'proposed', { reason: 'stage' })).record
  const evaluating = (await f.ledger.transition(proposed, 'evaluating', { reason: 'evaluate' })).record
  const evaluated = (await f.ledger.transition(evaluating, 'evaluated', { reason: 'done', comparisonCaseIds: ['case-1'] })).record
  return { ...f, proposed, evaluating, evaluated }
}

describe('ProposalLedger', () => {
  it('persists repeated evaluated entries and supports root/latest and exact queries', async () => {
    const f = await transitionPath()
    const rejected = (await f.ledger.transition(f.evaluated, 'rejected', { reason: 'reject' })).record
    const observed = (await f.ledger.transition(rejected, 'observed', { reason: 'observe' })).record
    const second = await f.ledger.transition(observed, 'evaluated', { reason: 'reevaluate', comparisonCaseIds: ['case-2'] })
    const records = await f.proposals.readAll()
    const decisions = await f.decisions.readAll()
    expect(records.filter(item => item.status === 'evaluated').map(item => item.id)).toEqual(['proposal:test:evaluated', 'proposal:test:evaluated:2'])
    expect(decisions.filter(item => item.toStatus === 'evaluated').map(item => item.recordId)).toEqual(['proposal:test:evaluated', 'proposal:test:evaluated:2'])
    expect((await f.ledger.latest('proposal:test')).id).toBe('proposal:test:evaluated:2')
    expect((await f.ledger.record('proposal:test:evaluated')).id).toBe('proposal:test:evaluated')
    expect((await f.ledger.record(second.record.id)).previousRecordId).toBe('proposal:test:observed')
    expect((await f.ledger.history('proposal:test')).length).toBe(6)
  })

  it('allocates repeated rejection ids and skips occupied candidates', async () => {
    const f = await transitionPath()
    const rejected = (await f.ledger.transition(f.evaluated, 'rejected', { reason: 'reject' })).record
    const observed = (await f.ledger.transition(rejected, 'observed', { reason: 'observe' })).record
    const second = await f.ledger.transition(observed, 'rejected', { reason: 'reject again' })
    expect(second.record.id).toBe('proposal:test:rejected:2')
    expect((await f.decisions.readAll()).at(-1)?.id).toBe('decision:ledger:proposal:test:rejected:2')
    const g = await transitionPath()
    const gRejected = (await g.ledger.transition(g.evaluated, 'rejected', { reason: 'reject' })).record
    const gObserved = (await g.ledger.transition(gRejected, 'observed', { reason: 'observe' })).record
    await g.proposals.append({ ...g.evaluated, id: 'proposal:test:evaluated:2', status: 'proposed' })
    const third = await g.ledger.transition(gObserved, 'evaluated', { reason: 'evaluate again' })
    expect(third.record.id).toBe('proposal:test:evaluated:3')
    expect((await g.decisions.readAll()).at(-1)?.recordId).toBe('proposal:test:evaluated:3')
  })

  it('replays the same transition without adding records and repairs a missing decision', async () => {
    const f = await transitionPath()
    const first = await f.ledger.transition(f.evaluated, 'rejected', { reason: 'reject' })
    const before = [await f.proposals.readAll(), await f.decisions.readAll()]
    const replay = await f.ledger.transition(f.evaluated, 'rejected', { reason: 'retry' })
    expect(replay.replayed).toBe(true)
    expect((await f.proposals.readAll()).length).toBe(before[0].length)
    expect((await f.decisions.readAll()).length).toBe(before[1].length)
    const originalAppend = f.decisions.append.bind(f.decisions)
    let fail = true
    f.decisions.append = (async (record: DecisionRecord) => { if (fail) { fail = false; throw new Error('decision failed') }; return originalAppend(record) }) as typeof f.decisions.append
    await expect(f.ledger.transition(first.record, 'observed', { reason: 'observe' })).rejects.toThrow('decision failed')
    const repaired = await f.ledger.transition(first.record, 'observed', { reason: 'retry observe' })
    expect(repaired.replayed).toBe(true)
    expect((await f.proposals.readAll()).filter(item => item.status === 'observed')).toHaveLength(1)
    expect((await f.decisions.readAll()).filter(item => item.recordId === repaired.record.id)).toHaveLength(1)
  })

  it('replays stage after a decision failure and distinguishes draft targets', async () => {
    const f = await fixture()
    const originalAppend = f.decisions.append.bind(f.decisions)
    f.decisions.append = (async () => { throw new Error('stage decision failed') }) as typeof f.decisions.append
    await expect(f.ledger.transition(f.draft, 'proposed', { reason: 'stage' })).rejects.toThrow('stage decision failed')
    f.decisions.append = originalAppend
    const stagedRetry = await f.ledger.transition(f.draft, 'proposed', { reason: 'retry stage' })
    expect(stagedRetry.replayed).toBe(true)
    expect((await f.proposals.readAll()).filter(item => item.status === 'proposed')).toHaveLength(1)
    expect((await f.decisions.readAll()).filter(item => item.id === 'decision:ledger:proposal:test')).toHaveLength(1)
    await expect(f.ledger.transition(f.draft, 'rejected', { reason: 'stale draft' })).rejects.toMatchObject({ code: 'conflict' })
    const sameTarget = await f.ledger.transition(f.draft, 'proposed', { reason: 'same stage' })
    expect(sameTarget.replayed).toBe(true)
    expect((await f.proposals.readAll())).toHaveLength(1)
    expect((await f.decisions.readAll())).toHaveLength(1)
  })

  it('rejects stale sources with old ids and same-id stale content', async () => {
    const f = await transitionPath()
    const rejected = await f.ledger.transition(f.evaluated, 'rejected', { reason: 'reject' })
    const before = [await f.proposals.readAll(), await f.decisions.readAll()]
    await expect(f.ledger.transition(f.proposed, 'rejected', { reason: 'stale' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.ledger.transition({ ...rejected.record, status: 'draft' }, 'observed', { reason: 'stale draft' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.ledger.transition({ ...rejected.record, candidateContent: 'stale' }, 'observed', { reason: 'stale content' })).rejects.toMatchObject({ code: 'conflict' })
    expect((await f.proposals.readAll()).length).toBe(before[0].length)
    expect((await f.decisions.readAll()).length).toBe(before[1].length)
  })

  it('propagates append failures without creating decisions', async () => {
    const f = await transitionPath()
    const failing = { appendComputed: async () => { throw new Error('proposal failed') } } as unknown as JsonlRecordStore<SkillProposal>
    const ledger = new ProposalLedger(failing, f.decisions)
    await expect(ledger.transition(f.evaluated, 'rejected', { reason: 'fail' })).rejects.toThrow('proposal failed')
    expect(await f.decisions.readAll()).toHaveLength(3)
    const duplicate = { appendComputed: async () => { throw new DuplicateRecordError('proposal:test:rejected') } } as unknown as JsonlRecordStore<SkillProposal>
    await expect(new ProposalLedger(duplicate, f.decisions).transition(f.evaluated, 'rejected', { reason: 'duplicate' })).rejects.toBeInstanceOf(DuplicateRecordError)
  })

  it('reads legacy records without links and writes the new linked ids', async () => {
    const f = await fixture()
    const proposed = { ...f.draft, status: 'proposed' as const }
    const evaluating = { ...proposed, id: 'proposal:test:evaluating', status: 'evaluating' as const }
    await f.proposals.appendMany([proposed, evaluating])
    expect((await f.ledger.record('proposal:test:evaluating')).previousRecordId).toBeUndefined()
    const evaluated = await f.ledger.transition(evaluating, 'evaluated', { reason: 'legacy continue' })
    expect(evaluated.record.id).toBe('proposal:test:evaluated')
    expect(evaluated.record.previousRecordId).toBe('proposal:test:evaluating')
  })
})
