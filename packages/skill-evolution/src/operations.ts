import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createContentHash } from './events.js'
import { type EvaluationRunner } from './evaluator.js'
import { assertCanTransition, findProposalById, ledgerRecordId, proposalRootId, ProposalLedgerError, createProposal } from './proposal.js'
import { renderProposalMarkdown } from './report.js'
import { EvolutionService } from './service.js'
import { assertPublicationScope, InvalidOptionError, type EvaluationArtifact, type PublicationScope, type SkillEvalResult, type SkillEvaluationCase, type SkillProposal } from './types.js'
import { OperationError } from './errors.js'
import { checkPromotion, defaultPolicyVersion, resolvePromotionArtifact } from './promotion-check.js'

export { OperationError } from './errors.js'

export interface ProposeSkillChangeOptions {
  readonly root?: string
  readonly skillName: string
  readonly baseContent?: string
  readonly baseFile?: string
  readonly candidateContent?: string
  readonly candidateFile?: string
  readonly proposedVersion: string
  readonly intent: string
  readonly id?: string
  readonly baseVersion?: string
  readonly reportPath?: string
}

export interface ProposeSkillChangeResult {
  readonly proposal: SkillProposal
  readonly reportPath: string
}

export interface EvaluateProposalOptions {
  readonly root?: string
  readonly proposalRef: string
  readonly cases?: readonly SkillEvaluationCase[]
  readonly casesFile?: string
  readonly evaluationPath?: string
  readonly reportPath?: string
  readonly runner?: EvaluationRunner
}

export interface EvaluateProposalResult {
  readonly proposal: SkillProposal
  readonly recordId: string
  readonly result: SkillEvalResult
  readonly artifact: EvaluationArtifact
  readonly evaluationPath: string
  readonly reportPath: string
}

export interface ReviewProposalOptions {
  readonly proposalRef: string
  readonly decision: 'accept' | 'reject' | 'defer'
  readonly reason: string
  readonly evidenceIds?: readonly string[]
}

export interface ReviewProposalResult {
  readonly proposal: SkillProposal
  readonly recordId: string
}

export interface PromoteProposalOptions {
  readonly proposalRef: string
  readonly evaluation?: SkillEvalResult | EvaluationArtifact
  readonly evaluationPath?: string
  readonly scope: PublicationScope | string
  readonly dryRun?: boolean
  readonly reason?: string
}

export type PromoteResult =
  | { readonly dryRun: true; readonly proposal: SkillProposal; readonly evaluation: EvaluationArtifact }
  | { readonly promoted: true; readonly skillName: string; readonly version: string; readonly scope: PublicationScope }

export interface RollbackSkillOptions {
  readonly skillName: string
  readonly version: string
  readonly reason?: string
}

export interface RollbackSkillResult {
  readonly skillName: string
  readonly version: string
}

export async function proposeSkillChange(service: EvolutionService, options: ProposeSkillChangeOptions): Promise<ProposeSkillChangeResult> {
  const current = await service.versions.readCurrent(options.skillName)
  const baseContent = await readOptionText(options.baseContent, options.baseFile, 'base content')
  const candidateContent = await readOptionText(options.candidateContent, options.candidateFile, 'candidate content')
  if (current === undefined || current.content !== baseContent || current.manifest.contentHash !== createContentHash(baseContent)) {
    throw new OperationError('stale-base', `Skill base is stale for ${options.skillName}`)
  }
  const proposal = createProposal({
    id: options.id,
    skillName: options.skillName,
    baseVersion: options.baseVersion ?? current.manifest.version,
    baseContent,
    proposedVersion: options.proposedVersion,
    candidateContent,
    intent: options.intent,
  })
  const staged = await service.stageProposal(proposal)
  const reportPath = options.reportPath ?? join(service.layout.proposalReportsDir, `${proposalRootId(staged.id)}.md`)
  await writeText(reportPath, renderProposalMarkdown({ proposal: staged }))
  return { proposal: staged, reportPath }
}

export async function evaluateProposal(service: EvolutionService, options: EvaluateProposalOptions): Promise<EvaluateProposalResult> {
  const proposal = await resolveProposal(service, options.proposalRef)
  if (proposal.status === 'proposed') assertTransition(proposal, 'evaluating')
  else if (proposal.status === 'evaluating') assertTransition(proposal, 'evaluated')
  else throw new OperationError('invalid-transition', `proposal ${proposal.id} cannot be evaluated from ${proposal.status}`)
  const current = await service.versions.readCurrent(proposal.skillName)
  if (current === undefined || current.manifest.contentHash !== proposal.expectedBase.contentHash) {
    throw new OperationError('stale-base', `proposal ${proposal.id} base no longer matches the current Skill`)
  }
  const cases = options.cases ?? await readJson<SkillEvaluationCase[]>(options.casesFile, 'evaluation cases')
  const result = await service.evaluate(proposal, cases, options.runner)
  const artifact = await findArtifact(service, result.artifactId)
  if (artifact === undefined) throw new OperationError('evaluation-missing', `evaluation artifact was not persisted for ${proposalRootId(proposal.id)}`)
  const evaluationPath = options.evaluationPath ?? join(service.layout.evaluationReportsDir, `${proposalRootId(proposal.id)}.json`)
  const evaluated = await latestProposal(service, proposalRootId(proposal.id))
  const reportPath = options.reportPath ?? join(service.layout.proposalReportsDir, `${proposalRootId(proposal.id)}.md`)
  await writeText(evaluationPath, `${JSON.stringify(artifact, null, 2)}\n`)
  await writeText(reportPath, renderProposalMarkdown({ proposal: evaluated, evaluation: result }))
  return { proposal: evaluated, recordId: evaluated.id, result, artifact, evaluationPath, reportPath }
}

