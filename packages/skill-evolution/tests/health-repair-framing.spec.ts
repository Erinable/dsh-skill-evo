import { join } from 'node:path'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolutionService,
  ObservationLog,
  createObservation,
  inspectJsonlHealth,
  isObservationValue,
  parseObservation,
  repairJsonlFile,
  type RuntimeObservation,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function observation(id: string): RuntimeObservation {
  return createObservation({
    id,
    kind: 'agent-step',
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'framing-session',
    correlationIds: [],
    payload: {},
    source: 'runtime',
  })
}

describe('health and repair JSONL framing', () => {
  it('probe C treats a parseable tail as partial across read, health, and repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-probe-c-'))
    roots.push(root)
    const path = join(root, 'observations.jsonl')
    const first = Buffer.from(JSON.stringify(observation('a')) + '\n')
    const tail = Buffer.from(JSON.stringify(observation('b')))
    await writeFile(path, Buffer.concat([first, tail]))

    expect((await new ObservationLog(path).readAll()).map(item => item.id)).toEqual(['a'])
    await expect(inspectJsonlHealth(path, { parse: isObservationValue })).resolves.toMatchObject({ readable: true, completeRecords: 1, trailingPartial: true })
    await expect(repairJsonlFile(path, { parse: isObservationValue })).resolves.toMatchObject({ validRecords: 1, removedInvalidLines: 1, truncatedTrailingBytes: tail.length })
  })

  it('keeps a current tail readable, but marks a complete bad line unreadable without changing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-health-tail-'))
    roots.push(root)
    const current = join(root, 'events.jsonl')
    const tailOnly = Buffer.from('partial')
    await writeFile(current, tailOnly)
    await expect(inspectJsonlHealth(current)).resolves.toMatchObject({ readable: true, completeRecords: 0, trailingPartial: true })
    const damaged = Buffer.from('not-json\npartial')
    await writeFile(current, damaged)
    await expect(inspectJsonlHealth(current)).resolves.toMatchObject({ readable: false, completeRecords: 0, trailingPartial: true })
    expect(await readFile(current)).toEqual(damaged)
  })

  it('quarantines truncated UTF-8 tail bytes exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-utf8-tail-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const tail = Buffer.from([0xe2, 0x82])
    await writeFile(path, Buffer.concat([Buffer.from('{"id":"ok"}\n'), tail]))
    const result = await repairJsonlFile(path)
    expect(result.invalidQuarantine).toBeDefined()
    expect(await readFile(result.invalidQuarantine!)).toEqual(tail)
  })

  it('quarantines complete bad lines followed by a raw tail and keeps valid records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-mixed-invalid-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const tail = Buffer.from([0xe2, 0x82, 0xac])
    const expectedQuarantine = Buffer.concat([Buffer.from('not-json\n{"broken":}\n'), tail])
    await writeFile(path, Buffer.concat([Buffer.from('{"id":"ok"}\n'), expectedQuarantine]))
    const result = await repairJsonlFile(path)
    expect(result).toMatchObject({ validRecords: 1, removedInvalidLines: 3, truncatedTrailingBytes: tail.length })
    expect(await readFile(result.invalidQuarantine!)).toEqual(expectedQuarantine)
    expect((await readFile(path, 'utf8')).trim()).toBe('{"id":"ok"}')
  })

  it('leaves the original file unchanged when quarantine creation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-quarantine-failure-'))
    roots.push(root)
    const path = join(root, 'f'.repeat(240))
    const original = Buffer.from('{"id":"ok"}\npartial')
    await writeFile(path, original)
    const before = await readdir(root)
    await expect(repairJsonlFile(path)).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    expect(await readFile(path)).toEqual(original)
    expect(await readdir(root)).toEqual(before)
  })

  it('keeps isObservationValue aligned with parseObservation', () => {
    const valid = observation('valid')
    const invalid = { ...valid, schemaVersion: 2 }
    expect(isObservationValue(valid)).toBe(true)
    expect(() => parseObservation(JSON.stringify(valid))).not.toThrow()
    expect(isObservationValue(invalid)).toBe(false)
    expect(() => parseObservation(JSON.stringify(invalid))).toThrow()
  })
})
