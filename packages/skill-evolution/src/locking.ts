import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

/** Local-filesystem lock. Unknown or remote owners are never reclaimed automatically. */
export async function withFileLock<T>(path: string, operation: () => Promise<T>, waitMs = 5000): Promise<T> {
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + waitMs
  let handle
  while (handle === undefined) {
    try { handle = await open(path, 'wx', 0o600) } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      await removeDeadLock(path)
      if (Date.now() >= deadline) throw new Error(`store busy: ${path}; inspect its owner before running repair`)
      await delay(20)
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }))
    return await operation()
  } finally {
    await handle.close()
    await unlink(path)
  }
}

export async function removeDeadLock(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: number; hostname?: string }
    if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return false
    try { process.kill(owner.pid!, 0); return false } catch (error) {
      if (!hasCode(error, 'ESRCH')) return false
    }
    await unlink(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT') || error instanceof SyntaxError) return false
    throw error
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
