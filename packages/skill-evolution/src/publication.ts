import { mkdir, readFile, unlink, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PublicationScope } from './types.js'

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

export async function readPublication(path: string): Promise<PublicationJournal | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isPublicationJournal(value)) throw new Error(`invalid publication journal: ${path}`)
    return value
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
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
  return item.v === 1 && (item.operation === 'promote' || item.operation === 'rollback')
    && typeof item.skillName === 'string' && typeof item.scope === 'string'
    && endpoint(item.from) && endpoint(item.to) && typeof item.startedAt === 'string'
    && (item.proposalId === undefined || typeof item.proposalId === 'string')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
