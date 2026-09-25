import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createContentHash } from './events.js'
import { withFileLock, removeDeadLock } from './locking.js'

export interface JsonlRepairResult {
  readonly path: string
  readonly validRecords: number
  readonly removedDuplicates: number
  readonly removedInvalidLines: number
  readonly truncatedTrailingBytes: number
  readonly invalidQuarantine?: string
}

export interface EvolutionRepairReport {
  readonly jsonl: readonly JsonlRepairResult[]
  readonly projectionCursorRebuilt: boolean
  readonly orphanLocksRemoved: readonly string[]
  readonly manifestIssues: readonly string[]
  readonly locksPreserved: readonly string[]
}

/** Repair append-only files while preserving invalid input in a quarantine file. */
export async function repairJsonlFile(
  path: string,
  options: { readonly parse?: (value: unknown) => boolean } = {},
): Promise<JsonlRepairResult> {
  return withFileLock(`${path}.lock`, () => repairJsonlUnlocked(path, options))
}

async function repairJsonlUnlocked(path: string, options: { readonly parse?: (value: unknown) => boolean }): Promise<JsonlRepairResult> {
  await mkdir(dirname(path), { recursive: true })
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
    await appendFile(path, '', 'utf8')
    return { path, validRecords: 0, removedDuplicates: 0, removedInvalidLines: 0, truncatedTrailingBytes: 0 }
  }
  const hadTrailingNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (hadTrailingNewline) lines.pop()
  const valid: string[] = []
  const invalid: string[] = []
  const ids = new Set<string>()
  let duplicates = 0
  let trailingBytes = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (recordId(value) === undefined) throw new Error('missing record id')
      if (options.parse !== undefined && !options.parse(value)) throw new Error('schema validation failed')
      const id = recordId(value)
      if (id !== undefined && ids.has(id)) {
        duplicates += 1
        continue
      }
      if (id !== undefined) ids.add(id)
      valid.push(JSON.stringify(value))
    } catch {
      invalid.push(line)
      if (!hadTrailingNewline && line === lines.at(-1)) trailingBytes = Buffer.byteLength(line, 'utf8')
    }
  }
  let invalidQuarantine: string | undefined
  if (invalid.length > 0) {
    invalidQuarantine = `${path}.invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await writeFile(invalidQuarantine, `${invalid.join('\n')}\n`, 'utf8')
  }
  await atomicWrite(path, valid.length === 0 ? '' : `${valid.join('\n')}\n`)
  return {
    path,
    validRecords: valid.length,
    removedDuplicates: duplicates,
    removedInvalidLines: invalid.length,
    truncatedTrailingBytes: trailingBytes,
    ...(invalidQuarantine === undefined ? {} : { invalidQuarantine }),
  }
}

/** Repair projections, stale locks, and skill manifests under an evolution root. */
export async function repairEvolutionRoot(root: string, options: { readonly jsonlPaths: readonly string[]; readonly observationsPath?: string }): Promise<EvolutionRepairReport> {
  const jsonl = []
  for (const path of options.jsonlPaths) jsonl.push(await repairJsonlFile(path))
  const cursorPath = join(root, '.skill-evolution', 'projection-cursor.json')
  // Rebuild the checkpoint from the repaired observation file.
  let projectionCursorRebuilt = false
  const observationsPath = options.observationsPath ?? join(root, '.skill-evolution', 'observations.jsonl')
  try {
    const text = await readFile(observationsPath, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    const lastId = lines.length === 0 ? undefined : recordId(JSON.parse(lines.at(-1)!))
    const fingerprint = createContentHash(lines.map(line => recordId(JSON.parse(line)) ?? '').join('\n'))
    await atomicWrite(cursorPath, `${JSON.stringify({ count: lines.length, ...(lastId === undefined ? {} : { lastId }), fingerprint })}\n`)
    projectionCursorRebuilt = true
  } catch (error) {
    if (!isMissing(error)) throw error
    await rm(cursorPath, { force: true })
  }
  const { removed, preserved } = await removeOrphanLocks(root)
  const manifestIssues = await inspectManifests(root)
  return { jsonl, projectionCursorRebuilt, orphanLocksRemoved: removed, locksPreserved: preserved, manifestIssues }
}

async function removeOrphanLocks(root: string): Promise<{ removed: string[]; preserved: string[] }> {
  const directory = join(root, '.skill-evolution', 'locks')
  let entries
  try { entries = await readdir(directory) } catch (error) { if (isMissing(error)) return { removed: [], preserved: [] }; throw error }
  const removed: string[] = []
  const preserved: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry)
    if (await removeDeadLock(path)) removed.push(path)
    else preserved.push(path)
  }
  return { removed, preserved }
}

async function inspectManifests(root: string): Promise<string[]> {
  const issues: string[] = []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) { if (isMissing(error)) return []; throw error }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue
    const directory = join(root, entry.name)
    const skillPath = join(directory, 'SKILL.md')
    const manifestPath = join(directory, 'manifest.json')
    const skill = await readOptional(skillPath)
    const manifest = await readJson(manifestPath)
    if (skill !== undefined && manifest !== undefined && manifest.contentHash !== createContentHash(skill)) {
      issues.push(manifestPath)
    }
    const versions = join(directory, 'versions')
    let versionEntries
    try { versionEntries = await readdir(versions, { withFileTypes: true }) } catch (error) { if (isMissing(error)) continue; throw error }
    for (const version of versionEntries) {
      if (!version.isDirectory()) continue
      const versionSkillPath = join(versions, version.name, 'SKILL.md')
      const versionManifestPath = join(versions, version.name, 'manifest.json')
      const versionSkill = await readOptional(versionSkillPath)
      const versionManifest = await readJson(versionManifestPath)
      if (versionSkill !== undefined && versionManifest !== undefined && versionManifest.contentHash !== createContentHash(versionSkill)) {
        issues.push(versionManifestPath)
      }
    }
  }
  return issues
}

function recordId(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : undefined
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) { if (isMissing(error)) return undefined; throw error }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readOptional(path)
  if (text === undefined) return undefined
  const value = JSON.parse(text)
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.repair-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
