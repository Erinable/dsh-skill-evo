import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  JsonlEventStore,
  EvolutionService,
  ObservationLog,
  StaleAdoptionBaseError,
  buildExposureView,
  createContentHash,
  createObservation,
  validateAdoptionBase,
  type AdoptionCandidate,
  type RuntimeObservation,
  type SkillRef,
  repairJsonlFile,
  rotateJsonl,
} from '../src/index.js'

const dirs: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function skill(contentHash = createContentHash('skill body')): SkillRef {
  return { name: 'api-debugging', provider: 'filesystem', source: 'project-dsh', contentHash }
}

function observation(
  id: string,
  kind: RuntimeObservation['kind'],
  currentSkill = skill(),
  payload: Record<string, unknown> = {},
): RuntimeObservation {
  return createObservation({
    id,
    kind,
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    taskId: 'task-1',
    skill: currentSkill,
    correlationIds: [],
    payload,
    source: 'runtime',
  })
}

describe('JsonlEventStore', () => {
  it('creates an append-only file and ignores duplicate event IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const store = new JsonlEventStore(join(dir, 'events.jsonl'))
    const event = observation('event-1', 'skill-loaded')

    expect(await store.append(event)).toBe(true)
    expect(await store.append(event)).toBe(false)
    expect(await store.readAll()).toEqual([event])
    expect((await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('queries by session, skill, and event kind after reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const store = new JsonlEventStore(path)
    await store.appendMany([
      observation('event-1', 'catalog-visible'),
      observation('event-2', 'skill-loaded'),
      observation('event-3', 'task-finished', { ...skill(), name: 'other-skill' }),
    ])

    const reopened = new JsonlEventStore(path)
    expect((await reopened.query({ skillName: 'api-debugging', kind: 'skill-loaded' })).map(item => item.id)).toEqual(['event-2'])
  })

  it('queries observations by inclusive ISO time bounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const store = new JsonlEventStore(join(dir, 'events.jsonl'))
    await store.appendMany([
      observation('early', 'agent-step'),
      createObservation({
        ...observation('late', 'task-finished'),
        occurredAt: '2026-09-25T00:00:01.000Z',
      }),
    ])
    expect((await store.query({ since: '2026-09-25T00:00:01.000Z' })).map(item => item.id)).toEqual(['late'])
  })

  it('serializes concurrent appends in invocation order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const store = new JsonlEventStore(join(dir, 'events.jsonl'))
    await Promise.all([
      store.append(observation('ordered-1', 'agent-step')),
      store.append(observation('ordered-2', 'agent-step')),
      store.append(observation('ordered-3', 'agent-step')),
    ])
    expect((await store.readAll()).map(item => item.id)).toEqual(['ordered-1', 'ordered-2', 'ordered-3'])
  })

  it('deduplicates same-ID appends from separate Node processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-process-lock-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const modulePath = new URL('../lib/index.js', import.meta.url).pathname
    const script = `import { JsonlEventStore } from ${JSON.stringify(modulePath)}; const store = new JsonlEventStore(process.argv[1]); await store.append(${JSON.stringify(observation('cross-process', 'agent-step'))})`
    await Promise.all([
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, path]),
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, path]),
    ])
    expect(await new JsonlEventStore(path).readAll()).toHaveLength(1)
  })

  it('repairs duplicate, invalid, and unterminated JSONL records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const event = observation('repair-1', 'agent-step')
    await writeFile(path, `${JSON.stringify(event)}\n${JSON.stringify(event)}\nnot-json`, 'utf8')
    const result = await repairJsonlFile(path)
    expect(result).toMatchObject({ validRecords: 1, removedDuplicates: 1, removedInvalidLines: 1 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ id: 'repair-1' })
    expect(result.invalidQuarantine).toBeDefined()
  })

  it('reclaims a dead file lock before repairing JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lock-repair-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    await writeFile(path, `${JSON.stringify(observation('locked', 'agent-step'))}\n`, 'utf8')
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 999999, hostname: hostname(), createdAt: new Date().toISOString() }), 'utf8')
    await expect(repairJsonlFile(path)).resolves.toMatchObject({ validRecords: 1 })
  })

  it('rotates only archives belonging to the selected JSONL file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-rotate-'))
    dirs.push(dir)
    const observations = join(dir, 'observations.jsonl')
    const feedback = join(dir, 'feedback.jsonl')
    await writeFile(observations, 'x'.repeat(20), 'utf8')
    await mkdir(join(dir, 'archive'), { recursive: true })
    await writeFile(join(dir, 'archive', 'feedback.jsonl.old.jsonl'), 'feedback', 'utf8')
    await writeFile(feedback, 'feedback', 'utf8')
    const result = await rotateJsonl(observations, { maxBytes: 1, retentionDays: 30 })
    expect(result.rotated).toBeDefined()
    expect(await readFile(join(dir, 'archive', 'feedback.jsonl.old.jsonl'), 'utf8')).toBe('feedback')
  })
})

