import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { withFileLock } from './locking.js'

export interface RetentionResult {
  readonly rotated?: string
  readonly deleted: readonly string[]
  readonly bytes: number
}

/** Rotate a JSONL fact file and delete archives older than the retention window. */
export async function rotateJsonl(path: string, options: { readonly maxBytes: number; readonly retentionDays?: number }): Promise<RetentionResult> {
  return withFileLock(`${path}.lock`, async () => {
    const file = await stat(path).catch(() => undefined)
    const archiveDir = join(dirname(path), 'archive')
    await mkdir(archiveDir, { recursive: true })
    let rotated: string | undefined
    if (file !== undefined && file.size >= options.maxBytes) {
      rotated = join(archiveDir, `${basename(path)}.${new Date().toISOString().replaceAll(':', '-')}.${process.pid}.jsonl`)
      await rename(path, rotated)
      await writeFile(path, '', 'utf8')
    }
    const deleted: string[] = []
    const cutoff = Date.now() - (options.retentionDays ?? 30) * 86_400_000
    for (const entry of await readdir(archiveDir)) {
      const archive = join(archiveDir, entry)
      const info = await stat(archive).catch(() => undefined)
      if (info?.isFile() === true && entry.startsWith(`${basename(path)}.`) && entry.endsWith('.jsonl') && info.mtimeMs < cutoff) {
        const { unlink } = await import('node:fs/promises')
        await unlink(archive)
        deleted.push(archive)
      }
    }
    const current = await stat(path).catch(() => undefined)
    return { ...(rotated === undefined ? {} : { rotated }), deleted, bytes: current?.size ?? 0 }
  })
}
