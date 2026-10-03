import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolutionWorkflow,
  JsonlRecordStore,
  SkillVersionStore,
  EvolutionService,
  analyzePortfolio,
  buildExperiences,
  buildFailureCases,
  clusterFailureCases,
  diagnoseFailureCluster,
  createContentHash,
  createProposal,
  evaluateCandidate,
  mergePortfolioEntries,
  aggregateMetrics,
  portfolioDecision,
  renderFailuresMarkdown,
  renderProposalMarkdown,
  resolveFollowUps,
  splitPortfolioEntry,
  transitionPortfolio,
  transitionProposal,
  type RuntimeObservation,
} from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function event(input: Partial<RuntimeObservation> & Pick<RuntimeObservation, 'id' | 'kind'>): RuntimeObservation {
  return {
    schemaVersion: 1,
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    correlationIds: [],
    payload: {},
    source: 'runtime',
    ...input,
  }
}

function skill(): NonNullable<RuntimeObservation['skill']> {
  return { name: 'api-debugging', provider: 'unknown', source: 'unknown' }
}

describe('phase 2 evidence workflow', () => {
  it('resolves the fixed follow-up vocabulary and negative boundaries', () => {
    const texts = ['不对，应该改', 'Please correct step two.', 'Please correct timeout diagnosis.', 'Please correct this.', 'still wrong', 'wrong, upload this again']
    const events = texts.map((text, index) => event({ id: `correction-${index}`, kind: 'user-follow-up', sessionId: `s-${index}`, payload: { text } }))
    expect(resolveFollowUps(events).map(item => item.intent)).toEqual(texts.map(() => 'incorrect'))
    expect(resolveFollowUps([event({ id: 'unknown', kind: 'user-follow-up', payload: { text: 'upload this again' } })])[0]).toMatchObject({ intent: 'unknown', ruleId: 'no-match' })
    expect(resolveFollowUps([event({ id: 'correct', kind: 'user-follow-up', payload: { text: "that's correct" } })])[0]!.intent).toBe('unknown')
  })

  it('does not attribute a pre-load follow-up and applies failed tool evidence only in its turn', () => {
    const beforeLoad = [
      event({ id: 'before', kind: 'user-follow-up', payload: { text: '不对' } }),
      event({ id: 'loaded', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
    ]
    expect(buildFailureCases(beforeLoad)).toEqual([])
    const events = [
      event({ id: 'loaded-2', sessionId: 's2', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'tool', sessionId: 's2', kind: 'tool-result', payload: { failed: true } }),
      event({ id: 'ack', sessionId: 's2', kind: 'user-follow-up', payload: { text: '好的' } }),
      event({ id: 'wrong', sessionId: 's2', kind: 'user-follow-up', payload: { text: '不对', precedingToolKind: 'tool-result', precedingToolFailed: false } }),
    ]
    expect(buildFailureCases(events).find(item => item.id === 'failure:wrong')).toMatchObject({ severity: 'medium' })
    const payloadFailure = buildFailureCases([events[0]!, events[1]!, event({ id: 'wrong-payload', sessionId: 's2', kind: 'user-follow-up', payload: { text: '不对', precedingToolKind: 'tool-result', precedingToolFailed: true } })])[0]
    expect(payloadFailure).toMatchObject({ severity: 'low', attribution: 'tool', attributionSource: 'tool' })
  })

  it('covers rule policy, explicit precedence, tool corrections, and overrides', () => {
    const sessionEvents = [
      event({ id: 'loaded-policy', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'thanks', kind: 'user-follow-up', payload: { text: '谢谢' } }),
      event({ id: 'okay', kind: 'user-follow-up', payload: { text: '好的' } }),
      event({ id: 'continue', kind: 'user-follow-up', payload: { text: '继续' } }),
      event({ id: 'constraint', kind: 'user-follow-up', payload: { text: '必须保留第二步' } }),
      event({ id: 'topic', kind: 'user-follow-up', payload: { text: '顺便问一下部署时间' } }),
    ]
    const resolutions = resolveFollowUps(sessionEvents)
    expect(resolutions.slice(0, 3).map(item => item.intent)).toEqual(['satisfied', 'satisfied', 'not-attributable'])
    expect(buildFailureCases(sessionEvents)).toHaveLength(1)
    expect(buildFailureCases(sessionEvents).find(item => item.id === 'failure:constraint')).toMatchObject({ severity: 'low', intent: 'constraint' })
    const topicCases = buildFailureCases([event({ id: 'topic-only', kind: 'user-follow-up', payload: { text: '换个话题' } })])
    expect(topicCases).toHaveLength(0)
    expect(buildFailureCases([event({ id: 'explicit-satisfied', kind: 'user-follow-up', payload: { explicit: true, feedbackKind: 'satisfied', text: 'done' } })])).toHaveLength(0)
    expect(buildFailureCases([event({ id: 'explicit-incorrect', kind: 'user-follow-up', skill: skill(), payload: { explicit: true, feedbackKind: 'incorrect', text: 'wrong' } })])[0]).toMatchObject({ severity: 'high' })

    const loadFailedPayload = [event({ id: 'load-payload', kind: 'skill-loaded', sessionId: 'load-payload-session', skill: skill() }), event({ id: 'follow-payload', kind: 'user-follow-up', sessionId: 'load-payload-session', skill: skill(), payload: { text: '不对', precedingToolKind: 'skill-load-failed', precedingToolFailed: true } })]
    const loadFailedOffline = [event({ id: 'load-offline', kind: 'skill-load-failed', sessionId: 'load-offline-session', skill: skill() }), event({ id: 'follow-offline', kind: 'user-follow-up', sessionId: 'load-offline-session', skill: skill(), payload: { text: '不对' } })]
    expect(buildFailureCases(loadFailedPayload)[0]).toMatchObject({ severity: 'medium', attribution: 'composition' })
    expect(buildFailureCases(loadFailedOffline).find(item => item.id === 'failure:follow-offline')).toMatchObject({ severity: 'medium', attribution: 'composition' })
    const failedToolOffline = [event({ id: 'tool-loaded', kind: 'skill-loaded', sessionId: 'tool-session', skill: skill() }), event({ id: 'tool-offline', kind: 'tool-result', sessionId: 'tool-session', payload: { failed: true } }), event({ id: 'follow-tool-offline', kind: 'user-follow-up', sessionId: 'tool-session', payload: { text: '不对' } })]
    expect(buildFailureCases(failedToolOffline)[0]).toMatchObject({ severity: 'low', attribution: 'tool' })
    const override = buildFailureCases([event({ id: 'override', kind: 'user-follow-up', skill: skill(), payload: { text: '不对', attributionOverride: 'content' } })])[0]
    expect(override).toMatchObject({ attribution: 'content', attributionSource: 'override' })
    const explicitTool = buildFailureCases([event({ id: 'explicit-tool', kind: 'user-follow-up', skill: skill(), payload: { explicit: true, feedbackKind: 'incorrect', text: '不对', precedingToolKind: 'tool-result', precedingToolFailed: true } })])[0]
    expect(explicitTool).toMatchObject({ severity: 'high', intent: 'incorrect' })
    expect(explicitTool?.attribution).toBeUndefined()
  })

  it('keeps diagnosis timestamps and ids stable across projections', () => {
    const events = [event({ id: 'loaded-stable', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, occurredAt: '2026-09-25T00:00:00.000Z' }), event({ id: 'wrong-stable', kind: 'user-follow-up', payload: { text: '不对' }, occurredAt: '2026-09-25T00:00:01.000Z' })]
    const failures = buildFailureCases(events); const clusters = clusterFailureCases(failures)
    const first = new EvolutionWorkflow(); first.add(events)
    const second = new EvolutionWorkflow(); second.add(events)
    expect(second.snapshot().diagnoses).toEqual(first.snapshot().diagnoses)
  })

  it('projects experience, failure cases, clusters, and conservative diagnoses', () => {
    const events = [
      event({ id: 'load', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown', contentHash: 'v1' } }),
      event({ id: 'follow-up', kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown', contentHash: 'v1' }, payload: { text: 'Please correct step two.' } }),
      event({ id: 'failed-load', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed' } }),
    ]
    const experiences = buildExperiences(events)
    const failures = buildFailureCases(events)
    const clusters = clusterFailureCases(failures)
    expect(experiences[0]).toMatchObject({ outcome: 'harmful', attribution: 'composition', evidenceEventIds: ['load', 'follow-up', 'failed-load'] })
    expect(failures).toHaveLength(2)
    expect(clusters).toHaveLength(2)
  })

  it('attributes a follow-up and task outcome only when one Skill is loaded', () => {
    const events = [
      event({ id: 'loaded', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'follow-up', kind: 'user-follow-up', payload: { text: 'Please fix the status check.' } }),
      event({ id: 'finished', kind: 'task-finished', payload: { outcome: 'completed' } }),
    ]
    const [experience] = buildExperiences(events)
    expect(experience).toMatchObject({
      outcome: 'helpful',
      evidenceEventIds: ['loaded', 'follow-up', 'finished'],
      relevantSkillVersions: [],
    })
  })

  it('retains multi-Skill follow-ups as not-attributable evidence', () => {
    const events = [
      event({ id: 'loaded-a', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'loaded-b', kind: 'skill-loaded', skill: { name: 'testing', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'follow-up', kind: 'user-follow-up', payload: { text: 'Please correct the output.' } }),
    ]
    const experience = buildExperiences(events).find(item => item.attribution === 'not-attributable')
    expect(experience).toMatchObject({ attribution: 'not-attributable', outcome: 'unknown', evidenceEventIds: ['loaded-a', 'loaded-b', 'follow-up'] })
  })

  it('records structured failure origins and diagnoses them without parsing free text', () => {
    const cases = buildFailureCases([
      event({ id: 'loaded', kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'implicit', kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { text: 'wrong, upload this again', explicit: false } }),
      event({ id: 'explicit', kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { text: 'wrong command', explicit: true, feedbackKind: 'incorrect', attributionConfidence: 0.9 } }),
      event({ id: 'load', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { text: 'download failed' } }),
    ])
    expect(cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'failure:implicit', origin: 'implicit-follow-up' }),
      expect.objectContaining({ id: 'failure:explicit', origin: 'explicit-feedback', feedbackKind: 'incorrect' }),
      expect.objectContaining({ id: 'failure:load', origin: 'load-failure' }),
    ]))
    const diagnosisFor = (caseId: string) => diagnoseFailureCluster({
      id: `cluster:api-debugging:${caseId}`, skillName: 'api-debugging', signature: 'free text is ignored',
      caseIds: [caseId], occurrenceCount: 1, createdAt: '2026-09-25T00:00:00.000Z', status: 'open',
    }, cases)
    expect(diagnosisFor('failure:implicit')).toMatchObject({ rootCause: 'content', proposedOperation: 'patch-content' })
    expect(diagnosisFor('failure:explicit')).toMatchObject({ rootCause: 'content', proposedOperation: 'patch-content' })
    expect(diagnosisFor('failure:load')).toMatchObject({ rootCause: 'composition', proposedOperation: 'edit-metadata' })
  })

  it.each([
    ['incorrect', 'content'],
    ['dissatisfied', 'content'],
    ['retry', 'content'],
    ['constraint', 'boundary'],
    ['goal-changed', 'not-skill'],
    ['other', 'uncertain'],
  ] as const)('maps explicit feedback kind %s to %s', (feedbackKind, rootCause) => {
    const [failure] = buildFailureCases([event({
      id: `feedback-${feedbackKind}`,
      kind: 'user-follow-up',
      skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' },
      payload: { explicit: true, feedbackKind, text: 'the wording is irrelevant' },
    })])
    if (feedbackKind === 'goal-changed') {
      expect(failure).toBeUndefined()
      const synthetic = { id: 'failure:goal', skillName: 'api-debugging', task: 'debug', failure: 'topic changed', evidenceEventIds: ['goal'], severity: 'low' as const, createdAt: '2026-09-25T00:00:00.000Z', status: 'open' as const, origin: 'explicit-feedback' as const, feedbackKind }
      expect(diagnoseFailureCluster({ id: 'cluster:api-debugging:failure:goal', skillName: 'api-debugging', signature: 'topic changed', caseIds: [synthetic.id], occurrenceCount: 1, createdAt: synthetic.createdAt, status: 'open' }, [synthetic]).rootCause).toBe(rootCause)
      return
    }
    expect(failure).toMatchObject({ origin: 'explicit-feedback', feedbackKind })
    expect(diagnoseFailureCluster({
      id: `cluster:api-debugging:${failure!.id}`, skillName: 'api-debugging', signature: 'irrelevant',
      caseIds: [failure!.id], occurrenceCount: 1, createdAt: failure!.createdAt, status: 'open',
    }, [failure!]).rootCause).toBe(rootCause)
  })

  it('clusters independently of input order and uses a stable member id', () => {
    const cases = [
      { id: 'case-a', skillName: 'api-debugging', task: 'debug', failure: 'git push timeout', evidenceEventIds: ['a'], severity: 'medium' as const, createdAt: '2026-09-25T00:00:00.000Z', status: 'open' as const, origin: 'implicit-follow-up' as const },
      { id: 'case-b', skillName: 'api-debugging', task: 'debug', failure: 'git push timeout proxy remote', evidenceEventIds: ['b'], severity: 'medium' as const, createdAt: '2026-09-25T00:00:01.000Z', status: 'open' as const, origin: 'implicit-follow-up' as const },
      { id: 'case-d', skillName: 'api-debugging', task: 'debug', failure: 'git push timeout auth', evidenceEventIds: ['d'], severity: 'medium' as const, createdAt: '2026-09-25T00:00:02.000Z', status: 'open' as const, origin: 'implicit-follow-up' as const },
    ]
    const forward = clusterFailureCases(cases)
    const reverse = clusterFailureCases([...cases].reverse())
    expect(reverse).toEqual(forward)
    expect(forward.map(cluster => cluster.id)).toEqual(['cluster:api-debugging:case-a', 'cluster:api-debugging:case-d'])
    expect(clusterFailureCases([cases[0]!])[0]!.id).toBe(clusterFailureCases(cases.slice(0, 2))[0]!.id)
  })

  it('shares a cluster for closely related CJK bigrams', () => {
    const cases = [
      { id: 'zh-a', skillName: 'api-debugging', task: 'debug', failure: '不对，应该先设置代理', evidenceEventIds: ['a'], severity: 'medium' as const, createdAt: '2026-09-25T00:00:00.000Z', status: 'open' as const, origin: 'implicit-follow-up' as const },
      { id: 'zh-b', skillName: 'api-debugging', task: 'debug', failure: '不对，要先配置代理', evidenceEventIds: ['b'], severity: 'medium' as const, createdAt: '2026-09-25T00:00:01.000Z', status: 'open' as const, origin: 'implicit-follow-up' as const },
    ]
    expect(clusterFailureCases(cases)).toHaveLength(1)
  })

  it('keeps unrelated short CJK replies in separate clusters', () => {
    const cases = (texts: readonly [string, string]) => texts.map((failure, index) => ({
      id: `negative-${index}`,
      skillName: 'api-debugging',
      task: 'debug',
      failure,
      evidenceEventIds: [`negative-${index}`],
      severity: 'medium' as const,
      createdAt: `2026-09-25T00:00:0${index}.000Z`,
      status: 'open' as const,
      origin: 'implicit-follow-up' as const,
    }))
    expect(clusterFailureCases(cases(['不对', '不对，数据库连接串写错了，应该用只读副本']))).toHaveLength(2)
    expect(clusterFailureCases(cases(['数据库对账不通过', '不对']))).toHaveLength(2)
  })

  it('uses evidence strength for diagnosis confidence and explicit attribution confidence', () => {
    const two = Array.from({ length: 2 }, (_, index) => [
      event({ id: `two-loaded-${index}`, sessionId: `two-session-${index}`, kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: `two-${index}`, sessionId: `two-session-${index}`, kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { text: 'still wrong' } }),
    ]).flat()
    const twenty = Array.from({ length: 20 }, (_, index) => [
      event({ id: `twenty-loaded-${index}`, sessionId: `twenty-session-${index}`, kind: 'skill-loaded', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: `twenty-${index}`, sessionId: `twenty-session-${index}`, kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { text: 'still wrong' } }),
    ]).flat()
    const twoCases = buildFailureCases(two)
    const twentyCases = buildFailureCases(twenty)
    const twoCluster = clusterFailureCases(twoCases)[0]!
    const twentyCluster = clusterFailureCases(twentyCases)[0]!
    expect(diagnoseFailureCluster(twoCluster, twoCases).confidence).toBe('medium')
    expect(diagnoseFailureCluster(twentyCluster, twentyCases).confidence).toBe('high')

    const counterEvent = event({ id: 'counter', kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { explicit: true, feedbackKind: 'incorrect', text: 'still wrong', counterEvidence: ['task completed successfully'] } })
    const counterCases = buildFailureCases([counterEvent])
    const counterCluster = clusterFailureCases(counterCases)[0]!
    const counterDiagnosis = diagnoseFailureCluster(counterCluster, counterCases)
    const baselineCases = buildFailureCases([event({ id: 'baseline', kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { explicit: true, feedbackKind: 'incorrect', text: 'still wrong' } })])
    const baselineCluster = clusterFailureCases(baselineCases)[0]!
    const baselineDiagnosis = diagnoseFailureCluster(baselineCluster, baselineCases)
    expect(counterDiagnosis.counterEvidence).toEqual(['task completed successfully'])
    expect(baselineDiagnosis.confidence).toBe('medium')
    expect(counterDiagnosis.confidence).toBe('low')

    const explicit = buildExperiences([event({ id: 'feedback', kind: 'user-follow-up', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { text: 'wrong', explicit: true, feedbackKind: 'incorrect', attributionConfidence: 0.9 } })])[0]!
    expect(explicit.confidence).toBe(0.9)
  })

  it('persists derived records idempotently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-records-'))
    dirs.push(dir)
    const store = new JsonlRecordStore<{ id: string; value: number }>(join(dir, 'experiences.jsonl'))
    expect(await store.append({ id: 'experience-1', value: 1 })).toBe(true)
    expect(await store.append({ id: 'experience-1', value: 2 })).toBe(false)
    expect(await store.readAll()).toEqual([{ id: 'experience-1', value: 1 }])
    expect((await readFile(join(dir, 'experiences.jsonl'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })
})

describe('phase 3 proposal and evaluation', () => {
  const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nUse curl.\n`
  const candidate = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nUse curl.\nCheck the response status before editing.\n`

  it('creates isolated proposals and enforces explicit state transitions', () => {
    const proposal = createProposal({
      id: 'proposal-1',
      skillName: 'api-debugging',
      baseVersion: '1.0.0',
      baseContent: base,
      proposedVersion: '1.1.0',
      candidateContent: candidate,
      intent: 'Check response status.',
    })
    expect(proposal.expectedBase.contentHash).toBe(createContentHash(base))
    expect(proposal.diff).toContain('+Check the response status')
    expect(transitionProposal(proposal, 'replayed').status).toBe('replayed')
    expect(() => transitionProposal(proposal, 'accepted')).toThrow('invalid proposal transition')
  })

  it('passes the regression gate only when the trigger case improves', async () => {
    const result = await evaluateCandidate({
      candidateId: 'proposal-2',
      baseContent: base,
      candidateContent: candidate,
      expectedSkillName: 'api-debugging',
      cases: [
        { id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } },
        { id: 'success', category: 'historical-success', task: 'debug', expected: { contains: ['Use curl'] } },
        { id: 'boundary', category: 'boundary', severity: 'high', task: 'other', expected: { excludes: ['dangerous command'] } },
      ],
    })
    expect(result.schemaValid).toBe(true)
    expect(result.passedGate).toBe(true)
    expect(result.categories['original-failure']).toMatchObject({ total: 1, passed: 1 })
  })

  it('rejects candidate changes to invocation policy', async () => {
    const result = await evaluateCandidate({
      candidateId: 'proposal-3',
      baseContent: base,
      candidateContent: candidate.replace('description:', 'user-invocable: false\ndescription:'),
      expectedSkillName: 'api-debugging',
      cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }],
    })
    expect(result.passedGate).toBe(false)
    expect(result.gateReasons).toContain('invocation policy changed')
  })

  it('applies configurable safety and cost gates', async () => {
    const result = await evaluateCandidate({
      candidateId: 'policy-1',
      baseContent: base,
      candidateContent: candidate,
      cases: [{ id: 'trigger', category: 'original-failure', task: 'debug' }],
      policy: { version: 'team-7', maxRegressionCount: 0, maxSecurityViolations: 0, maxTokenIncreaseRatio: 0.1, requireNoNewSideEffects: true, requireOriginalFailureImprovement: false },
      runner: async (content) => ({ passed: content === candidate, tokenCost: content === candidate ? 20 : 10, securityViolations: content === candidate ? ['unsafe'] : [], sideEffects: content === candidate ? ['write'] : [] }),
    })
    expect(result.policyVersion).toBe('team-7')
    expect(result.passedGate).toBe(false)
    expect(result.gateReasons).toEqual(expect.arrayContaining(['security violation limit exceeded', 'new side effects detected', 'token cost increase exceeded policy']))
  })

  it('rejects candidate content that changes Skill identity or adds scripts', async () => {
    const result = await evaluateCandidate({
      candidateId: 'policy-2',
      baseContent: base,
      candidateContent: candidate.replace('name: api-debugging', 'name: other').replace('Use curl.', '<script>alert(1)</script>'),
      expectedSkillName: 'api-debugging',
      cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check'] } }],
    })
    expect(result.gateReasons.some(reason => reason.startsWith('candidate:'))).toBe(true)
  })
})

describe('phase 4 publication and phase 5 portfolio maintenance', () => {
  it('does not leave publication artifacts when a historical version precheck fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lifecycle-precheck-'))
    dirs.push(dir)
    const store = new SkillVersionStore(dir)
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    await mkdir(join(dir, 'api-debugging'), { recursive: true })
    await writeFile(join(dir, 'api-debugging', 'SKILL.md'), base)
    const initial = createProposal({ id: 'precheck-initial', skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: base, proposedVersion: '1.0.0', candidateContent: base, intent: 'Initial' })
    await store.promote(initial, { scope: 'project' })
    await rm(join(dir, 'api-debugging', 'versions', '1.0.0', 'manifest.json'))
    const next = createProposal({ id: 'precheck-next', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: base.replace('Base.', 'Next.'), intent: 'Next' })

    await expect(store.promote(next, { scope: 'project' })).rejects.toThrow('incomplete published Skill version')
    await expect(readdir(join(dir, 'api-debugging', 'versions', '1.1.0'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(dir, 'api-debugging', '.publish.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(dir, '.skill-evolution', 'candidates', next.id, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an empty journaled version so a following promotion succeeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lifecycle-recovery-'))
    dirs.push(dir)
    const store = new SkillVersionStore(dir)
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    await mkdir(join(dir, 'api-debugging'), { recursive: true })
    await writeFile(join(dir, 'api-debugging', 'SKILL.md'), base)
    const initial = createProposal({ id: 'recovery-initial', skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: base, proposedVersion: '1.0.0', candidateContent: base, intent: 'Initial' })
    await store.promote(initial, { scope: 'project' })
    const next = createProposal({ id: 'recovery-next', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: base.replace('Base.', 'Next.'), intent: 'Next' })
    const root = join(dir, 'api-debugging')
    await mkdir(join(root, 'versions', next.proposedVersion))
    await writeFile(join(root, '.publish.json'), `${JSON.stringify({ proposalId: next.id, version: next.proposedVersion, contentHash: createContentHash(next.candidateContent) })}\n`)

    await expect(store.readCurrent('api-debugging')).resolves.toMatchObject({ manifest: { version: '1.0.0' } })
    await expect(readdir(join(root, 'versions', next.proposedVersion))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.publish.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.promote(next, { scope: 'project' })).resolves.toMatchObject({ manifest: { version: '1.1.0' } })
  })

  it('does not delete data for an untrusted journal version', async () => {
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    for (const version of ['', '.', '..', '../x', '../../outside']) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lifecycle-journal-guard-'))
      dirs.push(dir)
      const root = join(dir, 'api-debugging')
      const store = new SkillVersionStore(dir)
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'SKILL.md'), base)
      const initial = createProposal({ id: `journal-guard-${version || 'empty'}`, skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: base, proposedVersion: '1.0.0', candidateContent: base, intent: 'Initial' })
      await store.promote(initial, { scope: 'project' })
      const sibling = join(dir, 'outside', 'sibling.txt')
      await mkdir(join(dir, 'outside'), { recursive: true })
      await writeFile(sibling, 'keep')
      await writeFile(join(root, '.publish.json'), `${JSON.stringify({ proposalId: initial.id, version, contentHash: createContentHash(base) })}\n`)

      await expect(store.readCurrent('api-debugging')).resolves.toMatchObject({ manifest: { version: '1.0.0' } })
      await expect(readdir(join(root, 'versions'))).resolves.toContain('1.0.0')
      await expect(readFile(sibling, 'utf8')).resolves.toBe('keep')
      await expect(readFile(join(root, '.publish.json'), 'utf8')).resolves.toContain('contentHash')
    }
  })

  it('promotes atomically, preserves prior versions, and rolls back by hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lifecycle-'))
    dirs.push(dir)
    const invalidations: string[] = []
    const store = new SkillVersionStore(dir, {
      now: () => '2026-09-25T00:00:00.000Z',
      invalidate: async (name, scope) => { invalidations.push(`${name}:${scope}`) },
    })
    const initial = createProposal({
      id: 'initial', skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`, proposedVersion: '1.0.0', candidateContent: `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`, intent: 'Initial version',
    })
    await expect(store.promote(initial, { scope: 'project', expectedBase: { name: 'api-debugging', contentHash: createContentHash('missing') } })).rejects.toThrow('stale Skill base')

    const root = join(dir, 'api-debugging')
    await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true }))
    await import('node:fs/promises').then(fs => fs.writeFile(join(root, 'SKILL.md'), initial.candidateContent))
    const first = await store.promote(initial, { scope: 'project' })
    const stale = createProposal({
      id: 'stale', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: initial.candidateContent, proposedVersion: '1.0.5', candidateContent: initial.candidateContent.replace('Base.', 'Stale.'), intent: 'Stale',
    })
    const next = createProposal({
      id: 'next', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: initial.candidateContent, proposedVersion: '1.1.0', candidateContent: initial.candidateContent.replace('Base.', 'Improved.'), intent: 'Improve',
    })
    await store.promote(next, { scope: 'project' })
    const overwrite = createProposal({
      id: 'overwrite', skillName: 'api-debugging', baseVersion: '1.1.0', baseContent: next.candidateContent, proposedVersion: '1.1.0', candidateContent: next.candidateContent.replace('Improved.', 'Tampered.'), intent: 'Overwrite',
    })
    await expect(store.promote(overwrite, { scope: 'project' })).rejects.toThrow('published Skill version already exists')
    await expect(store.promote(stale, { scope: 'project' })).rejects.toThrow('stale Skill base')
    expect(invalidations).toEqual(['api-debugging:project', 'api-debugging:project'])
    expect(await store.listVersions('api-debugging')).toEqual(['1.0.0', '1.1.0'])
    const rolledBack = await store.rollback('api-debugging', first.manifest.version, { scope: 'project' })
    expect(rolledBack.manifest.version).toBe('1.0.0')
    expect((await store.readCurrent('api-debugging'))?.content).toContain('Base.')
  })

  it('serializes publication mutations and refuses a pre-existing cross-process lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lock-'))
    dirs.push(dir)
    const root = join(dir, 'api-debugging')
    await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true }))
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    await import('node:fs/promises').then(fs => fs.writeFile(join(root, 'SKILL.md'), base))
    const proposal = createProposal({ id: 'locked', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: base.replace('Base.', 'Next.'), intent: 'Next' })
    await import('node:fs/promises').then(fs => fs.mkdir(join(dir, '.skill-evolution', 'locks'), { recursive: true }))
    await import('node:fs/promises').then(fs => fs.writeFile(join(dir, '.skill-evolution', 'locks', 'api-debugging.lock'), 'held'))
    await expect(new SkillVersionStore(dir).promote(proposal, { scope: 'project' })).rejects.toThrow('already in progress')
  })

  it('reports the live publication owner without reclaiming it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-live-lock-'))
    dirs.push(dir)
    const root = join(dir, 'api-debugging')
    await mkdir(root, { recursive: true })
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    await writeFile(join(root, 'SKILL.md'), base)
    const proposal = createProposal({ id: 'live-locked', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: base.replace('Base.', 'Next.'), intent: 'Next' })
    const lockPath = join(dir, '.skill-evolution', 'locks', 'api-debugging.lock')
    await mkdir(join(dir, '.skill-evolution', 'locks'), { recursive: true })
    await writeFile(lockPath, JSON.stringify({ v: 1, token: 'live', pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(uptime() * 1000), operation: 'promote' }))
    await expect(new SkillVersionStore(dir).promote(proposal, { scope: 'project' })).rejects.toThrow(new RegExp(`already in progress.*pid ${process.pid}.*operation promote`))
    await expect(readFile(lockPath, 'utf8')).resolves.toContain('"token":"live"')
  })

  it('reclaims a dead publication lock before recovering a completed journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-recovery-'))
    dirs.push(dir)
    const store = new SkillVersionStore(dir)
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const proposal = createProposal({ id: 'recoverable', skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: base, proposedVersion: '1.0.0', candidateContent: base.replace('Base.', 'Recovered.'), intent: 'Recover' })
    await mkdir(join(dir, 'api-debugging'), { recursive: true })
    await writeFile(join(dir, 'api-debugging', 'SKILL.md'), base)
    await store.promote(proposal, { scope: 'project' })
    const root = join(dir, 'api-debugging')
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    await writeFile(join(root, '.publish.json'), JSON.stringify({ proposalId: proposal.id, version: '1.0.0', contentHash: manifest.contentHash }))
    await writeFile(join(root, 'SKILL.md'), base)
    await writeFile(join(root, 'current.json'), JSON.stringify({ version: 'stale', contentHash: createContentHash(base) }))
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    if (!deadPid) throw new Error('child pid unavailable')
    await writeFile(join(dir, '.skill-evolution', 'locks', 'api-debugging.lock'), JSON.stringify({ v: 1, token: 'dead', pid: deadPid, hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(uptime() * 1000), operation: 'promote' }))
    expect((await store.readCurrent('api-debugging'))?.content).toContain('Recovered.')
    await expect(readFile(join(root, '.publish.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')).version).toBe('1.0.0')
  })

  it('recovers a publication interrupted by SIGKILL after current.json is written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-sigkill-'))
    dirs.push(dir)
    const signalPath = join(dir, 'ready')
    const modulePath = new URL('../lib/index.js', import.meta.url).pathname
    const script = `import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; import { SkillVersionStore, createProposal } from ${JSON.stringify(modulePath)}; const [dir, signal] = process.argv.slice(1); const base = '---\\nname: api-debugging\\ndescription: Debug APIs.\\n---\\n\\nBase.\\n'; await mkdir(join(dir, 'api-debugging'), { recursive: true }); await writeFile(join(dir, 'api-debugging', 'SKILL.md'), base); const proposal = createProposal({ id: 'sigkill', skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: base, proposedVersion: '1.0.0', candidateContent: base.replace('Base.', 'Recovered.'), intent: 'Recover' }); const store = new SkillVersionStore(dir, { invalidate: async () => { await writeFile(signal, 'ready'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000); await new Promise(() => {}) } }); await store.promote(proposal, { scope: 'project' });`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, signalPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    const ready = once(child.stdout!, 'data')
    const timer = setTimeout(() => child.kill('SIGTERM'), 10_000)
    child.stdout!.once('data', () => undefined)
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('SIGKILL fixture timed out')), 5_000))])
    clearTimeout(timer)
    const root = join(dir, 'api-debugging')
    const lockPath = join(dir, '.skill-evolution', 'locks', 'api-debugging.lock')
    expect(JSON.parse(await readFile(lockPath, 'utf8')).operation).toBe('promote')
    await expect(readFile(join(root, '.publish.json'), 'utf8')).resolves.toContain('1.0.0')
    child.kill('SIGKILL')
    await once(child, 'exit')
    expect((await new SkillVersionStore(dir).readCurrent('api-debugging'))?.content).toContain('Recovered.')
    await expect(readFile(join(root, '.publish.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')).version).toBe('1.0.0')
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent promote and rollback calls on one store instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-queue-'))
    dirs.push(dir)
    const order: string[] = []
    let active = 0
    const store = new SkillVersionStore(dir, {
      invalidate: async () => {
        expect(active).toBe(0)
        active += 1
        order.push('start')
        await new Promise(resolve => setTimeout(resolve, 20))
        order.push('end')
        active -= 1
      },
    })
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    await mkdir(join(dir, 'api-debugging'), { recursive: true })
    await writeFile(join(dir, 'api-debugging', 'SKILL.md'), base)
    const initial = createProposal({ id: 'queue-initial', skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: base, proposedVersion: '1.0.0', candidateContent: base, intent: 'Initial' })
    await store.promote(initial, { scope: 'project' })
    order.splice(0)
    const next = createProposal({ id: 'queue-next', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: base.replace('Base.', 'Next.'), intent: 'Next' })
    const results = await Promise.all([
      store.promote(next, { scope: 'project' }),
      store.rollback('api-debugging', '1.0.0', { scope: 'project' }),
    ])
    expect(results).toHaveLength(2)
    expect(order).toEqual(['start', 'end', 'start', 'end'])
    expect(active).toBe(0)
  })

  it('analyzes overlap and keeps curator decisions append-only', () => {
    const entries = [
      { name: 'api-debugging', state: 'stable' as const, relatedSkills: [], description: 'Debug API responses and inspect HTTP status', usageCount: 3, contextCost: 120, updatedAt: '2026-09-25' },
      { name: 'api-testing', state: 'stable' as const, relatedSkills: [], description: 'Test API responses and inspect HTTP status', usageCount: 0, contextCost: 80, updatedAt: '2026-09-25' },
    ]
    const analysis = analyzePortfolio(entries, 0.3)
    expect(analysis.overlaps).toHaveLength(1)
    expect(analysis.totalContextCost).toBe(200)
    expect(analysis.dormantCandidates).toEqual(['api-testing'])
    expect(transitionPortfolio(entries[0]!, 'dormant').state).toBe('dormant')
    expect(portfolioDecision(entries[0]!, 'dormant', 'No recent usage').action).toBe('dormant')
  })

  it('supports reversible merge and split portfolio operations', () => {
    const entries = [
      { name: 'api-debugging', state: 'stable' as const, relatedSkills: [], description: 'Debug APIs', usageCount: 2, contextCost: 100, updatedAt: '2026-09-25' },
      { name: 'api-testing', state: 'stable' as const, relatedSkills: [], description: 'Test APIs', usageCount: 3, contextCost: 80, updatedAt: '2026-09-25' },
    ]
    const merged = mergePortfolioEntries(entries, 'api-work', ['api-debugging', 'api-testing'])
    expect(merged.find(entry => entry.name === 'api-work')).toMatchObject({ state: 'observed', usageCount: 5, contextCost: 180 })
    expect(merged.filter(entry => entry.state === 'retired').map(entry => entry.name)).toEqual(['api-debugging', 'api-testing'])
    const split = splitPortfolioEntry(merged.find(entry => entry.name === 'api-work')!, [
      { name: 'api-debugging', description: 'Debug APIs', relatedSkills: [] },
      { name: 'api-testing', description: 'Test APIs', relatedSkills: [] },
    ])
    expect(split.filter(entry => entry.state === 'observed').map(entry => entry.name)).toEqual(['api-debugging', 'api-testing'])
    expect(split[0]?.state).toBe('retired')
  })
})

describe('phase workflow orchestration', () => {
  it('uses the ledger transition table for review guards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-service-guards-'))
    dirs.push(dir)
    const service = new EvolutionService({ root: dir })
    const base = createProposal({ id: 'guard-draft', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: 'base', proposedVersion: '1.1.0', candidateContent: 'candidate', intent: 'Improve' })

    expect((await service.rejectProposal(base, 'unsafe')).status).toBe('rejected')

    const deferredDraft = createProposal({ id: 'guard-deferred', skillName: base.skillName, baseVersion: base.baseVersion, baseContent: 'base', proposedVersion: base.proposedVersion, candidateContent: 'candidate', intent: base.intent })
    expect((await service.deferProposal(deferredDraft, 'later')).status).toBe('deferred')

    const accepted = transitionProposal(
      transitionProposal(
        transitionProposal(createProposal({ id: 'guard-accepted', skillName: base.skillName, baseVersion: base.baseVersion, baseContent: 'base', proposedVersion: base.proposedVersion, candidateContent: 'candidate', intent: base.intent }), 'proposed'),
        'evaluating',
      ),
      'evaluated',
    )
    const acceptedRecord = transitionProposal(accepted, 'accepted')
    expect((await service.rejectProposal(acceptedRecord, 'new evidence')).status).toBe('rejected')
    await expect(service.deferProposal(acceptedRecord, 'x')).rejects.toMatchObject({ code: 'invalid-transition' })
  })

  it('retries evaluation from an evaluating record and audits the actual transition edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-service-evaluating-'))
    dirs.push(dir)
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved.')
    await mkdir(join(dir, 'api-debugging'), { recursive: true })
    await writeFile(join(dir, 'api-debugging', 'SKILL.md'), base)
    const service = new EvolutionService({ root: dir })
    const proposal = transitionProposal(createProposal({ id: 'retry-evaluation', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Improve' }), 'proposed')
    const evaluating = transitionProposal(proposal, 'evaluating')
    const result = await service.evaluate(evaluating, [{ id: 'retry', category: 'original-failure', task: 'debug', expected: { contains: ['Improved.'] } }])
    expect(result.passedGate).toBe(true)
    const decision = (await service.decisions.readAll()).find(item => item.toStatus === 'evaluated')
    expect(decision).toMatchObject({ fromStatus: 'evaluating', toStatus: 'evaluated', evidenceIds: ['retry'] })
  })

  it('requires repeated or high-severity evidence before invoking a Designer', async () => {
    const workflow = new EvolutionWorkflow()
    workflow.add([
      event({ id: 'failure-1', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed' } }),
      event({ id: 'failure-2', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed again' } }),
    ])
    const snapshot = workflow.snapshot()
    const proposal = await workflow.propose(snapshot.clusters[0]!.id, async () => ({
      skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: 'base', proposedVersion: '1.1.0', candidateContent: 'candidate',
    }))
    expect(proposal.status).toBe('draft')
    expect(proposal).toMatchObject({ diagnosisId: `diagnosis:${snapshot.clusters[0]!.id}`, clusterId: snapshot.clusters[0]!.id, evidenceEventIds: ['failure-1', 'failure-2'] })
  })

  it('persists derived Experience and failure records through EvolutionService', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-service-'))
    dirs.push(dir)
    const service = new EvolutionService({ root: dir })
    await service.recordObservation(event({ id: 'failed', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed' } }))
    const failures = await service.listFailures()
    expect(failures).toHaveLength(1)
    expect(await service.failures.readAll()).toHaveLength(1)
  })

  it('serializes projection refreshes from independent services', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-parallel-projection-'))
    dirs.push(dir)
    const first = new EvolutionService({ root: dir })
    const second = new EvolutionService({ root: dir })
    await first.recordObservation(event({ id: 'parallel-failure', kind: 'skill-load-failed', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { error: 'load failed' } }))
    await Promise.all([first.refreshDerived(), second.refreshDerived()])
    expect(await first.failures.readAll()).toHaveLength(1)
    expect(await second.failures.readAll()).toHaveLength(1)
  })

  it('records an adoption observation when the service promotes a passing proposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-service-promote-'))
    dirs.push(dir)
    const skillDir = join(dir, 'api-debugging')
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved.')
    await import('node:fs/promises').then(fs => fs.mkdir(skillDir, { recursive: true }))
    await import('node:fs/promises').then(fs => fs.writeFile(join(skillDir, 'SKILL.md'), base))
    const service = new EvolutionService({ root: dir })
    const proposal = transitionProposal(createProposal({ id: 'service-proposal', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Improve' }), 'proposed')
    const evaluation = await service.evaluate(proposal, [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Improved.'] } }])
    const evaluated = (await service.proposals.readAll()).find(item => item.id === 'service-proposal:evaluated')!
    await service.acceptProposal(evaluated, 'Reviewed passing evaluation')
    const accepted = (await service.proposals.readAll()).find(item => item.id === 'service-proposal:accepted')!
    await service.promote(accepted, evaluation, 'project')
    expect((await service.observations.query({ kind: 'adoption-applied' }))[0]?.payload).toMatchObject({ proposalId: 'service-proposal', effectiveAt: 'next-load' })
  })

  it('stores staged and promoted candidates under one proposal root directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-candidate-root-'))
    dirs.push(dir)
    const skillDir = join(dir, 'api-debugging')
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved.')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), base)
    const service = new EvolutionService({ root: dir })
    const draft = createProposal({ id: 'candidate:root', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Improve' })
    const proposed = await service.stageProposal(draft)
    const evaluation = await service.evaluate(proposed, [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Improved.'] } }])
    const evaluated = (await service.proposals.readAll()).find(item => item.id === 'candidate:root:evaluated')!
    await service.acceptProposal(evaluated, 'reviewed')
    const accepted = (await service.proposals.readAll()).find(item => item.id === 'candidate:root:accepted')!
    await service.promote(accepted, evaluation, 'project')

    const candidateEntries = await readdir(service.layout.candidatesDir, { withFileTypes: true })
    expect(candidateEntries.filter(entry => entry.isDirectory()).map(entry => entry.name)).toEqual(['candidate%3Aroot'])
    expect(candidateEntries.some(entry => entry.name.includes(':'))).toBe(false)
  })

  it('writes one deterministic transition decision per lifecycle edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-transition-decisions-'))
    dirs.push(dir)
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved.')
    await mkdir(join(dir, 'api-debugging'), { recursive: true })
    await writeFile(join(dir, 'api-debugging', 'SKILL.md'), base)
    const service = new EvolutionService({ root: dir })
    const proposal = transitionProposal(createProposal({ id: 'decision-lifecycle', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Improve' }), 'proposed')
    const evaluation = await service.evaluate(proposal, [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Improved.'] } }])
    const evaluated = (await service.proposals.readAll()).find(item => item.id === 'decision-lifecycle:evaluated')!
    await service.acceptProposal(evaluated, 'reviewed')
    const accepted = (await service.proposals.readAll()).find(item => item.id === 'decision-lifecycle:accepted')!
    await service.promote(accepted, evaluation, 'project')

    const decisions = await service.decisions.readAll()
    expect(decisions.filter(item => item.toStatus === 'evaluated')).toHaveLength(1)
    expect(decisions.filter(item => item.toStatus === 'accepted')).toHaveLength(1)
    expect(decisions.filter(item => item.toStatus === 'promoted')).toHaveLength(1)
    expect(decisions.every(item => !/^decision:(evaluate|accept|promote):/.test(item.id))).toBe(true)
    expect(await service.decisions.append(decisions.find(item => item.toStatus === 'accepted')!)).toBe(false)
    expect(await service.decisions.readAll()).toHaveLength(decisions.length)
  })

  it('deduplicates transition metrics with legacy action-only decisions', () => {
    const decisions = [
      { id: 'decision:transition:proposal-1:promoted:2026-09-25T00:00:00.000Z', proposalId: 'proposal-1', skillName: 'api-debugging', action: 'promoted' as const, reason: 'done', evidenceIds: [], fromStatus: 'accepted' as const, toStatus: 'promoted' as const, createdAt: '2026-09-25T00:00:00.000Z' },
      { id: 'decision:promote:proposal-1', skillName: 'api-debugging', action: 'promoted' as const, reason: 'legacy', evidenceIds: [], createdAt: '2026-09-25T00:00:00.000Z' },
      { id: 'decision:rejected:proposal-2', skillName: 'api-debugging', action: 'rejected' as const, reason: 'legacy', evidenceIds: [], createdAt: '2026-09-25T00:00:00.000Z' },
    ]
    expect(aggregateMetrics([], [], decisions).proposals).toEqual({ total: 0, promoted: 1, rejected: 1, rolledBack: 0 })
  })

  it('rejects an evaluation artifact that is missing or bound to another candidate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-artifact-'))
    dirs.push(dir)
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved.')
    const skillDir = join(dir, 'api-debugging')
    await import('node:fs/promises').then(fs => fs.mkdir(skillDir, { recursive: true }))
    await import('node:fs/promises').then(fs => fs.writeFile(join(skillDir, 'SKILL.md'), base))
    const service = new EvolutionService({ root: dir })
    const proposal = transitionProposal(createProposal({ id: 'artifact-proposal', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Improve' }), 'proposed')
    const evaluation = await service.evaluate(proposal, [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Improved.'] } }])
    const evaluated = (await service.proposals.readAll()).find(item => item.id === 'artifact-proposal:evaluated')!
    const accepted = await service.acceptProposal(evaluated, 'reviewed')
    await expect(service.promote(accepted, { ...evaluation, artifactId: undefined }, 'project')).rejects.toMatchObject({ message: expect.stringContaining('persisted evaluation artifact'), code: 'evaluation-missing' })
    await expect(service.promote(accepted, { ...evaluation, candidateContentHash: createContentHash('tampered') }, 'project')).rejects.toMatchObject({ message: expect.stringContaining('supplied evaluation'), code: 'evaluation-mismatch' })
  })

  it('turns explicit maintainer feedback into durable evidence and Markdown review output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-feedback-'))
    dirs.push(dir)
    const service = new EvolutionService({ root: dir })
    const record = await service.recordFeedback({ sessionId: 'session-1', skillName: 'api-debugging', kind: 'incorrect', confidence: 0.9, note: '遗漏代理超时配置' })
    expect(record.kind).toBe('incorrect')
    expect((await service.observations.query({ kind: 'user-follow-up' }))[0]?.payload).toMatchObject({ feedbackKind: 'incorrect', explicit: true })
    expect((await service.listFailures())[0]).toMatchObject({ origin: 'explicit-feedback', feedbackKind: 'incorrect', attributionConfidence: 0.9 })
    expect((await service.experiences.readAll())[0]?.confidence).toBe(0.9)
    const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
    const candidate = base.replace('Base.', 'Improved.')
    const proposal = createProposal({ id: 'markdown-proposal', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Add timeout diagnosis' })
    expect(renderProposalMarkdown({ proposal })).toContain('## Proposed changes')
    expect(renderFailuresMarkdown([{ id: 'failure-1', skillName: 'api-debugging', task: 'debug', failure: 'timeout omitted', origin: 'implicit-follow-up', evidenceEventIds: [record.id], severity: 'medium', createdAt: record.createdAt, status: 'open' }])).toContain('failure-1')
  })

  it('exports operational usage metrics without claiming causality', () => {
    const events = [
      event({ id: 'catalog', kind: 'catalog-visible', sessionId: 's1', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'request', kind: 'skill-load-requested', sessionId: 's1', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'loaded', kind: 'skill-loaded', sessionId: 's1', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'follow', kind: 'user-follow-up', sessionId: 's1', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
    ]
    expect(aggregateMetrics(events).skills[0]).toMatchObject({ skillName: 'api-debugging', exposed: 1, loadSucceeded: 1, followUps: 1, exposureToLoadRate: 1 })
  })

  it('adds content-derived context metrics while retaining host-reported context cost', () => {
    const content = '---\nname: api-debugging\ndescription: Debug APIs\n---\n\nUse curl.\n'
    const measured = aggregateMetrics([
      event({ id: 'catalog', kind: 'catalog-visible', sessionId: 's1', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' } }),
      event({ id: 'loaded', kind: 'skill-loaded', sessionId: 's1', skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' }, payload: { inputTokens: 7 } }),
    ], [], [], [], [{ name: 'api-debugging', content }])
    const skill = measured.skills[0]!
    expect(skill.context).toMatchObject({ catalogTokens: expect.any(Number), loadTokens: expect.any(Number), exposureWeightedTokens: expect.any(Number) })
    expect(measured.skillContext.estimator).toBe('utf8-bytes-div4-v1')
    expect(measured.contextCost).toBe(7)
    expect(measured.skillContext.exposureWeightedTokens).toBe((skill.context?.catalogTokens ?? 0) + (skill.context?.loadTokens ?? 0))
  })
})
