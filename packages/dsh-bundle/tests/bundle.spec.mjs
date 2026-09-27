import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createDefaultEventMapper, mapFileObservation } from '../index.js'
import { EvolutionService, createContentHash, rotateJsonl } from '@dsh-skill-evo/core'
import { createReferenceExecutor, runDshComparison } from '@dsh-skill-evo/dsh-adapter'

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

test('deduplicates replayed bundle observations after archive rotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-archive-'))
  try {
    const path = join(dir, 'events.jsonl')
    const { ctx, emit } = await createContext()
    apply(ctx, { storePath: path })
    const event = { id: 'replayed-session:1', seq: 1, type: 'skill-loaded', skillName: 'api-debugging' }
    emit({ id: 'replayed-session' }, event)
    const before = await readEvents(path)
    assert.equal(before.length, 1)

    const rotation = await rotateJsonl(path, { maxBytes: 1 })
    assert.ok(rotation.rotated)
    emit({ id: 'replayed-session' }, event)
    const after = await readEvents(path)
    assert.equal(after.length, 0)
    assert.equal((await readFile(rotation.rotated, 'utf8')).split('\n').filter(Boolean).length, 1)
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

test('falls back when a custom mapper returns an invalid observation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-'))
  try {
    const path = join(dir, 'events.jsonl')
    const { ctx, emit, warnings } = await createContext()
    apply(ctx, { storePath: path, mapEvent() { return { kind: 'not-a-real-observation' } } })
    emit({ id: 'session-invalid' }, { seq: 1, type: 'turn/start' })
    const [event] = await readEvents(path)
    assert.equal(event.kind, 'agent-step')
    assert.match(warnings[0], /invalid observation/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registers a maintainer slash command when the DSH command service is present', () => {
  const registered = []
  const listeners = new Map()
  const ctx = {
    on(name, listener) { listeners.set(name, listener) },
    commands: { register(definition) { registered.push(definition); return () => {} } },
    logger: { warn() {} },
  }
  apply(ctx, { storePath: '/tmp/dsh-skill-evo-command-test/events.jsonl' })
  assert.equal(registered[0].name, 'skill-evolution')
  assert.equal(registered[0].recordInput, false)
})

test('maintenance command reads the same configured store as the event collector', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-store-'))
  try {
    const storePath = join(dir, 'shared-events.jsonl')
    const registered = []
    const listeners = new Map()
    const ctx = {
      on(name, listener) { listeners.set(name, listener) },
      commands: { register(definition) { registered.push(definition); return () => {} } },
      logger: { warn() {} },
    }
    apply(ctx, { storePath })
    listeners.get('session/event')({ id: 'shared-session' }, { seq: 1, type: 'turn/start' })
    await new Promise(resolve => setTimeout(resolve, 30))
    const result = await registered[0].handler({ rawInput: 'observe', agent: { session: { id: 'shared-session', header: { cwd: dir } } } })
    assert.equal(JSON.parse(result.text).observations, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('completes the bundle to promotion and rollback lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bundle-e2e-'))
  try {
    const eventsPath = join(dir, '.skill-evolution', 'observations.jsonl')
    const skillDir = join(dir, 'api-debugging')
    const base = '---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n'
    const candidate = base.replace('Base.', 'Improved timeout diagnosis.')
    await mkdir(join(skillDir, 'versions', '1.0.0'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), base)
    await writeFile(join(skillDir, 'manifest.json'), JSON.stringify({ name: 'api-debugging', version: '1.0.0', contentHash: createContentHash(base), status: 'stable', scope: 'project', createdBy: 'human', createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' }))
    const { ctx, emit } = await createContext()
    apply(ctx, { storePath: eventsPath })

    emit({ id: 'session-e2e-1' }, { seq: 1, type: 'user/message', data: { source: { kind: 'skill-catalog', entries: [{ name: 'api-debugging', description: 'Debug APIs.' }] } } })
    emit({ id: 'session-e2e-1' }, { seq: 2, type: 'tool/call', data: { callId: 'skill-call', name: 'skill', arguments: '{"name":"api-debugging"}' } })
    emit({ id: 'session-e2e-1' }, { seq: 3, type: 'tool/result', data: { callId: 'skill-call', message: { content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: '<skill_content><skill_instructions>Base.</skill_instructions></skill_content>' }] }] } } })
    emit({ id: 'session-e2e-1' }, { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the timeout diagnosis.' }] } })
    emit({ id: 'session-e2e-1' }, { seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please correct timeout diagnosis.' }] } })
    emit({ id: 'session-e2e-1' }, { seq: 6, type: 'turn/end', data: { reason: { kind: 'failed' } } })
    await new Promise(resolve => setTimeout(resolve, 40))

    const service = new EvolutionService({ root: dir })
    const snapshot = await service.refreshDerived()
    assert.equal((await service.observations.query({ kind: 'catalog-visible' })).length, 1)
    assert.equal(snapshot.failures.length, 1)
    await service.recordFeedback({ sessionId: 'session-e2e-1', skillName: 'api-debugging', kind: 'incorrect', note: 'timeout diagnosis was missing' })
    const withFeedback = await service.refreshDerived()
    const proposalCluster = withFeedback.clusters.find(cluster => withFeedback.failures.filter(failure => cluster.caseIds.includes(failure.id)).some(failure => failure.severity === 'high'))
    const proposal = await service.proposeChange(proposalCluster.id, async () => ({ skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate }))
    const comparison = await runDshComparison(proposal, base, candidate, [{ id: 'timeout', task: 'require:timeout' }], createReferenceExecutor())
    assert.equal(comparison[1].observedOutcome, 'improved')
    const evaluation = await service.evaluate(proposal, [{ id: 'timeout', category: 'original-failure', task: 'timeout', expected: { contains: ['Improved timeout diagnosis'] } }])
    assert.equal(evaluation.passedGate, true)
    const evaluated = (await service.proposals.readAll()).find(item => item.id === `${proposal.id}:evaluated`)
    const accepted = await service.acceptProposal(evaluated, 'reviewed E2E evaluation')
    await service.promote(accepted, evaluation, 'project')
    assert.equal((await service.versions.readCurrent('api-debugging')).manifest.version, '1.1.0')

    emit({ id: 'session-e2e-2' }, { seq: 1, type: 'tool/call', data: { callId: 'skill-call-2', name: 'skill', arguments: '{"name":"api-debugging"}' } })
    emit({ id: 'session-e2e-2' }, { seq: 2, type: 'tool/result', data: { callId: 'skill-call-2', message: { content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: '<skill_content><skill_instructions>Improved timeout diagnosis.</skill_instructions></skill_content>' }] }] } } })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal((await service.observations.query({ sessionId: 'session-e2e-2', kind: 'skill-loaded' }))[0].skill.contentHash, createContentHash('Improved timeout diagnosis.'))
    await service.rollback('api-debugging', '1.0.0', 'E2E rollback')
    assert.equal((await service.versions.readCurrent('api-debugging')).manifest.version, '1.0.0')
    assert.ok((await service.proposals.readAll()).some(item => item.id === `${proposal.id}:rolled-back`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
