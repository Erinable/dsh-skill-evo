import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  JsonlEventStore,
  EvolutionService,
  ObservationLog,
  StaleAdoptionBaseError,
  buildExposureView,
  createContentHash,
  createObservation,
  parseObservation,
  validateAdoptionBase,
  type AdoptionCandidate,
  type RuntimeObservation,
  type SkillRef,
  repairJsonlFile,
  rotateJsonl,
  resolveLayout,
  classifyFollowUps,
  MaintenanceWorker,
  readCursor,
  redactSensitiveText,
} from '../src/index.js'

const dirs: string[] = []
const execFileAsync = promisify(execFile)

describe('tool summary redaction', () => {
  it('returns promptly for unterminated quoted headers', () => {
    const cases = [
      `'Authorization: ${'a\\'.repeat(5000)}`,
      `"Cookie: ${'a\\'.repeat(5000)}`,
    ]
    for (const input of cases) {
      const started = performance.now()
      redactSensitiveText(input)
      expect(performance.now() - started).toBeLessThan(100)
    }
  })

  it('matches the approved probes exactly and is idempotent', () => {
    const cases = [
      [
        'https_proxy=http://alice:s3cret@10.0.0.1:7890 git push',
        'https_proxy=http://[REDACTED]@10.0.0.1:7890 git push',
      ],
      [
        'git push https://alice:s3cret@github.com/o/r.git',
        'git push https://[REDACTED]@github.com/o/r.git',
      ],
      [
        "curl -H 'Authorization: Bearer abcdefghijklmnop' https://api.example.com",
        "curl -H 'Authorization: [REDACTED]' https://api.example.com",
      ],
      [
        "curl -H 'Cookie: theme=dark; session=sessval123' https://x.test",
        "curl -H 'Cookie: [REDACTED]' https://x.test",
      ],
      [
        'curl -H \'Authorization: Digest username="bob", response="6629fae49393a053"\' https://x.test',
        "curl -H 'Authorization: [REDACTED]' https://x.test",
      ],
      [
        "curl -H 'Authorization: AWS4-HMAC-SHA256 Credential=AKID/2020, Signature=fe5f80f77d5f' https://x.test",
        "curl -H 'Authorization: [REDACTED]' https://x.test",
      ],
      [
        "curl -H 'X-Api-Key: abc def ghi' https://x.test",
        "curl -H 'X-Api-Key: [REDACTED]' https://x.test",
      ],
      [
        'mytool --token abcdefghijkl --password hunter2',
        'mytool --token [REDACTED] --password [REDACTED]',
      ],
      [
        'GITHUB_TOKEN=secret npm publish',
        'GITHUB_TOKEN=[REDACTED] npm publish',
      ],
      [
        'export NPM_AUTH=secret; token=secret',
        'export NPM_AUTH=[REDACTED]; token=[REDACTED]',
      ],
      [
        'curl "https://api.example.com/v1?access_token=abc123def"',
        'curl "https://api.example.com/v1?[REDACTED]"',
      ],
      [
        'curl "https://b.s3.amazonaws.com/o?X-Amz-Signature=deadbeef&X-Amz-Credential=AKID"',
        'curl "https://b.s3.amazonaws.com/o?[REDACTED]"',
      ],
      [
        'curl "https://x.blob.core.windows.net/c?sv=2020&sig=abc%2Fdef"',
        'curl "https://x.blob.core.windows.net/c?[REDACTED]"',
      ],
      [
        'open https://app.example.com/cb#access_token=abc123',
        'open https://app.example.com/cb#[REDACTED]',
      ],
      [
        'git clone https://u:p@git.example.com/r.git?ref=main',
        'git clone https://[REDACTED]@git.example.com/r.git?[REDACTED]',
      ],
      ['mytool --password "hunter2"', 'mytool --password [REDACTED]'],
      ["mytool --token 'abc123'", 'mytool --token [REDACTED]'],
      ['export GITHUB_TOKEN="plainvalue"', 'export GITHUB_TOKEN=[REDACTED]'],
      ["API_KEY='abc123' ./run", 'API_KEY=[REDACTED] ./run'],
      [
        'curl -u "alice:pw" https://x.test',
        'curl -u [REDACTED] https://x.test',
      ],
    ]
    for (const [input, expected] of cases) {
      const redacted = redactSensitiveText(input)
      expect(redacted).toBe(expected)
      expect(redactSensitiveText(redacted)).toBe(redacted)
    }
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

function skill(contentHash = createContentHash('skill body')): SkillRef {
  return {
    name: 'api-debugging',
    provider: 'filesystem',
    source: 'project-dsh',
    contentHash,
  }
}

function observation(
  id: string,
  kind: RuntimeObservation['kind'],
  currentSkill = skill(),
  payload: Record<string, unknown> = {},
): RuntimeObservation {
  return createObservation({
    id,
    kind,
    occurredAt: '2026-09-25T00:00:00.000Z',
    sessionId: 'session-1',
    taskId: 'task-1',
    skill: currentSkill,
    correlationIds: [],
    payload,
    source: 'runtime',
  })
}

describe('EvolutionLayout', () => {
  it('preserves the established centralized state layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-layout-'))
    dirs.push(root)
    const layout = resolveLayout({ root })
    expect(layout).toMatchObject({
      root,
      stateDir: join(root, '.skill-evolution'),
      cursorPath: join(root, '.skill-evolution', 'projection-cursor.json'),
      locksDir: join(root, '.skill-evolution', 'locks'),
      candidatesDir: join(root, '.skill-evolution', 'candidates'),
      proposalReportsDir: join(root, '.skill-evolution', 'proposals'),
      evaluationReportsDir: join(root, '.skill-evolution', 'evaluations'),
    })
    expect(layout.candidateDir('proposal-1')).toBe(
      join(root, '.skill-evolution', 'candidates', 'proposal-1'),
    )
    expect(layout.publicationLockPath('api-debugging')).toBe(
      join(root, '.skill-evolution', 'locks', 'api-debugging.lock'),
    )
    expect(layout.skillVersionsDir('api-debugging')).toBe(
      join(root, 'api-debugging', 'versions'),
    )
    expect(layout.observations.path).toBe(
      join(root, '.skill-evolution', 'observations.jsonl'),
    )
    expect(layout.stores).toEqual([
      {
        name: 'observations',
        role: 'fact',
        projectionInput: true,
        path: join(root, '.skill-evolution', 'observations.jsonl'),
      },
      {
        name: 'proposals',
        role: 'fact',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'proposals.jsonl'),
      },
      {
        name: 'decisions',
        role: 'fact',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'decisions.jsonl'),
      },
      {
        name: 'feedback',
        role: 'fact',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'feedback.jsonl'),
      },
      {
        name: 'evaluations',
        role: 'fact',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'evaluations.jsonl'),
      },
      {
        name: 'classifications',
        role: 'memo',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'classifications.jsonl'),
      },
      {
        name: 'emissions',
        role: 'memo',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'emissions.jsonl'),
      },
      {
        name: 'experiences',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'experiences.jsonl'),
      },
      {
        name: 'follow-ups',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'follow-ups.jsonl'),
      },
      {
        name: 'failures',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'failures.jsonl'),
      },
      {
        name: 'clusters',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'clusters.jsonl'),
      },
      {
        name: 'diagnoses',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'diagnoses.jsonl'),
      },
      {
        name: 'skill-windows',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'skill-windows.jsonl'),
      },
      {
        name: 'skill-posteriors',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'skill-posteriors.jsonl'),
      },
      {
        name: 'failure-attributions',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'failure-attributions.jsonl'),
      },
      {
        name: 'episodes',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'episodes.jsonl'),
      },
      {
        name: 'patterns',
        role: 'derived',
        projectionInput: false,
        path: join(root, '.skill-evolution', 'patterns.jsonl'),
      },
    ])
  })

  it('only overrides the observation store path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-layout-override-'))
    dirs.push(root)
    const override = join(root, 'custom', 'observations.jsonl')
    const layout = resolveLayout({ root, observationStore: override })
    expect(layout.observations.path).toBe(override)
    expect(layout.stores.slice(1).map((store) => store.path)).toEqual([
      join(root, '.skill-evolution', 'proposals.jsonl'),
      join(root, '.skill-evolution', 'decisions.jsonl'),
      join(root, '.skill-evolution', 'feedback.jsonl'),
      join(root, '.skill-evolution', 'evaluations.jsonl'),
      join(root, '.skill-evolution', 'classifications.jsonl'),
      join(root, '.skill-evolution', 'emissions.jsonl'),
      join(root, '.skill-evolution', 'experiences.jsonl'),
      join(root, '.skill-evolution', 'follow-ups.jsonl'),
      join(root, '.skill-evolution', 'failures.jsonl'),
      join(root, '.skill-evolution', 'clusters.jsonl'),
      join(root, '.skill-evolution', 'diagnoses.jsonl'),
      join(root, '.skill-evolution', 'skill-windows.jsonl'),
      join(root, '.skill-evolution', 'skill-posteriors.jsonl'),
      join(root, '.skill-evolution', 'failure-attributions.jsonl'),
      join(root, '.skill-evolution', 'episodes.jsonl'),
      join(root, '.skill-evolution', 'patterns.jsonl'),
    ])
  })
})

