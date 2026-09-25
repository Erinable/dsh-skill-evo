import { createHash } from 'node:crypto'
import type { RuntimeObservation } from './types.js'

/** Hash an exact UTF-8 Skill snapshot for runtime and adoption evidence. */
export function createContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Build a runtime observation while enforcing the fixed schema version. */
export function createObservation(
  input: Omit<RuntimeObservation, 'schemaVersion'>,
): RuntimeObservation {
  return {
    ...input,
    schemaVersion: 1,
    correlationIds: [...input.correlationIds],
    payload: { ...input.payload },
  }
}

/** Serialize one observation as one JSONL record. */
export function serializeObservation(event: RuntimeObservation): string {
  return `${JSON.stringify(event)}\n`
}

/** Parse one JSONL record and reject unsupported schema versions. */
export function parseObservation(line: string): RuntimeObservation {
  const value: unknown = JSON.parse(line)
  if (!isRuntimeObservation(value)) throw new Error('invalid RuntimeObservation')
  return value
}

function isRuntimeObservation(value: unknown): value is RuntimeObservation {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === 1
    && typeof record.id === 'string'
    && typeof record.kind === 'string'
    && typeof record.occurredAt === 'string'
    && Array.isArray(record.correlationIds)
    && record.correlationIds.every(item => typeof item === 'string')
    && typeof record.payload === 'object'
    && record.payload !== null
    && typeof record.source === 'string'
}
