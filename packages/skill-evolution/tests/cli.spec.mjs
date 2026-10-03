import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { measureSkillContext } from '../lib/index.js'

const packageDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = join(packageDir, 'bin', 'dsh-skill-evolution.mjs')
const dirs = []
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))))

const base = '---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nUse curl.\n'
const candidate = `${base}Check the response status before editing.\n`
const passingCase = [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }]

async function run(root, ...args) {
  const result = await new Promise(resolveResult => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolveResult({ code, stdout, stderr }))
  })
  return result
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-cli-'))
  dirs.push(root)
  await mkdir(join(root, 'api-debugging'), { recursive: true })
  await writeFile(join(root, 'api-debugging', 'SKILL.md'), base)
  await writeFile(join(root, 'base.md'), base)
  await writeFile(join(root, 'candidate.md'), candidate)
  await writeFile(join(root, 'cases.json'), JSON.stringify(passingCase))
  return root
}

describe('CLI command help', () => {
  it.each(['--help', 'help'])('prints usage and exits successfully for %s', async command => {
    const result = await run(packageDir, command)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: dsh-skill-evolution')
    expect(result.stderr).toBe('')
  })

  it('names an unknown command before usage and exits unsuccessfully', async () => {
    const result = await run(packageDir, 'promot')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/^Unknown command: promot\nUsage: dsh-skill-evolution/)
  })

  it('lists version in usage and preserves its JSON response', async () => {
    const help = await run(packageDir, 'help')
    expect(help.stdout).toMatch(/<[^>]*\bversion\b[^>]*>/)

    const version = await run(packageDir, 'version')
    expect(version.code).toBe(0)
    expect(JSON.parse(version.stdout)).toEqual({ name: '@dsh-skill-evo/core', version: '0.1.0', schemaVersion: 1 })
    expect(version.stderr).toBe('')
  })
})

