import { ObservationLog, type RetentionResult } from './state-root.js'
export type { RetentionResult } from './state-root.js'

/** Rotate a JSONL fact file and delete archives older than the retention window. */
export async function rotateJsonl(path: string, options: { readonly maxBytes: number; readonly retentionDays?: number }): Promise<RetentionResult> {
  return new ObservationLog(path).rotate(options)
}
