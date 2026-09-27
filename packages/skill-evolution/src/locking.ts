import { randomUUID } from 'node:crypto'
import { hostname, uptime } from 'node:os'
import { mkdir, readFile, readdir, stat, unlink, writeFile, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_UNKNOWN_GRACE_MS = 600_000
const REBOOT_TOLERANCE_MS = 5_000
const V0_BOOT_TOLERANCE_MS = 60_000

export type LockOwner = { readonly v?: 1; readonly token?: string; readonly pid: number; readonly hostname: string; readonly createdAt: string; readonly uptimeMs?: number; readonly operation?: string }
export type LockState =
  | { readonly kind: 'free' }
  | { readonly kind: 'unknown'; readonly ageMs: number; readonly reclaimable: boolean }
  | { readonly kind: 'foreign'; readonly owner: LockOwner; readonly ageMs: number }
  | { readonly kind: 'held' | 'dead' | 'rebooted'; readonly owner: LockOwner; readonly ageMs: number }
export interface LockOptions { readonly waitMs?: number; readonly unknownGraceMs?: number }

export class LockBusyError extends Error {
  readonly path: string
  readonly state: LockState
  readonly guard?: string
  constructor(path: string, state: LockState, guard?: string) {
    super(`lock busy: ${path}${guard ? `; stale reclaim guard: ${guard}; run repair` : ''}`)
    this.name = 'LockBusyError'; this.path = path; this.state = state; this.guard = guard
  }
}

export interface SweptLock { readonly path: string; readonly artifact: 'lock' | 'guard' | 'tmp'; readonly state: LockState['kind'] | 'skipped'; readonly operation?: string; readonly ageMs?: number; readonly removed: boolean; readonly guard?: string }
type OwnerRecord = LockOwner & { readonly v: 1; readonly token: string; readonly uptimeMs: number; readonly operation: string }
const reclaimable = (state: LockState) => state.kind === 'dead' || state.kind === 'rebooted' || (state.kind === 'unknown' && state.reclaimable)
const ageMs = (mtimeMs: number) => Math.max(0, Date.now() - mtimeMs)

function validOwner(value: unknown): value is LockOwner {
  if (typeof value !== 'object' || value === null) return false
  const owner = value as Record<string, unknown>
  return Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.hostname === 'string' && owner.hostname.length > 0 && typeof owner.createdAt === 'string' && !Number.isNaN(Date.parse(owner.createdAt))
}

export async function inspectLock(path: string, options: Pick<LockOptions, 'unknownGraceMs'> = {}): Promise<LockState> {
  let raw: string; let mtime: number
  try { const info = await stat(path); mtime = ageMs(info.mtimeMs); raw = await readFile(path, 'utf8') } catch (error) { if (hasCode(error, 'ENOENT')) return { kind: 'free' }; throw error }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = undefined }
  if (!validOwner(parsed)) return { kind: 'unknown', ageMs: mtime, reclaimable: mtime > (options.unknownGraceMs ?? DEFAULT_UNKNOWN_GRACE_MS) }
  const owner = parsed
  if (owner.hostname !== hostname()) return { kind: 'foreign', owner, ageMs: mtime }
  const nowUptime = Math.round(uptime() * 1000)
  if (owner.uptimeMs !== undefined && Number.isInteger(owner.uptimeMs) && nowUptime + REBOOT_TOLERANCE_MS < owner.uptimeMs) return { kind: 'rebooted', owner, ageMs: mtime }
  if (owner.uptimeMs === undefined && Date.parse(owner.createdAt) < Date.now() - nowUptime - V0_BOOT_TOLERANCE_MS) return { kind: 'rebooted', owner, ageMs: mtime }
  try { process.kill(owner.pid, 0); return { kind: 'held', owner, ageMs: mtime } } catch (error) {
    if (hasCode(error, 'ESRCH')) return { kind: 'dead', owner, ageMs: mtime }
    if (hasCode(error, 'EPERM')) return { kind: 'held', owner, ageMs: mtime }
    throw error
  }
}

