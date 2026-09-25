import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  JsonlEventStore,
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
