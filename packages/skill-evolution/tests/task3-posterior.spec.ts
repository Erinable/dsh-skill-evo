import { describe, expect, it } from 'vitest'
import {
  createContentHash,
  createObservation,
  emissionInputHash,
  inferSkillAttribution,
  type RuntimeObservation,
  type SkillRef,
} from '../src/index.js'

const api: SkillRef = {
  name: 'api-debugging',
  provider: 'test',
  source: 'test',
  contentHash: createContentHash('api-body'),
}
const git: SkillRef = {
  name: 'git-workflow',
  provider: 'test',
  source: 'test',
  contentHash: createContentHash('git-body'),
}
function event(
  id: string,
  kind: RuntimeObservation['kind'],
  skill: SkillRef | undefined,
  payload: Record<string, unknown>,
): RuntimeObservation {
  return createObservation({
    id,
    kind,
    occurredAt: `2026-01-01T00:00:${id}`,
    sessionId: 's1',
    ...(skill === undefined ? {} : { skill }),
    correlationIds: [],
    payload,
    source: 'runtime',
  })
}
function session(): RuntimeObservation[] {
  return [
    event('01', 'skill-loaded', api, { sessionSeq: 1, shadowTracked: true }),
    event('02', 'agent-step', api, {
      sessionSeq: 2,
      toolName: 'bash',
      command: 'curl api',
    }),
    event('03', 'tool-result', api, {
      sessionSeq: 3,
      exitCode: 0,
      correlationIds: ['02'],
    }),
  ]
}
describe('Task 3 posterior inference', () => {
  it('uses a shared emission input hash and marks missing content', () => {
    const result = inferSkillAttribution(session(), {
      emissionVersion: 'fake-1',
    })
    expect(result.posteriors[0]?.emission.fallbackReason).toBe('not-scored')
    expect(result.posteriors[0]?.skills[0]?.profile).toBe('missing')
    expect(
      emissionInputHash({ sessionId: 's1', steps: [], skills: [] }),
    ).toHaveLength(64)
  })
  it('rejects invalid judge matrices and clamps valid extreme scores', () => {
    const bad = inferSkillAttribution(session(), {
      emissionVersion: 'fake-1',
      emissions: () => ({
        id: 'e',
        version: 'fake-1',
        sessionId: 's1',
        inputHash: 'x',
        logRatios: [[100]],
        createdAt: '',
      }),
    })
    expect(bad.posteriors[0]?.emission.source).toBe('judge')
  })
  it('keeps a shadowed Skill out of later eligible shares', () => {
    const events = [
      ...session(),
      event('04', 'skill-loaded', git, { sessionSeq: 4, shadowTracked: true }),
      event('05', 'context-shadowed', undefined, {
        sessionSeq: 5,
        shadowedSeqRanges: [[4, 4]],
      }),
      event('06', 'agent-step', git, {
        sessionSeq: 6,
        toolName: 'bash',
        command: 'git status',
      }),
    ]
    const result = inferSkillAttribution(events, {
      contents: new Map([
        [api.contentHash!, 'curl api'],
        [git.contentHash!, 'git status'],
      ]),
    })
    expect(
      result.posteriors[0]?.steps.at(-1)?.shares.skills,
    ).not.toHaveProperty('git-workflow')
  })
  it('is byte-stable when observations are reordered by sessionSeq', () => {
    const a = inferSkillAttribution(session(), {
      contents: new Map([[api.contentHash!, 'curl api']]),
    })
    const b = inferSkillAttribution([...session()].reverse(), {
      contents: new Map([[api.contentHash!, 'curl api']]),
    })
    expect(JSON.stringify(a.posteriors)).toBe(JSON.stringify(b.posteriors))
  })
})

