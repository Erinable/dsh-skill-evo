import type { EvaluationPolicyInput, NormalizedEvaluationPolicy } from './types.js'

export function normalizeEvaluationPolicy(policy: EvaluationPolicyInput): NormalizedEvaluationPolicy {
  validateEvaluationPolicy(policy)
  if ('schema' in policy && policy.schema === 2) {
    return {
      schema: 2, version: policy.version, maxRegressionCount: policy.maxRegressionCount,
      maxSecurityViolations: policy.maxSecurityViolations, requireNoNewSideEffects: policy.requireNoNewSideEffects,
      requirePositiveFeedback: policy.requirePositiveFeedback ?? false,
      sampling: { runs: policy.sampling?.runs ?? 5 }, significance: { alpha: policy.significance?.alpha ?? 0.05 },
      originalFailure: { requireImprovement: policy.originalFailure?.requireImprovement ?? true, costMetric: policy.originalFailure?.costMetric ?? 'steps', minCostReduction: policy.originalFailure?.minCostReduction ?? 0.2 },
      historicalSuccess: { maxPassRateDrop: policy.historicalSuccess?.maxPassRateDrop ?? 0.05, maxStepIncrease: policy.historicalSuccess?.maxStepIncrease ?? 0.1, maxTokenIncrease: policy.historicalSuccess?.maxTokenIncrease ?? 0.1 },
      context: { maxCatalogIncreaseTokens: policy.context?.maxCatalogIncreaseTokens ?? 64, maxLoadIncreaseTokens: policy.context?.maxLoadIncreaseTokens ?? 1024 },
      legacy: {},
    }
  }
  const legacyPolicy = policy as Extract<EvaluationPolicyInput, { readonly requireOriginalFailureImprovement: boolean }>
  return {
    schema: 1, version: policy.version, maxRegressionCount: policy.maxRegressionCount,
    maxSecurityViolations: policy.maxSecurityViolations, requireNoNewSideEffects: policy.requireNoNewSideEffects,
    requirePositiveFeedback: policy.requirePositiveFeedback ?? false,
    sampling: { runs: 1 }, significance: { alpha: 0.05 },
    originalFailure: { requireImprovement: legacyPolicy.requireOriginalFailureImprovement, costMetric: null, minCostReduction: 0 },
    historicalSuccess: { maxPassRateDrop: 0.05, maxStepIncrease: null, maxTokenIncrease: null },
    context: { maxCatalogIncreaseTokens: null, maxLoadIncreaseTokens: null },
    legacy: { ...(legacyPolicy.maxTokenIncreaseRatio === undefined ? {} : { maxTokenIncreaseRatio: legacyPolicy.maxTokenIncreaseRatio }), ...(legacyPolicy.maxContextIncreaseRatio === undefined ? {} : { maxContextIncreaseRatio: legacyPolicy.maxContextIncreaseRatio }) },
  }
}

export function validateEvaluationPolicy(policy: EvaluationPolicyInput): void {
  if (!policy.version || !Number.isInteger(policy.maxRegressionCount) || policy.maxRegressionCount < 0 || !Number.isInteger(policy.maxSecurityViolations) || policy.maxSecurityViolations < 0) throw new Error('invalid evaluation policy thresholds')
  if ('schema' in policy && policy.schema === 2) {
    const legacy = policy as unknown as Record<string, unknown>
    if ('requireOriginalFailureImprovement' in legacy || 'maxTokenIncreaseRatio' in legacy || 'maxContextIncreaseRatio' in legacy) throw new Error('schema 2 policy contains schema 1 fields')
    const runs = policy.sampling?.runs
    if (runs !== undefined && (!Number.isInteger(runs) || runs < 1 || runs > 20)) throw new Error('sampling.runs must be an integer from 1 through 20')
    const alpha = policy.significance?.alpha
    if (alpha !== undefined && (!Number.isFinite(alpha) || alpha <= 0 || alpha > 0.5)) throw new Error('significance.alpha must be in (0, 0.5]')
    const reduction = policy.originalFailure?.minCostReduction
    if (reduction !== undefined && (!Number.isFinite(reduction) || reduction <= 0 || reduction >= 1)) throw new Error('originalFailure.minCostReduction must be in (0, 1)')
    for (const value of [policy.historicalSuccess?.maxPassRateDrop, policy.historicalSuccess?.maxStepIncrease, policy.historicalSuccess?.maxTokenIncrease, policy.context?.maxCatalogIncreaseTokens, policy.context?.maxLoadIncreaseTokens]) if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) throw new Error('schema 2 policy thresholds must be non-negative numbers')
  } else {
    const legacyPolicy = policy as Extract<EvaluationPolicyInput, { readonly requireOriginalFailureImprovement: boolean }>
    for (const value of [legacyPolicy.maxTokenIncreaseRatio, legacyPolicy.maxContextIncreaseRatio]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('evaluation cost ratios must be non-negative numbers')
  }
}
