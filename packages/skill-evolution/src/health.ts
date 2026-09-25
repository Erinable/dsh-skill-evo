import { access, constants, readFile, stat } from 'node:fs/promises'

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
export async function inspectJsonlHealth(path: string): Promise<JsonlHealth> {
  try {
    const info = await stat(path)
    const text = await readFile(path, 'utf8')
    let readable = true
    let completeRecords = 0
    for (const line of text.split('\n').filter(Boolean)) {
      try { JSON.parse(line); completeRecords += 1 } catch { readable = false }
    }
    return {
      path,
      exists: true,
      readable,
      writable: await access(path, constants.W_OK).then(() => true, () => false),
      bytes: info.size,
      completeRecords,
      trailingPartial: text.length > 0 && !text.endsWith('\n'),
      ...(readable ? {} : { error: 'one or more JSONL records are invalid' }),
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
    return { path, exists: false, readable: false, writable: false, bytes: 0, completeRecords: 0, trailingPartial: false, error: code }
  }
}
