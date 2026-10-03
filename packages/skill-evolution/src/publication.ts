import { mkdir, readFile, unlink, writeFile, rename } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PublicationScope, SkillManifest } from './types.js'
import type { EvolutionLayout } from './state-root.js'
import { createContentHash } from './events.js'

export interface PublicationJournal {
  readonly v: 1
  readonly operation: 'promote' | 'rollback'
  readonly skillName: string
  readonly scope: PublicationScope
  readonly proposalId?: string
  readonly from: { readonly version: string; readonly contentHash: string }
  readonly to: { readonly version: string; readonly contentHash: string }
  readonly startedAt: string
}

export class PublicationJournalError extends Error {
  constructor(message: string, readonly raw: string) { super(message); this.name = 'PublicationJournalError' }
}

export async function readPublication(path: string): Promise<PublicationJournal | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const value: unknown = JSON.parse(raw)
    if (!isPublicationJournal(value) || parse(basename(path)).name !== value.skillName) throw new PublicationJournalError(`invalid publication journal: ${path}`, raw)
    return value
  } catch (error) {
    if (isMissing(error)) return undefined
    if (error instanceof PublicationJournalError) throw error
    if (error instanceof SyntaxError) throw new PublicationJournalError(`invalid publication journal: ${path}`, await readFile(path, 'utf8'))
    throw error
  }
}

export async function quarantinePublication(directory: string, skillName: string, raw: string, error: unknown, by: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = `${directory}/${skillName}-${Date.now()}-${process.pid}-${randomUUID()}.json`
  const payload = { v: 1, skillName, quarantinedAt: new Date().toISOString(), by, error: error instanceof Error ? error.message : String(error), raw }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return path
}

export async function writePublication(path: string, journal: PublicationJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

export async function removePublication(path: string): Promise<void> {
  await unlink(path).catch(error => { if (!isMissing(error)) throw error })
}

export function isPublicationJournal(value: unknown): value is PublicationJournal {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  const endpoint = (candidate: unknown): boolean => typeof candidate === 'object' && candidate !== null
    && typeof (candidate as Record<string, unknown>).version === 'string'
    && typeof (candidate as Record<string, unknown>).contentHash === 'string'
  const skillName = typeof item.skillName === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.skillName)
  const scope = item.scope === 'project' || item.scope === 'user' || item.scope === 'explicit-only'
  const version = (candidate: unknown) => endpoint(candidate) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test((candidate as { version: string }).version)
  return item.v === 1 && (item.operation === 'promote' || item.operation === 'rollback')
    && skillName && scope && version(item.from) && version(item.to) && typeof item.startedAt === 'string'
    && (item.proposalId === undefined || (typeof item.proposalId === 'string' && /^[A-Za-z0-9._:-]+$/.test(item.proposalId)))
}

export interface PublicationContext {
  readonly root: string
  readonly layout: EvolutionLayout
  readonly invalidate?: (skillName: string, scope: Exclude<PublicationScope, 'explicit-only'>) => void | Promise<void>
  readonly manifestFor: (journal: PublicationJournal) => Promise<SkillManifest>
  readonly legacyRecovery?: (skillName: string) => Promise<void>
  readonly retainJournal?: boolean
}

export class PublicationPermanentError extends Error { readonly permanent = true }

export async function recoverPendingPublication(skillName: string, context: PublicationContext): Promise<void> {
  const path = context.layout.publicationJournalPath(skillName)
  let journal: PublicationJournal | undefined
  try { journal = await readPublication(path) } catch (error) {
    const raw = error instanceof PublicationJournalError ? error.raw : await readText(path)
    if (raw === undefined) throw error
    await quarantinePublication(context.layout.publicationQuarantineDir, skillName, raw, error, 'store')
    await removePublication(path)
  }
  if (journal !== undefined) {
    try { await completePublication(journal, context) } catch (error) {
      if (!(error instanceof PublicationPermanentError)) throw error
      const raw = await readText(path); if (raw === undefined) throw error
      await quarantinePublication(context.layout.publicationQuarantineDir, skillName, raw, error, 'store'); await removePublication(path)
    }
  }
  await context.legacyRecovery?.(skillName)
}

