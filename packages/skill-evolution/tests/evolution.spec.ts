import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolutionWorkflow,
  JsonlRecordStore,
  SkillVersionStore,
  EvolutionService,
  analyzePortfolio,
  buildExperiences,
  buildFailureCases,
  clusterFailureCases,
  createContentHash,
  createProposal,
  evaluateCandidate,
  mergePortfolioEntries,
  portfolioDecision,
  splitPortfolioEntry,
  transitionPortfolio,
  transitionProposal,
  type RuntimeObservation,
} from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function event(input: Partial<RuntimeObservation> & Pick<RuntimeObservation, 'id' | 'kind'>): RuntimeObservation {
  return {
    schemaVersion: 1,
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    correlationIds: [],
    payload: {},
    source: 'runtime',
    ...input,
  }
}

describe('phase 2 evidence workflow', () => {
  it('projects experience, failure cases, clusters, and conservative diagnoses', () => {
    const events = [
      event({ id: 'load', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown', contentHash: 'v1' } }),
      event({ id: 'follow-up', kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown', contentHash: 'v1' }, payload: { text: 'Please correct step two.' } }),
      event({ id: 'failed-load', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed' } }),
    ]
    const experiences = buildExperiences(events)
    const failures = buildFailureCases(events)
    const clusters = clusterFailureCases(failures)
    expect(experiences[0]).toMatchObject({ outcome: 'harmful', attribution: 'composition', evidenceEventIds: ['load', 'follow-up', 'failed-load'] })
    expect(failures).toHaveLength(2)
    expect(clusters).toHaveLength(2)
  })

  it('attributes a follow-up and task outcome only when one Skill is loaded', () => {
    const events = [
      event({ id: 'loaded', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'follow-up', kind: 'user-follow-up', payload: { text: 'Please fix the status check.' } }),
      event({ id: 'finished', kind: 'task-finished', payload: { outcome: 'completed' } }),
    ]
    const [experience] = buildExperiences(events)
    expect(experience).toMatchObject({
      outcome: 'helpful',
      evidenceEventIds: ['loaded', 'follow-up', 'finished'],
      relevantSkillVersions: [],
    })
  })

  it('retains multi-Skill follow-ups as not-attributable evidence', () => {
    const events = [
      event({ id: 'loaded-a', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'loaded-b', kind: 'skill-loaded', skill: { name: 'testing', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'follow-up', kind: 'user-follow-up', payload: { text: 'Please correct the output.' } }),
    ]
    const experience = buildExperiences(events).find(item => item.attribution === 'not-attributable')
    expect(experience).toMatchObject({ attribution: 'not-attributable', outcome: 'unknown', evidenceEventIds: ['loaded-a', 'loaded-b', 'follow-up'] })
  })

  it('persists derived records idempotently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-records-'))
    dirs.push(dir)
    const store = new JsonlRecordStore<{ id: string; value: number }>(join(dir, 'experiences.jsonl'))
    expect(await store.append({ id: 'experience-1', value: 1 })).toBe(true)
    expect(await store.append({ id: 'experience-1', value: 2 })).toBe(false)
    expect(await store.readAll()).toEqual([{ id: 'experience-1', value: 1 }])
    expect((await readFile(join(dir, 'experiences.jsonl'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })
})

describe('phase 3 proposal and evaluation', () => {
  const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nUse curl.\n`
  const candidate = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nUse curl.\nCheck the response status before editing.\n`

  it('creates isolated proposals and enforces explicit state transitions', () => {
    const proposal = createProposal({
      id: 'proposal-1',
      skillName: 'api-debugging',
      baseVersion: '1.0.0',
      baseContent: base,
      proposedVersion: '1.1.0',
      candidateContent: candidate,
      intent: 'Check response status.',
    })
    expect(proposal.expectedBase.contentHash).toBe(createContentHash(base))
    expect(proposal.diff).toContain('+Check the response status')
    expect(transitionProposal(proposal, 'replayed').status).toBe('replayed')
    expect(() => transitionProposal(proposal, 'accepted')).toThrow('invalid proposal transition')
  })

  it('passes the regression gate only when the trigger case improves', async () => {
    const result = await evaluateCandidate({
      candidateId: 'proposal-2',
      baseContent: base,
      candidateContent: candidate,
      expectedSkillName: 'api-debugging',
      cases: [
        { id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } },
        { id: 'success', category: 'historical-success', task: 'debug', expected: { contains: ['Use curl'] } },
        { id: 'boundary', category: 'boundary', severity: 'high', task: 'other', expected: { excludes: ['dangerous command'] } },
      ],
    })
    expect(result.schemaValid).toBe(true)
    expect(result.passedGate).toBe(true)
    expect(result.categories['original-failure']).toMatchObject({ total: 1, passed: 1 })
  })

  it('rejects candidate changes to invocation policy', async () => {
    const result = await evaluateCandidate({
      candidateId: 'proposal-3',
      baseContent: base,
      candidateContent: candidate.replace('description:', 'user-invocable: false\ndescription:'),
      expectedSkillName: 'api-debugging',
      cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }],
    })
    expect(result.passedGate).toBe(false)
    expect(result.gateReasons).toContain('invocation policy changed')
  })
})

describe('phase 4 publication and phase 5 portfolio maintenance', () => {
  it('promotes atomically, preserves prior versions, and rolls back by hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lifecycle-'))
    dirs.push(dir)
    const invalidations: string[] = []
    const store = new SkillVersionStore(dir, {
      now: () => '2026-09-25T00:00:00.000Z',
      invalidate: async (name, scope) => { invalidations.push(`${name}:${scope}`) },
    })
    const initial = createProposal({
      id: 'initial', skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`, proposedVersion: '1.0.0', candidateContent: `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`, intent: 'Initial version',
    })
    await expect(store.promote(initial, { scope: 'project', expectedBase: { name: 'api-debugging', contentHash: createContentHash('missing') } })).rejects.toThrow('stale Skill base')

    const root = join(dir, 'api-debugging')
    await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true }))
    await import('node:fs/promises').then(fs => fs.writeFile(join(root, 'SKILL.md'), initial.candidateContent))
    const first = await store.promote(initial, { scope: 'project' })
    const stale = createProposal({
      id: 'stale', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: initial.candidateContent, proposedVersion: '1.0.5', candidateContent: initial.candidateContent.replace('Base.', 'Stale.'), intent: 'Stale',
    })
    const next = createProposal({
      id: 'next', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: initial.candidateContent, proposedVersion: '1.1.0', candidateContent: initial.candidateContent.replace('Base.', 'Improved.'), intent: 'Improve',
    })
    await store.promote(next, { scope: 'project' })
    await expect(store.promote(stale, { scope: 'project' })).rejects.toThrow('stale Skill base')
    expect(invalidations).toEqual(['api-debugging:project', 'api-debugging:project'])
    expect(await store.listVersions('api-debugging')).toEqual(['1.0.0', '1.1.0'])
    const rolledBack = await store.rollback('api-debugging', first.manifest.version, { scope: 'project' })
    expect(rolledBack.manifest.version).toBe('1.0.0')
    expect((await store.readCurrent('api-debugging'))?.content).toContain('Base.')
  })

  it('analyzes overlap and keeps curator decisions append-only', () => {
    const entries = [
      { name: 'api-debugging', state: 'stable' as const, relatedSkills: [], description: 'Debug API responses and inspect HTTP status', usageCount: 3, contextCost: 120, updatedAt: '2026-09-25' },
      { name: 'api-testing', state: 'stable' as const, relatedSkills: [], description: 'Test API responses and inspect HTTP status', usageCount: 0, contextCost: 80, updatedAt: '2026-09-25' },
    ]
    const analysis = analyzePortfolio(entries, 0.3)
    expect(analysis.overlaps).toHaveLength(1)
    expect(analysis.totalContextCost).toBe(200)
    expect(analysis.dormantCandidates).toEqual(['api-testing'])
    expect(transitionPortfolio(entries[0]!, 'dormant').state).toBe('dormant')
    expect(portfolioDecision(entries[0]!, 'dormant', 'No recent usage').action).toBe('dormant')
  })

  it('supports reversible merge and split portfolio operations', () => {
    const entries = [
      { name: 'api-debugging', state: 'stable' as const, relatedSkills: [], description: 'Debug APIs', usageCount: 2, contextCost: 100, updatedAt: '2026-09-25' },
      { name: 'api-testing', state: 'stable' as const, relatedSkills: [], description: 'Test APIs', usageCount: 3, contextCost: 80, updatedAt: '2026-09-25' },
    ]
    const merged = mergePortfolioEntries(entries, 'api-work', ['api-debugging', 'api-testing'])
    expect(merged.find(entry => entry.name === 'api-work')).toMatchObject({ state: 'observed', usageCount: 5, contextCost: 180 })
    expect(merged.filter(entry => entry.state === 'retired').map(entry => entry.name)).toEqual(['api-debugging', 'api-testing'])
    const split = splitPortfolioEntry(merged.find(entry => entry.name === 'api-work')!, [
      { name: 'api-debugging', description: 'Debug APIs', relatedSkills: [] },
      { name: 'api-testing', description: 'Test APIs', relatedSkills: [] },
    ])
    expect(split.filter(entry => entry.state === 'observed').map(entry => entry.name)).toEqual(['api-debugging', 'api-testing'])
    expect(split[0]?.state).toBe('retired')
  })
})

describe('phase workflow orchestration', () => {
  it('requires repeated or high-severity evidence before invoking a Designer', async () => {
    const workflow = new EvolutionWorkflow()
    workflow.add([
      event({ id: 'failure-1', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed' } }),
      event({ id: 'failure-2', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed again' } }),
    ])
    const snapshot = workflow.snapshot()
    const proposal = await workflow.propose(snapshot.clusters[0]!.id, async () => ({
      skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: 'base', proposedVersion: '1.1.0', candidateContent: 'candidate',
    }))
    expect(proposal.status).toBe('draft')
    expect(proposal).toMatchObject({ diagnosisId: `diagnosis:${snapshot.clusters[0]!.id}`, clusterId: snapshot.clusters[0]!.id, evidenceEventIds: ['failure-1', 'failure-2'] })
  })

  it('persists derived Experience and failure records through EvolutionService', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-service-'))
    dirs.push(dir)
    const service = new EvolutionService({ root: dir })
    await service.recordObservation(event({ id: 'failed', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed' } }))
    const failures = await service.listFailures()
    expect(failures).toHaveLength(1)
    expect(await service.failures.readAll()).toHaveLength(1)
  })

  it('records an adoption observation when the service promotes a passing proposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-service-promote-'))
    dirs.push(dir)
    const skillDir = join(dir, 'api-debugging')
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved.')
    await import('node:fs/promises').then(fs => fs.mkdir(skillDir, { recursive: true }))
    await import('node:fs/promises').then(fs => fs.writeFile(join(skillDir, 'SKILL.md'), base))
    const service = new EvolutionService({ root: dir })
    const proposal = createProposal({ id: 'service-proposal', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Improve' })
    const evaluation = await service.evaluate(proposal, [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Improved.'] } }])
    await service.promote(proposal, evaluation, 'project')
    expect((await service.observations.query({ kind: 'adoption-applied' }))[0]?.payload).toMatchObject({ proposalId: 'service-proposal', effectiveAt: 'next-load' })
  })
})
