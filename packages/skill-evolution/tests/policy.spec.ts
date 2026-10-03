import { describe, expect, it } from 'vitest'
import { evaluateCandidate, normalizeEvaluationPolicy } from '../src/index.js'

const basePolicy = { schema: 2 as const, version: '2', maxRegressionCount: 0, maxSecurityViolations: 0, requireNoNewSideEffects: true }
const skill = '---\nname: demo\ndescription: Demo\n---\n\nBody\n'
const evaluationCase = [{ id: 'case', category: 'original-failure' as const, task: 'test' }]

describe('evaluation policy contract', () => {
  it('normalizes schema 2 defaults, explicit nulls, and schema 1 legacy fields', () => {
    expect(normalizeEvaluationPolicy(basePolicy)).toMatchObject({
      schema: 2, sampling: { runs: 5 }, significance: { alpha: 0.05 },
      originalFailure: { costMetric: 'steps', minCostReduction: 0.2 },
      historicalSuccess: { maxPassRateDrop: 0.05, maxStepIncrease: 0.1, maxTokenIncrease: 0.1 },
      context: { maxCatalogIncreaseTokens: 64, maxLoadIncreaseTokens: 1024 },
    })
    expect(normalizeEvaluationPolicy({ ...basePolicy, originalFailure: { costMetric: null }, historicalSuccess: { maxStepIncrease: null, maxTokenIncrease: null }, context: { maxCatalogIncreaseTokens: null, maxLoadIncreaseTokens: null } })).toMatchObject({ originalFailure: { costMetric: null }, historicalSuccess: { maxStepIncrease: null, maxTokenIncrease: null }, context: { maxCatalogIncreaseTokens: null, maxLoadIncreaseTokens: null } })
    expect(normalizeEvaluationPolicy({ version: '1', maxRegressionCount: 0, maxSecurityViolations: 0, requireNoNewSideEffects: true, requireOriginalFailureImprovement: true, maxTokenIncreaseRatio: 0.2, maxContextIncreaseRatio: 0.3 })).toMatchObject({ schema: 1, sampling: { runs: 1 }, legacy: { maxTokenIncreaseRatio: 0.2, maxContextIncreaseRatio: 0.3 } })
  })

  it('rejects invalid schema 2 policy before invoking the runner', async () => {
    const invalid = [
      { schema: 3 }, { schema: '2' }, { maxTokenIncreaseRatio: 0.1 }, { maxContextIncreaseRatio: 0.1 }, { requireOriginalFailureImprovement: true },
      { sampling: { runs: 0 } }, { sampling: { runs: 21 } }, { sampling: { runs: 1.5 } }, { significance: { alpha: 0 } }, { significance: { alpha: 0.6 } },
      { originalFailure: { costMetric: 'step' } }, { originalFailure: { requireImprovement: 'yes' } }, { requireNoNewSideEffects: 'yes' },
    ]
    for (const extra of invalid) {
      let calls = 0
      await expect(evaluateCandidate({ candidateId: 'candidate', baseContent: skill, candidateContent: skill, cases: evaluationCase, policy: { ...basePolicy, ...extra } as never, runner: async () => { calls += 1; return { passed: true } } })).rejects.toThrow()
      expect(calls).toBe(0)
    }
  })
})
