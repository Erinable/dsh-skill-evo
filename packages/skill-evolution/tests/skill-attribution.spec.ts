import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionService, buildSkillWindows, createContentHash, createObservation, inferSkillAttribution, type RuntimeObservation, type SkillRef } from '../src/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const api: SkillRef = { name: 'api-debugging', provider: 'test', source: 'test', contentHash: createContentHash('api') }
const git: SkillRef = { name: 'git-workflow', provider: 'test', source: 'test', contentHash: createContentHash('git') }
function event(id: string, kind: RuntimeObservation['kind'], skill?: SkillRef, payload: Record<string, unknown> = {}): RuntimeObservation {
  return createObservation({ id, kind, occurredAt: `2026-01-01T00:00:0${id.slice(-1)}.000Z`, sessionId: 's1', ...(skill === undefined ? {} : { skill }), correlationIds: [], payload, source: 'runtime' })
}
function windowOf(events: RuntimeObservation[], id = 'a'): ReturnType<typeof buildSkillWindows>[number] { return buildSkillWindows(events).find(item => item.startObservationId === id)! }

describe('deterministic Skill windows', () => {
  it.each([
    ['next skill', [event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }), event('b', 'agent-step', api, { sessionSeq: 2 }), event('c', 'skill-loaded', git, { sessionSeq: 3, shadowTracked: true })], { end: 'c', reason: 'skill-loaded', certainty: 'observed', steps: ['b'] }],
    ['same skill reload', [event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }), event('b', 'skill-loaded', api, { sessionSeq: 2, shadowTracked: true })], { end: 'b', reason: 'skill-loaded', certainty: 'observed', steps: [] }],
    ['implicit follow-up', [event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }), event('b', 'user-follow-up', api, { sessionSeq: 2 })], { end: 'b', reason: 'user-follow-up', certainty: 'observed', steps: [] }],
    ['explicit follow-up without sequence', [event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }), event('b', 'user-follow-up', api, { explicit: true })], { end: undefined, reason: 'open', certainty: 'uncertain', steps: ['b'] }],
    ['task finished', [event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }), event('b', 'task-finished', api, { sessionSeq: 2 })], { end: 'b', reason: 'task-finished', certainty: 'observed', steps: [] }],
  ])('%s', (_name, events, expected) => {
    const actual = windowOf(events as RuntimeObservation[])
    expect(actual.endObservationId).toBe(expected.end)
    expect(actual.endReason).toBe(expected.reason)
    expect(actual.endCertainty).toBe(expected.certainty)
    expect(actual.stepObservationIds).toEqual(expected.steps)
  })

  it('handles shadowing, open and legacy uncertain windows and excludes replacements', () => {
    const shadowed = windowOf([event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }), event('r', 'tool-result', api, { sessionSeq: 2, surfaceReplace: true }), event('b', 'agent-step', api, { sessionSeq: 3 }), event('s', 'context-shadowed', undefined, { sessionSeq: 4, shadowedSeqRanges: [[1, 1]] })])
    expect(shadowed).toMatchObject({ endObservationId: 's', endReason: 'context-shadowed', endCertainty: 'observed', stepObservationIds: ['b'] })
    const open = windowOf([event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }), event('b', 'agent-step', api, { sessionSeq: 2 })])
    expect(open).toMatchObject({ endReason: 'open', endCertainty: 'uncertain', stepObservationIds: ['b'] })
    const legacy = windowOf([event('a', 'skill-loaded', api, { sessionSeq: 1 }), event('b', 'skill-loaded', git, { sessionSeq: 2, shadowTracked: true })])
    expect(legacy).toMatchObject({ endObservationId: 'b', endCertainty: 'uncertain' })
  })

  it('marks a non-zero session prefix and keeps legacy qualification through later loads', () => {
    const events = [event('p', 'agent-step', undefined, { sessionSeq: 4, toolName: 'bash', command: 'api-debugging' }), event('a', 'skill-loaded', api, { sessionSeq: 5 }), event('b', 'agent-step', api, { sessionSeq: 6, toolName: 'bash', command: 'api-debugging' }), event('g', 'skill-loaded', git, { sessionSeq: 7 }), event('c', 'agent-step', git, { sessionSeq: 8, toolName: 'bash', command: 'api-debugging' })]
    const result = inferSkillAttribution(events)
    expect(result.posteriors[0]?.unknownPrefix).toBe(true)
    expect(result.posteriors[0]?.steps.at(-1)?.shares.skills).toHaveProperty('api-debugging')
  })

  it('projects windows byte-identically on repeated refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-window-projection-')); roots.push(root)
    const service = new EvolutionService({ root })
    await service.recordObservation(event('a', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }))
    await service.recordObservation(event('b', 'agent-step', api, { sessionSeq: 2 }))
    await service.refreshDerived({ force: true })
    const path = service.layout.stores.find(store => store.name === 'skill-windows')!.path
    const first = await readFile(path, 'utf8')
    await service.refreshDerived({ force: true })
    expect(await readFile(path, 'utf8')).toBe(first)
  })
})
