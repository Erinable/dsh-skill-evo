import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFrames, quarantinePath, readFrames, splitFrames } from '../src/jsonl.js'

const fault = vi.hoisted(() => ({ quarantine: false }))
vi.mock('node:fs/promises', async importActual => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fault.quarantine && String(args[0]).includes('.invalid-')) throw new Error('quarantine failed')
      return actual.writeFile(...args)
    },
  }
})

const roots: string[] = []

async function file(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  roots.push(root)
  return join(root, 'records.jsonl')
}

afterEach(async () => {
  fault.quarantine = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('JSONL frames', () => {
  it('reads an absent or empty file as empty frames', async () => {
    const path = await file()
    expect(await readFrames(path)).toEqual({ lines: [], tail: Buffer.alloc(0) })
    await writeFile(path, '')
    expect(await readFrames(path)).toEqual({ lines: [], tail: Buffer.alloc(0) })
  })

  it('reads only complete nonblank lines and leaves ordinary and parseable tails out of records', async () => {
    const path = await file()
    const record = '{"id":"complete"}'
    for (const tail of ['{"id":', '{"id":"parseable"}']) {
      await writeFile(path, ` \n${record}\n\t\n${tail}`)
      const frames = await readFrames(path)
      expect(frames.lines.map(line => JSON.parse(line) as { id: string })).toEqual([{ id: 'complete' }])
      expect(frames.tail).toEqual(Buffer.from(tail))
    }
    await writeFile(path, `${record}\n`)
    expect(await readFrames(path)).toEqual({ lines: [record], tail: Buffer.alloc(0) })
  })

  it('keeps a truncated UTF-8 tail as exact bytes and treats a file without newline as all tail', async () => {
    const path = await file()
    const tail = Buffer.from([0x7b, 0x22, 0xe2, 0x82])
    const prefix = Buffer.from('{"id":1}\n')
    await writeFile(path, Buffer.concat([prefix, tail]))
    expect(await readFrames(path)).toEqual({ lines: ['{"id":1}'], tail })
    await writeFile(path, tail)
    expect(await readFrames(path)).toEqual({ lines: [], tail })
    expect(splitFrames(Buffer.from(' \n\t\n'))).toEqual({ lines: [], tail: Buffer.alloc(0) })
  })
})

describe('JSONL append', () => {
  it('appends directly when there is no tail', async () => {
    const path = await file()
    await writeFile(path, '{"id":1}\n')
    expect(await appendFrames(path, ['{"id":2}', '{"id":3}'])).toEqual({})
    expect(await readFile(path, 'utf8')).toBe('{"id":1}\n{"id":2}\n{"id":3}\n')
    expect(await readdir(join(path, '..'))).toEqual(['records.jsonl'])
  })

  it('quarantines the exact tail bytes before truncating and appending', async () => {
    const path = await file()
    const prefix = Buffer.from('{"id":1}\n')
    const tail = Buffer.from([0x7b, 0x22, 0xe2, 0x82])
    await writeFile(path, Buffer.concat([prefix, tail]))
    expect((await readFrames(path)).lines).toEqual(['{"id":1}'])
    const result = await appendFrames(path, ['{"id":2}'])
    expect(result.quarantined).toMatch(new RegExp(`^${path}\\.invalid-\\d+-${process.pid}-[0-9a-f-]{36}$`))
    expect(await readFile(result.quarantined!)).toEqual(tail)
    expect(await readFile(path)).toEqual(Buffer.from('{"id":1}\n{"id":2}\n'))
    expect((await readFrames(path)).lines.map(line => JSON.parse(line) as { id: number })).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('quarantines an entire file without a newline before appending', async () => {
    const path = await file()
    const original = Buffer.from('{"id":"parseable"}')
    await writeFile(path, original)
    const { quarantined } = await appendFrames(path, ['{"id":"new"}'])
    expect(await readFile(quarantined!)).toEqual(original)
    expect(await readFile(path, 'utf8')).toBe('{"id":"new"}\n')
  })

  it('preserves the original file when writing quarantine fails', async () => {
    const path = await file()
    const original = Buffer.from('{"id":1}\nunfinished')
    await writeFile(path, original)
    fault.quarantine = true
    await expect(appendFrames(path, ['{"id":2}'])).rejects.toThrow('quarantine failed')
    expect(await readFile(path)).toEqual(original)
  })

  it('generates distinct quarantine names', () => {
    expect(quarantinePath('records.jsonl')).not.toBe(quarantinePath('records.jsonl'))
  })
})
