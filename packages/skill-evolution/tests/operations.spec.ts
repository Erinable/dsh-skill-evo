import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolutionService,
  OperationError,
  evaluateProposal,
  proposalRootId,
  promoteProposal,
  proposeSkillChange,
  reviewProposal,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))))

const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nUse curl.\n`
const candidate = `${base}Check the response status before editing.\n`

async function setup(): Promise<{ root: string; service: EvolutionService }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-operations-'))
  dirs.push(root)
  await mkdir(join(root, 'api-debugging'), { recursive: true })
  await writeFile(join(root, 'api-debugging', 'SKILL.md'), base, 'utf8')
  return { root, service: new EvolutionService({ root }) }
}

async function acceptedProposal(): Promise<{ root: string; service: EvolutionService; proposalRef: string; evaluated: Awaited<ReturnType<typeof evaluateProposal>> }> {
  const { root, service } = await setup()
  const proposed = await proposeSkillChange(service, { root, skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'Improve diagnostics' })
  const evaluated = await evaluateProposal(service, { root, proposalRef: proposed.proposal.id, cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }] })
  const accepted = await reviewProposal(service, { proposalRef: evaluated.recordId, decision: 'accept', reason: 'reviewed' })
  return { root, service, proposalRef: accepted.recordId, evaluated }
}

async function expectNoPublication(root: string): Promise<void> {
  await expect(stat(join(root, 'api-debugging', 'versions'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, 'api-debugging', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('core maintenance operations', () => {
  it('rejects a stale base before staging a candidate or report', async () => {
    const { root, service } = await setup()
    await expect(proposeSkillChange(service, {
      root,
      skillName: 'api-debugging',
      baseContent: 'stale',
      candidateContent: candidate,
      proposedVersion: '1.1.0',
      intent: 'Improve diagnostics',
    })).rejects.toMatchObject({ code: 'stale-base' })
    await expect(stat(join(root, '.skill-evolution', 'candidates'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, '.skill-evolution', 'proposals'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists proposal and evaluation artifacts and returns new ledger ids', async () => {
    const { root, service } = await setup()
    const proposed = await proposeSkillChange(service, {
      root,
      skillName: 'api-debugging',
      baseContent: base,
      candidateContent: candidate,
      proposedVersion: '1.1.0',
      intent: 'Improve diagnostics',
    })
    expect(proposed.proposal.status).toBe('proposed')
    expect(await readFile(proposed.reportPath, 'utf8')).toContain('Improve diagnostics')
    const evaluated = await evaluateProposal(service, {
      root,
      proposalRef: proposed.proposal.id,
      cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }],
    })
    expect(evaluated.recordId).toMatch(/:evaluated$/)
    expect(JSON.parse(await readFile(evaluated.evaluationPath, 'utf8'))).toMatchObject({ proposalId: proposed.proposal.id })
    const accepted = await reviewProposal(service, { proposalRef: evaluated.recordId, decision: 'accept', reason: 'gate passed' })
    expect(accepted.recordId).toMatch(/:accepted$/)
  })

  it('shares promotion checks between dry-run and real execution', async () => {
    const { root, service } = await setup()
    const proposed = await proposeSkillChange(service, { root, skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'Improve diagnostics' })
    const evaluated = await evaluateProposal(service, { root, proposalRef: proposed.proposal.id, cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }] })
    const accepted = await reviewProposal(service, { proposalRef: evaluated.recordId, decision: 'accept', reason: 'gate passed' })
    const dryRun = await promoteProposal(service, { proposalRef: accepted.recordId, evaluation: evaluated.result, scope: 'project', dryRun: true })
    expect(dryRun).toMatchObject({ dryRun: true })
    await expectNoPublication(root)
    const published = await promoteProposal(service, { proposalRef: accepted.recordId, scope: 'project' })
    expect(published).toMatchObject({ promoted: true, version: '1.1.0', scope: 'project' })
    expect((await service.observations.readAll()).some(item => item.id === `adoption:${proposed.proposal.id}`)).toBe(true)
    expect((await service.proposals.readAll()).some(item => item.id === `${proposed.proposal.id}:promoted`)).toBe(true)
  })

  it('keeps one root-keyed candidate directory when promoting a ledger record', async () => {
    const { root, service, proposalRef } = await acceptedProposal()
    await promoteProposal(service, { proposalRef, scope: 'project' })

    const candidateNames = await readdir(join(root, '.skill-evolution', 'candidates'))
    expect(candidateNames).toEqual([proposalRootId(proposalRef)])
  })

  it.each([true, false])('rejects an unaccepted proposal in %s mode without publication', async dryRun => {
    const { root, service } = await setup()
    const proposed = await proposeSkillChange(service, { root, skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'Improve diagnostics' })
    await expect(promoteProposal(service, { proposalRef: proposed.proposal.id, scope: 'project', dryRun })).rejects.toMatchObject({ code: 'invalid-transition' })
    await expectNoPublication(root)
  })

  it.each([true, false])('rejects a missing or forged artifact in %s mode', async dryRun => {
    const { root, service, proposalRef, evaluated } = await acceptedProposal()
    const artifactPath = join(root, 'forged.json')
    const artifact = JSON.parse(await readFile(evaluated.evaluationPath, 'utf8')) as Record<string, unknown>
    artifact.id = 'evaluation:forged'
    await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, 'utf8')
    await expect(promoteProposal(service, { proposalRef, evaluationPath: artifactPath, scope: 'project', dryRun })).rejects.toMatchObject({ code: 'evaluation-missing' })
    await expectNoPublication(root)
  })

  it.each([true, false])('rejects a failed gate in %s mode', async dryRun => {
    const { root, service } = await setup()
    const proposed = await proposeSkillChange(service, { root, skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'Improve diagnostics' })
    const evaluated = await evaluateProposal(service, { root, proposalRef: proposed.proposal.id, cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['text that is absent'] } }] })
    const accepted = await reviewProposal(service, { proposalRef: evaluated.recordId, decision: 'accept', reason: 'reviewed' })
    await expect(promoteProposal(service, { proposalRef: accepted.recordId, scope: 'project', dryRun })).rejects.toMatchObject({ code: 'gate-failed' })
    await expectNoPublication(root)
  })

  it.each([true, false])('rejects an invalid scope in %s mode without publication', async dryRun => {
    const { root, service, proposalRef } = await acceptedProposal()
    await expect(promoteProposal(service, { proposalRef, scope: 'bogus', dryRun })).rejects.toMatchObject({ code: 'invalid-option' })
    await expectNoPublication(root)
  })

  it('rejects a forged artifact with changed evidence under the persisted id', async () => {
    const { root, service, proposalRef, evaluated } = await acceptedProposal()
    const artifactPath = join(root, 'forged-evidence.json')
    const artifact = JSON.parse(await readFile(evaluated.evaluationPath, 'utf8')) as Record<string, unknown>
    artifact.passedGate = false
    await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, 'utf8')
    await expect(promoteProposal(service, { proposalRef, evaluationPath: artifactPath, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-mismatch' })
    await expectNoPublication(root)
  })

  it('selects the latest unexpired artifact when a newer artifact is expired', async () => {
    const { root, service, proposalRef, evaluated } = await acceptedProposal()
    const persisted = (await service.evaluations.readAll()).find(item => item.id === evaluated.result.artifactId)
    expect(persisted).toBeDefined()
    await service.evaluations.append({
      ...persisted!,
      id: `${persisted!.id}:expired`,
      expiresAt: '2020-01-01T00:00:00.000Z',
      result: { ...persisted!.result, artifactId: `${persisted!.id}:expired` },
    })
    const dryRun = await promoteProposal(service, { proposalRef, scope: 'project', dryRun: true })
    expect(dryRun).toMatchObject({ dryRun: true, evaluation: { id: persisted!.id } })
    await expectNoPublication(root)
  })
})
