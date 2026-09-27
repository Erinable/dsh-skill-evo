import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionService, createObservation, type RuntimeObservation } from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function observation(id: string): RuntimeObservation {
  return createObservation({
    id,
    kind: 'agent-step',
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    correlationIds: [],
    payload: {},
    source: 'runtime',
  })
}

describe('observation archive health and repair', () => {
  it('reports and repairs malformed matching archive segments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-archive-health-'))
    dirs.push(root)
    const path = join(root, '.skill-evolution', 'observations.jsonl')
    const archive = join(root, '.skill-evolution', 'archive')
    await mkdir(archive, { recursive: true })
    const validPath = join(archive, 'observations.jsonl.2026-09-25T00-00-00.000Z.1.jsonl')
    const badJsonPath = join(archive, 'observations.jsonl.2026-09-25T00-00-01.000Z.1.jsonl')
    const badSchemaPath = join(archive, 'observations.jsonl.2026-09-25T00-00-02.000Z.1.jsonl')
    const tailPath = join(archive, 'observations.jsonl.2026-09-25T00-00-03.000Z.1.jsonl')
    const foreignPath = join(archive, 'feedback.jsonl.2026-09-25T00-00-00.000Z.1.jsonl')
    await writeFile(validPath, `${JSON.stringify(observation('kept'))}\n`, 'utf8')
    await writeFile(badJsonPath, `${JSON.stringify(observation('also-kept'))}\nnot-json\n`, 'utf8')
    await writeFile(badSchemaPath, `${JSON.stringify({ id: 'bad-schema', schemaVersion: 99 })}\n`, 'utf8')
    await writeFile(tailPath, JSON.stringify(observation('tail')), 'utf8')
    await writeFile(foreignPath, 'leave-this-byte-stream-alone', 'utf8')

    const service = new EvolutionService({ root })
    const health = await service.health()
    expect(health.find(item => item.path === badJsonPath)).toMatchObject({ readable: false })
    expect(health.find(item => item.path === badSchemaPath)).toMatchObject({ readable: false })
    expect(health.find(item => item.path === tailPath)).toMatchObject({ readable: false, trailingPartial: true })
    await expect(service.observations.readAll()).rejects.toThrow(badJsonPath)

    const report = await service.repair()
    expect(report.jsonl.map(item => item.path)).toEqual(expect.arrayContaining([badJsonPath, badSchemaPath, tailPath]))
    expect(report.jsonl.find(item => item.path === badJsonPath)).toMatchObject({ validRecords: 1, removedInvalidLines: 1 })
    expect(report.jsonl.find(item => item.path === badSchemaPath)).toMatchObject({ validRecords: 0, removedInvalidLines: 1 })
    expect(report.jsonl.find(item => item.path === badJsonPath)?.invalidQuarantine).toBeDefined()
    expect((await service.observations.readAll()).map(item => item.id)).toEqual(['kept', 'also-kept', 'tail'])
    expect(await readFile(foreignPath, 'utf8')).toBe('leave-this-byte-stream-alone')
  })
})
