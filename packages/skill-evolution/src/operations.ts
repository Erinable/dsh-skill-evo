import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createContentHash } from './events.js'
import { DEFAULT_EVALUATION_POLICY, validateSkillCandidate, validateSkillDocument, type EvaluationRunner } from './evaluator.js'
import { assertCanTransition, findProposalById, ledgerRecordId, proposalRootId, ProposalLedgerError, createProposal } from './proposal.js'
import { renderProposalMarkdown } from './report.js'
import { EvolutionService } from './service.js'
import { assertPublicationScope, InvalidOptionError, type EvaluationArtifact, type EvaluationPolicy, type PublicationScope, type SkillEvalResult, type SkillEvaluationCase, type SkillProposal } from './types.js'

export type OperationErrorCode =
  | 'not-found'
  | 'ambiguous'
  | 'invalid-option'
  | 'stale-base'
  | 'invalid-transition'
  | 'evaluation-missing'
  | 'evaluation-mismatch'
  | 'gate-failed'

export class OperationError extends Error {
  constructor(readonly code: OperationErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'OperationError'
  }
}

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
  const reportPath = options.reportPath ?? join(options.root ?? serviceRoot(service), '.skill-evolution', 'proposals', `${proposalRootId(staged.id)}.md`)
  await writeText(reportPath, renderProposalMarkdown({ proposal: staged }))
  return { proposal: staged, reportPath }
}