export async function reviewProposal(service: EvolutionService, options: ReviewProposalOptions): Promise<ReviewProposalResult> {
  const proposal = await resolveProposal(service, options.proposalRef)
  const evidenceIds = options.evidenceIds ?? []
  let reviewed: SkillProposal
  switch (options.decision) {
    case 'accept': reviewed = await service.acceptProposal(proposal, options.reason, evidenceIds); break
    case 'reject': reviewed = await service.rejectProposal(proposal, options.reason, evidenceIds); break
    case 'defer': reviewed = await service.deferProposal(proposal, options.reason, evidenceIds); break
    default: throw new OperationError('invalid-option', `decision must be accept, reject, or defer`)
  }
  const recordId = ledgerRecordId(proposalRootId(reviewed.id), options.decision === 'accept' ? 'accepted' : options.decision === 'reject' ? 'rejected' : 'deferred')
  return { proposal: { ...reviewed, id: recordId }, recordId }
}

export async function promoteProposal(service: EvolutionService, options: PromoteProposalOptions): Promise<PromoteResult> {
  const scope = assertScope(options.scope)
  const proposal = await resolveProposal(service, options.proposalRef)
  if (proposal.status !== 'accepted') throw new OperationError('invalid-transition', `proposal ${proposal.id} must be accepted before promotion`)
  const artifact = options.evaluationPath === undefined
    ? resolvePromotionArtifact(await service.evaluations.readAll(), proposal, options.evaluation)
    : resolvePromotionArtifact(await service.evaluations.readAll(), proposal, await readEvaluationFile(options.evaluationPath))
  checkPromotion({ proposal, artifact, current: await service.versions.readCurrent(proposal.skillName), policyVersion: defaultPolicyVersion(service.evaluationPolicy as never), now: Date.now() })
  if (options.dryRun === true) return { dryRun: true, proposal, evaluation: artifact }
  await service.promote(proposal, artifact.result, scope, options.reason)
  return { promoted: true, skillName: proposal.skillName, version: proposal.proposedVersion, scope }
}

export async function rollbackSkill(service: EvolutionService, options: RollbackSkillOptions): Promise<RollbackSkillResult> {
  await service.rollback(options.skillName, options.version, options.reason)
  return { skillName: options.skillName, version: options.version }
}

async function resolveProposal(service: EvolutionService, reference: string): Promise<SkillProposal> {
  try {
    return findProposalById(await service.proposals.readAll(), reference)
  } catch (error) {
    if (error instanceof ProposalLedgerError) throw new OperationError(error.code, error.message, error)
    throw error
  }
}

async function latestProposal(service: EvolutionService, root: string): Promise<SkillProposal> {
  return resolveProposal(service, root)
}

async function readEvaluationFile(path: string): Promise<SkillEvalResult | EvaluationArtifact> {
  try { return JSON.parse(await readFile(path, 'utf8')) as SkillEvalResult | EvaluationArtifact } catch (error) { throw new OperationError('evaluation-missing', `evaluation artifact not found: ${path}`, error) }
}

async function findArtifact(service: EvolutionService, id: string | undefined): Promise<EvaluationArtifact | undefined> {
  if (id === undefined) return undefined
  return (await service.evaluations.readAll()).find(item => item.id === id)
}

function assertTransition(proposal: SkillProposal, target: Parameters<typeof assertCanTransition>[1]): void {
  try { assertCanTransition(proposal.status, target) } catch (error) {
    if (error instanceof ProposalLedgerError) throw new OperationError('invalid-transition', error.message, error)
    throw error
  }
}

function assertScope(value: unknown): PublicationScope {
  try { return assertPublicationScope(value) } catch (error) {
    if (error instanceof InvalidOptionError) throw new OperationError('invalid-option', error.message, error)
    throw error
  }
}

async function readOptionText(value: string | undefined, file: string | undefined, label: string): Promise<string> {
  if (value !== undefined && file !== undefined) throw new OperationError('invalid-option', `${label} cannot specify both content and file`)
  if (value !== undefined) return value
  if (file !== undefined) return readFile(file, 'utf8')
  throw new OperationError('invalid-option', `${label} is required`)
}

async function readJson<T>(path: string | undefined, label: string): Promise<T> {
  if (path === undefined) throw new OperationError('invalid-option', `${label} are required`)
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { throw new OperationError('invalid-option', `invalid ${label} file: ${path}`, error) }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}
