import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DuplicateRecordError, JsonlRecordStore } from '../src/records.js'
import { LockBusyError } from '../src/locking.js'
import { JsonlEventStore } from '../src/store.js'
import { createObservation } from '../src/events.js'

const roots: string[] = []

async function file(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-store-framing-'))
  roots.push(root)
  return join(root, 'records.jsonl')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function event(id: string) {
  return createObservation({
    id,
    kind: 'agent-step',
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    taskId: 'task-1',
    correlationIds: [],
    payload: {},
    source: 'runtime',
  })
}

async function quarantinedTail(path: string): Promise<Buffer> {
  const names = (await readdir(join(path, '..'))).filter(name => name.startsWith('records.jsonl.invalid-'))
  expect(names).toHaveLength(1)
  return readFile(join(path, '..', names[0]!))
}

async function checkParseableTailAndBadLine<T extends { id: string }>(
  path: string,
  createStore: () => { append(record: T): Promise<boolean>; readAll(): Promise<unknown[]> },
  value: T,
  next: T,
): Promise<void> {
  const store = createStore()
  await writeFile(path, JSON.stringify(value))
  expect(await store.append(value)).toBe(true)
  expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(value)}\n`)
  expect(await quarantinedTail(path)).toEqual(Buffer.from(JSON.stringify(value)))

  await writeFile(path, `${JSON.stringify(value)}\nnot-json\n`)
  await expect(store.readAll()).rejects.toThrow()
  await expect(store.append(next)).rejects.toThrow()
  const reopened = createStore()
  await expect(reopened.readAll()).rejects.toThrow()
  await expect(reopened.append(next)).rejects.toThrow()
}

describe('store JSONL framing', () => {
  it('computes unique ids across independent concurrent stores', async () => {
    const path = await file()
    const stores = [new JsonlRecordStore<{ id: string }>(path), new JsonlRecordStore<{ id: string }>(path)]
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      stores[index % 2]!.appendComputed(current => ({ id: `n${current.length}` }))))

    const ids = records.map(record => record.id).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
    expect(ids).toEqual(Array.from({ length: 20 }, (_, index) => `n${index}`))
    expect((await stores[0]!.readAll()).map(record => record.id).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))).toEqual(ids)
  })

  it('isolates a trailing residual before appending the computed record', async () => {
    const path = await file()
    const tail = Buffer.from('{"id":"torn","value":')
    await writeFile(path, Buffer.concat([Buffer.from('{"id":"a"}\n'), tail]))
    let seen = -1
    const store = new JsonlRecordStore<{ id: string }>(path)

    const appended = await store.appendComputed(records => {
      seen = records.length
      return { id: 'b' }
    })

    expect(seen).toBe(1)
    expect(appended).toEqual({ id: 'b' })
    expect(await readFile(path, 'utf8')).toBe('{"id":"a"}\n{"id":"b"}\n')
    expect(await quarantinedTail(path)).toEqual(tail)
  })

  it('rejects an occupied computed id without changing the data file', async () => {
    const path = await file()
    await writeFile(path, '{"id":"existing"}\n')
    const before = await readFile(path)
    const store = new JsonlRecordStore<{ id: string }>(path)

    const error = await store.appendComputed(() => ({ id: 'existing' })).catch(value => value)
    expect(error).toBeInstanceOf(DuplicateRecordError)
    expect(error.id).toBe('existing')
    expect(await readFile(path)).toEqual(before)
  })

  it('propagates builder, data I/O, and lock errors unchanged', async () => {
    const path = await file()
    const store = new JsonlRecordStore<{ id: string }>(path)
    const builderError = new Error('builder failed')
    await expect(store.appendComputed(() => { throw builderError })).rejects.toBe(builderError)
    expect(await readFile(path, 'utf8')).toBe('')

    const directoryPath = await mkdtemp(join(tmpdir(), 'dsh-store-directory-'))
    roots.push(directoryPath)
    const ioStore = new JsonlRecordStore<{ id: string }>(directoryPath)
    await expect(ioStore.appendComputed(() => ({ id: 'io' }))).rejects.toMatchObject({ code: 'EISDIR' })

    const lockPath = `${path}.lock`
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(uptime() * 1000), operation: 'test' }))
    await expect(store.appendComputed(() => ({ id: 'locked' }))).rejects.toBeInstanceOf(LockBusyError)
  }, 15_000)

  it('keeps record-store appends readable after an incomplete tail', async () => {
    const path = await file()
    const a = { id: 'a', value: 1 }
    const c = { id: 'c', value: 3 }
    const d = { id: 'd', value: 4 }
    const tail = Buffer.from('{"id":"b","torn":tr')
    await writeFile(path, Buffer.concat([Buffer.from(`${JSON.stringify(a)}\n`), tail]))
    const store = new JsonlRecordStore<typeof a>(path)

    expect(await store.readAll()).toEqual([a])
    expect(await readFile(path)).toEqual(Buffer.concat([Buffer.from(`${JSON.stringify(a)}\n`), tail]))
    expect(await store.append(c)).toBe(true)
    expect(await store.readAll()).toEqual([a, c])
    expect(await store.append(d)).toBe(true)
    expect(await store.readAll()).toEqual([a, c, d])
    expect(await quarantinedTail(path)).toEqual(tail)
  })

  it('keeps event-store appends readable after an incomplete tail', async () => {
    const path = await file()
    const a = event('a')
    const c = event('c')
    const d = event('d')
    const tail = Buffer.from('{"id":"b","torn":tr')
    await writeFile(path, Buffer.concat([Buffer.from(`${JSON.stringify(a)}\n`), tail]))
    const store = new JsonlEventStore(path)

    expect(await store.query({ kind: 'agent-step' })).toEqual([a])
    expect(await readFile(path)).toEqual(Buffer.concat([Buffer.from(`${JSON.stringify(a)}\n`), tail]))
    expect(await store.append(c)).toBe(true)
    expect(await store.readAll()).toEqual([a, c])
    expect(await store.append(d)).toBe(true)
    expect(await store.readAll()).toEqual([a, c, d])
    expect(await quarantinedTail(path)).toEqual(tail)
  })

  it('record store ignores a parseable tail id but rejects a bad complete line', async () => {
    const path = await file()
    await checkParseableTailAndBadLine(path, () => new JsonlRecordStore<{ id: string; value: number }>(path),
      { id: 'b', value: 2 }, { id: 'c', value: 3 })
  })

  it('event store ignores a parseable tail id but rejects a bad complete line', async () => {
    const path = await file()
    await checkParseableTailAndBadLine(path, () => new JsonlEventStore(path), event('b'), event('c'))
  })
})
