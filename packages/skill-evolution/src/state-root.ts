import { appendFile, mkdir, readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises'
import { rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { parseObservation, serializeObservation } from './events.js'
import { withFileLock } from './locking.js'
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
    proposalReportsDir: join(stateDir, 'reports', 'proposals'),
    evaluationReportsDir: join(stateDir, 'reports', 'evaluations'),
    stores,
    observations: stores[0],
    skillVersionsDir: (skillName: string) => join(options.root, skillName, 'versions'),
  }
}

export class ObservationLog {
  private initialized: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly archiveCache = new Map<string, { readonly signature: string; readonly events: readonly RuntimeObservation[] }>()

  constructor(readonly filePath: string) {}
  get currentPath(): string { return this.filePath }

  async append(event: RuntimeObservation): Promise<boolean> {
    return this.enqueue(() => withFileLock(`${this.filePath}.lock`, async () => {
      await this.ensureInitialized()
      const events = await this.readFacts()
      if (events.some(item => item.id === event.id)) return false
      await appendFile(this.filePath, serializeObservation(event), 'utf8')
      return true
    }))
  }

  async appendMany(events: readonly RuntimeObservation[]): Promise<number> {
    let count = 0
    for (const event of events) if (await this.append(event)) count += 1
    return count
  }

  async readAll(): Promise<RuntimeObservation[]> {
    return withFileLock(`${this.filePath}.lock`, async () => {
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
    return withFileLock(`${this.filePath}.lock`, async () => rotateFile(this.filePath, options))
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
      let events = this.archiveCache.get(path)?.events
      if (this.archiveCache.get(path)?.signature !== signature) {
        const text = await readFile(path, 'utf8')
        if (text.length > 0 && !text.endsWith('\n')) throw new Error(`invalid observation archive (unterminated line): ${path}`)
        const parsed: RuntimeObservation[] = []
        for (const line of text.split('\n').filter(Boolean)) {
          try { parsed.push(parseObservation(line)) } catch (error) { throw new Error(`invalid observation archive ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
        }
        events = parsed
        this.archiveCache.set(path, { signature, events })
      }
      for (const event of events ?? []) addUnique(result, seen, event)
    }
    const current = await readFile(this.filePath, 'utf8')
    for (const line of completeLines(current).filter(Boolean)) addUnique(result, seen, parseObservation(line))
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
    const lastNewline = bytes.lastIndexOf(0x0a)
    const complete = lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1) : Buffer.alloc(0)
    const tail = lastNewline >= 0 ? bytes.subarray(lastNewline + 1) : bytes
    if (tail.length > 0) {
      invalidQuarantine = `${path}.invalid-${Date.now()}-${process.pid}-${randomUUID()}`
      await writeFile(invalidQuarantine, tail)
    }
    rotated = join(archiveDir, `${basename(path)}.${new Date().toISOString().replaceAll(':', '-')}.${process.pid}.jsonl`)
    const temporary = `${rotated}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporary, complete)
    await rename(temporary, rotated)
    await writeFile(path, '')
  }
  const deleted: string[] = []
  {
    const cutoff = Date.now() - (options.retentionDays ?? 30) * 86_400_000
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

function completeLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) !== '') lines.pop()
  return lines
}

function isMissingFile(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function archiveSignature(info: { readonly ino: number; readonly size: number; readonly mtimeMs: number }): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}`
}