describe('context shadowing vocabulary', () => {
  it('accepts the core kind without interpreting DSH event names', () => {
    const event = parseObservation(
      JSON.stringify(
        observation('shadowed', 'context-shadowed', skill(), {
          shadowedSeqRanges: [[6, 6]],
          mechanism: 'prune',
          shadowedTokenCount: 42,
        }),
      ),
    )
    expect(event.kind).toBe('context-shadowed')
    expect(event.payload).toMatchObject({
      shadowedSeqRanges: [[6, 6]],
      mechanism: 'prune',
      shadowedTokenCount: 42,
    })
  })
})

describe('JsonlEventStore', () => {
  it('creates an append-only file and ignores duplicate event IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const store = new JsonlEventStore(join(dir, 'events.jsonl'))
    const event = observation('event-1', 'skill-loaded')

    expect(await store.append(event)).toBe(true)
    expect(await store.append(event)).toBe(false)
    expect(await store.readAll()).toEqual([event])
    expect(
      (await readFile(join(dir, 'events.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean),
    ).toHaveLength(1)
  })

  it('queries by session, skill, and event kind after reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const store = new JsonlEventStore(path)
    await store.appendMany([
      observation('event-1', 'catalog-visible'),
      observation('event-2', 'skill-loaded'),
      observation('event-3', 'task-finished', {
        ...skill(),
        name: 'other-skill',
      }),
    ])

    const reopened = new JsonlEventStore(path)
    expect(
      (
        await reopened.query({
          skillName: 'api-debugging',
          kind: 'skill-loaded',
        })
      ).map((item) => item.id),
    ).toEqual(['event-2'])
  })

  it('queries observations by inclusive ISO time bounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const store = new JsonlEventStore(join(dir, 'events.jsonl'))
    await store.appendMany([
      observation('early', 'agent-step'),
      createObservation({
        ...observation('late', 'task-finished'),
        occurredAt: '2026-09-25T00:00:01.000Z',
      }),
    ])
    expect(
      (await store.query({ since: '2026-09-25T00:00:01.000Z' })).map(
        (item) => item.id,
      ),
    ).toEqual(['late'])
  })

  it('serializes concurrent appends in invocation order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-'))
    dirs.push(dir)
    const store = new JsonlEventStore(join(dir, 'events.jsonl'))
    await Promise.all([
      store.append(observation('ordered-1', 'agent-step')),
      store.append(observation('ordered-2', 'agent-step')),
      store.append(observation('ordered-3', 'agent-step')),
    ])
    expect((await store.readAll()).map((item) => item.id)).toEqual([
      'ordered-1',
      'ordered-2',
      'ordered-3',
    ])
  })

  it('deduplicates same-ID appends from separate Node processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-process-lock-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const modulePath = new URL('../lib/index.js', import.meta.url).pathname
    const script = `import { JsonlEventStore } from ${JSON.stringify(modulePath)}; const store = new JsonlEventStore(process.argv[1]); await store.append(${JSON.stringify(observation('cross-process', 'agent-step'))})`
    await Promise.all([
      execFileAsync(process.execPath, [
        '--input-type=module',
        '-e',
        script,
        path,
      ]),
      execFileAsync(process.execPath, [
        '--input-type=module',
        '-e',
        script,
        path,
      ]),
    ])
    expect(await new JsonlEventStore(path).readAll()).toHaveLength(1)
  })

  it('repairs duplicate, invalid, and unterminated JSONL records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-repair-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const event = observation('repair-1', 'agent-step')
    await writeFile(
      path,
      `${JSON.stringify(event)}\n${JSON.stringify(event)}\nnot-json`,
      'utf8',
    )
    const result = await repairJsonlFile(path)
    expect(result).toMatchObject({
      validRecords: 1,
      removedDuplicates: 1,
      removedInvalidLines: 1,
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      id: 'repair-1',
    })
    expect(result.invalidQuarantine).toBeDefined()
  })

  it('reclaims a dead file lock before repairing JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-lock-repair-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    await writeFile(
      path,
      `${JSON.stringify(observation('locked', 'agent-step'))}\n`,
      'utf8',
    )
    await writeFile(
      `${path}.lock`,
      JSON.stringify({
        pid: 999999,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    )
    await expect(repairJsonlFile(path)).resolves.toMatchObject({
      validRecords: 1,
    })
  })

  it('rotates only archives belonging to the selected JSONL file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-rotate-'))
    dirs.push(dir)
    const observations = join(dir, 'observations.jsonl')
    const feedback = join(dir, 'feedback.jsonl')
    await writeFile(observations, 'x'.repeat(20), 'utf8')
    await mkdir(join(dir, 'archive'), { recursive: true })
    await writeFile(
      join(dir, 'archive', 'feedback.jsonl.old.jsonl'),
      'feedback',
      'utf8',
    )
    await writeFile(feedback, 'feedback', 'utf8')
    const result = await rotateJsonl(observations, {
      maxBytes: 1,
      retentionDays: 30,
    })
    expect(result.rotated).toBeDefined()
    expect(
      await readFile(join(dir, 'archive', 'feedback.jsonl.old.jsonl'), 'utf8'),
    ).toBe('feedback')
  })
})