async function createOwner(path: string, operation: string): Promise<{ owner: OwnerRecord; acquired: boolean }> {
  const token = randomUUID(); const owner: OwnerRecord = { v: 1, token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(uptime() * 1000), operation }; const tmp = `${path}.${token}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try { await writeFile(tmp, JSON.stringify(owner), { mode: 0o600 }); try { await link(tmp, path); return { owner, acquired: true } } catch (error) { if (hasCode(error, 'EEXIST') || hasCode(error, 'ENOENT')) return { owner, acquired: false }; throw error } }
  finally { await unlink(tmp).catch(error => { if (!hasCode(error, 'ENOENT')) throw error }) }
}

async function release(path: string, token: string): Promise<void> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { token?: string }
    if (value.token !== token) return
    await unlink(path)
  } catch {
    // Cleanup must never replace the callback result or error.
  }
}

export async function reclaimLock(path: string, options: Pick<LockOptions, 'unknownGraceMs'> = {}): Promise<{ readonly state: LockState; readonly removed: boolean; readonly guard?: string }> {
  const initial = await inspectLock(path, options); if (initial.kind === 'free' || !reclaimable(initial)) return { state: initial, removed: false }
  const guardPath = `${path}.reclaim`; const guard = await createOwner(guardPath, 'reclaim'); if (!guard.acquired) return { state: initial, removed: false, guard: guardPath }
  try { const current = await inspectLock(path, options); if (!reclaimable(current)) return { state: current, removed: false }; await unlink(path).catch(error => { if (!hasCode(error, 'ENOENT')) throw error }); return { state: current, removed: true } } finally { await release(guardPath, guard.owner.token) }
}

export async function withLock<T>(path: string, operation: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const waitMs = options.waitMs ?? 5_000; const deadline = Date.now() + waitMs; let last: LockState = { kind: 'unknown', ageMs: 0, reclaimable: false }; let guard: string | undefined
  while (true) {
    const attempt = await createOwner(path, operation)
    if (attempt.acquired) { try { return await fn() } finally { await release(path, attempt.owner.token) } }
    last = await inspectLock(path, options)
    if (last.kind === 'free' && (waitMs > 0 || Date.now() < deadline)) continue
    if (reclaimable(last)) { const result = await reclaimLock(path, options); guard = result.guard; if (result.removed) continue }
    if (waitMs === 0 || Date.now() >= deadline) throw new LockBusyError(path, last, guard)
    await delay(Math.min(20, Math.max(1, deadline - Date.now())))
  }
}

async function sweepArtifact(path: string, artifact: 'lock' | 'guard' | 'tmp', options: Pick<LockOptions, 'unknownGraceMs'>): Promise<SweptLock> {
  const state = await inspectLock(path, options); let removed = false; let finalState = state
  if (artifact === 'lock') { const result = await reclaimLock(path, options); removed = result.removed; finalState = result.state } else if (reclaimable(state)) { await unlink(path).catch(error => { if (!hasCode(error, 'ENOENT')) throw error }); removed = true }
  const owner = 'owner' in finalState ? finalState.owner : undefined
  return { path, artifact, state: finalState.kind, operation: owner?.operation, ageMs: 'ageMs' in finalState ? finalState.ageMs : undefined, removed }
}

function isGuard(name: string): boolean { return /^.+\.lock\.reclaim$/.test(name) }
function isTmp(name: string): boolean { return /^.+\.lock\.[^.]+\.tmp$/.test(name) }

async function sweepDirectory(
  directory: string,
  selected: readonly string[] | undefined,
  options: Pick<LockOptions, 'unknownGraceMs'>,
  results: SweptLock[],
): Promise<void> {
  const sweepPath = join(directory, '.lock-sweep.lock')
  try {
    await withLock(sweepPath, 'sweep', async () => {
      let entries: string[] = []
      try { entries = await readdir(directory) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      const ownGuard = `${sweepPath}.reclaim`
      const ownTmp = (name: string) => name.startsWith(`${sweepPath}.`) && name.endsWith('.tmp')
      const locks = selected === undefined
        ? entries.filter(name => name.endsWith('.lock') && name !== '.lock-sweep.lock').map(name => join(directory, name))
        : selected
      const lockPaths = new Set(locks)
      const guardPaths = selected === undefined
        ? entries.filter(name => isGuard(name) && join(directory, name) !== ownGuard).map(name => join(directory, name))
        : [...lockPaths].map(path => `${path}.reclaim`).filter(path => entries.includes(basename(path)))
      for (const path of guardPaths) results.push(await sweepArtifact(path, 'guard', options))
      for (const path of lockPaths) results.push(await sweepArtifact(path, 'lock', options))
      const tmpPaths = selected === undefined
        ? entries.filter(name => isTmp(name) && !ownTmp(name)).map(name => join(directory, name))
        : entries.filter(name => isTmp(name) && !ownTmp(name) && [...lockPaths].some(lock => name.startsWith(`${basename(lock)}.`))).map(name => join(directory, name))
      for (const path of tmpPaths) results.push(await sweepArtifact(path, 'tmp', options))
    }, { waitMs: 0 })
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error
    results.push({ path: sweepPath, artifact: 'lock', state: 'skipped', removed: false, guard: error.guard })
  }
}

function basename(path: string): string { return path.slice(path.lastIndexOf('/') + 1) }

export async function sweepLocks(target: { readonly directories: readonly string[]; readonly paths: readonly string[] }, options: Pick<LockOptions, 'unknownGraceMs'> = {}): Promise<readonly SweptLock[]> {
  const results: SweptLock[] = []
  const directories = new Set(target.directories)
  const pathsByDirectory = new Map<string, string[]>()
  for (const path of target.paths) {
    const directory = dirname(path)
    if (!directories.has(directory)) pathsByDirectory.set(directory, [...(pathsByDirectory.get(directory) ?? []), path])
  }
  for (const directory of target.directories) await sweepDirectory(directory, undefined, options, results)
  for (const [directory, paths] of pathsByDirectory) await sweepDirectory(directory, paths, options, results)
  return results
}

export function hasCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code }
export function withFileLock<T>(path: string, operation: () => Promise<T>, waitMs = 5_000): Promise<T> { return withLock(path, 'legacy', operation, { waitMs }) }
export async function removeDeadLock(path: string): Promise<boolean> { return (await reclaimLock(path)).removed }
