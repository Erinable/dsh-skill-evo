import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createDefaultEventMapper, mapFileObservation } from '../index.js'

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

test('keeps unknown DSH events as agent-step when no mapper is configured', async () => {
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

test('maps the durable Skill catalog into catalog-visible observations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-'))
  try {
    const path = join(dir, 'events.jsonl')
    const { ctx, emit } = await createContext()
    apply(ctx, { storePath: path })
    emit({ id: 'session-3' }, {
      seq: 8,
      time: 1780000000000,
      type: 'user/message',
      data: {
        source: {
          kind: 'skill-catalog',
          form: 'catalog',
          entries: [
            { name: 'api-debugging', description: 'Debug APIs.' },
            { name: 'testing', description: 'Write tests.' },
          ],
        },
        content: [{ type: 'text', text: '<available_skills>...</available_skills>' }],
      },
    })
    const events = await readEvents(path)
    assert.deepEqual(events.map(event => [event.kind, event.skill.name]), [
      ['catalog-visible', 'api-debugging'],
      ['catalog-visible', 'testing'],
    ])
    assert.equal(events[0].occurredAt, '2026-05-28T20:26:40.000Z')
    assert.equal(events[0].payload.catalogSize, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('correlates Skill tool requests and successful loads with a content hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-'))
  try {
    const path = join(dir, 'events.jsonl')
    const { ctx, emit } = await createContext()
    apply(ctx, { storePath: path })
    emit({ id: 'session-4' }, {
      seq: 10,
      time: 1780000001000,
      type: 'tool/call',
      data: { callId: 'call-skill', name: 'skill', arguments: '{"name":"api-debugging"}' },
    })
    emit({ id: 'session-4' }, {
      seq: 11,
      time: 1780000002000,
      type: 'tool/result',
      data: {
        callId: 'call-skill',
        message: {
          source: { kind: 'tool', callId: 'call-skill' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-skill',
            isError: false,
            content: [{ type: 'text', text: '<skill_content name="api-debugging">\n<skill_instructions>\nUse curl.\n</skill_instructions>\n</skill_content>' }],
          }],
        },
      },
    })
    const events = await readEvents(path)
    assert.equal(events[0].kind, 'skill-load-requested')
    assert.equal(events[1].kind, 'skill-loaded')
    assert.deepEqual(events[1].correlationIds, ['session-4:10'])
    assert.match(events[1].skill.contentHash, /^[a-f0-9]{64}$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('records later human messages as user-follow-up observations', () => {
  const mapEvent = createDefaultEventMapper()
  const session = { id: 'session-5' }
  const first = mapEvent(session, {
    seq: 1,
    time: 1780000000000,
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the task.' }] },
  }, { id: 'session-5:1' })
  const followUp = mapEvent(session, {
    seq: 2,
    time: 1780000003000,
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please correct step two.' }] },
  }, { id: 'session-5:2' })

  assert.equal(first.kind, 'agent-step')
  assert.equal(followUp.kind, 'user-follow-up')
  assert.equal(followUp.payload.text, 'Please correct step two.')
  assert.equal(followUp.source, 'user')
})

test('maps failed Skill loads and ordinary tool results separately', () => {
  const mapEvent = createDefaultEventMapper()
  const session = { id: 'session-6' }
  mapEvent(session, {
    seq: 1,
    type: 'tool/call',
    data: { callId: 'call-fail', name: 'skill', arguments: '{"name":"missing"}' },
  }, { id: 'session-6:1' })
  const failed = mapEvent(session, {
    seq: 2,
    type: 'tool/result',
    data: {
      callId: 'call-fail',
      message: { content: [{ type: 'tool-result', isError: true, content: [] }] },
    },
  }, { id: 'session-6:2' })
  const ordinary = mapEvent(session, {
    seq: 3,
    type: 'tool/result',
    data: { callId: 'call-other', message: { content: [] } },
  }, { id: 'session-6:3' })

  assert.equal(failed.kind, 'skill-load-failed')
  assert.equal(failed.skill.name, 'missing')
  assert.equal(ordinary.kind, 'tool-result')
})

test('maps turn completion into a task-finished observation', () => {
  const mapEvent = createDefaultEventMapper()
  const result = mapEvent({ id: 'session-7' }, {
    seq: 20,
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  }, { id: 'session-7:20' })

  assert.equal(result.kind, 'task-finished')
  assert.equal(result.payload.outcome, 'completed')
})

test('maps filesystem observations for Skill.md files and ignores unrelated files', () => {
  const result = mapFileObservation(
    { targetKey: 'file:api', displayPath: '/workspace/.dsh/skills/api-debugging/SKILL.md' },
    { kind: 'present', version: 'fs-v4' },
    { id: 'file-event-1' },
  )
  assert.equal(result.kind, 'skill-file-observed')
  assert.deepEqual(result.skill, {
    name: 'api-debugging',
    provider: 'filesystem',
    source: 'project-dsh',
    path: '/workspace/.dsh/skills/api-debugging/SKILL.md',
    resourceHash: 'fs-v4',
  })
  assert.equal(mapFileObservation({ displayPath: '/workspace/README.md' }, { kind: 'present' }), undefined)
  assert.equal(mapFileObservation({ displayPath: '/workspace/.dsh/skills/api-debugging/references/SKILL.md' }, { kind: 'present' }), undefined)
})
