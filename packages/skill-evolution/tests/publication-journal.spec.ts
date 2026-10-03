import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillVersionStore, completePublication, createContentHash, createProposal, readPublication, resolveLayout } from '../src/index.js'

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
    const layout = resolveLayout({ root }); const journal = { v: 1 as const, operation: 'promote' as const, skillName: 'api-debugging', scope: 'project' as const, proposalId: 'manifest-target', from: { version: 'unversioned', contentHash: createContentHash(base) }, to: { version: '1.0.0', contentHash: createContentHash(candidate) }, startedAt: '2026-10-03T00:00:00.000Z' }
    await expect(completePublication(journal, { root, layout, manifestFor: async () => ({ name: 'api-debugging', version: '1.0.0', contentHash: journal.to.contentHash, status: 'stable', scope: 'project', createdBy: 'human', createdAt: journal.startedAt, updatedAt: journal.startedAt }) })).rejects.toThrow()
    await expect(readFile(join(root, '..', 'escaped', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const target = join(root, 'api-debugging', 'versions', '1.1.0'); await (await import('node:fs/promises')).mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'tampered')
    const second = proposal('target-two')
    await expect(value.promote({ ...second, baseVersion: '1.0.0', baseContent: candidate, expectedBase: { name: 'api-debugging', contentHash: createContentHash(candidate) }, proposedVersion: '1.1.0' }, { scope: 'project' })).rejects.toThrow()
    await expect(readFile(join(target, 'SKILL.md'), 'utf8')).resolves.toBe('tampered')
  })

  it('uses one timestamp and proposal metadata for rollback and promotion manifests', async () => {
    let tick = 0; const { root } = await store(); const value = new SkillVersionStore(root, { now: () => `2026-10-03T00:00:0${tick++}.000Z` }); const p = { ...proposal('metadata'), generatedBy: 'designer' as const, baseVersion: '0.0.0' }
    const promoted = await value.promote(p, { scope: 'project' })
    const live = JSON.parse(await readFile(join(root, 'api-debugging', 'manifest.json'), 'utf8'))
    const version = JSON.parse(await readFile(join(root, 'api-debugging', 'versions', '1.0.0', 'manifest.json'), 'utf8'))
    expect(promoted.manifest).toEqual(live); expect(live).toEqual(version)
    expect(live).toMatchObject({ parentVersion: '0.0.0', createdBy: 'evolution-agent' }); expect(live.createdAt).toBe(live.updatedAt)
    const rolled = await value.rollback('api-debugging', '1.0.0', { scope: 'project' }); expect(rolled.manifest.updatedAt).toBe(JSON.parse(await readFile(join(root, 'api-debugging', 'manifest.json'), 'utf8')).updatedAt)
  })

  it('keeps explicit-only publication out of live files and versions', async () => {
    const invalidations: string[] = []; const { root } = await store(); const value = new SkillVersionStore(root, { invalidate: async name => { invalidations.push(name) } })
    await value.promote(proposal('explicit'), { scope: 'explicit-only' })
    await expect(readdir(join(root, 'api-debugging', 'versions'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'api-debugging', 'SKILL.md'), 'utf8')).resolves.toBe(base)
    expect(invalidations).toEqual([])
  })

  it('completes an explicit-only journal without touching live files', async () => {
    const invalidations: string[] = []; const { root } = await store(); const layout = resolveLayout({ root })
    const journal = { v: 1 as const, operation: 'promote' as const, skillName: 'api-debugging', scope: 'explicit-only' as const, proposalId: 'explicit-journal', from: { version: 'unversioned', contentHash: createContentHash(base) }, to: { version: '1.0.0', contentHash: createContentHash(candidate) }, startedAt: '2026-10-03T00:00:00.000Z' }
    await (await import('node:fs/promises')).mkdir(layout.publicationsDir, { recursive: true }); await writeFile(layout.publicationJournalPath('api-debugging'), `${JSON.stringify(journal)}\n`)
    await completePublication(journal, { root, layout, invalidate: async name => invalidations.push(name), manifestFor: async () => ({ name: 'api-debugging', version: '1.0.0', contentHash: journal.to.contentHash, status: 'observed', scope: 'explicit-only', createdBy: 'human', createdAt: journal.startedAt, updatedAt: journal.startedAt }) })
    await expect(readFile(join(root, 'api-debugging', 'SKILL.md'), 'utf8')).resolves.toBe(base); await expect(readdir(join(root, 'api-debugging', 'versions'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(invalidations).toEqual([])
  })

  it('leaves an active journal untouched on read paths', async () => {
    const { root, value } = await store(); const p = proposal('read-only'); await value.writeCandidate(p)
    const path = join(root, '.skill-evolution', 'publications', 'api-debugging.json'); await (await import('node:fs/promises')).mkdir(join(root, '.skill-evolution', 'publications'), { recursive: true })
    const raw = JSON.stringify({ v: 1, operation: 'promote', skillName: 'api-debugging', scope: 'project', from: { version: 'unversioned', contentHash: createContentHash(base) }, to: { version: '1.0.0', contentHash: createContentHash(candidate) }, startedAt: '2026-10-03T00:00:00.000Z', proposalId: 'read-only' })
    await writeFile(path, raw); await value.readCurrent('api-debugging'); await value.healthIssues(); expect(await readFile(path, 'utf8')).toBe(raw)
  })

  it('rejects invalid journal field types, scope, filename, and candidate hash', async () => {
    const { root: validationRoot } = await store(); const directory = join(validationRoot, '.skill-evolution', 'publications'); await (await import('node:fs/promises')).mkdir(directory, { recursive: true })
    const valid = { v: 1, operation: 'promote', skillName: 'api-debugging', scope: 'project', from: { version: 'unversioned', contentHash: createContentHash(base) }, to: { version: '1.0.0', contentHash: createContentHash(candidate) }, startedAt: '2026-10-03T00:00:00.000Z' }
    for (const value of [{ ...valid, v: 2 }, { ...valid, scope: 'bad' }, { ...valid, startedAt: 1 }, { ...valid, from: { version: 'unversioned' } }]) {
      const path = join(directory, 'api-debugging.json'); await writeFile(path, JSON.stringify(value)); await expect(readPublication(path)).rejects.toThrow()
    }
    await writeFile(join(directory, 'other.json'), JSON.stringify(valid)); await expect(readPublication(join(directory, 'other.json'))).rejects.toThrow()
    const { root, value: storeValue } = await store(); const p = proposal('candidate-hash'); await storeValue.writeCandidate(p)
    const journal = { ...valid, proposalId: 'candidate-hash', to: { ...valid.to, contentHash: createContentHash('wrong') } } as const
    await expect(completePublication(journal, { root, layout: resolveLayout({ root }), manifestFor: async () => ({ name: 'api-debugging', version: '1.0.0', contentHash: journal.to.contentHash, status: 'stable', scope: 'project', createdBy: 'human', createdAt: journal.startedAt, updatedAt: journal.startedAt }) })).rejects.toThrow()
  })

  it('quarantines a pre-existing target manifest with the wrong hash', async () => {
    const { root, value } = await store(); const p = proposal('manifest-target'); await value.writeCandidate(p)
    const target = join(root, 'api-debugging', 'versions', '1.0.0'); await (await import('node:fs/promises')).mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), candidate); await writeFile(join(target, 'manifest.json'), JSON.stringify({ contentHash: 'tampered' }))
    const layout = resolveLayout({ root }); const journal = { v: 1 as const, operation: 'promote' as const, skillName: 'api-debugging', scope: 'project' as const, proposalId: 'manifest-target', from: { version: 'unversioned', contentHash: createContentHash(base) }, to: { version: '1.0.0', contentHash: createContentHash(candidate) }, startedAt: '2026-10-03T00:00:00.000Z' }
    await expect(completePublication(journal, { root, layout, manifestFor: async () => ({ name: 'api-debugging', version: '1.0.0', contentHash: journal.to.contentHash, status: 'stable', scope: 'project', createdBy: 'human', createdAt: journal.startedAt, updatedAt: journal.startedAt }) })).rejects.toThrow()
    await expect(readFile(join(target, 'manifest.json'), 'utf8')).resolves.toContain('tampered')
  })
})
