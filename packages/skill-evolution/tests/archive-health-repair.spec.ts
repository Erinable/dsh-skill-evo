import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function failedObservation(id: string, error: string): RuntimeObservation {
  return createObservation({
    id,
    kind: 'skill-load-failed',
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    skill: { name: 'api-debugging', provider: 'unknown', source: 'unknown' },
    correlationIds: [],
    payload: { error },
    source: 'runtime',
  })
}

describe('observation archive health and repair', () => {
  it.each(['default', 'override'] as const)('uses the %s layout store order and matching archive paths', async variant => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-layout-health-'))
    dirs.push(root)
    const store = variant === 'override' ? join(root, 'custom', 'events.jsonl') : undefined
    const service = new EvolutionService({ root, ...(store === undefined ? {} : { store }) })
    const observationPath = service.layout.observations.path
    const archive = join(dirname(observationPath), 'archive')
    await mkdir(archive, { recursive: true })
    const segment = join(archive, `${basename(observationPath)}.2026-09-25T00-00-00.000Z.1.jsonl`)
    const foreign = join(archive, 'other.jsonl.2026-09-25T00-00-00.000Z.1.jsonl')
    await writeFile(segment, `${JSON.stringify(observation('archived'))}\n`, 'utf8')
    await writeFile(foreign, 'not-json\n', 'utf8')

    const currentPaths = service.layout.stores.map(item => item.path)
    expect((await service.health()).map(item => item.path)).toEqual([...currentPaths, segment])
    expect((await service.repair()).jsonl.map(item => item.path).sort()).toEqual([...currentPaths, segment].sort())
    expect(await readFile(foreign, 'utf8')).toBe('not-json\n')
  })

  it('reports a complete observation with an invalid schema as unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-observation-health-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await mkdir(join(root, '.skill-evolution'), { recursive: true })
    await writeFile(service.layout.observations.path, `${JSON.stringify({ id: 'invalid', schemaVersion: 99 })}\n`, 'utf8')

    expect((await service.health()).find(item => item.path === service.layout.observations.path)).toMatchObject({ readable: false, completeRecords: 0 })
  })

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
    const tailBytes = Buffer.from(JSON.stringify(observation('tail')), 'utf8')
    await writeFile(tailPath, tailBytes)
    await writeFile(foreignPath, 'leave-this-byte-stream-alone', 'utf8')

    const service = new EvolutionService({ root })
    const health = await service.health()
    expect(health.find(item => item.path === badJsonPath)).toMatchObject({ readable: false })
    expect(health.find(item => item.path === badSchemaPath)).toMatchObject({ readable: false })
    expect(health.find(item => item.path === tailPath)).toMatchObject({ readable: false, completeRecords: 0, trailingPartial: true })
    await expect(service.observations.readAll()).rejects.toThrow(badJsonPath)
    await expect(service.observations.append(observation('new'))).rejects.toThrow(badJsonPath)

    const report = await service.repair()
    expect(report.jsonl.map(item => item.path)).toEqual(expect.arrayContaining([badJsonPath, badSchemaPath, tailPath]))
    expect(report.jsonl.find(item => item.path === badJsonPath)).toMatchObject({ validRecords: 1, removedInvalidLines: 1 })
    expect(report.jsonl.find(item => item.path === badSchemaPath)).toMatchObject({ validRecords: 0, removedInvalidLines: 1 })
    expect(report.jsonl.find(item => item.path === tailPath)).toMatchObject({ validRecords: 0, removedInvalidLines: 1, truncatedTrailingBytes: tailBytes.length })
    expect(report.jsonl.find(item => item.path === badJsonPath)?.invalidQuarantine).toBeDefined()
    expect(report.jsonl.find(item => item.path === badSchemaPath)?.invalidQuarantine).toBeDefined()
    const tailQuarantine = report.jsonl.find(item => item.path === tailPath)?.invalidQuarantine
    expect(tailQuarantine).toBeDefined()
    expect(await readFile(tailQuarantine!)).toEqual(tailBytes)
    expect((await service.observations.readAll()).map(item => item.id)).toEqual(['kept', 'also-kept'])
    expect(await readFile(foreignPath, 'utf8')).toBe('leave-this-byte-stream-alone')
    expect((await new EvolutionService({ root }).observations.readAll()).map(item => item.id)).toEqual(['kept', 'also-kept'])
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

  it.each(['default', 'override'] as const)('handles %s layout without an archive directory', async variant => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-no-archive-'))
    dirs.push(root)
    const store = variant === 'override' ? join(root, 'custom', 'events.jsonl') : undefined
    const service = new EvolutionService({ root, ...(store === undefined ? {} : { store }) })
    const paths = service.layout.stores.map(store => store.path)
    expect((await service.health()).map(item => item.path)).toEqual(paths)
    expect((await service.repair()).jsonl.map(item => item.path).sort()).toEqual([...paths].sort())
  })

  it('forces projection repair and keeps standalone repair from changing the cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-cursor-repair-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await service.observations.appendMany([
      failedObservation('first', 'first failure'),
      failedObservation('second', 'second failure'),
    ])
    const fresh = await service.refreshDerived()
    const cursorPath = join(root, '.skill-evolution', 'projection-cursor.json')
    const failuresPath = join(root, '.skill-evolution', 'failures.jsonl')
    const failureLines = (await readFile(failuresPath, 'utf8')).trimEnd().split('\n')
    await writeFile(failuresPath, `${failureLines[0]}\n`, 'utf8')
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

  it('propagates a derived projection failure without reporting a successful repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-projection-failure-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await service.observations.append(failedObservation('failure', 'projection failure'))
    await service.refreshDerived()
    vi.spyOn(service.failures, 'replaceAll').mockRejectedValueOnce(new Error('injected projection failure'))

    await expect(service.repair()).rejects.toThrow('injected projection failure')
  })

  it('propagates a cursor write failure without reporting a successful repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-cursor-failure-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await service.observations.append(failedObservation('failure', 'cursor failure'))
    await service.refreshDerived()
    const badCursorPath = join(root, '.skill-evolution', 'cursor-directory')
    await mkdir(badCursorPath)
    ;(service as unknown as { projectionCursorPath: string }).projectionCursorPath = badCursorPath

    await expect(service.repair()).rejects.toThrow()
  })

  it('self-heals a legacy cursor that only covered the current observation segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-legacy-cursor-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await service.observations.append(failedObservation('archived', 'archived failure'))
    await service.observations.rotate({ maxBytes: 1 })
    await service.observations.append(failedObservation('current', 'current failure'))
    const cursorPath = join(root, '.skill-evolution', 'projection-cursor.json')
    await Promise.all([
      writeFile(join(root, '.skill-evolution', 'experiences.jsonl'), '', 'utf8'),
      writeFile(join(root, '.skill-evolution', 'failures.jsonl'), '', 'utf8'),
      writeFile(join(root, '.skill-evolution', 'clusters.jsonl'), '', 'utf8'),
      writeFile(join(root, '.skill-evolution', 'diagnoses.jsonl'), '', 'utf8'),
    ])
    await writeFile(cursorPath, `${JSON.stringify({ count: 1, lastId: 'current', fingerprint: fingerprintOf(['current']) })}\n`, 'utf8')

    const snapshot = await service.refreshDerived()
    expect(snapshot.failures).toHaveLength(2)
    expect(await readCursor(cursorPath)).toEqual({ count: 2, lastId: 'current', fingerprint: fingerprintOf(['archived', 'current']) })
  })
})
