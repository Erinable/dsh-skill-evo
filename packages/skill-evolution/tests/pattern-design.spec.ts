import { describe, expect, it } from 'vitest'
import { createPatternProposal, selectPatternTarget, validateEnvironmentNeutralCandidate } from '../src/pattern-design.js'
import type { CorrectionPattern } from '../src/types.js'

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
    expect(proposal.skillName).toMatch(/^pattern-[a-z0-9-]+$/u)
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
})