describe('ObservationLog state root', () => {
  function archivePath(path: string): string {
    return join(
      path.replace(/[^/]+$/, 'archive'),
      `${path.split('/').at(-1)}.2026-09-25T00-00-00.000Z.1.jsonl`,
    )
  }

  it('keeps all derived projections stable when observations rotate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-projection-'))
    dirs.push(dir)
    const service = new EvolutionService({ root: dir })
    await service.observations.appendMany([
      observation('loaded', 'skill-loaded'),
      observation('follow-up', 'user-follow-up', skill(), {
        text: 'Please correct this.',
      }),
      observation('failure-1', 'skill-load-failed', skill(), {
        error: 'same failure',
      }),
      observation('failure-2', 'skill-load-failed', skill(), {
        error: 'same failure',
      }),
    ])
    const before = await service.refreshDerived()
    const result = await service.observations.rotate({ maxBytes: 1 })
    const after = await service.refreshDerived()
    expect(result.rotated).toBeDefined()
    expect(after).toMatchObject({
      experiences: before.experiences,
      failures: before.failures,
      clusters: before.clusters,
      diagnoses: before.diagnoses,
    })
    expect(after.clusters.map((item) => item.id)).toEqual(
      before.clusters.map((item) => item.id),
    )
    expect(after.diagnoses.map((item) => item.id)).toEqual(
      before.diagnoses.map((item) => item.id),
    )
  })

  it('deduplicates archived IDs, ignores foreign basenames, and locates override archives beside the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-archive-'))
    dirs.push(dir)
    const path = join(dir, 'custom-events.jsonl')
    const event = observation('archived', 'agent-step')
    const store = new ObservationLog(path)
    await store.append(event)
    await store.rotate({ maxBytes: 1 })
    const foreign = join(
      dir,
      'archive',
      'feedback.jsonl.2026-09-25T00-00-00.000Z.1.jsonl',
    )
    await writeFile(
      foreign,
      `${JSON.stringify(observation('foreign', 'agent-step'))}\n`,
      'utf8',
    )
    const reopened = new ObservationLog(path)
    expect((await reopened.readAll()).map((item) => item.id)).toEqual([
      'archived',
    ])
    expect(await reopened.append(event)).toBe(false)
    expect(
      (await readdir(join(dir, 'archive'))).some((name) =>
        name.startsWith('custom-events.jsonl.'),
      ),
    ).toBe(true)
  })

  it('quarantines a current tail before appending and keeps the new observation through repair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-observation-tail-'))
    dirs.push(dir)
    const service = new EvolutionService({ root: dir })
    const path = service.observations.filePath
    const first = observation('first', 'agent-step')
    const second = observation('second', 'agent-step')
    await service.recordObservation(first)
    const tail = Buffer.from('{"id":"second","torn":"abcdefg')
    expect(tail).toHaveLength(30)
    await writeFile(path, Buffer.concat([await readFile(path), tail]))

    expect(
      (await service.observations.readAll()).map((item) => item.id),
    ).toEqual(['first'])
    expect(await service.recordObservation(second)).toBe(true)
    expect(await service.recordObservation(second)).toBe(false)
    expect(
      (await service.observations.readAll()).map((item) => item.id),
    ).toEqual(['first', 'second'])
    const quarantines = (await readdir(join(dir, '.skill-evolution'))).filter(
      (name) => name.startsWith('observations.jsonl.invalid-'),
    )
    expect(quarantines).toHaveLength(1)
    expect(
      await readFile(join(dir, '.skill-evolution', quarantines[0])),
    ).toEqual(tail)

    const report = await service.repair()
    expect(
      report.jsonl.find((item) => item.path === path)?.removedInvalidLines,
    ).toBe(0)
    expect(
      (await service.observations.readAll()).map((item) => item.id),
    ).toEqual(['first', 'second'])
  })

  it.each([
    ['bad JSON', 'not-json'],
    ['invalid schema', JSON.stringify({ id: 'bad', schemaVersion: 99 })],
    [
      'unterminated tail',
      `${JSON.stringify(observation('bad', 'agent-step'))}x`,
    ],
  ])(
    'rejects %s in an archive for read and append',
    async (_label, content) => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-bad-archive-'))
      dirs.push(dir)
      const path = join(dir, 'observations.jsonl')
      await mkdir(join(dir, 'archive'), { recursive: true })
      const segment = archivePath(path)
      await writeFile(segment, content, 'utf8')
      const store = new ObservationLog(path)
      await expect(store.readAll()).rejects.toThrow(segment)
      await expect(store.query({ kind: 'agent-step' })).rejects.toThrow(segment)
      await expect(
        store.append(observation('new', 'agent-step')),
      ).rejects.toThrow(segment)
    },
  )

  it('quarantines an unterminated tail while retaining complete facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-tail-'))
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    const complete = observation('complete', 'agent-step')
    const tail = Buffer.from('partial-tail')
    await writeFile(path, `${JSON.stringify(complete)}\n`)
    await writeFile(path, Buffer.concat([await readFile(path), tail]))
    const result = await new ObservationLog(path).rotate({ maxBytes: 1 })
    expect(result.invalidQuarantine).toBeDefined()
    expect(result.invalidQuarantine).toMatch(
      /^.+\.invalid-\d+-\d+-[0-9a-f-]{36}$/,
    )
    expect(await readFile(result.invalidQuarantine!)).toEqual(tail)
    expect((await readFile(result.rotated!, 'utf8')).endsWith('\n')).toBe(true)
    expect(
      (await readFile(result.rotated!, 'utf8')).split('\n').filter(Boolean),
    ).toHaveLength(1)
    const store = new ObservationLog(path)
    expect((await store.readAll()).map((item) => item.id)).toEqual(['complete'])
    expect(await store.append(observation('new', 'agent-step'))).toBe(true)
  })

  it('quarantines an unterminated tail through rotateJsonl compatibility API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-compat-tail-'))
    dirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const tail = Buffer.from('legacy-partial-tail')
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(
          `${JSON.stringify(observation('complete-compat', 'agent-step'))}\n`,
        ),
        tail,
      ]),
    )

    const result = await rotateJsonl(path, { maxBytes: 1 })
    expect(result.invalidQuarantine).toBeDefined()
    expect(await readFile(result.invalidQuarantine!, 'utf8')).toBe(
      tail.toString(),
    )
    expect((await readFile(result.rotated!, 'utf8')).endsWith('\n')).toBe(true)
  })

  it('rotates only a residual tail into an empty archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-only-tail-'))
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    await writeFile(path, 'partial-tail', 'utf8')
    const result = await new ObservationLog(path).rotate({ maxBytes: 1 })
    expect(result.invalidQuarantine).toBeDefined()
    expect(await readFile(result.rotated!, 'utf8')).toBe('')
    expect(
      await new ObservationLog(path).append(observation('new', 'agent-step')),
    ).toBe(true)
  })

  it('leaves current bytes and archives untouched when quarantine fails', async () => {
    const dir = await mkdtemp(
      join(tmpdir(), 'dsh-skill-evo-quarantine-failure-'),
    )
    dirs.push(dir)
    const path = join(dir, `${'o'.repeat(240)}`)
    await mkdir(join(dir, 'archive'), { recursive: true })
    const original = `${JSON.stringify(observation('complete', 'agent-step'))}\npartial`
    await writeFile(path, original, 'utf8')
    await expect(
      new ObservationLog(path).rotate({ maxBytes: 1 }),
    ).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readdir(join(dir, 'archive'))).toEqual([])
  })

  it('does not delete archives unless retention is explicitly requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-retention-'))
    dirs.push(dir)
    const path = join(dir, 'observations.jsonl')
    await writeFile(path, 'x', 'utf8')
    const archive = join(
      dir,
      'archive',
      'observations.jsonl.2000-01-01T00-00-00.000Z.1.jsonl',
    )
    await mkdir(join(dir, 'archive'), { recursive: true })
    await writeFile(archive, '', 'utf8')
    await utimes(archive, new Date('2000-01-01'), new Date('2000-01-01'))
    const result = await rotateJsonl(path, { maxBytes: 2 })
    expect(result.deleted).toEqual([])
    expect(await readFile(archive, 'utf8')).toBe('')
  })
})

