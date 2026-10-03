import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolutionService,
  createProposal,
  normalizeEvaluationPolicy,
  normalizedPolicyHash,
  promoteProposal,
  transitionProposal,
  type EvaluationArtifact,
  type EvaluationPolicyV2,
} from '../src/index.js'

const roots: string[] = []
const base = `---\nname: api-debugging\ndescription: Debug APIs.\n---\n\nBase.\n`
const candidate = base.replace('Base.', 'Improved.')
const cases = [{ id: 'original', category: 'original-failure' as const, task: 'debug', expected: { contains: ['Improved.'] } }]
const schema2: EvaluationPolicyV2 = {
  schema: 2, version: 'same', maxRegressionCount: 0, maxSecurityViolations: 0, requireNoNewSideEffects: true,
  originalFailure: { costMetric: null },
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup(policy?: EvaluationPolicyV2) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-evo-policy-artifact-')); roots.push(root)
  await mkdir(join(root, 'api-debugging'), { recursive: true })
  await writeFile(join(root, 'api-debugging', 'SKILL.md'), base)
  const service = new EvolutionService({ root, ...(policy === undefined ? {} : { evaluationPolicy: policy }) })
  const proposal = transitionProposal(createProposal({ id: 'policy-artifact', skillName: 'api-debugging', baseVersion: '1.0.0', baseContent: base, proposedVersion: '1.1.0', candidateContent: candidate, intent: 'Improve' }), 'proposed')
  return { root, service, proposal }
}

async function evaluateAndAccept(service: EvolutionService, proposal: ReturnType<typeof transitionProposal>) {
  const result = await service.evaluate(proposal, cases)
  const evaluated = (await service.proposals.readAll()).find(item => item.id === `${proposal.id}:evaluated`)!
  return { result, evaluated: await service.acceptProposal(evaluated, 'reviewed') }
}

describe('policy-bound evaluation artifacts', () => {
  it('persists schema 2 evidence and keeps schema 1 artifacts legacy-shaped', async () => {
    const modern = await setup(schema2)
    const modernResult = await modern.service.evaluate(modern.proposal, cases)
    const modernArtifact = (await modern.service.evaluations.readAll())[0]!
    expect(modernArtifact).toMatchObject({ schemaVersion: 2, policy: normalizeEvaluationPolicy(schema2), policyHash: normalizedPolicyHash(schema2), statisticId: 'stratified-permutation-v1' })
    expect(modernArtifact.result).toMatchObject({ schemaVersion: 2, policyHash: modernArtifact.policyHash, statisticId: 'stratified-permutation-v1' })
    expect(modernArtifact.result.samples?.length).toBeGreaterThan(0)
    expect(modernResult.policyHash).toBe(modernArtifact.policyHash)

    const legacy = await setup()
    await legacy.service.evaluate(legacy.proposal, cases)
    const legacyArtifact = (await legacy.service.evaluations.readAll())[0]!
    expect(legacyArtifact).not.toHaveProperty('schemaVersion')
    expect(legacyArtifact).not.toHaveProperty('policy')
    expect(legacyArtifact).not.toHaveProperty('policyHash')
    expect(legacyArtifact.result).not.toHaveProperty('schemaVersion')
    expect(legacyArtifact.result).not.toHaveProperty('policyHash')
  })

  it('normalizes and promotes legacy evidence under schema 1', async () => {
    const { service, proposal } = await setup()
    const { result, evaluated } = await evaluateAndAccept(service, proposal)
    await expect(service.promote(evaluated, result, 'project')).resolves.toBeUndefined()
  })

  it('binds promotion to policy hashes across schema and version-compatible changes', async () => {
    const first = await setup(schema2)
    const { result, evaluated } = await evaluateAndAccept(first.service, first.proposal)
    const artifact = (await first.service.evaluations.readAll())[0]!

    await expect(promoteProposal(first.service, { proposalRef: evaluated.id, evaluation: { ...result, policyHash: '0'.repeat(64) }, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-mismatch' })
    await expect(promoteProposal(first.service, { proposalRef: evaluated.id, evaluation: { ...result, policyHash: undefined }, scope: 'project', dryRun: true })).resolves.toMatchObject({ dryRun: true })

    const changed = new EvolutionService({ root: first.root, evaluationPolicy: { ...schema2, context: { maxLoadIncreaseTokens: 999 } } })
    await expect(promoteProposal(changed, { proposalRef: evaluated.id, evaluation: result, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-mismatch' })

    const schema1Policy = { version: 'same', maxRegressionCount: 0, maxSecurityViolations: 0, requireNoNewSideEffects: true, requireOriginalFailureImprovement: true }
    const schema1 = new EvolutionService({ root: first.root, evaluationPolicy: schema1Policy })
    await expect(promoteProposal(schema1, { proposalRef: evaluated.id, evaluation: result, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-mismatch' })
    const strippedTop = { ...artifact, policyHash: undefined }
    await expect(promoteProposal(schema1, { proposalRef: evaluated.id, evaluation: strippedTop, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-mismatch' })
    const strippedBoth = { ...artifact, policyHash: undefined, result: { ...artifact.result, policyHash: undefined } }
    await writeFile(first.service.layout.stores.find(item => item.name === 'evaluations')!.path, `${JSON.stringify(strippedBoth)}\n`)
    await expect(promoteProposal(first.service, { proposalRef: evaluated.id, scope: 'project', dryRun: true })).rejects.toMatchObject({ code: 'evaluation-mismatch' })

    const matchingHash = normalizedPolicyHash(schema1Policy)
    const matching = { ...artifact, policyHash: matchingHash, result: { ...artifact.result, policyHash: matchingHash } }
    await writeFile(first.service.layout.stores.find(item => item.name === 'evaluations')!.path, `${JSON.stringify(matching)}\n`)
    await expect(promoteProposal(schema1, { proposalRef: evaluated.id, evaluation: matching, scope: 'project', dryRun: true })).resolves.toMatchObject({ dryRun: true })
  })

  it('records policy hashes in evaluated and promoted decision records', async () => {
    const { service, proposal } = await setup(schema2)
    const { result, evaluated } = await evaluateAndAccept(service, proposal)
    const hash = result.policyHash
    expect((await service.decisions.readAll()).find(item => item.toStatus === 'evaluated')?.policyHash).toBe(hash)
    await service.promote(evaluated, result, 'project')
    expect((await service.decisions.readAll()).find(item => item.toStatus === 'promoted')?.policyHash).toBe(hash)
  })
})