export async function evaluateProposal(service: EvolutionService, options: EvaluateProposalOptions): Promise<EvaluateProposalResult> {
  const proposal = await resolveProposal(service, options.proposalRef)
  if (proposal.status === 'proposed') assertTransition(proposal, 'evaluating')
  else if (proposal.status === 'evaluating') assertTransition(proposal, 'evaluated')
  else throw new OperationError('invalid-transition', `proposal ${proposal.id} cannot be evaluated from ${proposal.status}`)
  const cases = options.cases ?? await readJson<SkillEvaluationCase[]>(options.casesFile, 'evaluation cases')
  const result = await service.evaluate(proposal, cases, options.runner)
  const artifact = await findArtifact(service, result.artifactId)
  if (artifact === undefined) throw new OperationError('evaluation-missing', `evaluation artifact was not persisted for ${proposalRootId(proposal.id)}`)
  const root = options.root ?? serviceRoot(service)
  const evaluationPath = options.evaluationPath ?? join(root, '.skill-evolution', 'evaluations', `${proposalRootId(proposal.id)}.json`)
  const evaluated = await latestProposal(service, proposalRootId(proposal.id))
  const reportPath = options.reportPath ?? join(root, '.skill-evolution', 'proposals', `${proposalRootId(proposal.id)}.md`)
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
  const artifact = await loadPromotionArtifact(service, proposal, options)
  await precheckPromotion(service, proposal, artifact)
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

async function loadPromotionArtifact(service: EvolutionService, proposal: SkillProposal, options: PromoteProposalOptions): Promise<EvaluationArtifact> {
  if (options.evaluationPath !== undefined) {
    let value: unknown
    try { value = JSON.parse(await readFile(options.evaluationPath, 'utf8')) } catch (error) { throw new OperationError('evaluation-missing', `evaluation artifact not found: ${options.evaluationPath}`, error) }
    return normalizeArtifact(value, proposal)
  }
  if (options.evaluation !== undefined) {
    if (isRecord(options.evaluation) && !('result' in options.evaluation)) {
      const persisted = await findArtifact(service, (options.evaluation as SkillEvalResult).artifactId)
      if (persisted !== undefined && sameEvaluation(options.evaluation as SkillEvalResult, persisted.result)) return persisted
    }
    return normalizeArtifact(options.evaluation, proposal)
  }
  const artifacts = (await service.evaluations.readAll())
    .filter(item => item.proposalId === proposalRootId(proposal.id) && Date.parse(item.expiresAt) > Date.now())
  const artifact = artifacts.at(-1)
  if (artifact === undefined) throw new OperationError('evaluation-missing', `no unexpired evaluation artifact for ${proposalRootId(proposal.id)}`)
  return artifact
}

function normalizeArtifact(value: unknown, proposal: SkillProposal): EvaluationArtifact {
  if (!isRecord(value)) throw new OperationError('evaluation-mismatch', 'evaluation artifact has an invalid shape')
  const result = isRecord(value.result) ? value.result as unknown as SkillEvalResult : value as unknown as SkillEvalResult
  const artifact = isRecord(value.result)
    ? value as unknown as EvaluationArtifact
    : { id: result.artifactId ?? '', proposalId: proposalRootId(proposal.id), candidateId: result.candidateId, baseVersion: proposal.baseVersion, baseContentHash: result.baseContentHash, candidateContentHash: result.candidateContentHash, caseIds: result.caseIds, policyVersion: result.policyVersion, passedGate: result.passedGate, createdAt: result.createdAt, expiresAt: new Date(Date.now() + 1).toISOString(), result }
  if (!artifact.id || !artifact.result || !artifact.proposalId) throw new OperationError('evaluation-mismatch', 'evaluation artifact is incomplete')
  return artifact
}

function sameEvaluation(left: SkillEvalResult, right: SkillEvalResult): boolean {
  return left.artifactId === right.artifactId
    && left.candidateId === right.candidateId
    && left.baseContentHash === right.baseContentHash
    && left.candidateContentHash === right.candidateContentHash
    && left.passedGate === right.passedGate
    && left.policyVersion === right.policyVersion
    && JSON.stringify([...left.caseIds]) === JSON.stringify([...right.caseIds])
}

async function precheckPromotion(service: EvolutionService, proposal: SkillProposal, artifact: EvaluationArtifact): Promise<void> {
  const root = proposalRootId(proposal.id)
  if (artifact.proposalId !== root || artifact.candidateId !== root || artifact.result.candidateId !== root) throw new OperationError('evaluation-mismatch', 'evaluation artifact belongs to a different proposal')
  const current = await service.versions.readCurrent(proposal.skillName)
  if (current === undefined || current.manifest.contentHash !== proposal.expectedBase.contentHash || artifact.baseContentHash !== proposal.expectedBase.contentHash) throw new OperationError('stale-base', `proposal ${proposal.id} base no longer matches the current Skill`)
  const candidateHash = createContentHash(proposal.candidateContent)
  if (artifact.candidateContentHash !== candidateHash || artifact.result.candidateContentHash !== candidateHash) throw new OperationError('evaluation-mismatch', 'evaluation artifact candidate does not match the proposal')
  const policy = serviceEvaluationPolicy(service)
  if (artifact.policyVersion !== policy.version || artifact.result.policyVersion !== policy.version) throw new OperationError('evaluation-mismatch', 'evaluation policy does not match the current policy')
  if (Date.parse(artifact.expiresAt) <= Date.now()) throw new OperationError('evaluation-mismatch', 'evaluation artifact has expired')
  if (JSON.stringify([...proposal.comparisonCaseIds]) !== JSON.stringify([...artifact.caseIds])) throw new OperationError('evaluation-mismatch', 'evaluation cases do not match the proposal')
  if (!artifact.passedGate || !artifact.result.passedGate) throw new OperationError('gate-failed', `proposal ${proposal.id} failed the evaluation gate`)
  const validation = validateSkillDocument(proposal.candidateContent, proposal.skillName)
  const change = validateSkillCandidate(current.content, proposal.candidateContent, proposal.skillName)
  if (!validation.valid || !change.valid) throw new OperationError('evaluation-mismatch', `candidate Skill is invalid: ${[...validation.errors, ...change.errors].join('; ')}`)
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

async function findArtifact(service: EvolutionService, id: string | undefined): Promise<EvaluationArtifact | undefined> {
  if (id === undefined) return undefined
  return (await service.evaluations.readAll()).find(item => item.id === id)
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

function serviceRoot(service: EvolutionService): string {
  return (service as unknown as { options: { root: string } }).options.root
}

function serviceEvaluationPolicy(service: EvolutionService): EvaluationPolicy {
  return (service as unknown as { options: { evaluationPolicy?: EvaluationPolicy } }).options.evaluationPolicy ?? DEFAULT_EVALUATION_POLICY
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
