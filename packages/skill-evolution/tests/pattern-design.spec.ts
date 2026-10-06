import { describe, expect, it } from 'vitest'
import { createPatternProposal, selectPatternTarget, validateEnvironmentNeutralCandidate } from '../src/pattern-design.js'
import type { CorrectionPattern } from '../src/types.js'
import { createObservation } from '../src/events.js'
import { EvolutionService } from '../src/service.js'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const pattern: CorrectionPattern = {
  id: 'pattern:episode:s1:s1-r0', signatureKey: 'network-failure', intent: 'upload artifact', errorSignature: 'exit 443: refused', correction: ['set-env:HTTPS_PROXY'], environmental: true, retryOnly: false,
  occurrences: [
    { episodeId: 'episode:s1:s1-r0', sessionId: 's1', occurredAt: '2026-10-01T00:00:00.000Z' },
    { episodeId: 'episode:s2:s2-r0', sessionId: 's2', occurredAt: '2026-10-02T00:00:00.000Z' },
    { episodeId: 'episode:s3:s3-r0', sessionId: 's3', occurredAt: '2026-10-03T00:00:00.000Z' },
  ], totalSessionCount: 3, firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-03T00:00:00.000Z', policyVersion: 'correction-policy-v1',
}

describe('pattern design contracts', () => {
  it('uses the documented target order and records rationale', () => {
    expect(selectPatternTarget({ promotedTarget: 'promoted', explicitSkill: 'explicit', loadedSkills: { loaded: 2 }, similarities: { similar: 0.9 } })).toMatchObject({ target: 'promoted', reason: 'promoted' })
    expect(selectPatternTarget({ explicitSkill: 'explicit' })).toMatchObject({ target: 'explicit', reason: 'explicit' })
    expect(selectPatternTarget({ loadedSkills: { loaded: 2, other: 1 } })).toMatchObject({ target: 'loaded', reason: 'majority-loaded' })
    expect(selectPatternTarget({ similarities: { similar: 0.5 } })).toMatchObject({ target: 'similar', reason: 'similarity' })
    expect(selectPatternTarget({ similarities: { a: 0.7, b: 0.7 } })).toMatchObject({ reason: 'ambiguous', candidates: ['a', 'b'] })
    expect(selectPatternTarget({ similarities: { unrelated: 0.2 } })).toMatchObject({ reason: 'create-skill' })
  })

  it('creates an ADR-0021 compatible create-skill record with absent Base', () => {
    const proposal = createPatternProposal({ pattern, proposedVersion: '1.0.0', candidateContent: '---\nname: generated\n---\nProcedure.' , targetReason: 'create-skill' })
    expect(proposal.skillName).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    expect(proposal.operation).toBe('create-skill')
    expect(proposal.baseVersion).toBe('absent')
    expect(proposal.expectedBase.contentHash).toBe('absent')
    expect(proposal.source).toMatchObject({ kind: 'pattern', patternId: pattern.id, targetReason: 'create-skill' })
  })

  it.each([
    ['host', 'Use proxy.corp.internal:3128', ['proxy.corp.internal:3128']],
    ['ip', 'Use 10.0.0.4', ['10.0.0.4']],
    ['userinfo', 'Use https://user:secret@proxy.example', []],
    ['redacted', 'Use [REDACTED]', []],
  ])('rejects environment-specific candidate: %s', (_name, candidate, observed) => {
    expect(validateEnvironmentNeutralCandidate(candidate, observed)).toMatchObject({ valid: false })
  })

  it('runs the K-session create-skill flow and records source and ledger ids', async () => {
    const { service, patternId } = await fixture()
    const proposal = await service.proposePattern(patternId, async () => '---\nname: generated\ndescription: Conditional network procedure\n---\nThen rerun: git push origin main\n', { proposedVersion: '1.0.0' })
    expect(proposal.status).toBe('proposed')
    expect(proposal.operation).toBe('create-skill')
    expect(proposal.baseVersion).toBe('absent')
    expect(proposal.expectedBase.contentHash).toBe('absent')
    expect(proposal.source).toMatchObject({ kind: 'pattern', patternId, targetReason: 'create-skill' })
    expect(proposal.source?.signatureKey).toBeTruthy()
    expect(proposal.source?.episodeIds).toHaveLength(3)
    expect(proposal.source?.evidenceEventIds?.length).toBeGreaterThan(0)
    const rows = await service.proposals.readAll()
    expect(rows.at(-1)).toMatchObject({ id: proposal.id, status: 'proposed', previousRecordId: proposal.id })
    expect(proposal.id).toMatch(/^proposal:[^:]+$/u)
  })

  it.each([
    'Use proxy.corp.internal', 'Use proxy.corp.internal:3128', 'Ask alice for access', 'token pw123', 'Connect to 10.0.0.4',
  ])('rejects observed proxy value before writing state: %s', async candidate => {
    const { service, patternId } = await fixture()
    await expect(service.proposePattern(patternId, async () => `---\nname: generated\n---\n${candidate}\n`, { proposedVersion: '1.0.0' })).rejects.toMatchObject({ code: 'invalid-option' })
    expect(await service.proposals.readAll()).toHaveLength(0)
    await expect(readdir(service.layout.candidatesDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts an ordinary command while selecting a related managed Skill by similarity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pattern-similarity-'))
    await writeFile(join(root, 'network-helper', 'SKILL.md'), '---\nname: network-helper\ndescription: git push failed on 443; set HTTPS_PROXY before retry\n---\n', 'utf8').catch(async () => { await (await import('node:fs/promises')).mkdir(join(root, 'network-helper'), { recursive: true }); await writeFile(join(root, 'network-helper', 'SKILL.md'), '---\nname: network-helper\ndescription: git push failed on 443; set HTTPS_PROXY before retry\n---\n', 'utf8') })
    const service = new EvolutionService({ root }); const patternId = await seed(service, 'network-helper')
    const proposal = await service.proposePattern(patternId, async () => '---\nname: network-helper\n---\nThen rerun: git push origin main\n', { proposedVersion: '1.0.0' })
    expect(proposal.skillName).toBe('network-helper')
    expect(proposal.source?.targetReason).toBe('similarity')
    expect(proposal.operation).toBe('patch-content')
  })
})

async function fixture(): Promise<{ readonly service: EvolutionService; readonly patternId: string }> {
  const service = new EvolutionService({ root: await mkdtemp(join(tmpdir(), 'pattern-service-')) })
  return { service, patternId: await seed(service) }
}

async function seed(service: EvolutionService, _skillName?: string): Promise<string> {
  const base = Date.now() - 60_000
  for (let session = 0; session < 3; session += 1) {
    const sessionId = `s${session + 1}`
    const rows = [...Array.from({ length: 3 }, (_, index) => ({ command: 'git push origin main', exitCode: 128, id: `${sessionId}-f${index}` })), { command: 'HTTPS_PROXY=http://alice:pw123@proxy.corp.internal:3128 git push origin main', exitCode: 0, id: `${sessionId}-success` }]
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!
      const callId = `${row.id}-call`; const at = new Date(base + session * 1000 + index * 100).toISOString()
      await service.recordObservation(createObservation({ id: callId, kind: 'agent-step', occurredAt: at, sessionId, correlationIds: [], payload: { toolName: 'bash', command: row.command }, source: 'runtime' }))
      await service.recordObservation(createObservation({ id: `${row.id}-result`, kind: 'tool-result', occurredAt: new Date(base + session * 1000 + index * 100 + 1).toISOString(), sessionId, correlationIds: [callId], payload: { callId, exitCode: row.exitCode, ...(row.exitCode === 128 ? { errorLine: 'connect port 443' } : {}) }, source: 'runtime' }))
    }
    await service.recordObservation(createObservation({ id: `${sessionId}-finished`, kind: 'task-finished', occurredAt: new Date(base + session * 1000 + 999).toISOString(), sessionId, correlationIds: [], payload: {}, source: 'runtime' }))
  }
  const snapshot = await service.refreshDerived()
  return snapshot.patterns.find(item => item.totalSessionCount >= 3)?.id ?? snapshot.patterns[0]!.id
}
