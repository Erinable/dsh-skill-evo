import { access, constants, stat } from 'node:fs/promises'
import { readFrames } from './jsonl.js'

export interface JsonlHealth {
  readonly path: string
  readonly exists: boolean
  readonly readable: boolean
  readonly writable: boolean
  readonly bytes: number
  readonly completeRecords: number
  readonly trailingPartial: boolean
  readonly error?: string
}

/** Read-only store health probe for operators and readiness checks. */
export async function inspectJsonlHealth(
  path: string,
  options: { readonly parse?: (value: unknown) => boolean; readonly requireTrailingNewline?: boolean } = {},
): Promise<JsonlHealth> {
  try {
    const info = await stat(path)
    const { lines, tail } = await readFrames(path)
    let readable = options.requireTrailingNewline !== true || tail.length === 0
    let completeRecords = 0
    for (const line of lines) {
      try {
        const value = JSON.parse(line)
        if (options.parse !== undefined && !options.parse(value)) throw new Error('schema validation failed')
        completeRecords += 1
      } catch { readable = false }
    }
    return {
      path,
      exists: true,
      readable,
      writable: await access(path, constants.W_OK).then(() => true, () => false),
      bytes: info.size,
      completeRecords,
      trailingPartial: tail.length > 0,
      ...(readable ? {} : { error: tail.length > 0 && options.requireTrailingNewline === true ? 'JSONL file does not end with a newline' : 'one or more JSONL records are invalid' }),
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
    return { path, exists: false, readable: false, writable: false, bytes: 0, completeRecords: 0, trailingPartial: false, error: code }
  }
}
