import type { DshEvaluationExecutor, DshEvaluationRunInput, DshEvaluationRunResult } from './evaluator.js'

export interface FakeDshExecutorOptions {
  readonly outcomes?: Readonly<Record<string, DshEvaluationRunResult['outcome']>>
  readonly delayMs?: number
  readonly script?: (input: DshEvaluationRunInput) => Partial<DshEvaluationRunResult>
}

/** Small controllable executor for deterministic unit and integration tests. */
export function createFakeDshExecutor(options: FakeDshExecutorOptions = {}): DshEvaluationExecutor {
  return async input => {
    if (options.delayMs !== undefined && options.delayMs > 0) await new Promise(resolve => setTimeout(resolve, options.delayMs))
    if (input.signal.aborted) throw input.signal.reason ?? new Error('evaluation aborted')
    const scripted = options.script?.(input) ?? {}
    const outcome = scripted.outcome ?? options.outcomes?.[input.caseId] ?? (input.skillContent.includes('candidate') ? 'improved' : 'unchanged')
    return {
      outcome,
      evidence: ['fake:run'],
      toolCalls: scripted.toolCalls ?? 0,
      modelTurns: scripted.modelTurns,
      tokenCost: scripted.tokenCost ?? input.skillContent.length,
      contextCost: scripted.contextCost ?? input.skillContent.length,
      sideEffects: [],
      securityViolations: [],
      userFeedback: [],
      confidence: 'high',
    }
  }
}
