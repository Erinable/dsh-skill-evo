import { describe, expect, it } from 'vitest'
import { createObservation } from '../src/events.js'
import { assessPattern, correlateToolAttempts, inputHash, recognizeCorrections, validateEpisodeDraft } from '../src/correction.js'
import { aggregateMetrics } from '../src/metrics.js'
import { renderFailuresMarkdown } from '../src/report.js'
import { EvolutionService } from '../src/service.js'
import { classifyCorrections } from '../src/operations.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { readCursor } from '../src/state-root.js'
import { isClassificationMemoEntry } from '../src/follow-up.js'
import { repairJsonlFile } from '../src/repair.js'

function event(id: string, kind: 'agent-step' | 'tool-result' | 'task-finished', payload: Record<string, unknown>, seq: number) {
  return createObservation({ id, kind, occurredAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`, sessionId: 's1', correlationIds: kind === 'tool-result' ? [payload.callId as string] : [], payload, source: 'runtime' })
}

describe('correction projection', () => {
  it('assesses window, retry-only, and promotion reset using latest proposal state', () => {
    const base = { id: 'pattern:episode:s1:e1', signatureKey: 'sig', intent: 'git push', errorSignature: 'exit:128|x', correction: ['set-env:https_proxy'], environmental: true, retryOnly: false, occurrences: [
      { episodeId: 'e0', sessionId: 'old', occurredAt: '2025-12-01T00:00:00.000Z' },
      { episodeId: 'e1', sessionId: 's1', occurredAt: '2026-01-20T00:00:00.000Z' },
      { episodeId: 'e2', sessionId: 's2', occurredAt: '2026-01-21T00:00:00.000Z' },
      { episodeId: 'e3', sessionId: 's3', occurredAt: '2026-01-22T00:00:00.000Z' },
    ], totalSessionCount: 4, firstSeenAt: '2025-12-01T00:00:00.000Z', lastSeenAt: '2026-01-22T00:00:00.000Z', policyVersion: 'correction-policy-v1' } as const
    const proposals = [
      { id: 'root', skillName: 'proxy', status: 'proposed', updatedAt: '2026-01-10T00:00:00.000Z', source: { kind: 'pattern', patternId: base.id } },
      { id: 'root:accepted', previousRecordId: 'root:proposed', skillName: 'proxy', status: 'accepted', updatedAt: '2026-01-12T00:00:00.000Z', source: { kind: 'pattern', patternId: base.id } },
      { id: 'root:promoted', previousRecordId: 'root:accepted', skillName: 'proxy', status: 'promoted', updatedAt: '2026-01-15T00:00:00.000Z', source: { kind: 'pattern', patternId: base.id } },
    ]
    expect(assessPattern({ pattern: base, now: '2026-02-14T00:00:00.000Z', proposals })).toMatchObject({ candidate: true, windowSessionCount: 3, promotedSkill: 'proxy' })
    expect(assessPattern({ pattern: { ...base, retryOnly: true }, now: '2026-02-14T00:00:00.000Z' })).toMatchObject({ candidate: false, candidateReason: 'retry-only' })
    expect(assessPattern({ pattern: { ...base, occurrences: base.occurrences.slice(0, 2), totalSessionCount: 2 }, now: '2026-02-14T00:00:00.000Z' })).toMatchObject({ candidate: false, candidateReason: 'insufficient-evidence' })
  })

  it('excludes a complete 31-day-old window and accepts the same sessions at 29 days', () => {
    const pattern = { id: 'pattern:old', signatureKey: 'sig', intent: 'git push', errorSignature: 'exit:128|x', correction: ['set-env:https_proxy'], environmental: true, retryOnly: false, occurrences: ['s1', 's2', 's3'].map((sessionId, i) => ({ episodeId: `e${i}`, sessionId, occurredAt: `2026-01-14T00:0${i}:00.000Z` })), totalSessionCount: 3, firstSeenAt: '2026-01-14T00:00:00.000Z', lastSeenAt: '2026-01-14T00:02:00.000Z', policyVersion: 'correction-policy-v1' } as const
    expect(assessPattern({ pattern, now: '2026-02-15T00:00:00.000Z' })).toMatchObject({ candidate: false, windowSessionCount: 0, candidateReason: 'insufficient-evidence' })
    expect(assessPattern({ pattern, now: '2026-02-13T00:00:00.000Z' })).toMatchObject({ candidate: true, windowSessionCount: 3 })
  })

  it('renders policy-aware correction metrics and reports', () => {
    const pattern = { id: 'pattern:episode:s1:e1', signatureKey: 'sig', intent: 'git push', errorSignature: 'exit:128|x', correction: ['set-env:https_proxy'], environmental: true, retryOnly: false, occurrences: [{ episodeId: 'e1', sessionId: 's1', occurredAt: '2026-01-20T00:00:00.000Z' }], totalSessionCount: 1, firstSeenAt: '2026-01-20T00:00:00.000Z', lastSeenAt: '2026-01-20T00:00:00.000Z', policyVersion: 'correction-policy-v1' } as const
    const metrics = aggregateMetrics([], [], [], [], [], { episodes: [], patterns: [pattern], now: '2026-02-14T00:00:00.000Z', rejectedDrafts: 2 })
    expect(metrics.corrections).toMatchObject({ episodes: 0, patterns: 1, recognizer: { version: 'none' }, assessments: [{ patternId: pattern.id, candidate: false, candidateReason: 'insufficient-evidence', target: 'undecided' }] })
    const report = renderFailuresMarkdown([], { patterns: [pattern], now: '2026-02-14T00:00:00.000Z' })
    expect(report).toContain('Self-corrections')
    expect(report).toContain('target: undecided')
  })
  it('groups three failures and emits only the environment correction', () => {
    const events = [1, 2, 3].flatMap((n, i) => { const id = `c${n}`; return [event(id, 'agent-step', { toolName: 'bash', command: 'git push origin main' }, i * 2), event(`r${n}`, 'tool-result', { callId: id, exitCode: 128, errorLine: 'connect port 443' }, i * 2 + 1)] })
    const call = event('c4', 'agent-step', { toolName: 'bash', command: 'HTTPS_PROXY=http://10.0.0.1:7890 git push origin main' }, 7)
    const result = event('r4', 'tool-result', { callId: 'c4', exitCode: 0 }, 8)
    const drafts = recognizeCorrections('s1', correlateToolAttempts([...events, call, result]))
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.failureObservationIds).toEqual(['r1', 'r2', 'r3'])
    expect(drafts[0]?.correction).toEqual(['set-env:https_proxy'])
  })

  it('keeps unrelated intents outside the correction interval and records export evidence', () => {
    const rows = [
      ['a1', 'git push', 128], ['ls', 'ls', 0], ['a2', 'git push', 128], ['a3', 'git push', 128], ['proxy', 'export HTTPS_PROXY=http://10.0.0.1:7890', 0], ['ok', 'git push origin main', 0],
    ].flatMap(([id, command, exit], i) => { const c = event(id as string, 'agent-step', { toolName: 'bash', command }, i * 2); return [c, event(`rr${i}`, 'tool-result', { callId: id, exitCode: exit }, i * 2 + 1)] })
    const draft = recognizeCorrections('s1', correlateToolAttempts(rows))[0]!
    expect(draft.correctionObservationIds).toEqual(['rr4'])
    expect(draft.correction).toEqual(['set-env:https_proxy'])
  })

  it('writes a tool experience for a correction without a loaded skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-'))
    const service = new EvolutionService({ root })
    for (let i = 0; i < 2; i++) {
      const c = event(`x${i}`, 'agent-step', { toolName: 'bash', command: 'git push' }, i * 2)
      await service.recordObservation(c); await service.recordObservation(event(`y${i}`, 'tool-result', { callId: c.id, exitCode: 128 }, i * 2 + 1))
    }
    const c = event('ok', 'agent-step', { toolName: 'bash', command: 'HTTPS_PROXY=x git push' }, 5); await service.recordObservation(c); await service.recordObservation(event('ok-r', 'tool-result', { callId: c.id, exitCode: 0 }, 6))
    const snapshot = await service.refreshDerived()
    expect(snapshot.experiences.some(item => item.attribution === 'tool')).toBe(true)
    expect(snapshot.episodes[0]?.fallbackReason).toBe('not-classified')
    expect(snapshot.episodes[0]?.recognizerVersion).toBe('rule-1')
  })

  it('times out a classifier that ignores AbortSignal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-timeout-'))
    const service = new EvolutionService({ root, classifierTimeoutMs: 20, correctionClassifier: { version: 'hang-1', classify: async () => await new Promise<never>(() => undefined) } })
    await service.recordObservation(event('finish', 'task-finished', {}, 1))
    const result = await classifyCorrections(service)
    expect(result.failed[0]?.reason).toBe('timeout')
  })

  it('rejects missing command/result and short or invalid drafts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-invalid-'))
    const service = new EvolutionService({ root })
    await service.recordObservation(event('missing-command', 'agent-step', { toolName: 'bash' }, 1))
    await service.recordObservation(event('short', 'agent-step', { toolName: 'bash', command: 'git push' }, 2))
    const snapshot = await service.refreshDerived()
    expect(snapshot.episodes).toHaveLength(0)
    const attempts = correlateToolAttempts([event('f', 'agent-step', { toolName: 'bash', command: 'git push' }, 3), event('fr', 'tool-result', { callId: 'f', exitCode: 128 }, 4)])
    expect(validateEpisodeDraft({ intent: 'git push', errorSignature: 'exit:128|x', correction: [], failureObservationIds: ['fr'], correctionObservationIds: [], successObservationId: 'missing' }, attempts)).toBe(false)
    expect(isClassificationMemoEntry({ id: 'classification:correction:v:h', judge: 'correction', classifierVersion: 'v', inputHash: 'h', sessionId: 's', drafts: [], createdAt: new Date().toISOString() })).toBe(true)
  })

  it('rejects a draft with too few failures when its references are otherwise valid', () => {
    const attempts = correlateToolAttempts([event('f', 'agent-step', { toolName: 'bash', command: 'git push' }, 3), event('fr', 'tool-result', { callId: 'f', exitCode: 128 }, 4), event('s', 'agent-step', { toolName: 'bash', command: 'git push' }, 5), event('sr', 'tool-result', { callId: 's', exitCode: 0 }, 6)])
    expect(validateEpisodeDraft({ intent: 'git push', errorSignature: 'exit:128|x', correction: [], failureObservationIds: ['fr'], correctionObservationIds: [], successObservationId: 'sr' }, attempts)).toBe(false)
  })

  it('rejects a draft with enough failures when one reference is unknown', () => {
    const attempts = correlateToolAttempts([event('f1', 'agent-step', { toolName: 'bash', command: 'git push' }, 3), event('fr1', 'tool-result', { callId: 'f1', exitCode: 128 }, 4), event('f2', 'agent-step', { toolName: 'bash', command: 'git push' }, 5), event('fr2', 'tool-result', { callId: 'f2', exitCode: 128 }, 6), event('s', 'agent-step', { toolName: 'bash', command: 'git push' }, 7), event('sr', 'tool-result', { callId: 's', exitCode: 0 }, 8)])
    expect(validateEpisodeDraft({ intent: 'git push', errorSignature: 'exit:128|x', correction: [], failureObservationIds: ['fr1', 'missing'], correctionObservationIds: [], successObservationId: 'sr' }, attempts)).toBe(false)
  })

  it('counts invalid memo drafts rejected during projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-rejected-')); const service = new EvolutionService({ root })
    const call = event('memo-call', 'agent-step', { toolName: 'bash', command: 'git push' }, 1); const result = event('memo-result', 'tool-result', { callId: call.id, exitCode: 128 }, 2); await service.recordObservation(call); await service.recordObservation(result); await service.recordObservation(event('finish', 'task-finished', {}, 3))
    const hash = inputHash(correlateToolAttempts([call, result])); await service.classifications.append({ id: `classification:correction:rule-1:${hash}`, judge: 'correction', classifierVersion: 'rule-1', inputHash: hash, sessionId: 's1', drafts: [{ intent: 'git push', errorSignature: 'x', correction: [], failureObservationIds: ['missing'], correctionObservationIds: [], successObservationId: 'missing' }], createdAt: new Date().toISOString() } as never); await service.refreshDerived()
    expect((await service.metrics()).corrections?.rejectedDrafts).toBe(1)
    expect((await new EvolutionService({ root }).metrics()).corrections?.rejectedDrafts).toBe(1)
  })

  it('skips corrupt manifests while computing metrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corrupt-manifest-')); await mkdir(join(root, 'broken', 'versions'), { recursive: true }); await writeFile(join(root, 'broken', 'manifest.json'), '{broken', 'utf8'); await writeFile(join(root, 'broken', 'SKILL.md'), '---\nname: broken\ndescription: x\n---\nBody\n', 'utf8')
    const service = new EvolutionService({ root }); await service.recordObservation(createObservation({ id: 'broken-event', kind: 'skill-loaded', occurredAt: new Date().toISOString(), sessionId: 'broken-session', skill: { name: 'broken', provider: 'test', source: 'test' }, correlationIds: [], payload: {}, source: 'runtime' })); const metrics = await service.metrics(); expect(metrics.skills.find(skill => skill.skillName === 'broken')?.context).toBeUndefined()
  })

  it('does not call classifier for an open session and records classifier failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-failure-')); let calls = 0
    const classifier = { version: 'throws-1', classify: async () => { calls++; throw new Error('boom') } }
    const service = new EvolutionService({ root, correctionClassifier: classifier })
    await service.recordObservation(event('open', 'agent-step', { toolName: 'bash', command: 'git push' }, 1))
    const open = await classifyCorrections(service); expect(open.skipped.open).toBe(1); expect(calls).toBe(0)
    await service.recordObservation(event('done', 'task-finished', {}, 2)); const failed = await classifyCorrections(service)
    expect(failed.failed).toHaveLength(1); expect(await service.classifications.readAll()).toHaveLength(0); expect((await service.metrics()).corrections?.classifierFailures).toBe(1); expect((await new EvolutionService({ root }).metrics()).corrections?.classifierFailures).toBe(1)
    const second = new EvolutionService({ root, correctionClassifier: classifier }); const secondFailed = await classifyCorrections(second); expect(secondFailed.failed).toHaveLength(1); expect((await new EvolutionService({ root }).metrics()).corrections?.classifierFailures).toBe(2)
  })

  it('round-trips rule output through a memo without projection classifier calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-roundtrip-')); const base = new EvolutionService({ root })
    for (let i = 0; i < 2; i++) { const c = event(`b${i}`, 'agent-step', { toolName: 'bash', command: 'git push' }, i * 2); await base.recordObservation(c); await base.recordObservation(event(`br${i}`, 'tool-result', { callId: c.id, exitCode: 128 }, i * 2 + 1)) }
    const ok = event('bok', 'agent-step', { toolName: 'bash', command: 'HTTPS_PROXY=x git push' }, 5); await base.recordObservation(ok); await base.recordObservation(event('bokr', 'tool-result', { callId: ok.id, exitCode: 0 }, 6)); await base.recordObservation(event('finish', 'task-finished', {}, 7))
    const before = await base.refreshDerived(); const obsBytes = await readFile(base.observations.filePath, 'utf8')
    let calls = 0; const classifier = { version: 'fake-1', classify: async (_input: unknown, _signal: AbortSignal) => { calls++; return [{ ...recognizeCorrections('s1', correlateToolAttempts(await base.observations.readAll()))[0]!, correction: ['model-said'] }] } }
    const injected = new EvolutionService({ root, correctionClassifier: classifier }); await injected.refreshDerived(); expect(calls).toBe(0); await classifyCorrections(injected); const changed = await injected.refreshDerived(); expect(calls).toBe(1); expect(changed.episodes[0]?.correction).toEqual(['model-said'])
    const memoBytes = await readFile(injected.classifications.filePath, 'utf8'); expect(isClassificationMemoEntry(JSON.parse(memoBytes.trim()))).toBe(true); const repair = await repairJsonlFile(injected.classifications.filePath, { parse: isClassificationMemoEntry }); expect(repair.validRecords).toBe(1); expect(repair.removedInvalidLines).toBe(0); expect(await readFile(injected.classifications.filePath, 'utf8')).toBe(memoBytes)
    const restored = new EvolutionService({ root }); const after = await restored.refreshDerived(); expect(after.episodes).toEqual(before.episodes); expect(after.patterns[0]?.id).toBe('pattern:episode:s1:br0'); expect(await readFile(restored.observations.filePath, 'utf8')).toBe(obsBytes); const originalKey = (await readCursor(restored.layout.cursorPath))?.derivationKey
    const fake2 = new EvolutionService({ root, correctionClassifier: { version: 'fake-2', classify: async () => [] } }); const fake2Snapshot = await fake2.refreshDerived(); expect(fake2Snapshot.patterns[0]?.id).toBe(after.patterns[0]?.id); expect((await readCursor(fake2.layout.cursorPath))?.derivationKey).not.toBe(originalKey)
    const changedRules = new EvolutionService({ root, correctionRulesVersion: 'rule-2' }); await changedRules.refreshDerived(); expect((await readCursor(changedRules.layout.cursorPath))?.derivationKey).not.toBe(originalKey)
    const changedWindow = new EvolutionService({ root, windowRulesVersion: 'skill-windows-v2' }); await changedWindow.refreshDerived(); expect((await readCursor(changedWindow.layout.cursorPath))?.derivationKey).not.toBe(originalKey)
    const patternId = before.patterns[0]?.id; const proposalSource = { kind: 'pattern', patternId }; expect(fake2Snapshot.patterns.some(pattern => pattern.id === proposalSource.patternId)).toBe(true)
  })
})
