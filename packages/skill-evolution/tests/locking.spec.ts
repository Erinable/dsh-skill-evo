import { mkdtemp, readFile, rm, utimes, writeFile, stat } from 'node:fs/promises'
import { hostname, uptime, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LockBusyError, inspectLock, reclaimLock, sweepLocks, withLock } from '../src/locking.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'dsh-lock-')); roots.push(path); return path }
const deadOwner = (extra: Record<string, unknown> = {}) => ({ v: 1, token: 'dead', pid: 999999, hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(uptime() * 1000), operation: 'test', ...extra })

describe('unified locking protocol', () => {
  it('writes a complete owner and releases after success or failure', async () => {
    const dir = await fixture(); const path = join(dir, 'resource.lock'); let seen: Record<string, unknown> | undefined
    await withLock(path, 'append', async () => { seen = JSON.parse(await readFile(path, 'utf8')); await expect(stat(`${path}.${seen?.token}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' }) })
    expect(seen).toMatchObject({ v: 1, pid: process.pid, hostname: hostname(), operation: 'append' }); expect(typeof seen?.token).toBe('string'); expect(typeof seen?.uptimeMs).toBe('number')
    await expect(withLock(path, 'test', async () => { throw new Error('callback') })).rejects.toThrow('callback')
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('classifies and reclaims dead, rebooted, v0, held, foreign, and unknown owners', async () => {
    const dir = await fixture(); const path = join(dir, 'x.lock')
    await writeFile(path, JSON.stringify(deadOwner())); expect((await inspectLock(path)).kind).toBe('dead'); expect((await reclaimLock(path)).removed).toBe(true)
    await writeFile(path, JSON.stringify(deadOwner({ uptimeMs: Math.round(uptime() * 1000) + 86_400_000 }))); expect((await inspectLock(path)).kind).toBe('rebooted'); await reclaimLock(path)
    await writeFile(path, JSON.stringify({ pid: 999999, hostname: hostname(), createdAt: '1970-01-01T00:00:00.000Z' })); expect((await inspectLock(path)).kind).toBe('rebooted'); await reclaimLock(path)
    await writeFile(path, JSON.stringify({ ...deadOwner(), pid: process.pid, createdAt: '1970-01-01T00:00:00.000Z' })); expect((await inspectLock(path)).kind).toBe('held')
    await writeFile(path, JSON.stringify({ ...deadOwner(), hostname: 'foreign-host' })); expect((await inspectLock(path)).kind).toBe('foreign')
    await writeFile(path, 'broken'); expect((await inspectLock(path)).kind).toBe('unknown'); await expect(withLock(path, 'test', async () => undefined, { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    await utimes(path, new Date(0), new Date(0)); expect((await reclaimLock(path)).removed).toBe(true)
  })

  it('preserves a replacement lock when the original scope releases', async () => {
    const dir = await fixture(); const path = join(dir, 'x.lock'); let replacement = ''
    await withLock(path, 'test', async () => { const token = 'replacement'; replacement = token; await writeFile(path, JSON.stringify({ ...deadOwner(), pid: process.pid, token })) })
    expect(JSON.parse(await readFile(path, 'utf8')).token).toBe(replacement)
  })

  it('sweeps dead guards and temporary files without treating them as contention', async () => {
    const dir = await fixture(); const path = join(dir, 'x.lock')
    await writeFile(`${path}.reclaim`, JSON.stringify(deadOwner())); await writeFile(`${path}.dead.tmp`, JSON.stringify(deadOwner()))
    const report = await sweepLocks({ directories: [dir], paths: [path] }); expect(report.some(item => item.artifact === 'guard' && item.removed)).toBe(true); expect(report.some(item => item.artifact === 'tmp' && item.removed)).toBe(true)
    await withLock(path, 'test', async () => undefined)
  })
})
