import { randomUUID } from 'node:crypto'
import { appendFile, readFile, truncate, writeFile } from 'node:fs/promises'

export interface JsonlFrames {
  readonly lines: readonly string[]
  readonly tail: Buffer
}

/** Only newline-terminated lines are records; the remaining bytes stay untouched. */
export function splitFrames(bytes: Buffer): JsonlFrames {
  const lines: string[] = []
  let start = 0
  let newline = bytes.indexOf(0x0a, start)
  while (newline !== -1) {
    const line = bytes.toString('utf8', start, newline)
    if (line.trim()) lines.push(line)
    start = newline + 1
    newline = bytes.indexOf(0x0a, start)
  }
  return { lines, tail: bytes.subarray(start) }
}

export async function readFrames(path: string): Promise<JsonlFrames> {
  try {
    return splitFrames(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], tail: Buffer.alloc(0) }
    throw error
  }
}

export function quarantinePath(path: string): string {
  return `${path}.invalid-${Date.now()}-${process.pid}-${randomUUID()}`
}

/** The caller must hold the file lock before writing. */
export async function appendFrames(path: string, lines: readonly string[]): Promise<{ readonly quarantined?: string }> {
  if (lines.length === 0) return {}

  const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return Buffer.alloc(0)
    throw error
  })
  const { tail } = splitFrames(bytes)
  let quarantined: string | undefined
  if (tail.length > 0) {
    quarantined = quarantinePath(path)
    await writeFile(quarantined, tail, { flag: 'wx' })
    await truncate(path, bytes.length - tail.length)
  }
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
  return quarantined === undefined ? {} : { quarantined }
}
