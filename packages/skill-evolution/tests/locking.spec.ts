import { mkdtemp, readFile, readdir, rm, utimes, writeFile, stat, unlink } from 'node:fs/promises'
import { hostname, uptime, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { LockBusyError, inspectLock, reclaimLock, sweepLocks, withLock } from '../src/locking.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'dsh-lock-')); roots.push(path); return path }
function exitedPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''])
  if (!result.pid) throw new Error('child pid unavailable')
  return result.pid
}
const deadOwner = (extra: Record<string, unknown> = {}) => ({ v: 1, token: 'dead', pid: exitedPid(), hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(uptime() * 1000), operation: 'test', ...extra })

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
    await writeFile(path, JSON.stringify({ pid: exitedPid(), hostname: hostname(), createdAt: new Date().toISOString() })); expect((await inspectLock(path)).kind).toBe('dead'); expect((await reclaimLock(path)).removed).toBe(true)
    await writeFile(path, JSON.stringify({ pid: exitedPid(), hostname: hostname(), createdAt: '1970-01-01T00:00:00.000Z' })); expect((await inspectLock(path)).kind).toBe('rebooted'); await reclaimLock(path)
    await writeFile(path, JSON.stringify({ ...deadOwner(), pid: exitedPid(), createdAt: new Date().toISOString() })); expect((await inspectLock(path)).kind).toBe('dead'); expect((await reclaimLock(path)).removed).toBe(true)
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

  it('times out on a live owner and reports held', async () => {
    const dir = await fixture(); const path = join(dir, 'held.lock')
    await writeFile(path, JSON.stringify({ ...deadOwner(), pid: process.pid, createdAt: new Date().toISOString() }))
    await expect(withLock(path, 'test', async () => undefined, { waitMs: 10 })).rejects.toMatchObject({ state: { kind: 'held' } })
  })

  it('serializes eight child processes through a dead lock', async () => {
    const dir = await fixture(); const path = join(dir, 'counter.lock'); const counter = join(dir, 'counter.json'); const active = join(dir, 'active')
    await writeFile(path, JSON.stringify(deadOwner())); await writeFile(counter, '0'); await writeFile(active, '0')
    const modulePath = new URL('../lib/locking.js', import.meta.url).pathname
    const script = `import { readFile, writeFile } from 'node:fs/promises'; import { withLock } from ${JSON.stringify(modulePath)}; const [lock,counter,active] = process.argv.slice(1); await withLock(lock, 'child', async () => { const n = Number(await readFile(active, 'utf8')); if (n !== 0) process.exit(2); await writeFile(active, '1'); await new Promise(r => setTimeout(r, 10)); const value = Number(await readFile(counter, 'utf8')); await writeFile(counter, String(value + 1)); await writeFile(active, '0') })`
    const results = await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, ['--input-type=module', '-e', script, path, counter, active])))
    expect(results).toHaveLength(8); expect(await readFile(counter, 'utf8')).toBe('8')
  })

  it('does not let tmp files block acquisition and survives concurrent tmp deletion', async () => {
    const dir = await fixture(); const path = join(dir, 'tmp.lock'); await writeFile(`${path}.foreign.tmp`, JSON.stringify(deadOwner()))
    await withLock(path, 'test', async () => undefined)
    const deleter = setInterval(() => { void readdir(dir).then(names => Promise.all(names.filter(name => /^tmp\.lock\.[^.]+\.tmp$/.test(name)).map(name => unlink(join(dir, name)).catch(() => undefined)))).catch(() => undefined) }, 0)
    for (let index = 0; index < 200; index += 1) await withLock(path, 'test', async () => undefined)
    const started = Date.now()
    await withLock(path, 'budget', async () => undefined, { waitMs: 200 }).catch(() => undefined)
    expect(Date.now() - started).toBeLessThan(1_000)
    clearInterval(deleter)
  })

  it('sweeps dead guards and temporary files without treating them as contention', async () => {
    const dir = await fixture(); const path = join(dir, 'x.lock')
    await writeFile(path, JSON.stringify(deadOwner())); await writeFile(`${path}.reclaim`, JSON.stringify(deadOwner())); await writeFile(`${path}.dead.tmp`, JSON.stringify(deadOwner()))
    await expect(withLock(path, 'test', async () => undefined, { waitMs: 0 })).rejects.toMatchObject({ guard: `${path}.reclaim` })
    await expect(stat(path)).resolves.toBeDefined()
    const report = await sweepLocks({ directories: [dir], paths: [path] }); expect(report.some(item => item.artifact === 'guard' && item.removed)).toBe(true); expect(report.some(item => item.artifact === 'tmp' && item.removed)).toBe(true)
    await withLock(path, 'test', async () => undefined)
  })

  it('sweeps explicit paths under their directory lock and protects unrelated artifacts', async () => {
    const dir = await fixture(); const path = join(dir, 'shared.jsonl.lock'); const ownGuard = join(dir, '.lock-sweep.lock.reclaim'); const ownTmp = join(dir, '.lock-sweep.lock.deadbeef.tmp')
    await writeFile(path, JSON.stringify(deadOwner())); await writeFile(`${path}.reclaim`, JSON.stringify(deadOwner())); await writeFile(`${path}.dead.tmp`, JSON.stringify(deadOwner()))
    await writeFile(ownGuard, JSON.stringify(deadOwner())); await writeFile(ownTmp, JSON.stringify(deadOwner())); await writeFile(join(dir, 'unrelated.tmp'), JSON.stringify(deadOwner()))
    const report = await sweepLocks({ directories: [dir], paths: [] })
    expect(report.some(item => item.path === `${path}.reclaim` && item.removed)).toBe(true)
    await expect(stat(ownGuard)).resolves.toBeDefined()
    await expect(stat(ownTmp)).resolves.toBeDefined()
    await expect(stat(join(dir, 'unrelated.tmp'))).resolves.toBeDefined()
  })
})
