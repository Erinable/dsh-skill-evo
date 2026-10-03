import { createContentHash } from './events.js'
import { DEFAULT_EVALUATION_POLICY, validateSkillCandidate, validateSkillDocument } from './evaluator.js'
import { proposalRootId } from './proposal.js'
import type { CurrentSkill } from './lifecycle.js'
import type { EvaluationArtifact, EvaluationPolicyInput, SkillEvalResult, SkillProposal } from './types.js'
import { normalizedPolicyHash } from './policy.js'
import { OperationError } from './errors.js'

export interface PromotionCheckInput {
  readonly proposal: SkillProposal
  readonly artifact: EvaluationArtifact
  readonly current: CurrentSkill | undefined
  readonly policyVersion: string
  readonly policy?: EvaluationPolicyInput
  readonly now: number
}

export function checkPromotion(input: PromotionCheckInput): void {
  const { proposal, artifact, current } = input
  const root = proposalRootId(proposal.id)
  if (proposal.status !== 'accepted') throw new OperationError('invalid-transition', `proposal ${proposal.id} must be accepted before promotion`)
  if (artifact.proposalId !== root || artifact.candidateId !== root || artifact.result.candidateId !== root) {
    throw new OperationError('evaluation-mismatch', 'evaluation artifact belongs to a different proposal')
  }
  if (current === undefined || current.manifest.contentHash !== proposal.expectedBase.contentHash || artifact.baseContentHash !== proposal.expectedBase.contentHash || (current.manifest.version !== 'unversioned' && current.manifest.version !== proposal.baseVersion)) {
    throw new OperationError('stale-base', `proposal ${proposal.id} base no longer matches the current Skill`)
  }
  const candidateHash = createContentHash(proposal.candidateContent)
  if (artifact.candidateContentHash !== candidateHash || artifact.result.candidateContentHash !== candidateHash) {
    throw new OperationError('evaluation-mismatch', 'evaluation artifact candidate does not match the proposal')
  }
  if (artifact.policyVersion !== input.policyVersion || artifact.result.policyVersion !== input.policyVersion) {
    throw new OperationError('evaluation-mismatch', 'evaluation policy does not match the current policy')
  }
  {
    const currentPolicy = input.policy ?? DEFAULT_EVALUATION_POLICY
    const currentHash = normalizedPolicyHash(currentPolicy)
    if ('schema' in currentPolicy && currentPolicy.schema === 2) {
      if (artifact.policyHash === undefined || artifact.result.policyHash !== currentHash || artifact.policyHash !== currentHash) throw new OperationError('evaluation-mismatch', 'evaluation policy hash does not match the current policy')
    } else if ((artifact.policyHash !== undefined && artifact.policyHash !== currentHash)
      || (artifact.result.policyHash !== undefined && artifact.result.policyHash !== currentHash)
      || (artifact.policyHash !== undefined && artifact.result.policyHash !== undefined && artifact.policyHash !== artifact.result.policyHash)) {
      throw new OperationError('evaluation-mismatch', 'evaluation policy hash does not match the current policy')
    }
  }
  if (Date.parse(artifact.expiresAt) <= input.now) throw new OperationError('evaluation-mismatch', 'evaluation artifact has expired')
  if (JSON.stringify([...proposal.comparisonCaseIds]) !== JSON.stringify([...artifact.caseIds])) {
    throw new OperationError('evaluation-mismatch', 'evaluation cases do not match the proposal')
  }
  if (!artifact.passedGate || !artifact.result.passedGate) throw new OperationError('gate-failed', `proposal ${proposal.id} failed the evaluation gate`)
  const validation = validateSkillDocument(proposal.candidateContent, proposal.skillName)
  const change = validateSkillCandidate(current.content, proposal.candidateContent, proposal.skillName)
  if (!validation.valid || !change.valid) throw new OperationError('evaluation-mismatch', `candidate Skill is invalid: ${[...validation.errors, ...change.errors].join('; ')}`)
}

