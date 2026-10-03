export type OperationErrorCode =
  | 'not-found'
  | 'ambiguous'
  | 'invalid-option'
  | 'stale-base'
  | 'invalid-transition'
  | 'conflict'
  | 'evaluation-missing'
  | 'evaluation-mismatch'
  | 'gate-failed'

export class OperationError extends Error {
  constructor(readonly code: OperationErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'OperationError'
  }
}
