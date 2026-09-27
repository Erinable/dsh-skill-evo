import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withLock } from './locking.js'

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
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
      this.knownIds.add(record.id)
      return true
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
      const text = await readFile(this.filePath, 'utf8')
      return parseLines(text)
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
    try {
      const text = await readFile(this.filePath, 'utf8')
      for (const line of completeLines(text).filter(Boolean)) {
        const record = JSON.parse(line) as T
        if (typeof record.id !== 'string') throw new Error('invalid record id')
        this.knownIds.add(record.id)
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error
      await appendFile(this.filePath, '', 'utf8')
    }
  }

  private async refreshKnownIds(): Promise<void> {
    const text = await readFile(this.filePath, 'utf8')
    this.knownIds.clear()
    for (const line of completeLines(text).filter(Boolean)) {
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

function parseLines<T>(text: string): T[] {
  return completeLines(text).filter(Boolean).map(line => JSON.parse(line) as T)
}

function completeLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) !== '') lines.pop()
  return lines
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
