import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createContentHash } from './events.js'
import { validateSkillCandidate, validateSkillDocument } from './evaluator.js'
import { LockBusyError, withLock } from './locking.js'
import { proposalRootId } from './proposal.js'
import { resolveLayout, type EvolutionLayout } from './state-root.js'
import { assertPublicationScope, type AdoptionBase, type PublicationScope, type SkillManifest, type SkillProposal } from './types.js'
import { completePublication as completePublicationFile, recoverPendingPublication as recoverPendingPublicationFile, type PublicationJournal, writePublication } from './publication.js'

export interface SkillVersionStoreOptions {
  readonly invalidate?: (skillName: string, scope: Exclude<PublicationScope, 'explicit-only'>) => void | Promise<void>
  readonly now?: () => string
  readonly layout?: EvolutionLayout
}

export interface CurrentSkill {
  readonly content: string
  readonly manifest: SkillManifest
}

export interface PublishedSkill {
  readonly manifest: SkillManifest
  readonly path: string
}

/** Filesystem lifecycle store that keeps candidates isolated until explicit promotion. */
export class SkillVersionStore {
  constructor(
    private readonly root: string,
    private readonly options: SkillVersionStoreOptions = {},
  ) {}

  private mutationQueue: Promise<void> = Promise.resolve()

  async readCurrent(skillName: string): Promise<CurrentSkill | undefined> {
    return this.readCurrentUnlocked(skillName)
  }

  private async readCurrentUnlocked(skillName: string): Promise<CurrentSkill | undefined> {
    assertSkillName(skillName)
    const directory = skillDirectory(this.root, skillName)
    const contentPath = join(directory, 'SKILL.md')
    const content = await readTextIfPresent(contentPath)
    if (content === undefined) return undefined
    const storedManifest = await readJsonIfPresent<SkillManifest>(join(directory, 'manifest.json'))
    const now = this.clock()
    const manifest = storedManifest ?? {
      name: skillName,
      version: 'unversioned',
      contentHash: createContentHash(content),
      status: 'stable',
      scope: 'project',
      createdBy: 'human',
      createdAt: now,
      updatedAt: now,
    }
    if (manifest.contentHash !== createContentHash(content)) {
      return {
        content,
        manifest: { ...manifest, contentHash: createContentHash(content), updatedAt: now },
      }
    }
    return { content, manifest }
  }

