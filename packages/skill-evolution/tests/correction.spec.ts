import { describe, expect, it } from 'vitest'
import { createObservation } from '../src/events.js'
import { correlateToolAttempts, recognizeCorrections } from '../src/correction.js'
import { EvolutionService } from '../src/service.js'
import { classifyCorrections } from '../src/operations.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
})
