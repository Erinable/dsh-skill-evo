import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlEventStore } from '../../skill-evolution/src/index.js'
import { DshEvolutionAdapter } from '../src/index.js'
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
})
