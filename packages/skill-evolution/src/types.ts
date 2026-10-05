import type { EvaluationCostReport, EvaluationSample } from './evaluation-cost.js'

export interface SkillRef {
  readonly name: string
  readonly provider: string
  readonly source: string
  readonly path?: string
  readonly version?: string
  readonly contentHash?: string
  readonly resourceHash?: string
}

export type ObservationKind =
  | 'catalog-visible'
  | 'skill-load-requested'
  | 'skill-loaded'
  | 'skill-load-failed'
  | 'agent-step'
  | 'tool-result'
  | 'context-shadowed'
  | 'user-follow-up'
  | 'task-finished'
  | 'skill-file-observed'
  | 'adoption-applied'

export interface RuntimeObservation {
  readonly id: string
  readonly schemaVersion: 1
  readonly kind: ObservationKind
  readonly occurredAt: string
  readonly sessionId?: string
  readonly taskId?: string
  readonly agentId?: string
  readonly scope?: string
  readonly cwd?: string
  readonly skill?: SkillRef
  readonly correlationIds: readonly string[]
  readonly payload: Readonly<Record<string, unknown>>
  readonly source: 'runtime' | 'filesystem' | 'user' | 'maintenance'
}

export interface ExposureView {
  readonly skill: SkillRef
  readonly catalogVisible: boolean
  readonly loadRequested: boolean
  readonly loadSucceeded: boolean
  readonly loadFailed: boolean
  readonly followUpObservationIds: readonly string[]
  readonly observationIds: readonly string[]
}

export interface AdoptionBase {
  readonly name: string
  /** `absent` is the explicit base sentinel for create-skill proposals. */
  readonly contentHash: string | 'absent'
}

export interface AdoptionCandidate {
  readonly proposalId: string
  readonly skill: SkillRef
  readonly expectedBase: AdoptionBase
  readonly target: PublicationScope
  readonly effectiveAt: 'next-load' | string
}

export interface AdoptionContext {
  readonly current: SkillRef
}

export interface AdoptionValidation {
  readonly ok: true
  readonly candidate: AdoptionCandidate
}

export type ExperienceOutcome = 'helpful' | 'harmful' | 'neutral' | 'unknown'

export type Attribution =
  | 'routing'
  | 'content'
  | 'composition'
  | 'model'
  | 'tool'
  | 'task-change'
  | 'not-attributable'
  | 'unknown'

export interface Experience {
  readonly id: string
  readonly taskCluster: string
  readonly contextSummary: string
  readonly relevantSkillVersions: readonly string[]
  readonly observedPattern: string
  readonly evidenceEventIds: readonly string[]
  readonly outcome: ExperienceOutcome
  readonly attribution: Attribution
  /** Evidence strength score in [0, 1], not a calibrated probability. */
  readonly confidence: number
  readonly createdAt: string
}

export type FailureSeverity = 'low' | 'medium' | 'high'
export type FailureStatus = 'open' | 'clustered' | 'addressed' | 'ignored'
export type FailureOrigin = 'load-failure' | 'implicit-follow-up' | 'explicit-feedback'

export interface SkillFailureCase {
  readonly id: string
  readonly usageId?: string
  readonly skillName: string
  readonly skillVersion?: string
  readonly task: string
  readonly failure: string
  /** Structured provenance for this generated failure case. */
  readonly origin: FailureOrigin
  readonly sessionId?: string
  readonly feedbackKind?: FeedbackKind
  readonly followUpId?: string
  readonly intent?: FollowUpIntent
  readonly intentSource?: 'explicit' | 'classifier' | 'rule'
  readonly attribution?: Attribution
  readonly attributionSource?: 'override' | 'tool'
  readonly attributionConfidence?: number
  readonly counterEvidence?: readonly string[]
  readonly evidenceEventIds: readonly string[]
  readonly severity: FailureSeverity
  readonly createdAt: string
  readonly status: FailureStatus
}