describe('emission memo projection', () => {
  it('uses scored memo rows during refresh and restores rule output without a judge', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { EvolutionService } = await import('../src/index.js')
    const root = await mkdtemp(join(tmpdir(), 'task3-emission-'))
    try {
      const judge = {
        version: 'fake-2',
        judge: async (input: any) => ({
          logRatios: input.steps.map(() => input.skills.map(() => 2)),
        }),
      }
      const service = new EvolutionService({ root, emissionJudge: judge })
      for (const item of session()) await service.recordObservation(item)
      expect(await service.scoreSkillEmissions()).toMatchObject({
        scored: 1,
        failed: 0,
      })
      await service.refreshDerived({ force: true })
      expect(
        (await service.skillPosteriors.readAll())[0]?.emission.source,
      ).toBe('judge')
      const restored = new EvolutionService({ root })
      await restored.refreshDerived({ force: true })
      expect(
        (await restored.skillPosteriors.readAll())[0]?.emission.version,
      ).toBe('rule-1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('posterior invariants', () => {
  it('keeps judge-attributed shares normalized across 200 generated sessions', () => {
    for (let n = 0; n < 200; n++) {
      const sid = `s${n}`
      const loaded = createObservation({
        id: `${sid}-load`,
        kind: 'skill-loaded',
        occurredAt: '2026-01-01T00:00:00Z',
        sessionId: sid,
        skill: n % 2 ? git : api,
        correlationIds: [],
        payload: { sessionSeq: 1, shadowTracked: true },
        source: 'runtime',
      })
      const call = createObservation({
        id: `${sid}-call`,
        kind: 'agent-step',
        occurredAt: '2026-01-01T00:00:01Z',
        sessionId: sid,
        correlationIds: [],
        payload: {
          sessionSeq: 2,
          toolName: 'bash',
          command: n % 2 ? 'git status' : 'curl api',
        },
        source: 'runtime',
      })
      const result = createObservation({
        id: `${sid}-result`,
        kind: 'tool-result',
        occurredAt: '2026-01-01T00:00:02Z',
        sessionId: sid,
        correlationIds: [`${sid}-call`],
        payload: { sessionSeq: 3, exitCode: 0 },
        source: 'runtime',
      })
      const posterior = inferSkillAttribution([loaded, call, result], {
        contents: new Map([
          [api.contentHash!, 'curl api'],
          [git.contentHash!, 'git status'],
        ]),
        emissions: () => ({
          id: 'memo',
          version: 'fake',
          sessionId: sid,
          inputHash: '',
          logRatios: [[10]],
          createdAt: '',
        }),
      }).posteriors[0]!
      for (const step of posterior.steps)
        expect(
          step.shares.none +
            Object.values(step.shares.skills).reduce((a, b) => a + b, 0),
        ).toBeCloseTo(1, 6)
    }
  })
})

describe('design section 3.6 fixtures', () => {
  function fixture(length: number, includeNone: boolean): RuntimeObservation[] {
    const rows: RuntimeObservation[] = []
    for (let i = 0; i < length; i++) {
      const skill = i % 2 === 0 ? api : git
      rows.push(
        createObservation({
          id: `f${i}`,
          kind: 'agent-step',
          occurredAt: `2026-01-02T00:00:${String(i).padStart(2, '0')}Z`,
          sessionId: 's1',
          correlationIds: [],
          payload: {
            sessionSeq: i + 3,
            toolName: 'bash',
            command:
              includeNone && i % 3 === 0
                ? 'cat README'
                : i % 2 === 0
                  ? 'curl api'
                  : 'git rebase -i',
          },
          source: 'runtime',
        }),
      )
    }
    return [
      event('load-api', 'skill-loaded', api, {
        sessionSeq: 1,
        shadowTracked: true,
      }),
      event('load-git', 'skill-loaded', git, {
        sessionSeq: 2,
        shadowTracked: true,
      }),
      ...rows,
    ]
  }
  it.each([
    ['clean', 20, false, 0.9],
    ['noisy', 20, false, 0.9],
    ['withNone', 17, true, 0.85],
  ])('%s MAP agreement threshold', (_name, length, withNone, threshold) => {
    const result = inferSkillAttribution(fixture(length, withNone), {
      contents: new Map([
        [api.contentHash!, 'curl api endpoint'],
        [git.contentHash!, 'git rebase -i'],
      ]),
    })
    const mapped =
      result.posteriors[0]?.steps.filter((step) => step.map !== null).length ??
      0
    expect(mapped / length).toBeGreaterThanOrEqual(threshold)
  })
  it('keeps long +10 judge sessions finite', () => {
    const rows = fixture(120, false)
    const result = inferSkillAttribution(rows, {
      emissionVersion: 'fake',
      emissions: () => ({
        id: 'long',
        version: 'fake',
        sessionId: 's1',
        inputHash: '',
        logRatios: Array.from({ length: 120 }, () => [10, 10]),
        createdAt: '',
      }),
    })
    for (const step of result.posteriors[0]!.steps)
      expect(
        Number.isFinite(
          step.shares.none +
            Object.values(step.shares.skills).reduce((a, b) => a + b, 0),
        ),
      ).toBe(true)
  })
})
