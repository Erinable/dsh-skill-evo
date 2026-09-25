import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
} from '../src/index.js'

const dirs: string[] = []

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
