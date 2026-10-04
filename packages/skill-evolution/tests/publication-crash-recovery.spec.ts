import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, uptime } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EvolutionService,
  createContentHash,
  checkPromotion,
  resolvePromotionArtifact,
  evaluateProposal,
  promoteProposal,
  proposeSkillChange,
  reviewProposal,
  rollbackSkill,
} from '../src/index.js'

// Crash points and expected recovery: docs/design/publication-crash-recovery.md §1.3 and §4.
// `it.fails` rows reproduce today's non-convergence; flip them to `it` once the recovery protocol in that design lands.

const fault = vi.hoisted(() => ({ paths: [] as string[], invalidate: false }))
vi.mock('node:fs/promises', async importActual => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const target = fault.paths.find(path => String(args[0]).startsWith(`${path}.tmp-`))
      if (target !== undefined) {
        fault.paths = []
        throw new Error(`injected crash before writing ${target}`)
      }
      return actual.writeFile(...args)
    },
  }
})

const dirs: string[] = []
afterEach(async () => {
  fault.paths = []
  fault.invalidate = false
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const skillName = 'api-debugging'
const base = `---\nname: ${skillName}\ndescription: Debug APIs.\n---\n\nUse curl.\n`
const first = `${base}Check the response status before editing.\n`
const second = `${first}Retry idempotent requests once.\n`

type Crash =
  | { readonly kind: 'file'; readonly file: string }
  /** Today's journal is `<skill>/.publish.json`; the design moves it to `.skill-evolution/publications/<skill>.json`. */
  | { readonly kind: 'journal' }
  | { readonly kind: 'call'; readonly store: 'observations' | 'proposals' | 'decisions'; readonly call?: number }
  | { readonly kind: 'invalidate' }

interface CrashRow {
  readonly point: string
  readonly crash: Crash
  readonly versionedBase?: boolean
  /** Crash lands before the operation's commit point, so repair must leave the pre-operation state. */
  readonly beforeCommit?: boolean
}

function service(root: string): EvolutionService {
  return new EvolutionService({
    root,
    invalidate: async () => {
      if (!fault.invalidate) return
      fault.invalidate = false
      throw new Error('injected crash in invalidate')
    },
  })
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-publication-${label}-`))
  dirs.push(root)
  await mkdir(join(root, skillName), { recursive: true })
  await writeFile(join(root, skillName, 'SKILL.md'), base, 'utf8')
  return root
}

async function writeVersionedBase(root: string): Promise<void> {
  const now = '2026-09-28T00:00:00.000Z'
  const manifest = { name: skillName, version: '1.0.0', contentHash: createContentHash(base), status: 'stable', scope: 'project', createdBy: 'human', createdAt: now, updatedAt: now }
  await writeFile(join(root, skillName, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function accept(evolution: EvolutionService, root: string, id: string, baseContent: string, candidateContent: string, proposedVersion: string, marker: string): Promise<string> {
  const proposed = await proposeSkillChange(evolution, { root, id, skillName, baseContent, candidateContent, proposedVersion, intent: `publish ${proposedVersion}` })
  const evaluated = await evaluateProposal(evolution, { root, proposalRef: proposed.proposal.id, cases: [{ id: `case-${id}`, category: 'original-failure', task: 'debug', expected: { contains: [marker] } }] })
  return (await reviewProposal(evolution, { proposalRef: evaluated.recordId, decision: 'accept', reason: 'reviewed' })).recordId
}

/** One accepted proposal `proposal-crash` that publishes `first` as 1.1.0. */
async function promoteScenario(label: string, versionedBase = false): Promise<{ root: string; proposalRef: string }> {
  const root = await tempRoot(label)
  if (versionedBase) await writeVersionedBase(root)
  const proposalRef = await accept(service(root), root, 'proposal-crash', base, first, '1.1.0', 'Check the response status')
  return { root, proposalRef }
}

/** `proposal-one` published 1.0.0, `proposal-two` published 1.1.0; the operation under test rolls back to 1.0.0. */
async function rollbackScenario(label: string): Promise<{ root: string }> {
  const root = await tempRoot(label)
  const evolution = service(root)
  await promoteProposal(evolution, { proposalRef: await accept(evolution, root, 'proposal-one', base, first, '1.0.0', 'Check the response status'), scope: 'project' })
  await promoteProposal(evolution, { proposalRef: await accept(evolution, root, 'proposal-two', first, second, '1.1.0', 'Retry idempotent'), scope: 'project' })
  return { root }
}

function arm(crash: Crash, root: string, evolution: EvolutionService): void {
  if (crash.kind === 'file') fault.paths = [join(root, crash.file)]
  else if (crash.kind === 'journal') fault.paths = [join(root, skillName, '.publish.json'), join(root, '.skill-evolution', 'publications', `${skillName}.json`)]
  else if (crash.kind === 'invalidate') fault.invalidate = true
  else crashOnCall(evolution[crash.store], crash.call ?? 1, crash.store === 'proposals')
}

function crashOnCall(store: { append(record: never): Promise<boolean>; appendComputed?: (...args: never[]) => Promise<unknown> }, call: number, computed = false): void {
  const method = computed && store.appendComputed !== undefined ? 'appendComputed' : 'append'
  const original = store[method]!.bind(store) as (...args: unknown[]) => Promise<unknown>
  let count = 0
  vi.spyOn(store, method as 'append').mockImplementation(async (...args: never[]) => {
    count += 1
    if (count === call) throw new Error('injected crash in append')
    return original(...args)
  })
}

const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g
const EPOCH_MS = /:\d{13}(?![0-9a-f])/g

function normalize(text: string): string {
  return text.replace(TIMESTAMP, '<t>').replace(EPOCH_MS, ':<ms>')
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (!entry.name.includes('.tmp-')) files.push(path)
  }
  return files
}

async function jsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(normalize(line)))
}

/** Everything a publication changes, with clocks and absolute paths removed. Reads files directly so it never triggers recovery. */
async function publicationState(root: string): Promise<unknown> {
  const skillDirectory = join(root, skillName)
  const skillFiles: Record<string, string> = {}
  for (const path of await listFiles(skillDirectory)) {
    skillFiles[relative(skillDirectory, path)] = await readFile(path, 'utf8').then(normalize)
  }
  const state = join(root, '.skill-evolution')
  const journals = (await listFiles(join(state, 'publications'))).map(path => relative(state, path))
  const proposals = await jsonl(join(state, 'proposals.jsonl')) as Array<{ id: string; status: string }>
  const latest = new Map<string, string>()
  for (const record of proposals) latest.set(record.id.replace(/:[a-z-]+$/, ''), record.status)
  return {
    skillFiles,
    journals,
    latestStatus: Object.fromEntries(latest),
    proposals,
    decisions: await jsonl(join(state, 'decisions.jsonl')),
    observations: await jsonl(join(state, 'observations.jsonl')),
  }
}

async function latestStatus(root: string, proposalRoot: string): Promise<string | undefined> {
  return ((await publicationState(root)) as { latestStatus: Record<string, string> }).latestStatus[proposalRoot]
}

function publicationsOf(report: unknown): unknown {
  return (report as { publications?: unknown }).publications
}

const promoteRows: readonly CrashRow[] = [
  { point: 'P0 before the publication journal is written', crash: { kind: 'journal' }, beforeCommit: true },
  { point: 'P1a W1 before versions/1.1.0/SKILL.md', crash: { kind: 'file', file: `${skillName}/versions/1.1.0/SKILL.md` } },
  { point: 'P1b W1 before live SKILL.md', crash: { kind: 'file', file: `${skillName}/SKILL.md` } },
  { point: 'P1c W1 before live manifest.json', crash: { kind: 'file', file: `${skillName}/manifest.json` } },
  { point: 'P1d W1 before current.json', crash: { kind: 'file', file: `${skillName}/current.json` } },
  { point: 'P1e W1 invalidate before .publish.json unlink', crash: { kind: 'invalidate' } },
  { point: 'P1f W1 before versions/1.0.0/manifest.json (versioned base)', crash: { kind: 'file', file: `${skillName}/versions/1.0.0/manifest.json` }, versionedBase: true },
  { point: 'P2 after W1, before W2 observation', crash: { kind: 'call', store: 'observations' } },
  { point: 'P3 after W2, before W3 ledger record', crash: { kind: 'call', store: 'proposals' } },
  { point: 'P4 after W3, before W4 decision', crash: { kind: 'call', store: 'decisions' } },
]

const rollbackRows: readonly CrashRow[] = [
  { point: 'R1a R1 before live manifest.json', crash: { kind: 'file', file: `${skillName}/manifest.json` } },
  { point: 'R1b R1 before current.json', crash: { kind: 'file', file: `${skillName}/current.json` } },
  { point: 'R1c R1 invalidate after current.json', crash: { kind: 'invalidate' } },
  { point: 'R2 after R1, before R2 observation', crash: { kind: 'call', store: 'observations' } },
  { point: 'R3 after R2, before R3 rollback decision', crash: { kind: 'call', store: 'decisions' } },
  { point: 'R4 after R3, before R4 ledger record', crash: { kind: 'call', store: 'proposals' } },
  { point: 'R5 after R4, before R5 transition decision', crash: { kind: 'call', store: 'decisions', call: 2 } },
]

// Set EXPECT_PUBLICATION_RECOVERY=1 to run the pending rows as ordinary tests and see today's failures.
const pending = process.env.EXPECT_PUBLICATION_RECOVERY === '1' ? it : it.fails
const convergesToday = new Set<string>([
  'P0 before the publication journal is written:rerun',
  'P0 before the publication journal is written:repair',
  'P1a W1 before versions/1.1.0/SKILL.md:rerun',
  'P1b W1 before live SKILL.md:rerun',
  'P1f W1 before versions/1.0.0/manifest.json (versioned base):rerun',
  'P1a W1 before versions/1.1.0/SKILL.md:repair',
  'P1b W1 before live SKILL.md:repair',
  'P1c W1 before live manifest.json:rerun',
  'P1c W1 before live manifest.json:repair',
  'P1d W1 before current.json:rerun',
  'P1d W1 before current.json:repair',
  'P1e W1 invalidate before .publish.json unlink:rerun',
  'P1e W1 invalidate before .publish.json unlink:repair',
  'P1f W1 before versions/1.0.0/manifest.json (versioned base):repair',
  'P2 after W1, before W2 observation:rerun',
  'P2 after W1, before W2 observation:repair',
  'P4 after W3, before W4 decision:rerun',
  'P4 after W3, before W4 decision:repair',
  'R1a R1 before live manifest.json:rerun',
  'R1b R1 before current.json:rerun',
  'R1c R1 invalidate after current.json:rerun',
  'R2 after R1, before R2 observation:rerun',
  'R3 after R2, before R3 rollback decision:rerun',
  'R4 after R3, before R4 ledger record:rerun',
  'R5 after R4, before R5 transition decision:rerun',
  'P3 after W2, before W3 ledger record:rerun',
  'P3 after W2, before W3 ledger record:repair',
  'R1a R1 before live manifest.json:repair',
  'R1b R1 before current.json:repair',
  'R1c R1 invalidate after current.json:repair',
  'R2 after R1, before R2 observation:repair',
  'R3 after R2, before R3 rollback decision:repair',
  'R4 after R3, before R4 ledger record:repair',
  'R5 after R4, before R5 transition decision:repair',
])
const recovery = (row: CrashRow, path: 'rerun' | 'repair') => convergesToday.has(`${row.point}:${path}`) ? it : pending

async function crashPromote(row: CrashRow): Promise<{ root: string; proposalRef: string; reference: unknown; before: unknown }> {
  const reference = await promoteScenario('reference', row.versionedBase).then(async ({ root, proposalRef }) => {
    await promoteProposal(service(root), { proposalRef, scope: 'project' })
    return publicationState(root)
  })
  const { root, proposalRef } = await promoteScenario('crash', row.versionedBase)
  const before = await publicationState(root)
  const crashing = service(root)
  arm(row.crash, root, crashing)
  await expect(promoteProposal(crashing, { proposalRef, scope: 'project' })).rejects.toThrow('injected crash')
  return { root, proposalRef, reference, before }
}

async function crashRollback(row: CrashRow): Promise<{ root: string; reference: unknown }> {
  const reference = await rollbackScenario('reference').then(async ({ root }) => {
    await rollbackSkill(service(root), { skillName, version: '1.0.0' })
    return publicationState(root)
  })
  const { root } = await rollbackScenario('crash')
  const crashing = service(root)
  arm(row.crash, root, crashing)
  await expect(rollbackSkill(crashing, { skillName, version: '1.0.0' })).rejects.toThrow('injected crash')
  return { root, reference }
}

describe('promote crash points', () => {
  beforeAll(() => { expect(promoteRows.map(row => row.point.split(' ')[0])).toEqual(['P0', 'P1a', 'P1b', 'P1c', 'P1d', 'P1e', 'P1f', 'P2', 'P3', 'P4']) })

  for (const row of promoteRows) {
    recovery(row, 'rerun')(`${row.point}: rerunning the same promote converges to one successful promote`, async () => {
      const { root, proposalRef, reference } = await crashPromote(row)
      await expect(promoteProposal(service(root), { proposalRef, scope: 'project' })).resolves.toMatchObject({ promoted: true, version: '1.1.0' })
      expect(await publicationState(root)).toEqual(reference)
    })

    recovery(row, 'repair')(`${row.point}: repair alone converges to ${row.beforeCommit === true ? 'the state before promote' : 'one successful promote'}`, async () => {
      const { root, reference, before } = await crashPromote(row)
      await service(root).repair()
      expect(await publicationState(root)).toEqual(row.beforeCommit === true ? before : reference)
    })
  }

  it('health reports the unfinished promote and repair reports completing it', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P3'))!
    const { root } = await crashPromote(row)
    const health = await service(root).healthReport()
    expect(publicationsOf(health)).toEqual([expect.objectContaining({ skillName, operation: 'promote', proposalId: 'proposal-crash', fromVersion: 'unversioned', toVersion: '1.1.0' })])
    const repaired = await service(root).repair()
    expect(publicationsOf(repaired)).toEqual([expect.objectContaining({ skillName, operation: 'promote', outcome: 'completed' })])
    expect(publicationsOf(await service(root).healthReport())).toEqual([])
    expect(await latestStatus(root, 'proposal-crash')).toBe('promoted')
  })

  it('health reads a half-written promote without changing any file', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P1c'))!
    const { root } = await crashPromote(row)
    const crashed = await publicationState(root)
    await service(root).healthReport()
    expect(await publicationState(root)).toEqual(crashed)
  })

  it('H5 health and readCurrent answer while a live process holds the publication lock', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P1c'))!
    const { root } = await crashPromote(row)
    const lockPath = join(root, '.skill-evolution', 'locks', `${skillName}.lock`)
    await mkdir(join(root, '.skill-evolution', 'locks'), { recursive: true })
    await writeFile(lockPath, JSON.stringify({ v: 1, token: 'live', pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), uptimeMs: Math.round(uptime() * 1000), operation: 'promote' }))
    const crashed = await publicationState(root)
    const healthIssues = await service(root).versions.healthIssues()
    expect(healthIssues).toEqual(expect.any(Array))
    await expect(service(root).versions.readCurrent(skillName)).resolves.toMatchObject({ manifest: { version: 'unversioned' } })
    expect(await publicationState(root)).toEqual(crashed)
  })

  it('G1 rejecting the proposal after the commit point finishes the promote first, then refuses', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P1c'))!
    const { root, proposalRef, reference } = await crashPromote(row)
    await expect(reviewProposal(service(root), { proposalRef, decision: 'reject', reason: 'changed my mind' })).rejects.toMatchObject({ code: expect.stringMatching(/^(invalid-transition|conflict)$/) })
    expect(await publicationState(root)).toEqual(reference)
  })

  it('does not skip promotion checks for a different proposal with a pending journal', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P1c'))!
    const { root } = await crashPromote(row)
    vi.restoreAllMocks()
    fault.paths = []
    const evolution = service(root)
    const currentBase = await readFile(join(root, skillName, 'SKILL.md'), 'utf8')
    const proposalRef = await accept(evolution, root, 'proposal-other', currentBase, `${currentBase}Another change.\n`, '1.2.0', 'Another change')
    const evaluationsPath = join(root, '.skill-evolution', 'evaluations.jsonl')
    const evaluations = await readFile(evaluationsPath, 'utf8')
    const invalidArtifact = evaluations.split('\n').map(line => line.includes('proposal-other') ? line.replace('\"passedGate\":true', '\"passedGate\":false') : line).join('\n')
    await writeFile(evaluationsPath, invalidArtifact)
    await expect(promoteProposal(evolution, { proposalRef, scope: 'project' })).rejects.toMatchObject({ code: 'gate-failed' })
    await expect(readFile(join(root, '.skill-evolution', 'publications', `${skillName}.json`), 'utf8')).resolves.toContain('proposal-crash')
  })

  it('rollback completes a pending Promote before changing live state', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P1c'))!
    const { root } = await crashPromote(row)
    await expect(rollbackSkill(service(root), { skillName, version: 'unversioned' })).resolves.toMatchObject({ version: 'unversioned' })
    await expect(readFile(join(root, skillName, 'SKILL.md'), 'utf8')).resolves.toBe(first)
  })

  it('rollback over a pending Promote leaves a stale proposal rejected on retry', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P1c'))!
    const { root, proposalRef } = await crashPromote(row)
    await expect(rollbackSkill(service(root), { skillName, version: '1.1.0' })).resolves.toMatchObject({ version: '1.1.0' })
    await expect(promoteProposal(service(root), { proposalRef, scope: 'project' })).rejects.toMatchObject({ code: 'stale-base' })
  })

  it('P0 rerun completes from the pre-journal failure without duplicate facts', async () => {
    const row = promoteRows.find(item => item.point.startsWith('P0'))!
    const { root, proposalRef, reference } = await crashPromote(row)
    await promoteProposal(service(root), { proposalRef, scope: 'project' })
    expect(await publicationState(root)).toEqual(reference)
  })

  it('H3 rerun is idempotent even when the persisted artifact is expired', async () => {
    const { root, proposalRef } = await promoteScenario('expired-rerun')
    await promoteProposal(service(root), { proposalRef, scope: 'project' })
    const artifacts = await service(root).evaluations.readAll()
    const artifact = artifacts.at(-1)!
    await service(root).evaluations.append({ ...artifact, id: `${artifact.id}:expired-rerun`, expiresAt: '2020-01-01T00:00:00.000Z' })
    const before = await publicationState(root)
    await expect(promoteProposal(service(root), { proposalRef, scope: 'project' })).resolves.toMatchObject({ promoted: true, version: '1.1.0' })
    expect(await publicationState(root)).toEqual(before)
  })

})

describe('rollback crash points', () => {
  it('R0 rerun recovers a rollback that crashed before its journal write', async () => {
    const reference = await rollbackScenario('r0-reference')
    await rollbackSkill(service(reference.root), { skillName, version: '1.0.0' })
    const expected = await publicationState(reference.root)
    const crashed = await rollbackScenario('r0-crash')
    fault.paths = [join(crashed.root, '.skill-evolution', 'publications', `${skillName}.json`)]
    await expect(rollbackSkill(service(crashed.root), { skillName, version: '1.0.0' })).rejects.toThrow('injected crash')
    await expect(rollbackSkill(service(crashed.root), { skillName, version: '1.0.0' })).resolves.toMatchObject({ version: '1.0.0' })
    expect(await publicationState(crashed.root)).toEqual(expected)
  })

  for (const row of rollbackRows) {
    recovery(row, 'rerun')(`${row.point}: rerunning the same rollback converges to one successful rollback`, async () => {
      const { root, reference } = await crashRollback(row)
      await expect(rollbackSkill(service(root), { skillName, version: '1.0.0' })).resolves.toMatchObject({ skillName, version: '1.0.0' })
      expect(await publicationState(root)).toEqual(reference)
    })

    recovery(row, 'repair')(`${row.point}: repair alone converges to one successful rollback`, async () => {
      const { root, reference } = await crashRollback(row)
      await service(root).repair()
      expect(await publicationState(root)).toEqual(reference)
    })
  }

  it('a second rollback to the version that is already current writes nothing', async () => {
    const { root } = await rollbackScenario('double')
    await rollbackSkill(service(root), { skillName, version: '1.0.0' })
    const once = await publicationState(root)
    await rollbackSkill(service(root), { skillName, version: '1.0.0' })
    expect(await publicationState(root)).toEqual(once)
    expect(await latestStatus(root, 'proposal-one')).toBe('promoted')
    expect(await latestStatus(root, 'proposal-two')).toBe('rolled-back')
  })
})

describe('one promotion check', () => {
  it('dry-run rejects a base version that real promotion rejects', async () => {
    const root = await tempRoot('dry-run-base-version')
    await writeVersionedBase(root)
    const evolution = service(root)
    const proposed = await proposeSkillChange(evolution, { root, id: 'proposal-version', skillName, baseContent: base, baseVersion: '0.9.0', candidateContent: first, proposedVersion: '1.1.0', intent: 'stale base version' })
    const evaluated = await evaluateProposal(evolution, { root, proposalRef: proposed.proposal.id, cases: [{ id: 'case-version', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }] })
    const proposalRef = (await reviewProposal(evolution, { proposalRef: evaluated.recordId, decision: 'accept', reason: 'reviewed' })).recordId
    const before = await publicationState(root)
    await expect(promoteProposal(evolution, { proposalRef, scope: 'project' })).rejects.toMatchObject({ code: 'stale-base' })
    expect(await publicationState(root)).toEqual(before)
    await expect(promoteProposal(evolution, { proposalRef, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'stale-base' })
    expect(await publicationState(root)).toEqual(before)
  })

  it('service.promote and promoteProposal reject the same inconsistent artifact with the same code', async () => {
    const { root, proposalRef } = await promoteScenario('check-parity')
    const evolution = service(root)
    const persisted = (await evolution.evaluations.readAll()).at(-1)!
    const legacyId = `${persisted.id}:legacy`
    await evolution.evaluations.append({ ...persisted, id: legacyId, result: { ...persisted.result, artifactId: legacyId, policyVersion: 'legacy-policy' } })
    await expect(promoteProposal(evolution, { proposalRef, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-mismatch' })
    const accepted = (await evolution.proposals.readAll()).at(-1)!
    const legacy = (await evolution.evaluations.readAll()).find(item => item.id === legacyId)!
    await expect(evolution.promote(accepted, legacy.result, 'project')).rejects.toMatchObject({ code: 'evaluation-mismatch' })
  })

  it('C3 checks every promotion rule and resolver source with stable error codes', async () => {
    const { root, proposalRef } = await promoteScenario('c3')
    const evolution = service(root)
    const proposal = (await evolution.proposals.readAll()).find(item => item.id === proposalRef)!
    const artifact = (await evolution.evaluations.readAll()).at(-1)!
    const current = await evolution.versions.readCurrent(skillName)
    const input = { proposal, artifact, current, policyVersion: artifact.policyVersion, now: Date.now() }
    expect(() => checkPromotion(input)).not.toThrow()

    const rows: Array<{ name: string; expected: string; mutate: () => typeof input }> = [
      { name: 'status', expected: 'invalid-transition', mutate: () => ({ ...input, proposal: { ...proposal, status: 'proposed' as const } }) },
      { name: 'artifact proposal id', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, proposalId: 'other' } }) },
      { name: 'artifact candidate id', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, candidateId: 'other' } }) },
      { name: 'result candidate id', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, result: { ...artifact.result, candidateId: 'other' } } }) },
      { name: 'base hash', expected: 'stale-base', mutate: () => ({ ...input, artifact: { ...artifact, baseContentHash: 'wrong' } }) },
      { name: 'current missing', expected: 'stale-base', mutate: () => ({ ...input, current: undefined }) },
      { name: 'current hash', expected: 'stale-base', mutate: () => ({ ...input, current: { ...current!, manifest: { ...current!.manifest, contentHash: 'wrong' } } }) },
      { name: 'base version', expected: 'stale-base', mutate: () => ({ ...input, proposal: { ...proposal, baseVersion: '0.9.0' }, current: { ...current!, manifest: { ...current!.manifest, version: '1.0.0' } } }) },
      { name: 'candidate hash artifact', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, candidateContentHash: 'wrong' } }) },
      { name: 'candidate hash result', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, result: { ...artifact.result, candidateContentHash: 'wrong' } } }) },
      { name: 'policy artifact', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, policyVersion: 'wrong' } }) },
      { name: 'policy result', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, result: { ...artifact.result, policyVersion: 'wrong' } } }) },
      { name: 'expired', expected: 'evaluation-mismatch', mutate: () => ({ ...input, artifact: { ...artifact, expiresAt: '2020-01-01T00:00:00.000Z' }, now: Date.parse('2021-01-01T00:00:00.000Z') }) },
      { name: 'empty case ids', expected: 'evaluation-mismatch', mutate: () => ({ ...input, proposal: { ...proposal, comparisonCaseIds: [] }, artifact: { ...artifact, caseIds: ['unexpected'] } }) },
      { name: 'artifact gate', expected: 'gate-failed', mutate: () => ({ ...input, artifact: { ...artifact, passedGate: false } }) },
      { name: 'result gate', expected: 'gate-failed', mutate: () => ({ ...input, artifact: { ...artifact, result: { ...artifact.result, passedGate: false } } }) },
      { name: 'invalid document', expected: 'evaluation-mismatch', mutate: () => { const invalid = '---\nname: api-debugging\n---\n\nUse curl.\n'; return { ...input, proposal: { ...proposal, candidateContent: invalid }, artifact: { ...artifact, candidateContentHash: createContentHash(invalid), result: { ...artifact.result, candidateContentHash: createContentHash(invalid) } } } } },
      { name: 'invalid change', expected: 'evaluation-mismatch', mutate: () => { const invalid = base.replace('description: Debug APIs.', 'description: Debug APIs.\nmodel-invocable: true'); return { ...input, proposal: { ...proposal, candidateContent: invalid }, artifact: { ...artifact, candidateContentHash: createContentHash(invalid), result: { ...artifact.result, candidateContentHash: createContentHash(invalid) } } } } },
    ]
    for (const row of rows) expect(() => checkPromotion(row.mutate()), row.name).toThrowError(expect.objectContaining({ code: row.expected }))

    const unversioned = { ...input, proposal: { ...proposal, baseVersion: '0.9.0' } }
    expect(() => checkPromotion(unversioned)).not.toThrow()
    const emptyCases = { ...input, proposal: { ...proposal, comparisonCaseIds: [] }, artifact: { ...artifact, caseIds: [] } }
    expect(() => checkPromotion(emptyCases)).not.toThrow()

    expect(resolvePromotionArtifact([artifact], proposal, artifact)).toEqual(artifact)
    expect(resolvePromotionArtifact([artifact], proposal, artifact.result)).toEqual(artifact)
    expect(resolvePromotionArtifact([artifact], proposal, undefined, Date.parse(artifact.expiresAt) - 1)).toEqual(artifact)
    expect(() => resolvePromotionArtifact([], proposal, artifact)).toThrowError(expect.objectContaining({ code: 'evaluation-missing' }))
    expect(() => resolvePromotionArtifact([artifact], proposal, null as never)).toThrowError(expect.objectContaining({ code: 'evaluation-mismatch' }))
    expect(() => resolvePromotionArtifact([artifact], proposal, 'str' as never)).toThrowError(expect.objectContaining({ code: 'evaluation-mismatch' }))
    expect(() => resolvePromotionArtifact([artifact], proposal, { result: {} } as never)).toThrowError(expect.objectContaining({ code: 'evaluation-mismatch' }))
  })
})