export interface FailureCluster {
  readonly id: string
  readonly skillName: string
  readonly signature: string
  readonly caseIds: readonly string[]
  readonly occurrenceCount: number
  readonly createdAt: string
  readonly status: 'open' | 'diagnosed' | 'addressed' | 'ignored'
}

export type DiagnosisRootCause =
  | 'routing'
  | 'content'
  | 'boundary'
  | 'reference'
  | 'composition'
  | 'not-skill'
  | 'uncertain'

export type ProposalOperation = 'edit-metadata' | 'patch-content' | 'split' | 'merge' | 'retire' | 'observe-only'
  | 'create-skill'

export interface SkillDiagnosis {
  readonly id: string
  readonly clusterId: string
  readonly rootCause: DiagnosisRootCause
  readonly hypothesis: string
  readonly supportingExperienceIds: readonly string[]
  readonly counterEvidence: readonly string[]
  readonly proposedOperation: ProposalOperation
  /** Evidence strength band, not a calibrated probability or a release gate. */
  readonly confidence: 'low' | 'medium' | 'high'
  readonly createdAt: string
}

export type ProposalStatus = 'draft' | 'proposed' | 'evaluating' | 'evaluated' | 'replayed' | 'observed' | 'accepted' | 'rejected' | 'deferred' | 'promoted' | 'rolled-back' | 'reverted'

export type ProposalSurface = 'description' | 'trigger' | 'procedure' | 'reference' | 'composition'

