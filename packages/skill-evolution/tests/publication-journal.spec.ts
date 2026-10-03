import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillVersionStore, createContentHash, createProposal } from '../src/index.js'

const roots: string[] = []
const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
const candidate = `${base}Next.\n`
const proposal = (id = 'journal') => createProposal({ id, skillName: 'api-debugging', baseVersion: '0.0.0', baseContent: base, proposedVersion: '1.0.0', candidateContent: candidate, intent: 'publish' })

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function store(): Promise<{ root: string; value: SkillVersionStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-publication-journal-')); roots.push(root)
  await writeFile(join(root, 'api-debugging', 'SKILL.md'), base).catch(async () => { await (await import('node:fs/promises')).mkdir(join(root, 'api-debugging'), { recursive: true }); await writeFile(join(root, 'api-debugging', 'SKILL.md'), base) })
  return { root, value: new SkillVersionStore(root, { now: () => '2026-10-03T00:00:00.000Z' }) }
}

describe('file publication journals', () => {
  it('quarantines invalid journals and continues the next promote', async () => {
    const { root, value } = await store(); const p = proposal()
    await value.writeCandidate(p)
    const path = join(root, '.skill-evolution', 'publications', 'api-debugging.json')
    await (await import('node:fs/promises')).mkdir(join(root, '.skill-evolution', 'publications'), { recursive: true })
    await writeFile(path, JSON.stringify({ v: 2, skillName: 'api-debugging' }))
    await expect(value.promote(p, { scope: 'project' })).resolves.toMatchObject({ manifest: { version: '1.0.0' } })
    await expect(readdir(join(root, '.skill-evolution', 'publications', 'quarantine'))).resolves.toHaveLength(1)
  })

  it('rejects traversal and mismatched target files without overwriting them', async () => {
    const { root, value } = await store(); const p = proposal('target')
    await value.writeCandidate(p)
    const publication = join(root, '.skill-evolution', 'publications'); await (await import('node:fs/promises')).mkdir(publication, { recursive: true })
    await writeFile(join(publication, 'api-debugging.json'), JSON.stringify({ v: 1, operation: 'promote', skillName: '../escaped', scope: 'project', from: { version: 'unversioned', contentHash: createContentHash(base) }, to: { version: '1.0.0', contentHash: createContentHash(candidate) }, startedAt: '2026-10-03T00:00:00.000Z', proposalId: 'target' }))
    await expect(value.promote(p, { scope: 'project' })).resolves.toBeDefined()
    await expect(readFile(join(root, 'escaped', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses one timestamp and proposal metadata for rollback and promotion manifests', async () => {
    const { value } = await store(); const p = proposal('metadata')
    const promoted = await value.promote(p, { scope: 'project' })
    expect(promoted.manifest.createdAt).toBe('2026-10-03T00:00:00.000Z')
    const rolled = await value.rollback('api-debugging', '1.0.0', { scope: 'project' })
    expect(rolled.manifest.updatedAt).toBe('2026-10-03T00:00:00.000Z')
  })
})
