export type OperationErrorCode =
  | 'not-found'
  | 'ambiguous'
  | 'ambiguous-target'
  | 'insufficient-evidence'
  | 'already-proposed'
  | 'designer-failed'
  | 'invalid-option'
  | 'stale-base'
  | 'invalid-transition'
  | 'conflict'
  | 'evaluation-missing'
  | 'evaluation-mismatch'
  | 'gate-failed'
  | 'classifier-unavailable'
  | 'scope-not-allowed'

export class OperationError extends Error {
  constructor(readonly code: OperationErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'OperationError'
  }
}