describe('ObservationLog state root', () => {
  function archivePath(path: string): string {
    return join(path.replace(/[^/]+$/, 'archive'), `${path.split('/').at(-1)}.2026-09-25T00-00-00.000Z.1.jsonl`)
  }

  it('keeps all derived projections stable when observations rotate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-projection-'))
    dirs.push(dir)
    const service = new EvolutionService({ root: dir })
    await service.observations.appendMany([
      observation('loaded', 'skill-loaded'),
      observation('follow-up', 'user-follow-up', skill(), { text: 'Please correct this.' }),
      observation('failure-1', 'skill-load-failed', skill(), { error: 'same failure' }),
      observation('failure-2', 'skill-load-failed', skill(), { error: 'same failure' }),
    ])
    const before = await service.refreshDerived()
    const result = await service.observations.rotate({ maxBytes: 1 })
    const after = await service.refreshDerived()
    expect(result.rotated).toBeDefined()
    expect(after).toEqual(before)
    expect(after.clusters.map(item => item.id)).toEqual(before.clusters.map(item => item.id))
    expect(after.diagnoses.map(item => item.id)).toEqual(before.diagnoses.map(item => item.id))
  })

  it('deduplicates archived IDs, ignores foreign basenames, and locates override archives beside the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-archive-'))
    dirs.push(dir)
    const path = join(dir, 'custom-events.jsonl')
    const event = observation('archived', 'agent-step')
    const store = new ObservationLog(path)
    await store.append(event)
    await store.rotate({ maxBytes: 1 })
    const foreign = join(dir, 'archive', 'feedback.jsonl.2026-09-25T00-00-00.000Z.1.jsonl')
    await writeFile(foreign, `${JSON.stringify(observation('foreign', 'agent-step'))}\n`, 'utf8')
    const reopened = new ObservationLog(path)
    expect((await reopened.readAll()).map(item => item.id)).toEqual(['archived'])
    expect(await reopened.append(event)).toBe(false)
    expect((await readdir(join(dir, 'archive'))).some(name => name.startsWith('custom-events.jsonl.'))).toBe(true)
  })

  it.each([
    ['bad JSON', 'not-json'],
    ['invalid schema', JSON.stringify({ id: 'bad', schemaVersion: 99 })],
    ['unterminated tail', `${JSON.stringify(observation('bad', 'agent-step'))}x`],
  ])('rejects %s in an archive for read and append', async (_label, content) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bad-archive-'))
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    await mkdir(join(dir, 'archive'), { recursive: true })
    const segment = archivePath(path)
    await writeFile(segment, content, 'utf8')
    const store = new ObservationLog(path)
    await expect(store.readAll()).rejects.toThrow(segment)
    await expect(store.append(observation('new', 'agent-step'))).rejects.toThrow(segment)
  })

  it('quarantines an unterminated tail while retaining complete facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-tail-'))
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    const complete = observation('complete', 'agent-step')
    const tail = Buffer.from('partial-tail')
    await writeFile(path, `${JSON.stringify(complete)}\n`)
    await writeFile(path, Buffer.concat([await readFile(path), tail]))
    const result = await new ObservationLog(path).rotate({ maxBytes: 1 })
    expect(result.invalidQuarantine).toBeDefined()
    expect(await readFile(result.invalidQuarantine!, 'utf8')).toBe(tail.toString())
    expect((await readFile(result.rotated!, 'utf8')).endsWith('\n')).toBe(true)
    expect((await readFile(result.rotated!, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
    const store = new ObservationLog(path)
    expect((await store.readAll()).map(item => item.id)).toEqual(['complete'])
    expect(await store.append(observation('new', 'agent-step'))).toBe(true)
  })

  it('rotates only a residual tail into an empty archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-only-tail-'))
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    await writeFile(path, 'partial-tail', 'utf8')
    const result = await new ObservationLog(path).rotate({ maxBytes: 1 })
    expect(result.invalidQuarantine).toBeDefined()
    expect(await readFile(result.rotated!, 'utf8')).toBe('')
    expect(await new ObservationLog(path).append(observation('new', 'agent-step'))).toBe(true)
  })

  it('leaves current bytes and archives untouched when quarantine fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-quarantine-failure-'))
    dirs.push(dir)
    const path = join(dir, `${'o'.repeat(240)}`)
    await mkdir(join(dir, 'archive'), { recursive: true })
    const original = `${JSON.stringify(observation('complete', 'agent-step'))}\npartial`
    await writeFile(path, original, 'utf8')
    await expect(new ObservationLog(path).rotate({ maxBytes: 1 })).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    expect(await readFile(path, 'utf8')).toBe(original)
    expect((await readdir(join(dir, 'archive')))).toEqual([])
  })

  it('keeps the legacy thirty-day default retention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-retention-'))
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    await writeFile(path, 'x', 'utf8')
    const archive = join(dir, 'archive', 'observations.jsonl.2000-01-01T00-00-00.000Z.1.jsonl')
    await mkdir(join(dir, 'archive'), { recursive: true })
    await writeFile(archive, '', 'utf8')
    await utimes(archive, new Date('2000-01-01'), new Date('2000-01-01'))
    const result = await rotateJsonl(path, { maxBytes: 2 })
    expect(result.deleted).toContain(archive)
  })
})