describe('buildExposureView', () => {
  it('reports exposure facts without inferring Skill impact', () => {
    const events = [
      observation('catalog', 'catalog-visible'),
      observation('request', 'skill-load-requested'),
      observation('loaded', 'skill-loaded'),
      observation('follow-up', 'user-follow-up', skill(), {
        text: 'Please correct step two.',
      }),
    ]

    expect(buildExposureView(events)).toEqual([
      {
        skill: skill(),
        catalogVisible: true,
        loadRequested: true,
        loadSucceeded: true,
        loadFailed: false,
        followUpObservationIds: ['follow-up'],
        observationIds: ['catalog', 'request', 'loaded', 'follow-up'],
      },
    ])
  })

  it('keeps versions with different content hashes separate', () => {
    const first = skill(createContentHash('first'))
    const second = skill(createContentHash('second'))
    const views = buildExposureView([
      observation('first', 'skill-loaded', first),
      observation('second', 'skill-loaded', second),
    ])

    expect(views.map((view) => view.skill.contentHash)).toEqual([
      first.contentHash,
      second.contentHash,
    ])
  })

  it('merges an incomplete catalog identity into a later loaded snapshot', () => {
    const loaded = skill(createContentHash('loaded'))
    const views = buildExposureView([
      observation('catalog', 'catalog-visible', {
        name: loaded.name,
        provider: 'unknown',
        source: 'unknown',
      }),
      observation('request', 'skill-load-requested', {
        name: loaded.name,
        provider: 'unknown',
        source: 'unknown',
      }),
      observation('loaded', 'skill-loaded', loaded),
    ])

    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      skill: loaded,
      catalogVisible: true,
      loadRequested: true,
      loadSucceeded: true,
    })
  })
})

