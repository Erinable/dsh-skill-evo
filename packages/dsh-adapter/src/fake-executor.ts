import type { DshEvaluationExecutor, DshEvaluationRunResult } from './evaluator.js'

export interface FakeDshExecutorOptions {
  readonly outcomes?: Readonly<Record<string, DshEvaluationRunResult['outcome']>>
  readonly delayMs?: number
}

/** Small controllable executor for deterministic unit and integration tests. */
export function createFakeDshExecutor(options: FakeDshExecutorOptions = {}): DshEvaluationExecutor {
  return async input => {
    if (options.delayMs !== undefined && options.delayMs > 0) await new Promise(resolve => setTimeout(resolve, options.delayMs))
    if (input.signal.aborted) throw input.signal.reason ?? new Error('evaluation aborted')
    const outcome = options.outcomes?.[input.caseId] ?? (input.skillContent.includes('candidate') ? 'improved' : 'unchanged')
    return {
      outcome,
      evidence: ['fake:run'],
      toolCalls: 0,
      tokenCost: input.skillContent.length,
      contextCost: input.skillContent.length,
      sideEffects: [],
      securityViolations: [],
      userFeedback: [],
      confidence: 'high',
    }
  }
}