export interface SkillProposal {
  readonly id: string
  readonly previousRecordId?: string
  readonly skillName: string
  readonly diagnosisId?: string
  readonly clusterId?: string
  readonly evidenceEventIds?: readonly string[]
  readonly baseVersion: string
  readonly expectedBase: AdoptionBase
  readonly proposedVersion: string
  /** The lifecycle operation represented by this proposal. */
  readonly operation?: ProposalOperation
  /** Pattern provenance retained on pattern-derived proposals. */
  readonly source?: ProposalSource
  readonly candidateContent: string
  readonly diff: string
  readonly intent: string
  readonly changedSurfaces: readonly ProposalSurface[]
  readonly addressedExperienceIds: readonly string[]
  readonly knownRisks: readonly string[]
  readonly comparisonCaseIds: readonly string[]
  readonly generatedBy: 'designer' | 'human'
  readonly status: ProposalStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProposalSource {
  readonly kind: 'pattern' | 'cluster'
  readonly patternId?: string
  readonly signatureKey?: string
  readonly episodeIds?: readonly string[]
  readonly evidenceEventIds?: readonly string[]
  readonly targetReason?: 'promoted' | 'explicit' | 'majority-loaded' | 'similarity' | 'create-skill' | 'ambiguous'
  readonly targetCandidates?: readonly string[]
}

export type EvaluationCategory = 'original-failure' | 'historical-success' | 'boundary'

export interface SkillEvaluationCase {
  readonly id: string
  readonly category: EvaluationCategory
  readonly task: string
  readonly severity?: FailureSeverity
  readonly expected?: {
    readonly contains?: readonly string[]
    readonly excludes?: readonly string[]
  }
}

export interface CaseEvaluation {
  readonly caseId: string
  readonly category: EvaluationCategory
  readonly passed: boolean
  readonly status: 'passed' | 'failed' | 'unknown'
  readonly reason: string
  readonly evidence: readonly string[]
  readonly durationMs: number
}

export interface SkillEvalResult {
  readonly candidateId: string
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly unknown: number
  readonly categories: Readonly<Record<EvaluationCategory, { readonly total: number; readonly passed: number; readonly failed: number }>>
  readonly baseline: Readonly<Record<EvaluationCategory, { readonly total: number; readonly passed: number }>>
  readonly regressions: readonly string[]
  readonly gateReasons: readonly string[]
  readonly caseResults: readonly CaseEvaluation[]
  readonly durationMs: number
  readonly schemaValid: boolean
  readonly invocationPolicyUnchanged: boolean
  readonly passedGate: boolean
  readonly decision: 'passed' | 'needs-review' | 'rejected'
  readonly policyVersion: string
  readonly schemaVersion?: 2
  readonly policy?: NormalizedEvaluationPolicy
  readonly policyHash?: string
  readonly statisticId?: string
  readonly artifactId?: string
  readonly baseContentHash: string
  readonly candidateContentHash: string
  readonly caseIds: readonly string[]
  readonly createdAt: string
  readonly cost?: EvaluationCostReport
  readonly samples?: readonly EvaluationSample[]
}

/** Persisted evaluation evidence that promotion is allowed to consume. */
export interface EvaluationArtifact {
  readonly id: string
  readonly proposalId: string
  readonly candidateId: string
  readonly baseVersion: string
  readonly baseContentHash: string
  readonly candidateContentHash: string
  readonly caseIds: readonly string[]
  readonly policyVersion: string
  readonly passedGate: boolean
  readonly createdAt: string
  readonly expiresAt: string
  readonly result: SkillEvalResult
  readonly schemaVersion?: 2
  readonly policy?: NormalizedEvaluationPolicy
  readonly policyHash?: string
  readonly statisticId?: string
}

export interface EvaluationPolicy {
  readonly version: string
  readonly maxRegressionCount: number
  readonly maxSecurityViolations: number
  readonly maxTokenIncreaseRatio?: number
  readonly maxContextIncreaseRatio?: number
  readonly requireNoNewSideEffects: boolean
  readonly requirePositiveFeedback?: boolean
  readonly requireOriginalFailureImprovement: boolean
}

export interface EvaluationPolicyV2 {
  readonly schema: 2
  readonly version: string
  readonly maxRegressionCount: number
  readonly maxSecurityViolations: number
  readonly requireNoNewSideEffects: boolean
  readonly requirePositiveFeedback?: boolean
  readonly sampling?: { readonly runs?: number }
  readonly significance?: { readonly alpha?: number }
  readonly originalFailure?: {
    readonly requireImprovement?: boolean
    readonly costMetric?: 'steps' | 'tokens' | 'steps-or-tokens' | 'steps-and-tokens' | null
    readonly minCostReduction?: number
  }
  readonly historicalSuccess?: {
    readonly maxPassRateDrop?: number
    readonly maxStepIncrease?: number | null
    readonly maxTokenIncrease?: number | null
  }
  readonly context?: {
    readonly maxCatalogIncreaseTokens?: number | null
    readonly maxLoadIncreaseTokens?: number | null
  }
}

export type EvaluationPolicyInput = EvaluationPolicy | EvaluationPolicyV2

export interface NormalizedEvaluationPolicy {
  readonly schema: 1 | 2
  readonly version: string
  readonly maxRegressionCount: number
  readonly maxSecurityViolations: number
  readonly requireNoNewSideEffects: boolean
  readonly requirePositiveFeedback: boolean
  readonly sampling: { readonly runs: number }
  readonly significance: { readonly alpha: number }
  readonly originalFailure: {
    readonly requireImprovement: boolean
    readonly costMetric: 'steps' | 'tokens' | 'steps-or-tokens' | 'steps-and-tokens' | null
    readonly minCostReduction: number
  }
  readonly historicalSuccess: {
    readonly maxPassRateDrop: number
    readonly maxStepIncrease: number | null
    readonly maxTokenIncrease: number | null
  }
  readonly context: {
    readonly maxCatalogIncreaseTokens: number | null
    readonly maxLoadIncreaseTokens: number | null
  }
  readonly legacy: {
    readonly maxTokenIncreaseRatio?: number
    readonly maxContextIncreaseRatio?: number
  }
}

export interface ProposalComparison {
  readonly proposalId: string
  readonly caseId: string
  readonly exposure: 'base' | 'candidate'
  readonly observedOutcome: 'improved' | 'regressed' | 'unchanged' | 'unknown'
  readonly evidence: readonly string[]
  readonly confidence: 'low' | 'medium' | 'high'
  readonly toolCalls: number
  readonly tokenCost?: number
  readonly sideEffects: readonly string[]
  readonly securityViolations: readonly string[]
  readonly timedOut: boolean
}

export type DecisionAction = 'proposed' | 'evaluating' | 'evaluated' | 'accepted' | 'rejected' | 'deferred' | 'promoted' | 'rollback' | 'reverted' | 'dormant' | 'retired' | 'restored'

export interface DecisionRecord {
  readonly id: string
  readonly recordId?: string
  readonly proposalId?: string
  readonly skillName: string
  readonly action: DecisionAction
  readonly reason: string
  readonly evidenceIds: readonly string[]
  readonly actor?: string
  readonly fromStatus?: ProposalStatus
  readonly toStatus?: ProposalStatus
  readonly baseContentHash?: string
  readonly candidateContentHash?: string
  readonly policyVersion?: string
  readonly policyHash?: string
  readonly createdAt: string
}

export type ArtifactLifecycleState = 'draft' | 'observed' | 'canary' | 'stable' | 'dormant' | 'retired'

export interface SkillManifest {
  readonly name: string
  readonly version: string
  readonly parentVersion?: string
  readonly contentHash: string
  readonly status: ArtifactLifecycleState
  readonly scope: PublicationScope
  readonly createdBy: 'human' | 'evolution-agent' | 'mixed'
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PortfolioEntry {
  readonly name: string
  readonly state: ArtifactLifecycleState
  readonly relatedSkills: readonly string[]
  readonly description?: string
  readonly usageCount: number
  readonly contextCost: number
  readonly updatedAt: string
}

export const PUBLICATION_SCOPES = ['explicit-only', 'project', 'user', 'stable'] as const
export type PublicationScope = typeof PUBLICATION_SCOPES[number]

export const FEEDBACK_KINDS = ['incorrect', 'constraint', 'retry', 'dissatisfied', 'satisfied', 'goal-changed', 'other'] as const
export type FeedbackKind = typeof FEEDBACK_KINDS[number]
export const FOLLOW_UP_INTENTS = ['incorrect', 'constraint', 'retry', 'dissatisfied', 'satisfied', 'goal-changed', 'other', 'not-attributable', 'unknown'] as const
export type FollowUpIntent = typeof FOLLOW_UP_INTENTS[number]
export interface ObservationDigest { readonly kind: ObservationKind; readonly skillName?: string; readonly toolName?: string; readonly failed?: true }
export interface FollowUpClassificationInput { readonly observationId: string; readonly text?: string; readonly skillName?: string; readonly before: readonly ObservationDigest[]; readonly after: readonly ObservationDigest[] }
export interface FollowUpClassifier { readonly version: string; classify(input: FollowUpClassificationInput, signal: AbortSignal): Promise<{ readonly intent: Exclude<FollowUpIntent, 'other'>; readonly confidence: number; readonly rationale?: string }> }
export interface CorrectionClassifierInput { readonly sessionId: string; readonly attempts: readonly ToolAttempt[] }
export interface CorrectionClassifier { readonly version: string; classify(input: CorrectionClassifierInput, signal: AbortSignal): Promise<readonly EpisodeDraft[]> }
export interface ClassificationMemoEntry { readonly id: string; readonly classifierVersion: string; readonly inputHash: string; readonly observationId: string; readonly intent: Exclude<FollowUpIntent, 'other'>; readonly confidence: number; readonly rationale?: string; readonly createdAt: string; readonly judge?: 'follow-up' }
export interface CorrectionClassificationMemoEntry { readonly id: string; readonly judge: 'correction'; readonly classifierVersion: string; readonly inputHash: string; readonly sessionId: string; readonly drafts: readonly EpisodeDraft[]; readonly createdAt: string }
export type ClassificationMemo = ClassificationMemoEntry | CorrectionClassificationMemoEntry

export interface ToolAttempt {
  readonly sessionId: string
  readonly sessionSeq?: number
  readonly callObservationId: string
  readonly resultObservationId?: string
  readonly occurredAt: string
  readonly toolName: string
  readonly command?: string
  readonly argKeys: readonly string[]
  readonly outcome: 'failure' | 'success' | 'unknown'
  readonly exitCode?: number
  readonly signal?: string
  readonly timedOut?: boolean
  readonly errorLine?: string
}
export interface EpisodeDraft { readonly intent: string; readonly errorSignature: string; readonly correction: readonly string[]; readonly failureObservationIds: readonly string[]; readonly correctionObservationIds: readonly string[]; readonly successObservationId: string }
export interface CorrectionEpisode extends EpisodeDraft { readonly id: string; readonly sessionId: string; readonly taskId?: string; readonly signatureKey: string; readonly environmental: boolean; readonly retryOnly: boolean; readonly loadedSkills: readonly string[]; readonly occurredAt: string; readonly recognizerVersion: string; readonly fallbackFrom?: string; readonly fallbackReason?: 'not-classified'; readonly inputHash: string; readonly createdAt: string }
export interface CorrectionPattern { readonly id: string; readonly signatureKey: string; readonly intent: string; readonly errorSignature: string; readonly correction: readonly string[]; readonly environmental: boolean; readonly retryOnly: boolean; readonly occurrences: readonly { readonly episodeId: string; readonly sessionId: string; readonly occurredAt: string }[]; readonly totalSessionCount: number; readonly firstSeenAt: string; readonly lastSeenAt: string; readonly policyVersion: string }
export interface FollowUpResolution {
  readonly id: string; readonly observationId: string; readonly sessionId?: string; readonly skillName?: string; readonly intent: FollowUpIntent; readonly confidence: number
  readonly source: 'explicit' | 'classifier' | 'rule'; readonly version: string; readonly ruleId?: string; readonly fallbackReason?: 'no-classifier' | 'not-classified'; readonly inputHash?: string
  readonly attribution: Attribution; readonly attributionSource: 'override' | 'tool' | 'intent'; readonly policyVersion: string; readonly evidenceEventIds: readonly string[]
}

export class InvalidOptionError extends Error {
  readonly code = 'invalid-option'

