import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionService, createObservation, fingerprintOf, readCursor, repairEvolutionRoot, type RuntimeObservation } from '../src/index.js'
import { withLock } from '../src/locking.js'

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
    await expect(service.observations.append(observation('new'))).rejects.toThrow(badJsonPath)

    const report = await service.repair()
    expect(report.jsonl.map(item => item.path)).toEqual(expect.arrayContaining([badJsonPath, badSchemaPath, tailPath]))
    expect(report.jsonl.find(item => item.path === badJsonPath)).toMatchObject({ validRecords: 1, removedInvalidLines: 1 })
    expect(report.jsonl.find(item => item.path === badSchemaPath)).toMatchObject({ validRecords: 0, removedInvalidLines: 1 })
    expect(report.jsonl.find(item => item.path === badJsonPath)?.invalidQuarantine).toBeDefined()
    expect(report.jsonl.find(item => item.path === badSchemaPath)?.invalidQuarantine).toBeDefined()
    expect((await service.observations.readAll()).map(item => item.id)).toEqual(['kept', 'also-kept', 'tail'])
    expect(await readFile(foreignPath, 'utf8')).toBe('leave-this-byte-stream-alone')
    expect((await new EvolutionService({ root }).observations.readAll()).map(item => item.id)).toEqual(['kept', 'also-kept', 'tail'])
  })

  it('waits for the observation lock before changing archive bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-archive-lock-'))
    dirs.push(root)
    const path = join(root, '.skill-evolution', 'observations.jsonl')
    const archive = join(root, '.skill-evolution', 'archive')
    await mkdir(archive, { recursive: true })
    const segment = join(archive, 'observations.jsonl.2026-09-25T00-00-00.000Z.1.jsonl')
    await writeFile(segment, 'not-json\n', 'utf8')
    const before = await readFile(segment)
    const service = new EvolutionService({ root })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const lock = withLock(`${path}.lock`, 'test-hold', () => held)
    await delay(30)
    const repair = service.repair()
    await delay(40)
    expect(await readFile(segment)).toEqual(before)
    let completed = false
    void repair.then(() => { completed = true })
    await delay(20)
    expect(completed).toBe(false)
    release()
    await lock
    await repair
    expect(await readFile(segment)).toEqual(Buffer.alloc(0))
  })

  it('handles health and repair without an archive directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-no-archive-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    expect(await service.health()).toHaveLength(9)
    expect((await service.repair()).jsonl).toHaveLength(9)
  })

  it('forces projection repair and keeps standalone repair from changing the cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-cursor-repair-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await service.observations.appendMany([observation('first'), observation('second')])
    const fresh = await service.refreshDerived()
    const cursorPath = join(root, '.skill-evolution', 'projection-cursor.json')
    const failuresPath = join(root, '.skill-evolution', 'failures.jsonl')
    await writeFile(failuresPath, '', 'utf8')
    const beforeStandalone = await readFile(cursorPath, 'utf8')

    const standalone = await repairEvolutionRoot(root, { jsonlPaths: [], observationsPath: service.observations.filePath })
    expect(standalone.projectionCursorRebuilt).toBe(false)
    expect(await readFile(cursorPath, 'utf8')).toBe(beforeStandalone)

    const report = await service.repair()
    expect(report.projectionCursorRebuilt).toBe(true)
    expect(await service.failures.readAll()).toEqual(fresh.failures)
    expect(await readCursor(cursorPath)).toEqual({ count: 2, lastId: 'second', fingerprint: fingerprintOf(['first', 'second']) })
  })

  it('does not parse an observation tail when standalone repair leaves the cursor alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-cursor-tail-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await service.observations.append(observation('complete'))
    await service.refreshDerived()
    const cursorPath = join(root, '.skill-evolution', 'projection-cursor.json')
    const before = await readFile(cursorPath, 'utf8')
    await writeFile(service.observations.filePath, `${await readFile(service.observations.filePath, 'utf8')}partial`, 'utf8')

    await expect(repairEvolutionRoot(root, { jsonlPaths: [], observationsPath: service.observations.filePath })).resolves.toMatchObject({ projectionCursorRebuilt: false })
    expect(await readFile(cursorPath, 'utf8')).toBe(before)
  })
})
