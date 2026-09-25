import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Small append-only JSONL repository for derived evolution records. */
export class JsonlRecordStore<T extends { readonly id: string }> {
  private readonly knownIds = new Set<string>()
  private initialized: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  async append(record: T): Promise<boolean> {
    await this.ensureInitialized()
    return this.enqueue(async () => {
      if (this.knownIds.has(record.id)) return false
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
      this.knownIds.add(record.id)
      return true
    })
  }

  async appendMany(records: readonly T[]): Promise<number> {
    let count = 0
    for (const record of records) if (await this.append(record)) count += 1
    return count
  }

  async readAll(): Promise<T[]> {
    await this.ensureInitialized()
    const text = await readFile(this.filePath, 'utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
  }

  async query(predicate: (record: T) => boolean): Promise<T[]> {
    return (await this.readAll()).filter(predicate)
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize()
    return this.initialized
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const text = await readFile(this.filePath, 'utf8')
      for (const line of text.split('\n').filter(Boolean)) {
        const record = JSON.parse(line) as T
        if (typeof record.id !== 'string') throw new Error('invalid record id')
        this.knownIds.add(record.id)
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error
      await appendFile(this.filePath, '', 'utf8')
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
