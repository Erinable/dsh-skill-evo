import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolutionService,
  OperationError,
  ProposalLedgerError,
  createProposal,
  evaluateProposal,
  proposalRootId,
  promoteProposal,
  proposeSkillChange,
  reviewProposal,
  renderEvaluationMarkdown,
  renderProposalMarkdown,
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
  it('renders operation cost statistics and every check, including legacy reports', async () => {
    const { root, service } = await setup()
    const proposed = await proposeSkillChange(service, { root, skillName: 'api-debugging', baseContent: base, candidateContent: base, proposedVersion: '1.1.0', intent: 'cost report' })
    const policy = { schema: 2 as const, version: '2', maxRegressionCount: 0, maxSecurityViolations: 0, requireNoNewSideEffects: true, sampling: { runs: 5 }, originalFailure: { costMetric: 'steps' as const, minCostReduction: 0.2 }, historicalSuccess: { maxStepIncrease: null, maxTokenIncrease: null }, context: { maxCatalogIncreaseTokens: null, maxLoadIncreaseTokens: null } }
    const modern = new EvolutionService({ root, evaluationPolicy: policy })
    const evaluated = await evaluateProposal(modern, { root, proposalRef: proposed.proposal.id, cases: [{ id: 'cost', category: 'original-failure', task: 'debug', expected: { contains: ['Use curl.'] } }], runner: async (_content, _item, context) => ({ passed: true, toolCalls: context!.exposure === 'base' ? 6 : 2 }) })
    expect(evaluated.result.cost?.categories['original-failure'].steps).toMatchObject({ relativeChange: -2 / 3, pValue: 1 / 252 })
    const report = await readFile(evaluated.reportPath, 'utf8')
    expect(report).toContain('change -0.6666666666666666; p=0.003968253968253968')
    for (const check of evaluated.result.cost!.checks) expect(report).toContain(check.id)
    const legacy = renderProposalMarkdown({ proposal: evaluated.proposal, evaluation: { ...evaluated.result, cost: undefined } })
    expect(legacy).toContain('Execution cost: not recorded')
    expect(renderEvaluationMarkdown({ ...evaluated.result, cost: undefined })).toContain('Execution cost: not recorded')
    const unstableProposal = await proposeSkillChange(service, { root, skillName: 'api-debugging', baseContent: base, candidateContent: base, proposedVersion: '1.2.0', intent: 'unstable report' })
    const unstable = await evaluateProposal(new EvolutionService({ root, evaluationPolicy: policy }), { root, proposalRef: unstableProposal.proposal.id, cases: [{ id: 'cost', category: 'original-failure', task: 'debug', expected: { contains: ['Use curl.'] } }], runner: async (_content, _item, context) => ({ passed: context!.sample < 3, toolCalls: 2 }) })
    expect(unstable.result.cost?.unstable).toContainEqual({ caseId: 'cost', exposure: 'base', passRate: 0.6 })
    const unstableReport = await readFile(unstable.reportPath, 'utf8')
    expect(unstableReport).toContain('`cost` base: pass rate 0.6')
    expect(renderEvaluationMarkdown(unstable.result)).toContain('`cost` base: pass rate 0.6')
  })
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

  it('routes service evaluation retries through the ledger and preserves exact records', async () => {
    const { service } = await setup()
    const cases = [{ id: 'trigger', category: 'original-failure' as const, task: 'debug', expected: { contains: ['Check the response status'] } }]
    const proposed = await proposeSkillChange(service, { skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'Improve diagnostics' })
    await evaluateProposal(service, { proposalRef: proposed.proposal.id, cases })
    const firstEvaluated = (await service.proposals.readAll()).find(item => item.id === `${proposed.proposal.id}:evaluated`)!
    const rejected = await reviewProposal(service, { proposalRef: firstEvaluated.id, decision: 'reject', reason: 'retry' })
    const observed = (await service.ledger.transition(rejected.proposal, 'observed', { reason: 'observe' })).record
    await service.evaluate(observed, cases)
    const records = await service.proposals.readAll()
    expect(records.filter(item => item.status === 'evaluated').map(item => item.id)).toEqual([
      `${proposed.proposal.id}:evaluated`, `${proposed.proposal.id}:evaluated:2`,
    ])
    expect((await service.decisions.readAll()).filter(item => item.toStatus === 'evaluated').map(item => item.recordId)).toEqual([
      `${proposed.proposal.id}:evaluated`, `${proposed.proposal.id}:evaluated:2`,
    ])
    expect((await service.ledger.latest(proposed.proposal.id)).id).toBe(`${proposed.proposal.id}:evaluated:2`)
    expect((await service.ledger.record(`${proposed.proposal.id}:evaluated`)).id).toBe(`${proposed.proposal.id}:evaluated`)
  })

  it('keeps service ledger and decisions unchanged on stale transitions and proposal write failures', async () => {
    const { service } = await setup()
    const proposed = await proposeSkillChange(service, { skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'Improve diagnostics' })
    await evaluateProposal(service, { proposalRef: proposed.proposal.id, cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }] })
    const evaluated = (await service.proposals.readAll()).find(item => item.status === 'evaluated')!
    await service.rejectProposal(evaluated, 'reject')
    const before = { proposals: (await service.proposals.readAll()).length, decisions: (await service.decisions.readAll()).length }
    await expect(service.acceptProposal(evaluated, 'stale')).rejects.toMatchObject({ code: 'conflict' })
    expect(await service.proposals.readAll()).toHaveLength(before.proposals)
    expect(await service.decisions.readAll()).toHaveLength(before.decisions)

    const originalAppendComputed = service.proposals.appendComputed
    const writeError = new Error('proposal write failed')
    service.proposals.appendComputed = (async () => { throw writeError }) as typeof service.proposals.appendComputed
    const draft = createProposal({ id: 'write-failure', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'write failure' })
    await expect(service.stageProposal(draft)).rejects.toBe(writeError)
    expect(await service.decisions.readAll()).toHaveLength(before.decisions)
    service.proposals.appendComputed = originalAppendComputed
  })

  it('rejects suffixed roots before staging and guards invalid service evaluation without writes', async () => {
    const { service } = await setup()
    const invalid = createProposal({ id: 'proposal:invalid:evaluated', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'invalid root' })
    await expect(service.stageProposal(invalid)).rejects.toMatchObject({ code: 'invalid-transition' })
    expect(await service.proposals.readAll()).toHaveLength(0)
    expect(await service.decisions.readAll()).toHaveLength(0)

    const proposed = await proposeSkillChange(service, { skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'guard evaluation' })
    await evaluateProposal(service, { proposalRef: proposed.proposal.id, cases: [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }] })
    const evaluated = (await service.proposals.readAll()).find(item => item.status === 'evaluated')!
    const accepted = await service.acceptProposal(evaluated, 'accepted')
    const evaluationCount = (await service.evaluations.readAll()).length
    await expect(service.evaluate(accepted, [{ id: 'trigger', category: 'original-failure', task: 'debug', expected: { contains: ['Check the response status'] } }])).rejects.toMatchObject({ code: 'invalid-transition' })
    expect(await service.evaluations.readAll()).toHaveLength(evaluationCount)
  })

  it('maps ledger conflicts from review operations to OperationError', async () => {
    const { service } = await setup()
    const proposed = await proposeSkillChange(service, { skillName: 'api-debugging', baseContent: base, candidateContent: candidate, proposedVersion: '1.1.0', intent: 'conflict mapping' })
    const failing = { proposals: { readAll: async () => [proposed.proposal] }, acceptProposal: async () => { throw new ProposalLedgerError('conflict', 'stale proposal') } } as unknown as EvolutionService
    await expect(reviewProposal(failing, { proposalRef: proposed.proposal.id, decision: 'accept', reason: 'review' })).rejects.toBeInstanceOf(OperationError)
    await expect(reviewProposal(failing, { proposalRef: proposed.proposal.id, decision: 'accept', reason: 'review' })).rejects.toMatchObject({ code: 'conflict' })
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

  it('keeps one encoded root-keyed candidate directory when promoting a ledger record', async () => {
    const { root, service, proposalRef } = await acceptedProposal()
    await promoteProposal(service, { proposalRef, scope: 'project' })

    const candidateNames = await readdir(join(root, '.skill-evolution', 'candidates'))
    expect(candidateNames).toEqual([encodeURIComponent(proposalRootId(proposalRef))])
    expect(candidateNames[0]).not.toContain(':')
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