describe('CLI maintenance lifecycle', () => {
  it('exports content-derived context metrics for current Skills and preserves host context cost', async () => {
    const root = await setup()
    const skill = { name: 'api-debugging', provider: 'unknown', source: 'runtime' }
    const missing = { name: 'missing-skill', provider: 'unknown', source: 'runtime' }
    await mkdir(join(root, '.skill-evolution'), { recursive: true })
    await writeFile(join(root, '.skill-evolution', 'observations.jsonl'), [
      { schemaVersion: 1, id: 'catalog-1', kind: 'catalog-visible', occurredAt: '2026-01-01T00:00:00.000Z', sessionId: 's1', skill, correlationIds: [], payload: {}, source: 'runtime' },
      { schemaVersion: 1, id: 'catalog-2', kind: 'catalog-visible', occurredAt: '2026-01-01T00:00:01.000Z', sessionId: 's2', skill, correlationIds: [], payload: {}, source: 'runtime' },
      { schemaVersion: 1, id: 'loaded-1', kind: 'skill-loaded', occurredAt: '2026-01-01T00:00:02.000Z', sessionId: 's1', skill, correlationIds: [], payload: { inputTokens: 7 }, source: 'runtime' },
      { schemaVersion: 1, id: 'missing', kind: 'catalog-visible', occurredAt: '2026-01-01T00:00:03.000Z', sessionId: 's3', skill: missing, correlationIds: [], payload: {}, source: 'runtime' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n')

    const result = await run(root, 'metrics', '--root', root)
    expect(result.code).toBe(0)
    const metrics = JSON.parse(result.stdout)
    const expected = measureSkillContext(base)
    const current = metrics.skills.find(skillMetric => skillMetric.skillName === 'api-debugging')
    expect(current.context).toEqual({
      catalogTokens: expected.catalogTokens,
      loadTokens: expected.loadTokens,
      exposureWeightedTokens: expected.catalogTokens * 2 + expected.loadTokens,
    })
    expect(metrics.skills.find(skillMetric => skillMetric.skillName === 'missing-skill')).not.toHaveProperty('context')
    expect(metrics.skillContext).toEqual({
      estimator: expected.estimator,
      catalogTokens: expected.catalogTokens,
      loadTokens: expected.loadTokens,
      exposureWeightedTokens: expected.catalogTokens * 2 + expected.loadTokens,
    })
    expect(metrics.contextCost).toBe(7)
  })

  it('delegates lifecycle commands and validates promote dry-runs', async () => {
    const root = await setup()
    const feedback = await run(root, 'feedback', '--session', 's1', '--kind', 'incorrect', '--skill', 'api-debugging', '--note', 'n', '--attribution', 'content')
    expect(feedback.code).toBe(0)
    expect(JSON.parse(feedback.stdout)).toMatchObject({ kind: 'incorrect', attribution: 'content' })
    const proposed = await run(root, 'propose', '--skill', 'api-debugging', '--base-file', 'base.md', '--candidate-file', 'candidate.md', '--proposed-version', '1.1.0', '--intent', 'Improve diagnostics')
    expect(proposed.code).toBe(0)
    const proposedRecord = JSON.parse(proposed.stdout).proposal

    const evaluated = await run(root, 'evaluate', '--proposal', proposedRecord.id, '--cases', 'cases.json')
    expect(evaluated.code).toBe(0)
    expect(await readFile(join(root, '.skill-evolution', 'evaluations', `${proposedRecord.id}.json`), 'utf8')).toContain(proposedRecord.id)
    const evaluatedRecord = JSON.parse((await run(root, 'accept', '--proposal', `${proposedRecord.id}:evaluated`, '--reason', 'Reviewed')).stdout)
    expect(evaluatedRecord.id).toMatch(/:accepted$/)

    const dryRun = await run(root, 'promote', '--proposal', evaluatedRecord.id, '--dry-run')
    expect(dryRun.code).toBe(0)
    expect(JSON.parse(dryRun.stdout).dryRun).toBe(true)
    const promoted = await run(root, 'promote', '--proposal', evaluatedRecord.id, '--format', 'json')
    expect(promoted.code).toBe(0)
    expect(JSON.parse(promoted.stdout)).toMatchObject({ promoted: true, version: '1.1.0' })
  })

  it('returns typed errors for invalid promote dry-runs', async () => {
    const root = await setup()
    const proposed = JSON.parse((await run(root, 'propose', '--skill', 'api-debugging', '--base-file', 'base.md', '--candidate-file', 'candidate.md', '--proposed-version', '1.1.0', '--intent', 'Improve diagnostics')).stdout).proposal
    const unaccepted = await run(root, 'promote', '--proposal', proposed.id, '--dry-run')
    expect(unaccepted).toMatchObject({ code: 1 })
    expect(unaccepted.stderr).toContain('invalid-transition')
    await run(root, 'evaluate', '--proposal', proposed.id, '--cases', 'cases.json')
    const accepted = JSON.parse((await run(root, 'accept', '--proposal', `${proposed.id}:evaluated`, '--reason', 'Reviewed')).stdout)
    const missingArtifact = await run(root, 'promote', '--proposal', accepted.id, '--evaluation', 'missing.json', '--dry-run')
    expect(missingArtifact.code).toBe(1)
    expect(missingArtifact.stderr).toContain('evaluation-missing')
    await writeFile(join(root, 'fake.json'), JSON.stringify({ passedGate: true }))
    const fakeArtifact = await run(root, 'promote', '--proposal', accepted.id, '--evaluation', 'fake.json', '--dry-run')
    expect(fakeArtifact.code).toBe(1)
    expect(fakeArtifact.stderr).toContain('evaluation-mismatch')
    const invalidScope = await run(root, 'promote', '--proposal', accepted.id, '--scope', 'bogus', '--dry-run')
    expect(invalidScope.code).toBe(1)
    expect(invalidScope.stderr).toContain('invalid-option')

    const badCandidate = `${base}Use a different response phrase.\n`
    await writeFile(join(root, 'bad-candidate.md'), badCandidate)
    await writeFile(join(root, 'bad-cases.json'), JSON.stringify([{ ...passingCase[0], expected: { contains: ['missing phrase'] } }]))
    const second = JSON.parse((await run(root, 'propose', '--skill', 'api-debugging', '--base-file', 'base.md', '--candidate-file', 'bad-candidate.md', '--proposed-version', '1.2.0', '--intent', 'Try another change')).stdout).proposal
    await run(root, 'evaluate', '--proposal', second.id, '--cases', 'bad-cases.json')
    const secondAccepted = JSON.parse((await run(root, 'accept', '--proposal', `${second.id}:evaluated`, '--reason', 'Review failed gate')).stdout)
    const failedGate = await run(root, 'promote', '--proposal', secondAccepted.id, '--dry-run')
    expect(failedGate.stderr).toContain('gate-failed')
  })

  it('rotates the configured store, honors file precedence, and makes retention explicit', async () => {
    const root = await setup()
    const store = join(root, 'custom-events.jsonl')
    const override = join(root, 'override-events.jsonl')
    await writeFile(store, 'store-content\n', 'utf8')
    await writeFile(override, 'override-content\n', 'utf8')

    const storeRotation = await run(root, 'rotate', '--root', root, '--store', store, '--max-bytes', '1')
    expect(storeRotation.code).toBe(0)
    expect(JSON.parse(storeRotation.stdout).rotated).toContain(join('archive', 'custom-events.jsonl.'))

    const precedence = await run(root, 'rotate', '--root', root, '--store', store, '--file', override, '--max-bytes', '1')
    expect(precedence.code).toBe(0)
    expect(JSON.parse(precedence.stdout).rotated).toContain(join('archive', 'override-events.jsonl.'))

    const oldStoreArchive = join(root, 'archive', 'custom-events.jsonl.2000-01-01T00-00-00.000Z.1.jsonl')
    const oldOtherArchive = join(root, 'archive', 'other-events.jsonl.2000-01-01T00-00-00.000Z.1.jsonl')
    await writeFile(oldStoreArchive, '', 'utf8')
    await writeFile(oldOtherArchive, '', 'utf8')
    await utimes(oldStoreArchive, new Date('2000-01-01'), new Date('2000-01-01'))
    await utimes(oldOtherArchive, new Date('2000-01-01'), new Date('2000-01-01'))

    const noRetention = await run(root, 'rotate', '--root', root, '--store', store, '--max-bytes', '999999')
    expect(JSON.parse(noRetention.stdout).deleted).toEqual([])
    expect(await stat(oldStoreArchive)).toBeTruthy()

    const withRetention = await run(root, 'rotate', '--root', root, '--store', store, '--max-bytes', '999999', '--retention-days', '30')
    expect(JSON.parse(withRetention.stdout).deleted).toContain(oldStoreArchive)
    await expect(stat(oldStoreArchive)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stat(oldOtherArchive)).toBeTruthy()
  })
})
