import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlRecordStore } from '../src/records.js'
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
