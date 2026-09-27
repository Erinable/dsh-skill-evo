import { hostname } from 'node:os'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionService, SkillVersionStore, createContentHash, createObservation, createProposal, repairEvolutionRoot, type RuntimeObservation } from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function observation(id: string, kind: RuntimeObservation['kind'], payload: Record<string, unknown> = {}): RuntimeObservation {
  return createObservation({
    id,
    kind,
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'repair-session',
    taskId: 'repair-task',
    skill: { name: 'api-debugging', provider: 'filesystem', source: 'project-dsh', contentHash: createContentHash('skill') },
    correlationIds: [],
    payload,
    source: 'runtime',
  })
}

async function old(path: string): Promise<void> {
  await utimes(path, new Date(0), new Date(0))
}

describe('repair lock sweep', () => {
  it('reports legacy colon-containing candidate directories without changing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-candidates-'))
    roots.push(root)
    const legacySuffixed = join(root, '.skill-evolution', 'candidates', 'proposal:accepted')
    const legacyRoot = join(root, '.skill-evolution', 'candidates', 'proposal:root')
    await mkdir(legacySuffixed, { recursive: true })
    await mkdir(legacyRoot, { recursive: true })
    await writeFile(join(legacySuffixed, 'marker.txt'), 'keep', 'utf8')
    await writeFile(join(legacyRoot, 'marker.txt'), 'keep-root', 'utf8')

    const report = await new EvolutionService({ root }).repair()

    expect(report.legacyCandidateDirectories).toEqual([legacyRoot, legacySuffixed].sort())
    expect(await readFile(join(legacySuffixed, 'marker.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(legacyRoot, 'marker.txt'), 'utf8')).toBe('keep-root')
    expect((await readdir(join(root, '.skill-evolution', 'candidates'))).sort()).toEqual(['proposal:accepted', 'proposal:root'])
  })

  it('reclaims a stale publication lock so the following promote succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-promote-'))
    roots.push(root)
    const content = '---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n'
    await mkdir(join(root, 'api-debugging'), { recursive: true })
    await writeFile(join(root, 'api-debugging', 'SKILL.md'), content)
    const lock = join(root, '.skill-evolution', 'locks', 'api-debugging.lock')
    await mkdir(join(root, '.skill-evolution', 'locks'), { recursive: true })
    await writeFile(lock, '')
    await old(lock)
    const service = new EvolutionService({ root })
    const report = await service.repair()
    expect(report.orphanLocksRemoved).toContain(lock)
    const proposal = createProposal({ id: 'repair-promote', skillName: 'api-debugging', baseVersion: 'unversioned', baseContent: content, proposedVersion: '1.0.0', candidateContent: content.replace('Base.', 'Recovered.'), intent: 'Recover publication' })
    await expect(new SkillVersionStore(root).promote(proposal, { scope: 'project' })).resolves.toMatchObject({ manifest: { version: '1.0.0' } })
  })

  it('preserves unrelated project lockfiles while reclaiming explicit JSONL locks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-root-'))
    roots.push(root)
    const projectLocks = ['yarn.lock', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'flake.lock']
    for (const name of projectLocks) { const path = join(root, name); await writeFile(path, 'not a skill evolution lock'); await old(path) }
    const jsonl = join(root, 'events.jsonl')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-outside-'))
    roots.push(outside)
    const observationPath = join(outside, 'observations.jsonl')
    const jsonlLock = `${jsonl}.lock`
    await writeFile(jsonl, '')
    await writeFile(jsonlLock, '')
    await old(jsonlLock)
    const observationLock = `${observationPath}.lock`
    await writeFile(observationPath, '')
    await writeFile(observationLock, '')
    await old(observationLock)
    const report = await repairEvolutionRoot(root, { jsonlPaths: [jsonl], observationsPath: observationPath })
    expect(await Promise.all(projectLocks.map(async name => (await readFile(join(root, name), 'utf8'))))).toHaveLength(5)
    expect(report.orphanLocksRemoved).toContain(jsonlLock)
    expect(report.orphanLocksRemoved).toContain(observationLock)
  })

  it('rebuilds derived records after quarantining a bad derived line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-derived-'))
    roots.push(root)
    const service = new EvolutionService({ root })
    await service.recordObservation(observation('failure-1', 'skill-load-failed', { error: 'same failure' }))
    await service.recordObservation(observation('failure-2', 'skill-load-failed', { error: 'same failure' }))
    const before = await service.refreshDerived()
    expect(before.failures.length).toBeGreaterThan(0)
    await writeFile(service.failures.filePath, 'bad-json\n', 'utf8')
    await service.repair()
    expect((await service.refreshDerived()).failures.length).toBe(before.failures.length)
  })

  it('repairs malformed lines in the current observation file before rebuilding projections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-observation-'))
    roots.push(root)
    const service = new EvolutionService({ root })
    await service.recordObservation(observation('valid-observation', 'skill-loaded'))
    await writeFile(service.observations.filePath, `${await readFile(service.observations.filePath, 'utf8')}partial-tail`, 'utf8')
    await expect(service.repair()).resolves.toMatchObject({ jsonl: expect.arrayContaining([expect.objectContaining({ path: service.observations.filePath, removedInvalidLines: 1 })]) })
    expect((await service.observations.readAll()).map(item => item.id)).toEqual(['valid-observation'])
  })

  it('reports lock, guard, tmp states and excludes skipped directory locks from legacy arrays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-report-'))
    roots.push(root)
    const state = join(root, '.skill-evolution')
    const locks = join(state, 'locks')
    await mkdir(locks, { recursive: true })
    const dead = join(locks, 'dead.lock')
    const live = join(locks, 'live.lock')
    const foreign = join(locks, 'foreign.lock')
    const unknown = join(locks, 'unknown.lock')
    const guard = `${dead}.reclaim`
    const tmp = `${dead}.token.tmp`
    await writeFile(dead, '')
    await old(dead)
    await writeFile(live, JSON.stringify({ v: 1, token: 'live', pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(process.uptime() * 1000), operation: 'test' }))
    await writeFile(foreign, JSON.stringify({ v: 1, token: 'foreign', pid: 999999, hostname: 'foreign-host', createdAt: new Date().toISOString(), uptimeMs: 1, operation: 'foreign' }))
    await writeFile(unknown, '')
    await writeFile(guard, '')
    await writeFile(tmp, '')
    await old(guard)
    await old(tmp)
    const report = await repairEvolutionRoot(root, { jsonlPaths: [] })
    expect(report.locks.some(item => item.artifact === 'lock' && item.path === dead && item.removed)).toBe(true)
    expect(report.locks.some(item => item.artifact === 'guard' && item.path === guard && item.removed)).toBe(true)
    expect(report.locks.some(item => item.artifact === 'tmp' && item.path === tmp && item.removed)).toBe(true)
    expect(report.locks.some(item => item.path === live && item.state === 'held' && !item.removed)).toBe(true)
    expect(report.locks.some(item => item.path === foreign && item.state === 'foreign' && !item.removed)).toBe(true)
    expect(report.locks.some(item => item.path === unknown && item.state === 'unknown' && !item.removed)).toBe(true)
    expect(report.locks.every(item => 'path' in item && 'state' in item && 'removed' in item)).toBe(true)
    expect(report.orphanLocksRemoved.every(path => report.locks.some(item => item.artifact === 'lock' && item.path === path))).toBe(true)
    expect(report.locksPreserved.every(path => report.locks.some(item => item.artifact === 'lock' && item.path === path))).toBe(true)
  })

  it('surfaces a stale directory-lock guard as skipped without treating it as an ordinary lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-skip-'))
    roots.push(root)
    const state = join(root, '.skill-evolution')
    await mkdir(state, { recursive: true })
    const sweep = join(state, '.lock-sweep.lock')
    const guard = `${sweep}.reclaim`
    await writeFile(sweep, '')
    await writeFile(guard, '')
    await old(sweep)
    await old(guard)
    const report = await repairEvolutionRoot(root, { jsonlPaths: [] })
    expect(report.locks).toContainEqual(expect.objectContaining({ path: sweep, artifact: 'lock', state: 'skipped', guard, removed: false }))
    expect(report.orphanLocksRemoved).not.toContain(sweep)
    expect(report.locksPreserved).not.toContain(sweep)
  })

  it('coordinates concurrent repairs sharing an observation directory and removes one stale guard', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-concurrent-a-'))
    const rootB = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-concurrent-b-'))
    const shared = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-concurrent-shared-'))
    roots.push(rootA, rootB, shared)
    const observationPath = join(shared, 'observations.jsonl')
    const lock = `${observationPath}.lock`
    const guard = `${lock}.reclaim`
    await writeFile(observationPath, '')
    await writeFile(lock, '')
    await writeFile(guard, '')
    await old(lock)
    await old(guard)
    const results = await Promise.allSettled([
      repairEvolutionRoot(rootA, { jsonlPaths: [observationPath], observationsPath: observationPath }),
      repairEvolutionRoot(rootB, { jsonlPaths: [observationPath], observationsPath: observationPath }),
    ])
    expect(results.every(result => result.status === 'fulfilled')).toBe(true)
    const reports = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const guardRemoved = reports.flatMap(report => report.locks).filter(item => item.artifact === 'guard' && item.path === guard && item.removed)
    const directoryOutcomes = reports.flatMap(report => report.locks).filter(item => item.path === join(shared, '.lock-sweep.lock'))
    expect(guardRemoved).toHaveLength(1)
    expect(directoryOutcomes.every(item => item.state === 'skipped' || item.removed === false)).toBe(true)
    await expect(readFile(guard, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
