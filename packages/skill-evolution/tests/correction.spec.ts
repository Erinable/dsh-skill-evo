import { describe, expect, it } from 'vitest'
import { createObservation } from '../src/events.js'
import { correlateToolAttempts, recognizeCorrections } from '../src/correction.js'
import { EvolutionService } from '../src/service.js'
import { classifyCorrections } from '../src/operations.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { readCursor } from '../src/state-root.js'
import { isClassificationMemoEntry } from '../src/follow-up.js'

function event(id: string, kind: 'agent-step' | 'tool-result' | 'task-finished', payload: Record<string, unknown>, seq: number) {
  return createObservation({ id, kind, occurredAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`, sessionId: 's1', correlationIds: kind === 'tool-result' ? [payload.callId as string] : [], payload, source: 'runtime' })
}

describe('correction projection', () => {
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
    expect(isClassificationMemoEntry({ id: 'classification:correction:v:h', judge: 'correction', classifierVersion: 'v', inputHash: 'h', sessionId: 's', drafts: [], createdAt: new Date().toISOString() })).toBe(true)
  })

  it('does not call classifier for an open session and records classifier failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-failure-')); let calls = 0
    const classifier = { version: 'throws-1', classify: async () => { calls++; throw new Error('boom') } }
    const service = new EvolutionService({ root, correctionClassifier: classifier })
    await service.recordObservation(event('open', 'agent-step', { toolName: 'bash', command: 'git push' }, 1))
    const open = await classifyCorrections(service); expect(open.skipped.open).toBe(1); expect(calls).toBe(0)
    await service.recordObservation(event('done', 'task-finished', {}, 2)); const failed = await classifyCorrections(service)
    expect(failed.failed).toHaveLength(1); expect(await service.classifications.readAll()).toHaveLength(0); expect((await service.metrics()).corrections?.classifierFailures).toBe(1)
  })

  it('round-trips rule output through a memo without projection classifier calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'correction-roundtrip-')); const base = new EvolutionService({ root })
    for (let i = 0; i < 2; i++) { const c = event(`b${i}`, 'agent-step', { toolName: 'bash', command: 'git push' }, i * 2); await base.recordObservation(c); await base.recordObservation(event(`br${i}`, 'tool-result', { callId: c.id, exitCode: 128 }, i * 2 + 1)) }
    const ok = event('bok', 'agent-step', { toolName: 'bash', command: 'HTTPS_PROXY=x git push' }, 5); await base.recordObservation(ok); await base.recordObservation(event('bokr', 'tool-result', { callId: ok.id, exitCode: 0 }, 6)); await base.recordObservation(event('finish', 'task-finished', {}, 7))
    const before = await base.refreshDerived(); const obsBytes = await readFile(base.observations.filePath, 'utf8')
    let calls = 0; const classifier = { version: 'fake-1', classify: async (_input: unknown, _signal: AbortSignal) => { calls++; return [{ ...recognizeCorrections('s1', correlateToolAttempts(await base.observations.readAll()))[0]!, correction: ['model-said'] }] } }
    const injected = new EvolutionService({ root, correctionClassifier: classifier }); await injected.refreshDerived(); expect(calls).toBe(0); await classifyCorrections(injected); const changed = await injected.refreshDerived(); expect(calls).toBe(1); expect(changed.episodes[0]?.correction).toEqual(['model-said'])
    const restored = new EvolutionService({ root }); const after = await restored.refreshDerived(); expect(after.episodes).toEqual(before.episodes); expect(after.patterns[0]?.id).toBe('pattern:episode:s1:br0'); expect(await readFile(restored.observations.filePath, 'utf8')).toBe(obsBytes); expect((await readCursor(restored.layout.cursorPath))?.derivationKey).toBeTruthy()
  })
})
