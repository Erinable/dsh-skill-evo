import { join } from 'node:path'
import { createContentHash, isObservationValue, redactSensitiveText } from './events.js'
import { fingerprintOf, ObservationLog, readCursor, resolveLayout, writeCursor } from './state-root.js'
import { JsonlRecordStore } from './records.js'
import { EvolutionWorkflow, type Designer } from './workflow.js'
import { DEFAULT_EVALUATION_POLICY, evaluateCandidate, type EvaluateCandidateInput, type EvaluationRunner } from './evaluator.js'
import { validateEvaluationPolicy } from './policy.js'
import { assertCanTransition, latestProposalsByRoot, ledgerRecordId, proposalRootId, transitionProposal } from './proposal.js'
import { SkillVersionStore } from './lifecycle.js'
import { aggregateMetrics, type EvolutionMetrics } from './metrics.js'
import { repairEvolutionRoot, repairJsonlFileUnlocked, type EvolutionRepairReport, type JsonlRepairResult } from './repair.js'
import { inspectJsonlHealth, type JsonlHealth } from './health.js'
import { withLock } from './locking.js'
import { archivePaths } from './state-root.js'
import { assertFeedbackKind, assertPublicationScope } from './types.js'
import type { ClassificationMemoEntry, FollowUpClassifier } from './types.js'
import { OperationError } from './errors.js'
import { checkPromotion, defaultPolicyVersion, resolvePromotionArtifact } from './promotion-check.js'
import type {
  DecisionRecord,
  FeedbackKind,
  FeedbackRecord,
  Experience,
  FailureCluster,
  RuntimeObservation,
  SkillEvalResult,
  SkillEvaluationCase,
  SkillDiagnosis,
  SkillFailureCase,
  SkillProposal,
  EvaluationPolicyInput,
  Attribution,
  EvaluationArtifact,
  PublicationScope,
} from './types.js'

export interface EvolutionServiceOptions {
  readonly root: string
  readonly store?: string
  readonly invalidate?: (skillName: string, scope: Exclude<PublicationScope, 'explicit-only'>) => void | Promise<void>
  readonly evaluationPolicy?: EvaluationPolicyInput
  readonly operator?: string
  readonly evaluationTtlMs?: number
  readonly followUpClassifier?: FollowUpClassifier
  readonly classifierTimeoutMs?: number
}

/** Maintainer-facing service for the full observe → diagnose → evaluate → publish loop. */
export class EvolutionService {
  readonly observations: ObservationLog
  readonly proposals: JsonlRecordStore<SkillProposal>
  readonly decisions: JsonlRecordStore<DecisionRecord>
  readonly experiences: JsonlRecordStore<Experience>
  readonly failures: JsonlRecordStore<SkillFailureCase>
  readonly clusters: JsonlRecordStore<FailureCluster>
  readonly diagnoses: JsonlRecordStore<SkillDiagnosis>
  readonly classifications: JsonlRecordStore<ClassificationMemoEntry>
  readonly followUps: JsonlRecordStore<import('./types.js').FollowUpResolution>
  readonly feedback: JsonlRecordStore<FeedbackRecord>
  readonly evaluations: JsonlRecordStore<EvaluationArtifact>
  readonly versions: SkillVersionStore
  readonly evaluationPolicy: EvaluationPolicyInput | undefined
  private readonly projectionCursorPath: string
  readonly layout: ReturnType<typeof resolveLayout>
  readonly followUpClassifier: FollowUpClassifier | undefined
  readonly classifierTimeoutMs: number

  constructor(private readonly options: EvolutionServiceOptions) {
    this.evaluationPolicy = options.evaluationPolicy
    this.followUpClassifier = options.followUpClassifier
    this.classifierTimeoutMs = options.classifierTimeoutMs ?? 10_000
    this.layout = resolveLayout({ root: options.root, observationStore: options.store })
    this.projectionCursorPath = this.layout.cursorPath
    const path = (name: string) => this.layout.stores.find(store => store.name === name)!.path
    this.observations = new ObservationLog(this.layout.observations.path)
    this.proposals = new JsonlRecordStore(path('proposals'))
    this.decisions = new JsonlRecordStore(path('decisions'))
    this.experiences = new JsonlRecordStore(path('experiences'))
    this.failures = new JsonlRecordStore(path('failures'))
    this.clusters = new JsonlRecordStore(path('clusters'))
    this.diagnoses = new JsonlRecordStore(path('diagnoses'))
    this.classifications = new JsonlRecordStore(path('classifications'))
    this.followUps = new JsonlRecordStore(path('follow-ups'))
    this.feedback = new JsonlRecordStore(path('feedback'))
    this.evaluations = new JsonlRecordStore(path('evaluations'))
    this.versions = new SkillVersionStore(options.root, { invalidate: options.invalidate, layout: this.layout })
  }