export function resolvePromotionArtifact(
  evaluations: readonly EvaluationArtifact[],
  proposal: SkillProposal,
  supplied?: SkillEvalResult | EvaluationArtifact,
  now = Date.now(),
): EvaluationArtifact {
  const root = proposalRootId(proposal.id)
  if (supplied !== undefined) {
    const normalized = normalizeArtifact(supplied, proposal)
    const persisted = evaluations.find(item => item.id === normalized.id)
    if (persisted === undefined) throw new OperationError('evaluation-missing', `evaluation artifact not found: ${normalized.id}`)
    const matches = normalized.expiresAt === ''
      ? persisted.proposalId === root && sameResultEvidence(normalized.result, persisted.result)
      : sameArtifactEvidence(normalized, persisted)
    if (!matches) throw new OperationError('evaluation-mismatch', `supplied evaluation does not match the persisted artifact: ${normalized.id}`)
    return persisted
  }
  const artifact = evaluations.filter(item => item.proposalId === root && Date.parse(item.expiresAt) > now).at(-1)
  if (artifact === undefined) throw new OperationError('evaluation-missing', `proposal ${proposal.id} requires a persisted evaluation artifact`)
  return artifact
}

function normalizeArtifact(value: SkillEvalResult | EvaluationArtifact, proposal: SkillProposal): EvaluationArtifact {
  if (!isRecord(value)) throw new OperationError('evaluation-mismatch', 'evaluation artifact has an invalid shape')
  const candidate = value as Partial<EvaluationArtifact>
  if (candidate.result !== undefined) {
    if (!isRecord(candidate.result) || typeof candidate.id !== 'string' || typeof candidate.proposalId !== 'string') throw new OperationError('evaluation-mismatch', 'evaluation artifact has an invalid shape')
    return candidate as EvaluationArtifact
  }
  const result = value as SkillEvalResult
  if (result.artifactId === undefined) {
    if (result.candidateId === undefined) throw new OperationError('evaluation-mismatch', 'evaluation artifact has an invalid shape')
    throw new OperationError('evaluation-missing', `proposal ${proposal.id} requires a persisted evaluation artifact`)
  }
  return { id: result.artifactId, proposalId: proposalRootId(proposal.id), candidateId: result.candidateId, baseVersion: proposal.baseVersion, baseContentHash: result.baseContentHash, candidateContentHash: result.candidateContentHash, caseIds: result.caseIds, policyVersion: result.policyVersion, passedGate: result.passedGate, createdAt: result.createdAt, expiresAt: '', result, ...(result.schemaVersion === 2 ? { schemaVersion: 2 as const, policy: result.policy, policyHash: result.policyHash, statisticId: result.statisticId } : {}) }
}

function sameArtifactEvidence(left: EvaluationArtifact, right: EvaluationArtifact): boolean {
  return left.proposalId === right.proposalId && left.candidateId === right.candidateId && left.baseVersion === right.baseVersion && left.baseContentHash === right.baseContentHash && left.candidateContentHash === right.candidateContentHash && left.policyVersion === right.policyVersion && left.passedGate === right.passedGate && left.expiresAt === right.expiresAt && (left.policyHash === undefined || right.policyHash === undefined || left.policyHash === right.policyHash) && JSON.stringify([...left.caseIds]) === JSON.stringify([...right.caseIds]) && sameResultEvidence(left.result, right.result)
}

function sameResultEvidence(left: SkillEvalResult, right: SkillEvalResult): boolean {
  return left.candidateId === right.candidateId && left.baseContentHash === right.baseContentHash && left.candidateContentHash === right.candidateContentHash && left.passedGate === right.passedGate && left.policyVersion === right.policyVersion && (left.policyHash === undefined || right.policyHash === undefined || left.policyHash === right.policyHash) && JSON.stringify([...left.caseIds]) === JSON.stringify([...right.caseIds])
}

export const defaultPolicyVersion = (policy: EvaluationPolicyInput | undefined): string => (policy ?? DEFAULT_EVALUATION_POLICY).version

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
