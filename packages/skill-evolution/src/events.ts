import { createHash } from 'node:crypto'
import type { RuntimeObservation } from './types.js'

/** Hash an exact UTF-8 Skill snapshot for runtime and adoption evidence. */
export function createContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Remove common credentials before user/tool text enters durable evidence. */
export function redactSensitiveText(value: string): string {
  return value
    // URL credentials must be removed before query/fragment handling.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@"']+)(@)/gi, '$1[REDACTED]$3')
    // Signed URLs and callback fragments are never durable evidence.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*?)(\?[^\s"'#]*)/gi, '$1?[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*?)(#[^\s"']*)/gi, '$1#[REDACTED]')
    .replace(/(['"])(\b(?:proxy-)?authorization|x-api-key|x-auth-token|cookie)\s*:\s*(?:(?:\\.)|(?!\1)[^\r\n])*\1/gi, '$1$2: [REDACTED]$1')
    .replace(/(\b(?:proxy-)?authorization|x-api-key|x-auth-token|cookie)\s*:\s*(?:"[^"]*"|'[^']*'|[^\n"']+)/gi, '$1: [REDACTED]')
    .replace(/(--(?:token|password|passwd|pass|secret|api-key|apikey|auth|auth-token|access-token|client-secret))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, '$1 [REDACTED]')
    .replace(/((?:^|\s)(?:-u|--user))\s+(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s"']+:[^\s"']+)/gi, '$1 [REDACTED]')
    .replace(/(^|[;\s])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|AUTH|CREDENTIALS?|COOKIE))=(?:"[^"]*"|'[^']*'|[^\s;"']+)/gi, '$1$2=[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|xox[abp]-)[A-Za-z0-9_-]{8,}\b|\bAKIA[0-9A-Z]{16}\b|\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[REDACTED_AUTH]')
    .replace(/\b(password|passwd|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
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
  if (!isObservationValue(value)) throw new Error('invalid RuntimeObservation')
  return value
}

export function isObservationValue(value: unknown): value is RuntimeObservation {
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
