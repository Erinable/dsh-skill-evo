import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContentHash } from './events.js'
import { validateSkillDocument } from './evaluator.js'
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

  async readCurrent(skillName: string): Promise<CurrentSkill | undefined> {
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
    assertSkillName(proposal.skillName)
    assertVersion(proposal.proposedVersion)
    const expected = options.expectedBase ?? proposal.expectedBase
    const current = await this.readCurrent(proposal.skillName)
    assertExpectedBase(expected, current)
    const validation = validateSkillDocument(proposal.candidateContent, proposal.skillName)
    if (!validation.valid) throw new Error(`candidate Skill is invalid: ${validation.errors.join('; ')}`)
    await this.writeCandidate(proposal)

    if (options.scope === 'explicit-only') {
      return {
        manifest: this.manifestFor(proposal, options.scope, 'observed'),
        path: join(this.root, '.skill-evolution', 'candidates', proposal.id, 'SKILL.md'),
      }
    }

    const directory = skillDirectory(this.root, proposal.skillName)
    await mkdir(join(directory, 'versions', proposal.proposedVersion), { recursive: true })
    if (current !== undefined && current.manifest.version !== 'unversioned') {
      const previousDirectory = join(directory, 'versions', current.manifest.version)
      await mkdir(previousDirectory, { recursive: true })
      await writeAtomic(join(previousDirectory, 'SKILL.md'), current.content)
      await writeAtomic(join(previousDirectory, 'manifest.json'), `${JSON.stringify(current.manifest, null, 2)}\n`)
    }
    const manifest = this.manifestFor(proposal, options.scope, 'stable')
    const versionDirectory = join(directory, 'versions', proposal.proposedVersion)
    await writeAtomic(join(versionDirectory, 'SKILL.md'), proposal.candidateContent)
    await writeAtomic(join(versionDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeAtomic(join(directory, 'SKILL.md'), proposal.candidateContent)
    await writeAtomic(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeAtomic(join(directory, 'current.json'), `${JSON.stringify({ version: manifest.version, contentHash: manifest.contentHash }, null, 2)}\n`)
    await this.options.invalidate?.(proposal.skillName, options.scope)
    return { manifest, path: join(directory, 'SKILL.md') }
  }

  async rollback(
    skillName: string,
    version: string,
    options: { readonly scope: 'project' | 'user' | 'stable'; readonly expectedBase?: AdoptionBase },
  ): Promise<PublishedSkill> {
    assertSkillName(skillName)
    assertVersion(version)
    const current = await this.readCurrent(skillName)
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

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
