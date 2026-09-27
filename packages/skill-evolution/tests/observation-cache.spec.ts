import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createObservation, serializeObservation } from '../src/events.js'
import type { RuntimeObservation } from '../src/types.js'

const execFileAsync = promisify(execFile)
const readPaths: string[] = []

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readPaths.push(String(args[0]))
      return actual.readFile(...args)
    },
  }
})

const { ObservationLog } = await import('../src/state-root.js')

const dirs: string[] = []

afterEach(async () => {
  readPaths.length = 0
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function observation(id: string): RuntimeObservation {
  return createObservation({
    id,
    kind: 'agent-step',
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    taskId: 'task-1',
    skill: { name: 'api-debugging', provider: 'filesystem', source: 'project-dsh' },
    correlationIds: [],
    payload: {},
    source: 'runtime',
  })
}

function archivePath(path: string, stamp: string): string {
  return join(path.replace(/[^/]+$/, 'archive'), `${path.split('/').at(-1)}.${stamp}.jsonl`)
}

async function setupArchive(path: string, events: readonly RuntimeObservation[], stamp = '2026-09-25T00-00-00.000Z.1'): Promise<string> {
  const archive = archivePath(path, stamp)
  await mkdir(join(path.replace(/[^/]+$/, 'archive')), { recursive: true })
  await writeFile(archive, events.map(serializeObservation).join(''), 'utf8')
  await writeFile(path, '', 'utf8')
  return archive
}

function modulePath(): string {
  return new URL('../lib/index.js', import.meta.url).pathname
}

describe('ObservationLog archive cache', () => {
  it('reads unchanged archives once while refreshing the current file for each append', async () => {
    const dir = await mkdtemp()
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    const archive = await setupArchive(path, [observation('archived')])
    readPaths.length = 0
    const store = new ObservationLog(path)

    await store.append(observation('first'))
    await store.append(observation('second'))

    expect(readPaths.filter(candidate => candidate === archive)).toHaveLength(1)
    expect(readPaths.filter(candidate => candidate === path)).toHaveLength(2)
  })

  it('refreshes cache after archive addition, same-name replacement, and deletion', async () => {
    const dir = await mkdtemp()
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    const archive = await setupArchive(path, [observation('old')])
    const store = new ObservationLog(path)

    expect(await store.append(observation('old'))).toBe(false)
    expect(await store.append(observation('before-new'))).toBe(true)

    const newArchive = archivePath(path, '2026-09-25T00-00-01.000Z.2')
    await writeFile(newArchive, serializeObservation(observation('new')))
    expect(await store.append(observation('new'))).toBe(false)

    const replacement = `${archive}.replacement`
    await writeFile(replacement, serializeObservation(observation('repaired')))
    await rename(replacement, archive)
    expect(await store.append(observation('old'))).toBe(true)
    expect(await store.append(observation('repaired'))).toBe(false)

    await rm(newArchive)
    expect(await store.append(observation('new'))).toBe(true)
  })

  it('discovers archive changes from a long-lived instance in another process', async () => {
    const dir = await mkdtemp()
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    const archive = await setupArchive(path, [observation('before')])
    const script = `import { createInterface } from 'node:readline'; import { ObservationLog } from ${JSON.stringify(modulePath())}; const store = new ObservationLog(process.argv[1]); const rl = createInterface({ input: process.stdin }); rl.on('line', async line => { const event = JSON.parse(line); process.stdout.write(JSON.stringify(await store.append(event)) + '\\n') })`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['pipe', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stdin.write(`${JSON.stringify(observation('before'))}\n`)
    await vi.waitFor(() => expect(output).toContain('false'))

    const replacement = `${archive}.replacement`
    await writeFile(replacement, serializeObservation(observation('after')))
    await rename(replacement, archive)
    child.stdin.write(`${JSON.stringify(observation('before'))}\n`)
    await vi.waitFor(() => expect(output).toMatch(/false\ntrue\n/))
    child.stdin.write(`${JSON.stringify(observation('after'))}\n`)
    await vi.waitFor(() => expect(output).toMatch(/false\ntrue\nfalse\n/))
    child.stdin.end()
    await new Promise<void>(resolve => child.once('close', () => resolve()))
  })

  it('deduplicates concurrent appends from separate ObservationLog processes', async () => {
    const dir = await mkdtemp()
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    const event = observation('same-id')
    const script = `import { ObservationLog } from ${JSON.stringify(modulePath())}; const result = await new ObservationLog(process.argv[1]).append(JSON.parse(process.argv[2])); process.stdout.write(String(result))`
    const results = await Promise.all([
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, path, JSON.stringify(event)]),
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, path, JSON.stringify(event)]),
    ])
    expect(results.map(result => result.stdout).sort()).toEqual(['false', 'true'])
    expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })
})

async function mkdtemp(): Promise<string> {
  const path = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), 'dsh-skill-evo-cache-')))
  return path
}