describe('buildExposureView', () => {
  it('reports exposure facts without inferring Skill impact', () => {
    const events = [
      observation('catalog', 'catalog-visible'),
      observation('request', 'skill-load-requested'),
      observation('loaded', 'skill-loaded'),
      observation('follow-up', 'user-follow-up', skill(), { text: 'Please correct step two.' }),
    ]

    expect(buildExposureView(events)).toEqual([{
      skill: skill(),
      catalogVisible: true,
      loadRequested: true,
      loadSucceeded: true,
      loadFailed: false,
      followUpObservationIds: ['follow-up'],
      observationIds: ['catalog', 'request', 'loaded', 'follow-up'],
    }])
  })

  it('keeps versions with different content hashes separate', () => {
    const first = skill(createContentHash('first'))
    const second = skill(createContentHash('second'))
    const views = buildExposureView([
      observation('first', 'skill-loaded', first),
      observation('second', 'skill-loaded', second),
    ])

    expect(views.map(view => view.skill.contentHash)).toEqual([first.contentHash, second.contentHash])
  })

  it('merges an incomplete catalog identity into a later loaded snapshot', () => {
    const loaded = skill(createContentHash('loaded'))
    const views = buildExposureView([
      observation('catalog', 'catalog-visible', { name: loaded.name, provider: 'unknown', source: 'unknown' }),
      observation('request', 'skill-load-requested', { name: loaded.name, provider: 'unknown', source: 'unknown' }),
      observation('loaded', 'skill-loaded', loaded),
    ])

    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      skill: loaded,
      catalogVisible: true,
      loadRequested: true,
      loadSucceeded: true,
    })
  })
})

describe('validateAdoptionBase', () => {
  const candidate: AdoptionCandidate = {
    proposalId: 'proposal-1',
    skill: skill(createContentHash('candidate')),
    expectedBase: { name: 'api-debugging', contentHash: createContentHash('base') },
    target: 'project',
    effectiveAt: 'next-load',
  }

  it('accepts an unchanged base snapshot', () => {
    expect(validateAdoptionBase(candidate, { current: skill(candidate.expectedBase.contentHash) })).toEqual({ ok: true, candidate })
  })

  it('rejects a stale base without modifying anything', () => {
    expect(() => validateAdoptionBase(candidate, { current: skill(createContentHash('newer')) })).toThrow(StaleAdoptionBaseError)
  })
})