describe('validateAdoptionBase', () => {
  const candidate: AdoptionCandidate = {
    proposalId: 'proposal-1',
    skill: skill(createContentHash('candidate')),
    expectedBase: {
      name: 'api-debugging',
      contentHash: createContentHash('base'),
    },
    target: 'project',
    effectiveAt: 'next-load',
  }

  it('accepts an unchanged base snapshot', () => {
    expect(
      validateAdoptionBase(candidate, {
        current: skill(candidate.expectedBase.contentHash),
      }),
    ).toEqual({ ok: true, candidate })
  })

  it('rejects a stale base without modifying anything', () => {
    expect(() =>
      validateAdoptionBase(candidate, {
        current: skill(createContentHash('newer')),
      }),
    ).toThrow(StaleAdoptionBaseError)
  })
})

describe('follow-up classification memo', () => {
  async function setup(
    classify = vi.fn(async () => ({
      intent: 'goal-changed' as const,
      confidence: 0.9,
    })),
    version = 'fake-v1',
  ) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-classifications-'))
    dirs.push(root)
    const service = new EvolutionService({
      root,
      followUpClassifier: { version, classify },
      classifierTimeoutMs: 20,
    })
    await service.observations.appendMany([
      observation('loaded', 'skill-loaded'),
      observation('correction', 'user-follow-up', skill(), {
        text: 'wrong, please correct this',
      }),
      observation('finished', 'task-finished'),
    ])
    return { root, service, classify }
  }

  it('changes projection only after classification and restores the entire rule snapshot when removed', async () => {
    const { root, service, classify } = await setup()
    const original = await new EvolutionService({ root }).refreshDerived()
    expect(original.followUps[0]).toMatchObject({
      source: 'rule',
      intent: 'incorrect',
    })
    expect(original.failures).toHaveLength(1)
    const cursorRule = await readCursor(service.layout.cursorPath)
    await service.refreshDerived()
    const cursorInjected = await readCursor(service.layout.cursorPath)
    expect(cursorInjected?.derivationKey).not.toBe(cursorRule?.derivationKey)
    await service.listFailures()
    await service.metrics()
    await new MaintenanceWorker({ service }).runOnce()
    expect(classify).not.toHaveBeenCalled()
    expect(await classifyFollowUps(service)).toMatchObject({
      classified: 1,
      cached: 0,
      failed: [],
    })
    const classified = await service.refreshDerived()
    expect(classified.followUps[0]).toMatchObject({
      source: 'classifier',
      intent: 'goal-changed',
      attribution: 'task-change',
    })
    expect(classified.failures).toEqual([])
    expect(
      (await readCursor(service.layout.cursorPath))?.derivationKey,
    ).not.toBe(cursorInjected?.derivationKey)
    expect(await classifyFollowUps(service)).toMatchObject({
      classified: 0,
      cached: 1,
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-02T00:00:00Z'))
    expect(await new EvolutionService({ root }).refreshDerived()).toEqual(
      original,
    )
    const nextVersion = new EvolutionService({
      root,
      followUpClassifier: { version: 'fake-v2', classify },
    })
    expect((await nextVersion.refreshDerived()).followUps[0]).toMatchObject({
      source: 'rule',
      fallbackReason: 'not-classified',
    })
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('preserves valid memo bytes and isolates malformed rows during repair without model calls', async () => {
    const { service, classify } = await setup()
    await classifyFollowUps(service)
    const path = service.classifications.filePath
    const entries = await service.classifications.readAll()
    const bytes = `  ${JSON.stringify(entries[0], null, 0)}  \r\n`
    await writeFile(path, bytes)
    await service.repair()
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await writeFile(
      path,
      `${bytes}{"id":"bad-schema"}\nnot-json\n{"unterminated":`,
    )
    const report = await service.repair()
    const memoRepair = report.jsonl.find((item) => item.path === path)!
    expect(memoRepair.removedInvalidLines).toBe(3)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readFile(memoRepair.invalidQuarantine!, 'utf8')).toContain(
      'bad-schema',
    )
    expect(
      (await service.health()).find((item) => item.path === path)?.readable,
    ).toBe(true)
    expect(classify).toHaveBeenCalledTimes(1)
    expect((await service.refreshDerived()).followUps[0]?.source).toBe(
      'classifier',
    )
  })

  it('skips explicit and pending rows and bounds redacted classifier context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-classifier-input-'))
    dirs.push(root)
    const inputs: unknown[] = []
    const classify = vi.fn(async (input: unknown) => {
      inputs.push(input)
      return { intent: 'satisfied' as const, confidence: 0.8 }
    })
    const service = new EvolutionService({
      root,
      followUpClassifier: { version: 'input-v1', classify },
    })
    const before = Array.from({ length: 25 }, (_, index) =>
      observation(`before-${index}`, 'tool-result', skill(), {
        toolName: 'tool',
        input: index,
      }),
    )
    await service.observations.appendMany([
      ...before,
      observation('explicit', 'user-follow-up', skill(), {
        explicit: true,
        feedbackKind: 'satisfied',
        text: 'explicit',
      }),
      observation('pending', 'user-follow-up', skill(), { text: 'pending' }),
      observation('closed', 'user-follow-up', skill(), {
        text: 'password: secret-value please continue',
      }),
      ...Array.from({ length: 25 }, (_, index) =>
        observation(`after-${index}`, 'tool-result', skill(), {
          toolName: 'tool',
          failed: index === 0,
        }),
      ),
      observation('finish', 'task-finished'),
      observation('pending-tail', 'user-follow-up', skill(), {
        text: 'pending',
      }),
    ])
    const result = await classifyFollowUps(service)
    expect(result.skipped).toEqual({ explicit: 1, pending: 1 })
    expect(result.classified).toBe(2)
    expect(classify).toHaveBeenCalledTimes(2)
    const input = inputs.find((item) =>
      (item as { text?: string }).text?.includes('[REDACTED]'),
    ) as { text?: string; before: unknown[]; after: unknown[] }
    expect(input.text).toContain('[REDACTED]')
    expect(input.text).not.toContain('secret-value')
    expect(input.before.length).toBeLessThanOrEqual(20)
    expect(input.after.length).toBeLessThanOrEqual(20)
  })

  it('isolates timeout, thrown, and invalid classifier results while continuing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-classifier-errors-'))
    dirs.push(root)
    const classify = vi.fn(
      async (input: { observationId: string }, signal: AbortSignal) => {
        if (input.observationId === 'timeout')
          return new Promise<never>((resolve) =>
            setTimeout(
              () => resolve({ intent: 'satisfied', confidence: 0.5 } as never),
              80,
            ),
          )
        if (input.observationId === 'throw') throw new Error('model failed')
        if (input.observationId === 'invalid')
          return { intent: 'other' as never, confidence: 2 }
        signal.throwIfAborted()
        return { intent: 'satisfied' as const, confidence: 0.7 }
      },
    )
    const service = new EvolutionService({
      root,
      followUpClassifier: { version: 'errors-v1', classify },
      classifierTimeoutMs: 10,
    })
    for (const id of ['timeout', 'throw', 'invalid', 'success']) {
      await service.observations.appendMany([
        observation(id, 'user-follow-up', skill(), { text: id }),
        observation(`${id}-done`, 'task-finished'),
      ])
    }
    const result = await classifyFollowUps(service)
    expect(
      result.failed.map((item) => [item.observationId, item.reason]),
    ).toEqual([
      ['timeout', 'timeout'],
      ['throw', 'error'],
      ['invalid', 'invalid-output'],
    ])
    expect(result.classified).toBe(1)
    expect(await service.classifications.readAll()).toHaveLength(1)
  })

  it('fails before model calls when no classifier is configured and exposes source-split metrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-classifier-metrics-'))
    dirs.push(root)
    const service = new EvolutionService({ root })
    await service.observations.appendMany([
      observation('explicit-metric', 'user-follow-up', skill(), {
        explicit: true,
        feedbackKind: 'incorrect',
        text: 'wrong',
      }),
      observation('explicit-done', 'task-finished'),
      observation('rule-metric', 'user-follow-up', skill(), { text: 'wrong' }),
      observation('rule-done', 'task-finished'),
    ])
    await expect(classifyFollowUps(service)).rejects.toMatchObject({
      code: 'classifier-unavailable',
    })
    const metrics = await service.metrics()
    expect(metrics.followUpIntents.explicit).toMatchObject({
      total: 1,
      failures: 1,
      byIntent: { incorrect: 1 },
    })
    expect(metrics.followUpIntents.rule).toMatchObject({
      total: 1,
      failures: 1,
      byIntent: { incorrect: 1 },
    })
    expect(metrics.skills[0]).toMatchObject({ followUps: 1, followUpRate: 0 })
    expect(metrics.skills[0]?.followUpIntents.explicit).toMatchObject({
      total: 1,
      failures: 1,
      byIntent: { incorrect: 1 },
    })
  })
})