export async function completePublication(journal: PublicationJournal, context: PublicationContext): Promise<void> {
  assertSafeName(journal.skillName); assertSafeVersion(journal.to.version)
  const directory = join(context.root, journal.skillName)
  const versions = context.layout.skillVersionsDir(journal.skillName)
  if (journal.scope === 'explicit-only') { if (context.retainJournal !== true) await removePublication(context.layout.publicationJournalPath(journal.skillName)); return }
  const source = journal.operation === 'promote' ? join(context.layout.candidateDir(journal.proposalId ?? ''), 'SKILL.md') : join(versions, journal.to.version, 'SKILL.md')
  const content = await readText(source)
  if (content === undefined || createContentHash(content) !== journal.to.contentHash) throw new PublicationPermanentError(`publication content does not match journal for "${journal.skillName}"`)
  if (journal.operation === 'promote') {
    await mkdir(versions, { recursive: true })
    const current = await readText(join(directory, 'SKILL.md'))
    if (journal.from.version !== 'unversioned' && current !== undefined && createContentHash(current) === journal.from.contentHash) {
      const previous = join(versions, journal.from.version); await mkdir(previous, { recursive: true })
      const previousContent = await readText(join(previous, 'SKILL.md'))
      if (previousContent !== undefined && createContentHash(previousContent) !== journal.from.contentHash) throw new PublicationPermanentError('publication snapshot does not match journal')
      if (previousContent === undefined) await writeAtomic(join(previous, 'SKILL.md'), current)
      if (await readText(join(previous, 'manifest.json')) === undefined) {
        const oldManifest = await readJson<SkillManifest>(join(directory, 'manifest.json'))
        if (oldManifest !== undefined) await writeAtomic(join(previous, 'manifest.json'), `${JSON.stringify(oldManifest.contentHash === journal.from.contentHash ? oldManifest : { ...oldManifest, contentHash: journal.from.contentHash }, null, 2)}\n`)
      }
      const previousManifest = await readJson<SkillManifest>(join(previous, 'manifest.json'))
      if (previousManifest !== undefined && previousManifest.contentHash !== journal.from.contentHash) throw new PublicationPermanentError('publication snapshot manifest does not match journal')
    }
    const target = join(versions, journal.to.version); await mkdir(target, { recursive: true })
    const existing = await readText(join(target, 'SKILL.md'))
    if (existing !== undefined && createContentHash(existing) !== journal.to.contentHash) throw new PublicationPermanentError('publication target does not match journal')
    const existingManifest = await readJson<SkillManifest>(join(target, 'manifest.json'))
    if (existingManifest !== undefined && existingManifest.contentHash !== journal.to.contentHash) throw new PublicationPermanentError('publication target manifest does not match journal')
    const manifest = await context.manifestFor(journal)
    await writeIfDifferent(join(target, 'SKILL.md'), content); await writeIfDifferent(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeIfDifferent(join(directory, 'SKILL.md'), content); await writeIfDifferent(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`); await writeIfDifferent(join(directory, 'current.json'), `${JSON.stringify({ version: manifest.version, contentHash: manifest.contentHash }, null, 2)}\n`)
  } else {
    const manifest = await readJson<SkillManifest>(join(versions, journal.to.version, 'manifest.json')); if (manifest === undefined) throw new PublicationPermanentError('missing manifest for rollback target')
    await writeIfDifferent(join(directory, 'SKILL.md'), content); await writeIfDifferent(join(directory, 'manifest.json'), `${JSON.stringify({ ...manifest, scope: journal.scope, status: 'stable', updatedAt: journal.startedAt }, null, 2)}\n`); await writeIfDifferent(join(directory, 'current.json'), `${JSON.stringify({ version: journal.to.version, contentHash: journal.to.contentHash }, null, 2)}\n`)
  }
  await context.invalidate?.(journal.skillName, journal.scope)
  if (context.retainJournal !== true) await removePublication(context.layout.publicationJournalPath(journal.skillName))
}

function assertSafeName(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new PublicationPermanentError(`invalid Skill name "${value}"`) }
function assertSafeVersion(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new PublicationPermanentError(`invalid Skill version "${value}"`) }
async function readText(path: string): Promise<string | undefined> { try { return await readFile(path, 'utf8') } catch (error) { if (isMissing(error)) return undefined; throw error } }
async function readJson<T>(path: string): Promise<T | undefined> { const text = await readText(path); return text === undefined ? undefined : JSON.parse(text) as T }
async function writeAtomic(path: string, content: string): Promise<void> { const temp = `${path}.tmp-${process.pid}-${randomUUID()}`; await writeFile(temp, content, 'utf8'); await rename(temp, path) }
async function writeIfDifferent(path: string, content: string): Promise<void> { if (await readText(path) !== content) await writeAtomic(path, content) }

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
