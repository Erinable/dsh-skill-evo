import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionService, JsonlEventStore } from '../../skill-evolution/src/index.js'
import { DshEvolutionAdapter, createReferenceExecutor } from '../src/index.js'
import { createDshEvaluationRunner, createFakeDshExecutor, createProcessReferenceDshExecutor, runDshComparison } from '../src/index.js'
import type { DshSkillRef, RuntimeObservationRecord } from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const apiSkill: DshSkillRef = {
  name: 'api-debugging',
  provider: 'filesystem',
  source: 'project-dsh',
  contentHash: 'sha256:api-v1',
}

describe('DshEvolutionAdapter', () => {
  it('expands a catalog snapshot into independent Skill visibility facts', async () => {
    const events: RuntimeObservationRecord[] = []
    const adapter = new DshEvolutionAdapter({
      async append(event) {
        events.push(event)
        return true
      },
    })

    expect(await adapter.record({
      id: 'catalog-1',
      kind: 'catalog-visible',
      occurredAt: '2026-09-25T00:00:00.000Z',
      sessionId: 'session-1',
      catalogRevision: 'catalog-7',
      skills: [apiSkill, { ...apiSkill, name: 'testing' }],
    })).toBe(2)
    expect(events.map(event => event.id)).toEqual(['catalog-1:0', 'catalog-1:1'])
    expect(events[0]).toMatchObject({
      kind: 'catalog-visible',
      skill: apiSkill,
      payload: { catalogRevision: 'catalog-7', catalogSize: 2 },
      source: 'runtime',
    })
  })

  it('keeps an empty catalog replacement as an observable snapshot', async () => {
    const events: RuntimeObservationRecord[] = []
    const adapter = new DshEvolutionAdapter({
      async append(event) {
        events.push(event)
        return true
      },
    })

    expect(await adapter.record({
      id: 'catalog-empty',
      kind: 'catalog-visible',
      occurredAt: '2026-09-25T00:00:00.000Z',
      sessionId: 'session-1',
      skills: [],
      payload: { catalogUpdate: true },
    })).toBe(1)
    expect(events[0]).toMatchObject({
      id: 'catalog-empty',
      kind: 'catalog-visible',
      payload: { catalogUpdate: true, catalogSize: 0 },
    })
  })

  it('preserves source defaults and caller correlation data', async () => {
    const events: RuntimeObservationRecord[] = []
    const adapter = new DshEvolutionAdapter({
      async append(event) {
        events.push(event)
        return true
      },
    })

    await adapter.record({
      id: 'follow-up-1',
      kind: 'user-follow-up',
      occurredAt: '2026-09-25T00:00:01.000Z',
      sessionId: 'session-1',
      correlationIds: ['load-1'],
      payload: { text: 'Please correct step two.' },
    })

    expect(events[0]).toMatchObject({ source: 'user', correlationIds: ['load-1'] })
  })

  it('writes adapter output directly to the core JSONL store and keeps retries idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-adapter-'))
    dirs.push(dir)
    const store = new JsonlEventStore(join(dir, 'events.jsonl'))
    const adapter = new DshEvolutionAdapter(store)
    const input = {
      id: 'loaded-1',
      kind: 'skill-loaded' as const,
      occurredAt: '2026-09-25T00:00:02.000Z',
      sessionId: 'session-1',
      skill: apiSkill,
    }

    expect(await adapter.record(input)).toBe(1)
    expect(await adapter.record(input)).toBe(0)
    expect((await store.readAll()).map(event => event.id)).toEqual(['loaded-1'])
  })

  it('runs base and candidate cases in separate temporary workspaces', async () => {
    const workspaces: string[] = []
    const results = await runDshComparison(
      { id: 'proposal-1', skillName: 'api-debugging' },
      'base',
      'candidate',
      [{ id: 'case-1', task: 'debug' }],
      async input => {
        workspaces.push(input.cwd)
        return { outcome: input.skillContent === 'candidate' ? 'improved' : 'unchanged', toolCalls: 2, tokenCost: 10, evidence: [input.skillContent] }
      },
      { timeoutMs: 1000 },
    )
    expect(results.map(result => result.exposure)).toEqual(['base', 'candidate'])
    expect(new Set(workspaces).size).toBe(2)
    expect(results[1]).toMatchObject({ caseId: 'case-1', observedOutcome: 'improved', toolCalls: 2, tokenCost: 10, timedOut: false })
  })

  it('provides deterministic fake and core-runner adapters', async () => {
    const runner = createDshEvaluationRunner(
      { id: 'proposal-runner', skillName: 'api-debugging' },
      'base',
      createReferenceExecutor(),
      { timeoutMs: 1000 },
    )
    await expect(runner('candidate', { id: 'case-1', task: 'require:candidate' })).resolves.toMatchObject({ passed: true, status: 'passed' })
    await expect(runner('base', { id: 'case-1', task: 'require:candidate' })).resolves.toMatchObject({ passed: false, status: 'failed' })
  })

  it('converts executor timeouts into unknown evidence', async () => {
    const [result] = await runDshComparison(
      { id: 'proposal-timeout', skillName: 'api-debugging' },
      'base',
      'candidate',
      [{ id: 'case-1', task: 'debug' }],
      async input => await new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      { timeoutMs: 5 },
    )
    expect(result).toMatchObject({ observedOutcome: 'unknown', timedOut: true })
  })

  it('keeps a real DSH process without a verifier as unknown', async () => {
    const executor = createProcessReferenceDshExecutor({ command: process.execPath, commandArgs: ['-e', 'process.stdout.write("ready")', '--'] })
    const [result] = await runDshComparison({ id: 'process-reference', skillName: 'api-debugging' }, 'base', 'candidate', [{ id: 'case-1', task: 'debug' }], executor, { timeoutMs: 1000 })
    expect(result).toMatchObject({ observedOutcome: 'unknown', status: 'unknown', timedOut: false })
    expect(result.evidence).toContain('DSH exited successfully; no task verifier configured')
  })

  it('runs the cross-package observe to rollback loop with an isolated executor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-e2e-'))
    dirs.push(dir)
    const skillDir = join(dir, 'api-debugging')
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved require:timeout.')
    await mkdir(join(skillDir, 'versions', '1.0.0'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), base)
    await writeFile(join(skillDir, 'manifest.json'), JSON.stringify({ name: 'api-debugging', version: '1.0.0', contentHash: 'stale', status: 'stable', scope: 'project', createdBy: 'human', createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' }))

    const service = new EvolutionService({ root: dir })
    const adapter = new DshEvolutionAdapter(service.observations)
    const failed = (id: string) => ({ id, kind: 'skill-load-failed' as const, occurredAt: '2026-09-25T00:00:00.000Z', sessionId: id, skill: apiSkill, payload: { error: 'load failed' } })
    await adapter.record(failed('failed-1'))
    await adapter.record(failed('failed-2'))
    const snapshot = await service.refreshDerived()
    const proposal = await service.proposeChange(snapshot.clusters[0]!.id, async () => ({ skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate }))
    const comparison = await runDshComparison(proposal, base, candidate, [{ id: 'timeout', task: 'require:timeout' }], createReferenceExecutor())
    expect(comparison[1]).toMatchObject({ exposure: 'candidate', observedOutcome: 'improved' })
    const evaluation = await service.evaluate(proposal, [{ id: 'timeout', category: 'original-failure', task: 'debug', expected: { contains: ['Improved'] } }])
    expect(evaluation.passedGate).toBe(true)
    const evaluated = (await service.proposals.readAll()).find(item => item.id === `${proposal.id}:evaluated`)
    const accepted = await service.acceptProposal(evaluated!, 'E2E review')
    await service.promote(accepted, evaluation, 'project')
    expect((await service.versions.readCurrent('api-debugging'))?.manifest.version).toBe('1.1.0')
    await service.rollback('api-debugging', '1.0.0')
    expect((await service.versions.readCurrent('api-debugging'))?.manifest.version).toBe('1.0.0')
  })
})
