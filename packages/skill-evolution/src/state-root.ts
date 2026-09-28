import { mkdir, readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises'
import { rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { createContentHash, parseObservation, serializeObservation } from './events.js'
import { appendFrames, quarantinePath, readFrames, splitFrames } from './jsonl.js'
import { withLock } from './locking.js'
import type { ObservationQuery } from './store.js'
import type { RuntimeObservation } from './types.js'

export type StoreRole = 'fact' | 'derived'
export type StoreName = 'observations' | 'proposals' | 'decisions' | 'feedback' | 'evaluations' | 'experiences' | 'failures' | 'clusters' | 'diagnoses'

export interface StoreDescriptor {
  readonly name: StoreName
  readonly path: string
  readonly role: StoreRole
  readonly projectionInput: boolean
}

export interface ProjectionCursor {
  readonly count: number
  readonly lastId?: string
  readonly fingerprint: string
}

export interface EvolutionLayout {
  readonly root: string
  readonly stateDir: string
  readonly cursorPath: string
  readonly locksDir: string
  readonly candidatesDir: string
  readonly proposalReportsDir: string
  readonly evaluationReportsDir: string
  readonly stores: readonly StoreDescriptor[]
  readonly observations: StoreDescriptor
  readonly candidateDir: (proposalRootId: string) => string
  readonly publicationLockPath: (skillName: string) => string
  skillVersionsDir(skillName: string): string
}

export interface RetentionResult {
  readonly rotated?: string
  readonly invalidQuarantine?: string
  readonly deleted: readonly string[]
  readonly bytes: number
}

export function resolveLayout(options: { readonly root: string; readonly observationStore?: string }): EvolutionLayout {
  const stateDir = join(options.root, '.skill-evolution')
  const paths: Array<[StoreName, StoreRole, boolean, string]> = [
    ['observations', 'fact', true, options.observationStore ?? join(stateDir, 'observations.jsonl')],
    ['proposals', 'fact', false, join(stateDir, 'proposals.jsonl')],
    ['decisions', 'fact', false, join(stateDir, 'decisions.jsonl')],
    ['feedback', 'fact', false, join(stateDir, 'feedback.jsonl')],
    ['evaluations', 'fact', false, join(stateDir, 'evaluations.jsonl')],
    ['experiences', 'derived', false, join(stateDir, 'experiences.jsonl')],
    ['failures', 'derived', false, join(stateDir, 'failures.jsonl')],
    ['clusters', 'derived', false, join(stateDir, 'clusters.jsonl')],
    ['diagnoses', 'derived', false, join(stateDir, 'diagnoses.jsonl')],
  ]
  const stores = paths.map(([name, role, projectionInput, path]) => ({ name, role, projectionInput, path }))
  return {
    root: options.root,
    stateDir,
    cursorPath: join(stateDir, 'projection-cursor.json'),
    locksDir: join(stateDir, 'locks'),
    candidatesDir: join(stateDir, 'candidates'),
    proposalReportsDir: join(stateDir, 'proposals'),
    evaluationReportsDir: join(stateDir, 'evaluations'),
    stores,
    observations: stores[0],
    candidateDir: (proposalRootId: string) => join(stateDir, 'candidates', encodeURIComponent(proposalRootId)),
    publicationLockPath: (skillName: string) => join(stateDir, 'locks', `${skillName}.lock`),
    skillVersionsDir: (skillName: string) => join(options.root, skillName, 'versions'),
  }
}

export async function readCursor(path: string): Promise<ProjectionCursor | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { count?: unknown; lastId?: unknown; fingerprint?: unknown }
    if (typeof value.count !== 'number' || !Number.isFinite(value.count) || typeof value.fingerprint !== 'string') return undefined
    return {
      count: value.count,
      ...(typeof value.lastId === 'string' ? { lastId: value.lastId } : {}),
      fingerprint: value.fingerprint,
    }
  } catch {
    return undefined
  }
}

