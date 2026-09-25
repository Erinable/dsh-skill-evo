import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

async function createContext() {
  const listeners = new Map()
  const warnings = []
  return {
    ctx: {
      on(name, listener) { listeners.set(name, listener) },
      logger: { warn(message) { warnings.push(message) } },
    },
    emit(...args) { return listeners.get('session/event')(...args) },
    warnings,
  }
}

async function readEvents(path) {
  await new Promise(resolve => setTimeout(resolve, 25))
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
}

test('persists an explicit mapped Skill observation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-'))
  try {
    const path = join(dir, 'events.jsonl')
    const { ctx, emit, warnings } = await createContext()
    apply(ctx, {
      storePath: path,
      mapEvent(_session, event, { id }) {
        return {
          id,
          kind: 'skill-loaded',
          occurredAt: '2026-09-25T00:00:00.000Z',
          skill: { name: event.skillName, provider: 'filesystem', source: 'project-dsh' },
        }
      },
    })

    emit({ id: 'session-1' }, { seq: 1, type: 'skill-loaded', skillName: 'api-debugging' })
    const [event] = await readEvents(path)
    assert.equal(event.kind, 'skill-loaded')
    assert.equal(event.skill.name, 'api-debugging')
    assert.deepEqual(warnings, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('falls back to agent-step when no mapper is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-'))
  try {
    const path = join(dir, 'events.jsonl')
    const { ctx, emit } = await createContext()
    apply(ctx, { storePath: path })
    emit({ id: 'session-2' }, { seq: 4, type: 'tool-result' })
    const [event] = await readEvents(path)
    assert.equal(event.kind, 'agent-step')
    assert.deepEqual(event.payload, { eventType: 'tool-result', sessionSeq: 4 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
