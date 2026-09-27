import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolutionService,
  OperationError,
  evaluateProposal,
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
    await expect(stat(join(root, 'api-debugging', 'versions', '1.1.0'))).rejects.toMatchObject({ code: 'ENOENT' })
    const published = await promoteProposal(service, { proposalRef: accepted.recordId, scope: 'project' })
    expect(published).toMatchObject({ promoted: true, version: '1.1.0', scope: 'project' })
    await expect(promoteProposal(service, { proposalRef: accepted.recordId, scope: 'bogus', dryRun: true })).rejects.toMatchObject({ code: 'invalid-option' })
  })

  it('reports missing artifacts, invalid transitions, and failed gates with typed codes', async () => {
    const { root, service } = await setup()
    const proposed = await proposeSkillChange(service, { root, skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'Improve diagnostics' })
    await expect(promoteProposal(service, { proposalRef: proposed.proposal.id, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'invalid-transition' })
    const evaluated = await evaluateProposal(service, { root, proposalRef: proposed.proposal.id, cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }] })
    const accepted = await reviewProposal(service, { proposalRef: evaluated.recordId, decision: 'accept', reason: 'reviewed' })
    await expect(promoteProposal(service, { proposalRef: accepted.recordId, evaluationPath: join(root, 'missing.json'), scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-missing' })
    const failed = { ...evaluated.result, passedGate: false, gateReasons: ['failed'] }
    await expect(promoteProposal(service, { proposalRef: accepted.recordId, evaluation: failed, scope: 'project', dryRun: true })).rejects.toBeInstanceOf(OperationError)
  })
})