export async function writeCursor(path: string, cursor: ProjectionCursor): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(cursor)}\n`, 'utf8')
  await rename(temporary, path)
}

export function fingerprintOf(ids: readonly string[]): string {
  return createContentHash(ids.join('\n'))
}

export class ObservationLog {
  private initialized: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly archiveCache = new Map<string, { readonly signature: string; readonly events: readonly RuntimeObservation[] }>()

  constructor(readonly filePath: string) {}
  get currentPath(): string { return this.filePath }

  async append(event: RuntimeObservation): Promise<boolean> {
    return this.enqueue(() => withLock(`${this.filePath}.lock`, 'append', async () => {
      await this.ensureInitialized()
      const events = await this.readFacts()
      if (events.some(item => item.id === event.id)) return false
      await appendFrames(this.filePath, [serializeObservation(event).slice(0, -1)])
      return true
    }))
  }

  async appendMany(events: readonly RuntimeObservation[]): Promise<number> {
    let count = 0
    for (const event of events) if (await this.append(event)) count += 1
    return count
  }

  async readAll(): Promise<RuntimeObservation[]> {
    return withLock(`${this.filePath}.lock`, 'read', async () => {
      await this.ensureInitialized()
      return this.readFacts()
    })
  }

  async query(query: ObservationQuery = {}): Promise<RuntimeObservation[]> {
    return (await this.readAll()).filter(event => (
      (query.sessionId === undefined || event.sessionId === query.sessionId)
      && (query.taskId === undefined || event.taskId === query.taskId)
      && (query.skillName === undefined || event.skill?.name === query.skillName)
      && (query.kind === undefined || event.kind === query.kind)
      && (query.since === undefined || event.occurredAt >= query.since)
      && (query.until === undefined || event.occurredAt <= query.until)
    ))
  }

  async rotate(options: { readonly maxBytes: number; readonly retentionDays?: number }): Promise<RetentionResult> {
    return withLock(`${this.filePath}.lock`, 'rotate', async () => rotateFile(this.filePath, options))
  }

  private async readFacts(): Promise<RuntimeObservation[]> {
    const seen = new Set<string>()
    const result: RuntimeObservation[] = []
    const paths = await archivePaths(this.filePath)
    const activePaths = new Set(paths)
    for (const path of this.archiveCache.keys()) {
      if (!activePaths.has(path)) this.archiveCache.delete(path)
    }
    for (const path of paths) {
      const info = await stat(path)
      const signature = archiveSignature(info)
      const cached = this.archiveCache.get(path)
      let events = cached?.events
      if (cached?.signature !== signature) {
        const { lines, tail } = await readFrames(path)
        if (tail.length > 0) throw new Error(`invalid observation archive (unterminated line): ${path}`)
        const parsed: RuntimeObservation[] = []
        for (const line of lines) {
          try { parsed.push(parseObservation(line)) } catch (error) { throw new Error(`invalid observation archive ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
        }
        events = parsed
        this.archiveCache.set(path, { signature, events })
      }
      for (const event of events ?? []) addUnique(result, seen, event)
    }
    const current = await readFrames(this.filePath)
    for (const line of current.lines) addUnique(result, seen, parseObservation(line))
    return result
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      try { await stat(this.filePath) } catch (error) {
        if (!isMissingFile(error)) throw error
        await writeFile(this.filePath, '', 'utf8')
      }
    })()
    await this.initialized
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

export async function archivePaths(path: string): Promise<string[]> {
  const dir = join(dirname(path), 'archive')
  const prefix = `${basename(path)}.`
  const pattern = new RegExp(`^${escapeRegExp(basename(path))}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.\\d+\\.jsonl$`)
  const entries = await readdir(dir).catch(error => isMissingFile(error) ? [] : Promise.reject(error))
  const candidates = entries.filter(name => name.startsWith(prefix) && pattern.test(name)).sort()
  const files = await Promise.all(candidates.map(async name => {
    const info = await stat(join(dir, name)).catch(() => undefined)
    return info?.isFile() === true ? join(dir, name) : undefined
  }))
  return files.filter((value): value is string => value !== undefined)
}

export async function rotateFile(path: string, options: { readonly maxBytes: number; readonly retentionDays?: number }): Promise<RetentionResult> {
  const current = await stat(path).catch(error => isMissingFile(error) ? undefined : Promise.reject(error))
  const archiveDir = join(dirname(path), 'archive')
  await mkdir(archiveDir, { recursive: true })
  let rotated: string | undefined
  let invalidQuarantine: string | undefined
  if (current !== undefined && current.size >= options.maxBytes) {
    const bytes = await readFile(path)
    const { tail } = splitFrames(bytes)
    const complete = bytes.subarray(0, bytes.length - tail.length)
    if (tail.length > 0) {
      invalidQuarantine = quarantinePath(path)
      await writeFile(invalidQuarantine, tail)
    }
    rotated = join(archiveDir, `${basename(path)}.${new Date().toISOString().replaceAll(':', '-')}.${process.pid}.jsonl`)
    const temporary = `${rotated}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporary, complete)
    await rename(temporary, rotated)
    await writeFile(path, '')
  }
  const deleted: string[] = []
  if (options.retentionDays !== undefined) {
    const cutoff = Date.now() - options.retentionDays * 86_400_000
    for (const archive of await archivePaths(path)) {
      const info = await stat(archive)
      if (info.isFile() && info.mtimeMs < cutoff) { await unlink(archive); deleted.push(archive) }
    }
  }
  const size = await stat(path).catch(() => undefined)
  return { ...(rotated === undefined ? {} : { rotated }), ...(invalidQuarantine === undefined ? {} : { invalidQuarantine }), deleted, bytes: size?.size ?? 0 }
}

function addUnique(result: RuntimeObservation[], seen: Set<string>, event: RuntimeObservation): void {
  if (seen.has(event.id)) return
  seen.add(event.id)
  result.push(event)
}

function isMissingFile(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function archiveSignature(info: { readonly ino: number; readonly size: number; readonly mtimeMs: number }): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}`
}
