import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseObservation, serializeObservation } from './events.js'
import { withLock } from './locking.js'
import type { RuntimeObservation } from './types.js'

export interface ObservationQuery {
  readonly sessionId?: string
  readonly taskId?: string
  readonly skillName?: string
  readonly kind?: RuntimeObservation['kind']
  readonly since?: string
  readonly until?: string
}

/** Append-only JSONL store for runtime observations. */
export class JsonlEventStore {
  private readonly knownIds = new Set<string>()
  private initialized: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  /** Append an observation once; duplicate event IDs are idempotent. */
  async append(event: RuntimeObservation): Promise<boolean> {
    return this.enqueue(() => withLock(`${this.filePath}.lock`, 'append', async () => {
      await this.ensureInitialized()
      await this.refreshKnownIds()
      if (this.knownIds.has(event.id)) return false
      await appendFile(this.filePath, serializeObservation(event), 'utf8')
      this.knownIds.add(event.id)
      return true
    }))
  }

  /** Append observations in order and return the number of new records. */
  async appendMany(events: readonly RuntimeObservation[]): Promise<number> {
    let added = 0
    for (const event of events) if (await this.append(event)) added += 1
    return added
  }

  /** Read all valid observations in file order. */
  async readAll(): Promise<RuntimeObservation[]> {
    return withLock(`${this.filePath}.lock`, 'read', async () => {
      await this.ensureInitialized()
      const text = await readFile(this.filePath, 'utf8')
      return parseLines(text, parseObservation)
    })
  }

  /** Query observations without changing their stored order. */
  async query(query: ObservationQuery = {}): Promise<RuntimeObservation[]> {
    const events = await this.readAll()
    return events.filter(event => (
      (query.sessionId === undefined || event.sessionId === query.sessionId)
      && (query.taskId === undefined || event.taskId === query.taskId)
      && (query.skillName === undefined || event.skill?.name === query.skillName)
      && (query.kind === undefined || event.kind === query.kind)
      && (query.since === undefined || event.occurredAt >= query.since)
      && (query.until === undefined || event.occurredAt <= query.until)
    ))
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize()
    return this.initialized
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const text = await readFile(this.filePath, 'utf8')
      for (const event of parseLines(text, parseObservation)) this.knownIds.add(event.id)
    } catch (error) {
      if (!isMissingFile(error)) throw error
      await appendFile(this.filePath, '', 'utf8')
    }
  }

  private async refreshKnownIds(): Promise<void> {
    const text = await readFile(this.filePath, 'utf8')
    this.knownIds.clear()
    for (const event of parseLines(text, parseObservation)) this.knownIds.add(event.id)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

function parseLines<T>(text: string, parser: (line: string) => T): T[] {
  const lines = text.split('\n')
  const trailing = lines.at(-1)
  if (trailing !== undefined && trailing.length > 0) lines.pop()
  return lines.filter(Boolean).map(parser)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