  async writeCandidate(proposal: SkillProposal): Promise<string> {
    assertSkillName(proposal.skillName)
    assertVersion(proposal.proposedVersion)
    const directory = this.layout().candidateDir(proposalRootId(proposal.id))
    await mkdir(directory, { recursive: true })
    await writeAtomic(join(directory, 'SKILL.md'), proposal.candidateContent)
    await writeAtomic(join(directory, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`)
    return directory
  }

  async promote(
    proposal: SkillProposal,
    options: {
      readonly scope: PublicationScope
      readonly expectedBase?: AdoptionBase
    },
  ): Promise<PublishedSkill> {
    assertPublicationScope(options.scope)
    return this.withMutationLock(proposal.skillName, 'promote', async () => {
      await this.recoverPendingPublication(proposal.skillName)
      return this.promoteUnlocked(proposal, options)
    })
  }

  private async promoteUnlocked(
    proposal: SkillProposal,
    options: {
      readonly scope: PublicationScope
      readonly expectedBase?: AdoptionBase
    },
  ): Promise<PublishedSkill> {
    assertSkillName(proposal.skillName)
    assertVersion(proposal.proposedVersion)
    const expected = options.expectedBase ?? proposal.expectedBase
    const current = await this.readCurrentUnlocked(proposal.skillName)
    const candidateHash = createContentHash(proposal.candidateContent)
    if (current?.manifest.version === proposal.proposedVersion && current.manifest.contentHash === candidateHash) {
      const existing = await readVersionIfPresent(join(this.layout().skillVersionsDir(proposal.skillName), proposal.proposedVersion))
      if (existing !== undefined && existing.contentHash === candidateHash) return { manifest: existing.manifest, path: join(this.layout().skillVersionsDir(proposal.skillName), proposal.proposedVersion, 'SKILL.md') }
    }
    assertExpectedBase(expected, current)
    const validation = validateSkillDocument(proposal.candidateContent, proposal.skillName)
    if (!validation.valid) throw new Error(`candidate Skill is invalid: ${validation.errors.join('; ')}`)
    const changeValidation = validateSkillCandidate(current?.content ?? '', proposal.candidateContent, proposal.skillName)
    if (!changeValidation.valid) throw new Error(`candidate Skill change is invalid: ${changeValidation.errors.join('; ')}`)

    if (options.scope === 'explicit-only') {
      await this.writeCandidate(proposal)
      return {
        manifest: this.manifestFor(proposal, options.scope, 'observed'),
        path: join(this.layout().candidateDir(proposalRootId(proposal.id)), 'SKILL.md'),
      }
    }

    const directory = skillDirectory(this.root, proposal.skillName)
    const versionsDirectory = this.layout().skillVersionsDir(proposal.skillName)
    const versionDirectory = join(versionsDirectory, proposal.proposedVersion)
    const existingVersion = await readVersionIfPresent(versionDirectory)
    if (existingVersion !== undefined) {
      if (existingVersion.contentHash !== createContentHash(proposal.candidateContent) || current?.manifest.version !== proposal.proposedVersion) {
        throw new Error(`published Skill version already exists: ${proposal.skillName}@${proposal.proposedVersion}`)
      }
      return { manifest: existingVersion.manifest, path: join(versionDirectory, 'SKILL.md') }
    }
    let previous: { readonly contentHash: string; readonly manifest: SkillManifest } | undefined
    if (current !== undefined && current.manifest.version !== 'unversioned') {
      const previousDirectory = join(versionsDirectory, current.manifest.version)
      previous = await readVersionIfPresent(previousDirectory)
      if (previous !== undefined && previous.contentHash !== createContentHash(current.content)) {
        throw new Error(`historical Skill version is inconsistent: ${proposal.skillName}@${current.manifest.version}`)
      }
    }
    await this.writeCandidate(proposal)
    await mkdir(versionsDirectory, { recursive: true })
    const startedAt = this.clock()
    const journal: PublicationJournal = { v: 1, operation: 'promote', skillName: proposal.skillName, scope: options.scope, proposalId: proposalRootId(proposal.id), from: { version: current?.manifest.version ?? 'unversioned', contentHash: current?.manifest.contentHash ?? proposal.expectedBase.contentHash }, to: { version: proposal.proposedVersion, contentHash: createContentHash(proposal.candidateContent) }, startedAt }
    await writePublication(this.layout().publicationJournalPath(proposal.skillName), journal)
    await this.completePublication(journal)
    const manifest = this.manifestFor(proposal, options.scope, 'stable', startedAt)
    return { manifest, path: join(directory, 'SKILL.md') }
  }

  async rollback(
    skillName: string,
    version: string,
    options: { readonly scope: Exclude<PublicationScope, 'explicit-only'>; readonly expectedBase?: AdoptionBase },
  ): Promise<PublishedSkill> {
    assertPublicationScope(options.scope)
    return this.withMutationLock(skillName, 'rollback', async () => {
      await this.recoverPendingPublication(skillName)
      return this.rollbackUnlocked(skillName, version, options)
    })
  }

  private async rollbackUnlocked(
    skillName: string,
    version: string,
    options: { readonly scope: Exclude<PublicationScope, 'explicit-only'>; readonly expectedBase?: AdoptionBase },
  ): Promise<PublishedSkill> {
    assertSkillName(skillName)
    assertVersion(version)
    const current = await this.readCurrentUnlocked(skillName)
    const expected = options.expectedBase ?? (current === undefined ? undefined : {
      name: skillName,
      contentHash: current.manifest.contentHash,
    })
    if (expected !== undefined) assertExpectedBase(expected, current)
    const directory = skillDirectory(this.root, skillName)
    const sourceDirectory = join(this.layout().skillVersionsDir(skillName), version)
    const content = await readFile(join(sourceDirectory, 'SKILL.md'), 'utf8')
    const sourceManifest = await readJsonIfPresent<SkillManifest>(join(sourceDirectory, 'manifest.json'))
    if (sourceManifest === undefined) throw new Error(`missing manifest for Skill version ${version}`)
    const manifest: SkillManifest = {
      ...sourceManifest,
      status: 'stable',
      scope: options.scope,
      updatedAt: this.clock(),
    }
    const startedAt = this.clock()
    const journal: PublicationJournal = { v: 1, operation: 'rollback', skillName, scope: options.scope, from: { version: current?.manifest.version ?? 'unversioned', contentHash: current?.manifest.contentHash ?? createContentHash(content) }, to: { version: manifest.version, contentHash: manifest.contentHash }, startedAt }
    const returnedManifest = { ...manifest, updatedAt: startedAt }
    await writePublication(this.layout().publicationJournalPath(skillName), journal)
    await this.completePublication(journal)
    return { manifest: returnedManifest, path: join(directory, 'SKILL.md') }
  }

  async listVersions(skillName: string): Promise<string[]> {
    assertSkillName(skillName)
    try {
      const entries = await readdir(this.layout().skillVersionsDir(skillName), { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
  }

  async healthIssues(): Promise<readonly string[]> {
    const issues: string[] = []
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) } catch (error) { if (isMissingFile(error)) return []; throw error }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue
      const directory = join(this.root, entry.name)
      const current = await this.readCurrentUnlocked(entry.name)
      const pointer = await readJsonIfPresent<{ version?: string; contentHash?: string }>(join(directory, 'current.json'))
      if (current === undefined) continue
      if (await readTextIfPresent(join(directory, '.publish.json')) !== undefined) issues.push(join(directory, '.publish.json'))
      if (pointer?.version !== current.manifest.version || pointer?.contentHash !== current.manifest.contentHash) issues.push(join(directory, 'current.json'))
      for (const version of await this.listVersions(entry.name)) {
        const versionPath = join(this.layout().skillVersionsDir(entry.name), version)
        const record = await readVersionIfPresent(versionPath).catch(() => undefined)
        if (record === undefined || record.manifest.contentHash !== record.contentHash) issues.push(versionPath)
      }
    }
    return issues
  }

  private withMutationLock<T>(skillName: string, operationName: 'read-current' | 'promote' | 'rollback', operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const lockPath = this.layout().publicationLockPath(skillName)
      try {
        return await withLock(lockPath, operationName, operation, { waitMs: 0 })
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error
        const owner = 'owner' in error.state ? error.state.owner : undefined
        const diagnostics = owner === undefined ? '' : ` (pid ${owner.pid}, operation ${owner.operation ?? 'unknown'})`
        const repair = error.guard === undefined ? '' : `; stale reclaim guard: ${error.guard}; run repair`
        throw new Error(`Skill publication already in progress for "${skillName}"${diagnostics}${repair}`)
      }
    })
    this.mutationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private manifestFor(proposal: SkillProposal, scope: PublicationScope, status: SkillManifest['status'], at = this.clock()): SkillManifest {
    const now = at
    return {
      name: proposal.skillName,
      version: proposal.proposedVersion,
      parentVersion: proposal.baseVersion,
      contentHash: createContentHash(proposal.candidateContent),
      status,
      scope,
      createdBy: proposal.generatedBy === 'designer' ? 'evolution-agent' : 'human',
      createdAt: now,
      updatedAt: now,
    }
  }

  private async recoverPendingPublication(skillName: string): Promise<void> {
    await recoverPendingPublicationFile(skillName, {
      root: this.root,
      layout: this.layout(),
      invalidate: this.options.invalidate,
      manifestFor: journal => this.manifestForJournal(journal, 'stable'),
      legacyRecovery: name => recoverPublication(skillDirectory(this.root, name), this.layout().skillVersionsDir(name), this.options.invalidate),
    })
  }

  private async completePublication(journal: PublicationJournal): Promise<void> {
    await completePublicationFile(journal, {
      root: this.root,
      layout: this.layout(),
      invalidate: this.options.invalidate,
      manifestFor: item => this.manifestForJournal(item, 'stable'),
    })
  }

  private async manifestForJournal(journal: PublicationJournal, status: SkillManifest['status']): Promise<SkillManifest> {
    const proposal = journal.proposalId === undefined ? undefined : await readJsonIfPresent<SkillProposal>(join(this.layout().candidateDir(journal.proposalId), 'proposal.json'))
    if (proposal !== undefined) return this.manifestFor(proposal, journal.scope, status, journal.startedAt)
    const existing = await readJsonIfPresent<SkillManifest>(join(skillDirectory(this.root, journal.skillName), 'manifest.json'))
    return { ...(existing ?? { name: journal.skillName, createdBy: 'human' as const }), version: journal.to.version, contentHash: journal.to.contentHash, status, scope: journal.scope, createdAt: journal.startedAt, updatedAt: journal.startedAt }
  }

  private clock(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private layout(): EvolutionLayout {
    return this.options.layout ?? resolveLayout({ root: this.root })
  }
}

function skillDirectory(root: string, skillName: string): string {
  return join(root, skillName)
}

function assertSkillName(value: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`invalid Skill name "${value}"`)
}

function assertVersion(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`invalid Skill version "${value}"`)
}

function assertExpectedBase(expected: AdoptionBase, current: CurrentSkill | undefined): void {
  if (current === undefined || current.manifest.name !== expected.name || current.manifest.contentHash !== expected.contentHash) {
    const actual = current?.manifest.contentHash ?? 'missing'
    throw new Error(`stale Skill base for "${expected.name}": expected ${expected.contentHash}, actual ${actual}`)
  }
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  const text = await readTextIfPresent(path)
  return text === undefined ? undefined : JSON.parse(text) as T
}

async function readVersionIfPresent(directory: string): Promise<{ readonly contentHash: string; readonly manifest: SkillManifest } | undefined> {
  const content = await readTextIfPresent(join(directory, 'SKILL.md'))
  const manifest = await readJsonIfPresent<SkillManifest>(join(directory, 'manifest.json'))
  if (content === undefined && manifest === undefined) return undefined
  if (content === undefined || manifest === undefined) throw new Error(`incomplete published Skill version at ${directory}`)
  return { contentHash: createContentHash(content), manifest }
}

async function recoverPublication(
  directory: string,
  versionsDirectory: string,
  invalidate?: SkillVersionStoreOptions['invalidate'],
): Promise<void> {
  const journalPath = join(directory, '.publish.json')
  const journal = await readJsonIfPresent<{ readonly version?: string; readonly contentHash?: string }>(journalPath)
  if (typeof journal?.version !== 'string' || journal.contentHash === undefined) return
  try {
    assertVersion(journal.version)
  } catch {
    return
  }
  const versionDirectory = join(versionsDirectory, journal.version)
  if (dirname(resolve(versionDirectory)) !== resolve(versionsDirectory)) return
  const content = await readTextIfPresent(join(versionDirectory, 'SKILL.md'))
  const manifest = await readJsonIfPresent<SkillManifest>(join(versionDirectory, 'manifest.json'))
  if (content === undefined || manifest === undefined) {
    await rm(versionDirectory, { recursive: true, force: true })
    await unlink(journalPath).catch(() => undefined)
    return
  }
  const version = { contentHash: createContentHash(content), manifest }
  if (version.contentHash !== journal.contentHash) return
  await writeAtomic(join(directory, 'SKILL.md'), content)
  await writeAtomic(join(directory, 'manifest.json'), `${JSON.stringify(version.manifest, null, 2)}\n`)
  await writeAtomic(join(directory, 'current.json'), `${JSON.stringify({ version: version.manifest.version, contentHash: version.manifest.contentHash }, null, 2)}\n`)
  if (version.manifest.scope !== 'explicit-only') await invalidate?.(version.manifest.name, version.manifest.scope)
  await unlink(join(directory, '.publish.json')).catch(() => undefined)
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

async function writeIfDifferent(path: string, content: string): Promise<void> {
  if (await readTextIfPresent(path) === content) return
  await writeAtomic(path, content)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
