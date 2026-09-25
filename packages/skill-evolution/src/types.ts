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
  readonly contentHash: string
}

export interface AdoptionCandidate {
  readonly proposalId: string
  readonly skill: SkillRef
  readonly expectedBase: AdoptionBase
  readonly target: 'explicit-only' | 'project' | 'user' | 'stable'
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
  readonly confidence: number
  readonly createdAt: string
}

export type FailureSeverity = 'low' | 'medium' | 'high'
export type FailureStatus = 'open' | 'clustered' | 'addressed' | 'ignored'

export interface SkillFailureCase {
  readonly id: string
  readonly usageId?: string
  readonly skillName: string
  readonly skillVersion?: string
  readonly task: string
  readonly failure: string
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

export interface SkillDiagnosis {
  readonly id: string
  readonly clusterId: string
  readonly rootCause: DiagnosisRootCause
  readonly hypothesis: string
  readonly supportingExperienceIds: readonly string[]
  readonly counterEvidence: readonly string[]
  readonly proposedOperation: ProposalOperation
  readonly confidence: 'low' | 'medium' | 'high'
  readonly createdAt: string
}

export type ProposalStatus = 'draft' | 'replayed' | 'observed' | 'accepted' | 'rejected' | 'deferred' | 'reverted'

export type ProposalSurface = 'description' | 'trigger' | 'procedure' | 'reference' | 'composition'

export interface SkillProposal {
  readonly id: string
  readonly skillName: string
  readonly diagnosisId?: string
  readonly clusterId?: string
  readonly evidenceEventIds?: readonly string[]
  readonly baseVersion: string
  readonly expectedBase: AdoptionBase
  readonly proposedVersion: string
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
}

export type DecisionAction = 'accepted' | 'rejected' | 'deferred' | 'promoted' | 'rollback' | 'reverted' | 'dormant' | 'retired' | 'restored'

export interface DecisionRecord {
  readonly id: string
  readonly proposalId?: string
  readonly skillName: string
  readonly action: DecisionAction
  readonly reason: string
  readonly evidenceIds: readonly string[]
  readonly createdAt: string
}

export type ArtifactLifecycleState = 'draft' | 'observed' | 'canary' | 'stable' | 'dormant' | 'retired'

export interface SkillManifest {
  readonly name: string
  readonly version: string
  readonly parentVersion?: string
  readonly contentHash: string
  readonly status: ArtifactLifecycleState
  readonly scope: 'explicit-only' | 'project' | 'user' | 'stable'
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
