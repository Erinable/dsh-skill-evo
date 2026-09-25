import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContentHash } from './events.js'
import { validateSkillCandidate, validateSkillDocument } from './evaluator.js'
import type { AdoptionBase, SkillManifest, SkillProposal } from './types.js'

export interface SkillVersionStoreOptions {
  readonly invalidate?: (skillName: string, scope: 'project' | 'user' | 'stable') => void | Promise<void>
  readonly now?: () => string
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
    return this.withMutationLock(skillName, () => this.readCurrentUnlocked(skillName))
  }

  private async readCurrentUnlocked(skillName: string): Promise<CurrentSkill | undefined> {
    assertSkillName(skillName)
    const directory = skillDirectory(this.root, skillName)
    await recoverPublication(directory, this.options.invalidate)
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
    const directory = join(this.root, '.skill-evolution', 'candidates', proposal.id)
    await mkdir(directory, { recursive: true })
    await writeAtomic(join(directory, 'SKILL.md'), proposal.candidateContent)
    await writeAtomic(join(directory, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`)
    return directory
  }

  async promote(
    proposal: SkillProposal,
    options: {
      readonly scope: 'explicit-only' | 'project' | 'user' | 'stable'
      readonly expectedBase?: AdoptionBase
    },
  ): Promise<PublishedSkill> {
    return this.withMutationLock(proposal.skillName, () => this.promoteUnlocked(proposal, options))
  }

  private async promoteUnlocked(
    proposal: SkillProposal,
    options: {
      readonly scope: 'explicit-only' | 'project' | 'user' | 'stable'
      readonly expectedBase?: AdoptionBase
    },
  ): Promise<PublishedSkill> {
    assertSkillName(proposal.skillName)
    assertVersion(proposal.proposedVersion)
    const expected = options.expectedBase ?? proposal.expectedBase
    const current = await this.readCurrentUnlocked(proposal.skillName)
    assertExpectedBase(expected, current)
    if (current !== undefined && current.manifest.version !== 'unversioned' && current.manifest.version !== proposal.baseVersion) {
      throw new Error(`stale Skill base version for "${proposal.skillName}": expected ${proposal.baseVersion}, actual ${current.manifest.version}`)
    }
    const validation = validateSkillDocument(proposal.candidateContent, proposal.skillName)
    if (!validation.valid) throw new Error(`candidate Skill is invalid: ${validation.errors.join('; ')}`)
    const changeValidation = validateSkillCandidate(current?.content ?? '', proposal.candidateContent, proposal.skillName)
    if (!changeValidation.valid) throw new Error(`candidate Skill change is invalid: ${changeValidation.errors.join('; ')}`)
    await this.writeCandidate(proposal)

    if (options.scope === 'explicit-only') {
      return {
        manifest: this.manifestFor(proposal, options.scope, 'observed'),
        path: join(this.root, '.skill-evolution', 'candidates', proposal.id, 'SKILL.md'),
      }
    }

    const directory = skillDirectory(this.root, proposal.skillName)
    await mkdir(join(directory, 'versions'), { recursive: true })
    const versionDirectory = join(directory, 'versions', proposal.proposedVersion)
    const existingVersion = await readVersionIfPresent(versionDirectory)
    if (existingVersion !== undefined) {
      if (existingVersion.contentHash !== createContentHash(proposal.candidateContent) || current?.manifest.version !== proposal.proposedVersion) {
        throw new Error(`published Skill version already exists: ${proposal.skillName}@${proposal.proposedVersion}`)
      }
      return { manifest: existingVersion.manifest, path: join(versionDirectory, 'SKILL.md') }
    }
    await writeAtomic(join(directory, '.publish.json'), `${JSON.stringify({ proposalId: proposal.id, version: proposal.proposedVersion, contentHash: createContentHash(proposal.candidateContent) })}\n`)
    await mkdir(versionDirectory, { recursive: false })
    if (current !== undefined && current.manifest.version !== 'unversioned') {
      const previousDirectory = join(directory, 'versions', current.manifest.version)
      const previous = await readVersionIfPresent(previousDirectory)
      if (previous === undefined) {
        await mkdir(previousDirectory, { recursive: true })
        await writeAtomic(join(previousDirectory, 'SKILL.md'), current.content)
        await writeAtomic(join(previousDirectory, 'manifest.json'), `${JSON.stringify(current.manifest, null, 2)}\n`)
      } else if (previous.contentHash !== createContentHash(current.content)) {
        throw new Error(`historical Skill version is inconsistent: ${proposal.skillName}@${current.manifest.version}`)
      }
    }
    const manifest = this.manifestFor(proposal, options.scope, 'stable')
    await writeAtomic(join(versionDirectory, 'SKILL.md'), proposal.candidateContent)
    await writeAtomic(join(versionDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeAtomic(join(directory, 'SKILL.md'), proposal.candidateContent)
    await writeAtomic(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeAtomic(join(directory, 'current.json'), `${JSON.stringify({ version: manifest.version, contentHash: manifest.contentHash }, null, 2)}\n`)
    await this.options.invalidate?.(proposal.skillName, options.scope)
    await unlink(join(directory, '.publish.json')).catch(() => undefined)
    return { manifest, path: join(directory, 'SKILL.md') }
  }

  async rollback(
    skillName: string,
    version: string,
    options: { readonly scope: 'project' | 'user' | 'stable'; readonly expectedBase?: AdoptionBase },
  ): Promise<PublishedSkill> {
    return this.withMutationLock(skillName, () => this.rollbackUnlocked(skillName, version, options))
  }

  private async rollbackUnlocked(
    skillName: string,
    version: string,
    options: { readonly scope: 'project' | 'user' | 'stable'; readonly expectedBase?: AdoptionBase },
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
    const sourceDirectory = join(directory, 'versions', version)
    const content = await readFile(join(sourceDirectory, 'SKILL.md'), 'utf8')
    const sourceManifest = await readJsonIfPresent<SkillManifest>(join(sourceDirectory, 'manifest.json'))
    if (sourceManifest === undefined) throw new Error(`missing manifest for Skill version ${version}`)
    const manifest: SkillManifest = {
      ...sourceManifest,
      status: 'stable',
      scope: options.scope,
      updatedAt: this.clock(),
    }
    await writeAtomic(join(directory, 'SKILL.md'), content)
    await writeAtomic(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeAtomic(join(directory, 'current.json'), `${JSON.stringify({ version: manifest.version, contentHash: manifest.contentHash }, null, 2)}\n`)
    await this.options.invalidate?.(skillName, options.scope)
    return { manifest, path: join(directory, 'SKILL.md') }
  }

  async listVersions(skillName: string): Promise<string[]> {
    assertSkillName(skillName)
    try {
      const entries = await readdir(join(skillDirectory(this.root, skillName), 'versions'), { withFileTypes: true })
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
      const current = await this.readCurrent(entry.name)
      const pointer = await readJsonIfPresent<{ version?: string; contentHash?: string }>(join(directory, 'current.json'))
      if (current === undefined) continue
      if (await readTextIfPresent(join(directory, '.publish.json')) !== undefined) issues.push(join(directory, '.publish.json'))
      if (pointer?.version !== current.manifest.version || pointer?.contentHash !== current.manifest.contentHash) issues.push(join(directory, 'current.json'))
      for (const version of await this.listVersions(entry.name)) {
        const record = await readVersionIfPresent(join(directory, 'versions', version)).catch(() => undefined)
        if (record === undefined || record.manifest.contentHash !== record.contentHash) issues.push(join(directory, 'versions', version))
      }
    }
    return issues
  }

  private withMutationLock<T>(skillName: string, operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const lockPath = join(this.root, '.skill-evolution', 'locks', `${skillName}.lock`)
      await mkdir(join(this.root, '.skill-evolution', 'locks'), { recursive: true })
      let handle
      try {
        handle = await open(lockPath, 'wx')
      } catch (error) {
        if (isExists(error)) throw new Error(`Skill publication already in progress for "${skillName}"`)
        throw error
      }
      try {
        return await operation()
      } finally {
        await handle.close()
        await unlink(lockPath).catch(() => undefined)
      }
    })
    this.mutationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private manifestFor(proposal: SkillProposal, scope: 'explicit-only' | 'project' | 'user' | 'stable', status: SkillManifest['status']): SkillManifest {
    const now = this.clock()
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

  private clock(): string {
    return this.options.now?.() ?? new Date().toISOString()
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
  invalidate?: SkillVersionStoreOptions['invalidate'],
): Promise<void> {
  const journal = await readJsonIfPresent<{ readonly version?: string; readonly contentHash?: string }>(join(directory, '.publish.json'))
  if (journal?.version === undefined || journal.contentHash === undefined) return
  const versionDirectory = join(directory, 'versions', journal.version)
  const version = await readVersionIfPresent(versionDirectory).catch(() => undefined)
  if (version === undefined || version.contentHash !== journal.contentHash) return
  await writeAtomic(join(directory, 'SKILL.md'), await readFile(join(versionDirectory, 'SKILL.md'), 'utf8'))
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

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