  async recordObservation(event: RuntimeObservation): Promise<boolean> {
    return this.observations.append(event)
  }

  async recordFeedback(input: {
    readonly sessionId: string
    readonly skillName?: string
    readonly skillVersion?: string
    readonly correlationIds?: readonly string[]
    readonly stepId?: string
    readonly toolCallId?: string
    readonly kind: FeedbackKind
    readonly attribution?: Attribution
    readonly attributionStatus?: FeedbackRecord['attributionStatus']
    readonly attributedBy?: FeedbackRecord['attributedBy']
    readonly confidence?: number
    readonly note: string
    readonly source?: 'user' | 'maintainer'
  }): Promise<FeedbackRecord> {
    const kind = assertFeedbackKind(input.kind)
    const note = redactSensitiveText(input.note.trim())
    if (note.length === 0) throw new Error('feedback note must not be empty')
    const record: FeedbackRecord = {
      id: `feedback:${input.sessionId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      sessionId: input.sessionId,
      ...(input.skillName === undefined ? {} : { skillName: input.skillName }),
      ...(input.skillVersion === undefined ? {} : { skillVersion: input.skillVersion }),
      correlationIds: [...input.correlationIds ?? []],
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      kind,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
      attributionStatus: input.attributionStatus ?? (input.attribution === undefined ? 'pending' : 'accepted'),
      attributedBy: input.attributedBy ?? (input.source === 'user' ? 'rule' : 'human'),
      ...(input.confidence === undefined ? {} : { confidence: Math.max(0, Math.min(1, input.confidence)) }),
      note,
      createdAt: new Date().toISOString(),
      source: input.source ?? 'maintainer',
    }
    await this.feedback.append(record)
    await this.observations.append({
      id: record.id,
      schemaVersion: 1,
      kind: 'user-follow-up',
      occurredAt: record.createdAt,
      sessionId: record.sessionId,
      ...(record.skillName === undefined ? {} : { skill: { name: record.skillName, provider: 'unknown', source: 'feedback', ...(record.skillVersion === undefined ? {} : { contentHash: record.skillVersion }) } }),
      correlationIds: [...record.correlationIds],
      payload: { feedbackKind: record.kind, text: record.note, explicit: true, ...(record.stepId === undefined ? {} : { stepId: record.stepId }), ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }), attributionStatus: record.attributionStatus, attributedBy: record.attributedBy, ...(record.attribution === undefined ? {} : { attributionOverride: record.attribution }), ...(record.confidence === undefined ? {} : { attributionConfidence: record.confidence }) },
      source: 'user',
    })
    return record
  }

  async listFailures(): Promise<SkillFailureCase[]> {
    return [...(await this.refreshDerived()).failures]
  }

  async metrics(): Promise<EvolutionMetrics> {
    const snapshot = await this.refreshDerived()
    return aggregateMetrics(await this.observations.readAll(), await this.proposals.readAll(), await this.decisions.readAll(), snapshot.followUps)
  }

  async health(): Promise<readonly JsonlHealth[]> {
    const reports = await Promise.all(this.layout.stores.map(store => inspectJsonlHealth(
      store.path,
      store.name === 'observations' ? { parse: isObservationValue } : {},
    )))
    const archives = await archivePaths(this.layout.observations.path)
    const archiveReports = await Promise.all(archives.map(path => inspectJsonlHealth(path, { parse: isObservationValue, requireTrailingNewline: true })))
    return [...reports, ...archiveReports]
  }

  async healthReport(): Promise<{ readonly jsonl: readonly JsonlHealth[]; readonly skillIssues: readonly string[] }> {
    return { jsonl: await this.health(), skillIssues: await this.versions.healthIssues() }
  }

  async repair(): Promise<EvolutionRepairReport> {
    const paths = this.layout.stores.filter(store => store.name !== 'observations').map(store => store.path)
    const jsonl: JsonlRepairResult[] = []
    const report = await repairEvolutionRoot(this.options.root, { jsonlPaths: paths, observationsPath: this.observations.filePath, layout: this.layout })
    await withLock(`${this.observations.filePath}.lock`, 'repair', async () => {
      jsonl.push(await repairJsonlFileUnlocked(this.observations.filePath, { parse: isObservationValue }))
      for (const path of await archivePaths(this.observations.filePath)) {
        jsonl.push(await repairJsonlFileUnlocked(path, { parse: isObservationValue }))
      }
    })
    await this.refreshDerived({ force: true })
    return { ...report, jsonl: [...jsonl, ...report.jsonl], projectionCursorRebuilt: true }
  }

  async proposeChange(clusterId: string, designer: Designer): Promise<SkillProposal> {
    await this.refreshDerived()
    const workflow = new EvolutionWorkflow()
    workflow.add(await this.observations.readAll())
    const proposal = await workflow.propose(clusterId, designer)
    return this.stageProposal(proposal)
  }

  async stageProposal(proposal: SkillProposal): Promise<SkillProposal> {
    if (proposal.status !== 'draft') throw new Error(`stageProposal requires draft status, got ${proposal.status}`)
    const existing = (await this.proposals.readAll()).find(item => item.id === proposal.id)
    if (existing !== undefined) {
      if (existing.candidateContent !== proposal.candidateContent || existing.expectedBase.contentHash !== proposal.expectedBase.contentHash) throw new Error(`proposal ${proposal.id} already exists with different content`)
      return existing
    }
    const proposed = transitionProposal(proposal, 'proposed')
    await this.versions.writeCandidate(proposed)
    await this.proposals.append(proposed)
    if (proposal.status === 'draft') await this.recordDecision(proposed, 'proposed', 'draft', 'proposed', 'candidate created')
    return proposed
  }

  async evaluate(
    proposal: SkillProposal,
    cases: readonly SkillEvaluationCase[],
    runner?: EvaluationRunner,
  ): Promise<SkillEvalResult> {
    const targetStatus = proposal.status === 'proposed' ? 'evaluating' : 'evaluated'
    assertCanTransition(proposal.status, targetStatus)
    const evaluating = targetStatus === 'evaluating' ? transitionProposal(proposal, 'evaluating') : proposal
    const proposalId = proposalRootId(proposal.id)
    if (evaluating !== proposal) {
      await this.proposals.append({ ...evaluating, id: ledgerRecordId(proposalId, 'evaluating') })
      await this.recordDecision(evaluating, 'evaluating', proposal.status, 'evaluating', 'evaluation started')
    }
    const current = await this.versions.readCurrent(proposal.skillName)
    if (current === undefined) throw new Error(`cannot evaluate without a current Skill: ${proposal.skillName}`)
    if (current.manifest.contentHash !== proposal.expectedBase.contentHash) throw new Error(`proposal ${proposal.id} base no longer matches the current Skill`)
    if (this.options.evaluationPolicy !== undefined) validateEvaluationPolicy(this.options.evaluationPolicy)
    const input: EvaluateCandidateInput = {
      candidateId: proposalId,
      baseContent: current.content,
      candidateContent: proposal.candidateContent,
      cases,
      runner,
      expectedSkillName: proposal.skillName,
      policy: this.options.evaluationPolicy,
    }
    validateEvaluationCases(cases)
    const result = await evaluateCandidate(input)
    const artifactId = `evaluation:${proposalId}:${result.candidateContentHash}:${Date.now()}`
    const expiresAt = new Date(Date.now() + (this.options.evaluationTtlMs ?? 7 * 86_400_000)).toISOString()
    const persistedResult: SkillEvalResult = { ...result, artifactId }
    await this.evaluations.append({
      id: artifactId,
      proposalId,
      candidateId: proposalId,
      baseVersion: proposal.baseVersion,
      baseContentHash: result.baseContentHash,
      candidateContentHash: result.candidateContentHash,
      caseIds: [...result.caseIds],
      policyVersion: result.policyVersion,
      passedGate: result.passedGate,
      createdAt: result.createdAt,
      expiresAt,
      result: persistedResult,
    })
    const evaluated = { ...transitionProposal(evaluating, 'evaluated'), comparisonCaseIds: [...result.caseIds] }
    await this.proposals.append({ ...evaluated, id: ledgerRecordId(proposalId, 'evaluated') })
    await this.recordDecision(evaluated, 'evaluated', evaluating.status, 'evaluated', 'evaluation completed', result.policyVersion, result.caseResults.map(item => item.caseId))
    return persistedResult
  }

  async acceptProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    assertCanTransition(proposal.status, 'accepted')
    const accepted = transitionProposal(proposal, 'accepted')
    const proposalId = proposalRootId(proposal.id)
    await this.proposals.append({ ...accepted, id: ledgerRecordId(proposalId, 'accepted') })
    await this.recordDecision(accepted, 'accepted', proposal.status, 'accepted', reason, undefined, evidenceIds)
    return accepted
  }

  async promote(
    proposal: SkillProposal,
    evaluation: SkillEvalResult,
    scope: PublicationScope,
    reason = 'evaluation gate passed',
  ): Promise<void> {
    assertPublicationScope(scope)
    if (proposal.status !== 'accepted') throw new OperationError('invalid-transition', `proposal ${proposal.id} must be accepted before promotion`)
    const artifact = resolvePromotionArtifact(await this.evaluations.readAll(), proposal, evaluation)
    const current = await this.versions.readCurrent(proposal.skillName)
    checkPromotion({ proposal, artifact, current, policyVersion: defaultPolicyVersion(this.evaluationPolicy), now: Date.now() })
    const verifiedEvaluation = artifact.result
    const proposalId = proposalRootId(proposal.id)
    await this.versions.promote(proposal, { scope })
    await this.observations.append({
      id: `adoption:${proposalId}`,
      schemaVersion: 1,
      kind: 'adoption-applied',
      occurredAt: new Date().toISOString(),
      correlationIds: [proposalId],
      skill: {
        name: proposal.skillName,
        provider: 'filesystem',
        source: scope,
        contentHash: createContentHash(proposal.candidateContent),
        version: proposal.proposedVersion,
      },
      payload: { proposalId, scope, effectiveAt: 'next-load' },
      source: 'maintenance',
    })
    const promoted = transitionProposal(proposal, 'promoted')
    await this.proposals.append({ ...promoted, id: ledgerRecordId(proposalId, 'promoted') })
    await this.recordDecision(promoted, 'promoted', 'accepted', 'promoted', reason, verifiedEvaluation.policyVersion, verifiedEvaluation.caseResults.map(result => result.caseId))
  }

  async verifyEvaluation(proposal: SkillProposal, evaluation: SkillEvalResult): Promise<EvaluationArtifact> {
    return resolvePromotionArtifact(await this.evaluations.readAll(), proposal, evaluation)
  }

  async rollback(skillName: string, version: string, reason = 'manual rollback'): Promise<void> {
    const before = await this.versions.readCurrent(skillName)
    const published = await this.versions.rollback(skillName, version, { scope: 'project' })
    const latestStates = latestProposalsByRoot(await this.proposals.readAll())
    const latestPromoted = [...latestStates.values()].filter(item => item.skillName === skillName && item.status === 'promoted' && item.proposedVersion === before?.manifest.version).at(-1)
    const targetProposal = [...latestStates.values()].find(item => item.skillName === skillName && item.proposedVersion === version)
    await this.observations.append({
      id: `rollback:${skillName}:${version}:${Date.now()}`,
      schemaVersion: 1,
      kind: 'adoption-applied',
      occurredAt: new Date().toISOString(),
      correlationIds: [],
      skill: {
        name: skillName,
        provider: 'filesystem',
        source: 'project',
        contentHash: published.manifest.contentHash,
        version: published.manifest.version,
      },
      payload: { operation: 'rollback', version, ...(latestPromoted === undefined ? {} : { sourceProposalId: proposalRootId(latestPromoted.id) }), ...(targetProposal === undefined ? {} : { targetProposalId: proposalRootId(targetProposal.id) }), ...(before === undefined ? {} : { fromVersion: before.manifest.version, fromContentHash: before.manifest.contentHash }), toContentHash: published.manifest.contentHash },
      source: 'maintenance',
    })
    await this.decisions.append({
      id: `decision:rollback:${skillName}:${version}:${Date.now()}`,
      ...(latestPromoted === undefined ? {} : { proposalId: proposalRootId(latestPromoted.id) }),
      skillName,
      action: 'rollback',
      reason,
      evidenceIds: [],
      createdAt: new Date().toISOString(),
      actor: this.options.operator ?? 'maintainer',
    })
    if (latestPromoted !== undefined) {
      const rolledBack = transitionProposal(latestPromoted, 'rolled-back')
      await this.proposals.append({ ...rolledBack, id: ledgerRecordId(proposalRootId(latestPromoted.id), 'rolled-back') })
      await this.recordDecision(rolledBack, 'rollback', 'promoted', 'rolled-back', reason)
    }
  }

  async rejectProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    assertCanTransition(proposal.status, 'rejected')
    const rejected = transitionProposal(proposal, 'rejected')
    const rootId = proposalRootId(proposal.id)
    await this.proposals.append({ ...rejected, id: ledgerRecordId(rootId, 'rejected') })
    await this.recordDecision(rejected, 'rejected', proposal.status, 'rejected', reason, undefined, evidenceIds)
    return rejected
  }

  async deferProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    assertCanTransition(proposal.status, 'deferred')
    const deferred = transitionProposal(proposal, 'deferred')
    const rootId = proposalRootId(proposal.id)
    await this.proposals.append({ ...deferred, id: ledgerRecordId(rootId, 'deferred') })
    await this.recordDecision(deferred, 'deferred', proposal.status, 'deferred', reason, undefined, evidenceIds)
    return deferred
  }

  private async recordDecision(
    proposal: SkillProposal,
    action: DecisionRecord['action'],
    fromStatus: DecisionRecord['fromStatus'],
    toStatus: DecisionRecord['toStatus'],
    reason: string,
    policyVersion?: string,
    evidenceIds: readonly string[] = [],
  ): Promise<void> {
    await this.decisions.append({
      id: `decision:transition:${proposalRootId(proposal.id)}:${toStatus}:${proposal.updatedAt}`,
      proposalId: proposalRootId(proposal.id),
      skillName: proposal.skillName,
      action,
      reason,
      evidenceIds: [...evidenceIds],
      actor: this.options.operator ?? 'maintainer',
      fromStatus,
      toStatus,
      baseContentHash: proposal.expectedBase.contentHash,
      candidateContentHash: createContentHash(proposal.candidateContent),
      ...(policyVersion === undefined ? {} : { policyVersion }),
      createdAt: new Date().toISOString(),
    })
  }

  async refreshDerived(options: { readonly force?: boolean } = {}): Promise<ReturnType<EvolutionWorkflow['snapshot']>> {
    return withLock(`${this.projectionCursorPath}.lock`, 'refresh', () => this.refreshDerivedUnlocked(options))
  }

  private async refreshDerivedUnlocked(options: { readonly force?: boolean }): Promise<ReturnType<EvolutionWorkflow['snapshot']>> {
    const observations = await this.observations.readAll()
    const cursor = await readCursor(this.projectionCursorPath)
    const lastId = observations.at(-1)?.id
    const fingerprint = fingerprintOf(observations.map(item => item.id))
    const memoEntries = await this.classifications.readAll()
    const memo = new Map(memoEntries.map(entry => [entry.id, entry]))
    const lastMemo = memoEntries.at(-1)
    const derivationKey = createContentHash(JSON.stringify({ rules: 'follow-up-rules-v1', policy: 'intent-policy-v1', classifier: this.followUpClassifier?.version ?? 'none', memoCount: memoEntries.length, memoLastId: lastMemo?.id ?? null }))
    if (!options.force && cursor?.count === observations.length && cursor.lastId === lastId && cursor.fingerprint === fingerprint && cursor.derivationKey === derivationKey) {
      return { experiences: await this.experiences.readAll(), failures: await this.failures.readAll(), clusters: await this.clusters.readAll(), diagnoses: await this.diagnoses.readAll(), followUps: await this.followUps.readAll() }
    }
    const workflow = new EvolutionWorkflow({ memo, ...(this.followUpClassifier === undefined ? {} : { classifierVersion: this.followUpClassifier.version }) })
    workflow.add(observations)
    const snapshot = workflow.snapshot()
    await this.experiences.replaceAll(snapshot.experiences)
    await this.followUps.replaceAll(snapshot.followUps)
    await this.failures.replaceAll(snapshot.failures)
    await this.clusters.replaceAll(snapshot.clusters)
    await this.diagnoses.replaceAll(snapshot.diagnoses)
    await writeCursor(this.projectionCursorPath, { count: observations.length, ...(lastId === undefined ? {} : { lastId }), fingerprint, derivationKey })
    return snapshot
  }
}

function validateEvaluationCases(cases: readonly SkillEvaluationCase[]): void {
  if (cases.length === 0) throw new Error('evaluation requires at least one case')
  const ids = new Set<string>()
  for (const item of cases) {
    if (!item.id || ids.has(item.id)) throw new Error(`evaluation case IDs must be unique and non-empty: ${item.id}`)
    ids.add(item.id)
    if (item.category !== 'original-failure' && item.category !== 'historical-success' && item.category !== 'boundary') throw new Error(`invalid evaluation category for ${item.id}`)
    if (item.severity !== undefined && item.severity !== 'low' && item.severity !== 'medium' && item.severity !== 'high') throw new Error(`invalid evaluation severity for ${item.id}`)
  }
}