  constructor(readonly option: string, readonly value: unknown, allowed: readonly string[]) {
    super(`${option} must be one of: ${allowed.join(', ')}`)
    this.name = 'InvalidOptionError'
  }
}

export function assertPublicationScope(value: unknown): PublicationScope {
  if (typeof value === 'string' && (PUBLICATION_SCOPES as readonly string[]).includes(value)) return value as PublicationScope
  throw new InvalidOptionError('scope', value, PUBLICATION_SCOPES)
}

export function assertFeedbackKind(value: unknown): FeedbackKind {
  if (typeof value === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(value)) return value as FeedbackKind
  throw new InvalidOptionError('feedback kind', value, FEEDBACK_KINDS)
}

export interface FeedbackRecord {
  readonly id: string
  readonly sessionId: string
  readonly skillName?: string
  readonly skillVersion?: string
  readonly correlationIds: readonly string[]
  readonly stepId?: string
  readonly toolCallId?: string
  readonly kind: FeedbackKind
  readonly attribution?: Attribution
  readonly attributionStatus: 'pending' | 'accepted' | 'rejected' | 'unknown'
  readonly attributedBy: 'rule' | 'human' | 'evaluator' | 'model'
  readonly confidence?: number
  readonly note: string
  readonly createdAt: string
  readonly source: 'user' | 'maintainer'
}

export class StaleAdoptionBaseError extends Error {
  readonly code = 'STALE_ADOPTION_BASE'

  constructor(
    readonly expected: AdoptionBase,
    readonly actual: SkillRef,
  ) {
    super(`skill "${expected.name}" changed since proposal base ${expected.contentHash}`)
    this.name = 'StaleAdoptionBaseError'
  }
}
