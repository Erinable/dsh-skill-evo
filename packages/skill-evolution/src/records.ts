import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { appendFrames, readFrames } from './jsonl.js'
import { withLock } from './locking.js'

/** Raised when a computed append produces an id already present in the store. */
export class DuplicateRecordError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`duplicate record id: ${id}`)
    this.name = 'DuplicateRecordError'
    this.id = id
  }
}

/** Small append-only JSONL repository for derived evolution records. */
export class JsonlRecordStore<T extends { readonly id: string }> {
  private readonly knownIds = new Set<string>()
  private initialized: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  async append(record: T): Promise<boolean> {
    return this.enqueue(() => withLock(`${this.filePath}.lock`, 'append', async () => {
      await this.ensureInitialized()
      await this.refreshKnownIds()
      if (this.knownIds.has(record.id)) return false
      await appendFrames(this.filePath, [JSON.stringify(record)])
      this.knownIds.add(record.id)
      return true
    }))
  }

  async appendComputed(build: (records: readonly T[]) => T): Promise<T> {
    return this.enqueue(() => withLock(`${this.filePath}.lock`, 'append-computed', async () => {
      await this.ensureInitialized()
      const { lines } = await readFrames(this.filePath)
      const records = lines.map(line => {
        const record = JSON.parse(line) as T
        if (typeof record.id !== 'string') throw new Error('invalid record id')
        return record
      })
      this.knownIds.clear()
      for (const record of records) this.knownIds.add(record.id)

      const candidate = build(records)
      if (this.knownIds.has(candidate.id)) throw new DuplicateRecordError(candidate.id)
      await appendFrames(this.filePath, [JSON.stringify(candidate)])
      this.knownIds.add(candidate.id)
      return candidate
    }))
  }

  async appendMany(records: readonly T[]): Promise<number> {
    let count = 0
    for (const record of records) if (await this.append(record)) count += 1
    return count
  }

  async readAll(): Promise<T[]> {
    return withLock(`${this.filePath}.lock`, 'read', async () => {
      await this.ensureInitialized()
      const { lines } = await readFrames(this.filePath)
      return lines.map(line => JSON.parse(line) as T)
    })
  }

  async query(predicate: (record: T) => boolean): Promise<T[]> {
    return (await this.readAll()).filter(predicate)
  }

  /** Replace a derived projection atomically while retaining append-only input facts. */
  async replaceAll(records: readonly T[]): Promise<void> {
    await this.enqueue(() => withLock(`${this.filePath}.lock`, 'replace', async () => {
      await this.ensureInitialized()
      const temporary = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
      await writeFile(temporary, records.length === 0 ? '' : `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
      await rename(temporary, this.filePath)
      this.knownIds.clear()
      for (const record of records) this.knownIds.add(record.id)
    }))
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize()
    return this.initialized
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const { lines } = await readFrames(this.filePath)
    for (const line of lines) {
      const record = JSON.parse(line) as T
      if (typeof record.id !== 'string') throw new Error('invalid record id')
      this.knownIds.add(record.id)
    }
    try {
      await stat(this.filePath)
    } catch (error) {
      if (!isMissingFile(error)) throw error
      await appendFile(this.filePath, '', 'utf8')
    }
  }

  private async refreshKnownIds(): Promise<void> {
    const { lines } = await readFrames(this.filePath)
    this.knownIds.clear()
    for (const line of lines) {
      const record = JSON.parse(line) as T
      if (typeof record.id !== 'string') throw new Error('invalid record id')
      this.knownIds.add(record.id)
    }
  }

  private enqueue<U>(operation: () => Promise<U>): Promise<U> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
