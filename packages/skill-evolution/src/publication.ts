import { mkdir, readFile, unlink, writeFile, rename } from 'node:fs/promises'
import { basename, dirname, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
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

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
