import { join, basename } from 'node:path'
import { readdir } from 'node:fs/promises'
import { createContentHash, isObservationValue, redactSensitiveText } from './events.js'
import { fingerprintOf, ObservationLog, readCursor, resolveLayout, writeCursor } from './state-root.js'
import { JsonlRecordStore } from './records.js'
import { EvolutionWorkflow, type Designer } from './workflow.js'
import { DEFAULT_EVALUATION_POLICY, evaluateCandidate, type EvaluateCandidateInput, type EvaluationRunner } from './evaluator.js'
import { validateEvaluationPolicy } from './policy.js'
import { assertCanTransition, latestProposalsByRoot, proposalRootId, assertProposalRoot } from './proposal.js'
import { ProposalLedger } from './ledger.js'
import { SkillVersionStore } from './lifecycle.js'
import { aggregateMetrics, type EvolutionMetrics } from './metrics.js'
import { repairEvolutionRoot, repairJsonlFileUnlocked, type EvolutionRepairReport, type JsonlRepairResult } from './repair.js'
import { inspectJsonlHealth, type JsonlHealth } from './health.js'
import { withLock } from './locking.js'
import { archivePaths } from './state-root.js'
import { assertFeedbackKind, assertPublicationScope } from './types.js'
import { FOLLOW_UP_RULES_VERSION, INTENT_POLICY_VERSION, isClassificationMemoEntry } from './follow-up.js'
import { buildSkillWindows, type SkillWindow } from './skill-attribution.js'
import type { ClassificationMemoEntry, FollowUpClassifier, FollowUpResolution } from './types.js'
import { OperationError } from './errors.js'
import { readPublication } from './publication.js'
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
  readonly ledger: ProposalLedger
  readonly experiences: JsonlRecordStore<Experience>
  readonly failures: JsonlRecordStore<SkillFailureCase>
  readonly clusters: JsonlRecordStore<FailureCluster>
  readonly diagnoses: JsonlRecordStore<SkillDiagnosis>
  readonly skillWindows: JsonlRecordStore<SkillWindow>
  readonly classifications: JsonlRecordStore<ClassificationMemoEntry>
  readonly followUps: JsonlRecordStore<FollowUpResolution>
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
    this.ledger = new ProposalLedger(this.proposals, this.decisions, options.operator ?? 'maintainer')
    this.experiences = new JsonlRecordStore(path('experiences'))
    this.failures = new JsonlRecordStore(path('failures'))
    this.clusters = new JsonlRecordStore(path('clusters'))
    this.diagnoses = new JsonlRecordStore(path('diagnoses'))
    this.skillWindows = new JsonlRecordStore(path('skill-windows'))
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
      store.name === 'observations' ? { parse: isObservationValue } : store.name === 'classifications' ? { parse: isClassificationMemoEntry } : {},
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
    await this.repairPublications()
    await withLock(`${this.observations.filePath}.lock`, 'repair', async () => {
      jsonl.push(await repairJsonlFileUnlocked(this.observations.filePath, { parse: isObservationValue }))
      for (const path of await archivePaths(this.observations.filePath)) {
        jsonl.push(await repairJsonlFileUnlocked(path, { parse: isObservationValue }))
      }
    })
    await this.refreshDerived({ force: true })
    return { ...report, jsonl: [...jsonl, ...report.jsonl], projectionCursorRebuilt: true }
  }

  private async repairPublications(): Promise<void> {
    let entries: string[] = []
    try { entries = await readdir(this.layout.publicationsDir) } catch { return }
    for (const entry of entries.filter(item => item.endsWith('.json'))) {
      const skillName = basename(entry, '.json')
      try {
        const journal = await readPublication(join(this.layout.publicationsDir, entry))
        if (journal === undefined) continue
        if (journal.operation === 'promote' && journal.proposalId !== undefined) {
          const proposal = latestProposalsByRoot(await this.proposals.readAll()).get(proposalRootId(journal.proposalId))
          const artifact = proposal === undefined ? undefined : (await this.evaluations.readAll()).filter(item => item.proposalId === proposalRootId(proposal.id)).at(-1)
          if (proposal !== undefined && artifact !== undefined && proposal.status !== 'promoted') await this.promote(proposal, artifact.result, journal.scope)
        } else if (journal.operation === 'rollback') {
          await this.rollback(journal.skillName, journal.to.version)
          const source = [...latestProposalsByRoot(await this.proposals.readAll()).values()].find(item => item.skillName === journal.skillName && item.status === 'rolled-back' && item.proposedVersion === journal.from.version)
          if (source !== undefined && !(await this.decisions.readAll()).some(item => item.id === `decision:ledger:${source.id}`)) await this.decisions.append({ id: `decision:ledger:${source.id}`, proposalId: proposalRootId(source.id), skillName: source.skillName, action: 'rollback', reason: 'manual rollback', evidenceIds: [], createdAt: source.updatedAt, actor: this.options.operator ?? 'maintainer', fromStatus: 'promoted', toStatus: 'rolled-back', recordId: source.id, baseContentHash: source.expectedBase.contentHash, candidateContentHash: createContentHash(source.candidateContent) })
        }
      } catch { /* leave the journal for the next repair attempt */ }
    }
  }

  async proposeChange(clusterId: string, designer: Designer): Promise<SkillProposal> {
    await this.refreshDerived()
    const memo = new Map((await this.classifications.readAll()).map(entry => [entry.id, entry]))
    const workflow = new EvolutionWorkflow({ memo, classifierVersion: this.followUpClassifier?.version })
    workflow.add(await this.observations.readAll())
    const proposal = await workflow.propose(clusterId, designer)
    return this.stageProposal(proposal)
  }

  async stageProposal(proposal: SkillProposal): Promise<SkillProposal> {
    if (proposal.status !== 'draft') throw new Error(`stageProposal requires draft status, got ${proposal.status}`)
    assertProposalRoot(proposal.id)
    const existing = (await this.proposals.readAll()).find(item => item.id === proposal.id)
    if (existing !== undefined) {
      if (existing.candidateContent !== proposal.candidateContent || existing.expectedBase.contentHash !== proposal.expectedBase.contentHash) throw new Error(`proposal ${proposal.id} already exists with different content`)
      return existing
    }
    const proposed = (await this.ledger.transition(proposal, 'proposed', { reason: 'candidate created', action: 'proposed' })).record
    await this.versions.writeCandidate(proposed)
    return proposed
  }

  async evaluate(
    proposal: SkillProposal,
    cases: readonly SkillEvaluationCase[],
    runner?: EvaluationRunner,
  ): Promise<SkillEvalResult> {
    const targetStatus = proposal.status === 'proposed' ? 'evaluating' : 'evaluated'
    assertCanTransition(proposal.status, targetStatus)
    const evaluating = targetStatus === 'evaluating'
      ? (await this.ledger.transition(proposal, 'evaluating', { reason: 'evaluation started', action: 'evaluating' })).record
      : proposal
    const proposalId = proposalRootId(proposal.id)
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
    await this.ledger.transition(evaluating, 'evaluated', {
      reason: 'evaluation completed',
      action: 'evaluated',
      policyVersion: result.policyVersion,
      comparisonCaseIds: result.caseIds,
      evidenceIds: result.caseResults.map(item => item.caseId),
    })
    return persistedResult
  }

  async acceptProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    return (await this.ledger.transition(proposal, 'accepted', { reason, action: 'accepted', evidenceIds })).record
  }

  async promote(
    proposal: SkillProposal,
    evaluation: SkillEvalResult,
    scope: PublicationScope,
    reason = 'evaluation gate passed',
  ): Promise<void> {
    assertPublicationScope(scope)
    const rootId = proposalRootId(proposal.id)
    const latest = latestProposalsByRoot(await this.proposals.readAll()).get(rootId)
    if (latest?.status === 'promoted') {
      const decisionId = `decision:ledger:${latest.id}`
      if (!(await this.decisions.readAll()).some(item => item.id === decisionId)) await this.decisions.append({ id: decisionId, proposalId: rootId, skillName: proposal.skillName, action: 'promoted', reason, evidenceIds: [...proposal.comparisonCaseIds], createdAt: latest.updatedAt, actor: this.options.operator ?? 'maintainer', fromStatus: 'accepted', toStatus: 'promoted', recordId: latest.id, baseContentHash: proposal.expectedBase.contentHash, candidateContentHash: createContentHash(proposal.candidateContent), policyVersion: defaultPolicyVersion(this.evaluationPolicy) })
      await this.versions.finalizePublication(proposal.skillName)
      return
    }
    if (proposal.status !== 'accepted') throw new OperationError('invalid-transition', `proposal ${proposal.id} must be accepted before promotion`)
    const artifact = resolvePromotionArtifact(await this.evaluations.readAll(), proposal, evaluation)
    const current = await this.versions.readCurrent(proposal.skillName)
    if (!(await this.versions.hasPendingPublication(proposal.skillName))) checkPromotion({ proposal, artifact, current, policyVersion: defaultPolicyVersion(this.evaluationPolicy), now: Date.now() })
    const verifiedEvaluation = artifact.result
    const proposalId = rootId
    await this.versions.promote(proposal, { scope, retainJournal: true })
    if (!(await this.observations.readAll()).some(item => item.id === `adoption:${proposalId}`)) await this.observations.append({
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
    const latestAfterObservation = latestProposalsByRoot(await this.proposals.readAll()).get(proposalId) ?? proposal
    if (latestAfterObservation.status !== 'promoted') await this.ledger.transition(latestAfterObservation, 'promoted', { reason, action: 'promoted', policyVersion: verifiedEvaluation.policyVersion, evidenceIds: verifiedEvaluation.caseResults.map(result => result.caseId) })
    await this.versions.finalizePublication(proposal.skillName)
  }

  async verifyEvaluation(proposal: SkillProposal, evaluation: SkillEvalResult): Promise<EvaluationArtifact> {
    return resolvePromotionArtifact(await this.evaluations.readAll(), proposal, evaluation)
  }

  async rollback(skillName: string, version: string, reason = 'manual rollback'): Promise<void> {
    const before = await this.versions.readCurrent(skillName)
    const pending = await this.versions.pendingPublication(skillName)
    const latestStates = latestProposalsByRoot(await this.proposals.readAll())
    if (pending?.operation === 'rollback') {
      await this.versions.recoverPublication(skillName, true)
    } else if (before?.manifest.version !== version) {
      await this.versions.rollback(skillName, version, { scope: 'project', retainJournal: true })
    } else {
      return
    }
    const published = await this.versions.readCurrent(skillName)
    if (published === undefined) throw new Error(`rollback did not produce a current Skill: ${skillName}`)
    const sourceVersion = pending?.from.version ?? before?.manifest.version
    const latestPromoted = [...latestStates.values()].filter(item => item.skillName === skillName && item.status === 'promoted' && item.proposedVersion === sourceVersion).at(-1)
    const targetProposal = [...latestStates.values()].find(item => item.skillName === skillName && item.proposedVersion === version)
    const occurredAt = pending?.startedAt ?? published.manifest.updatedAt
    const observationId = `rollback:${skillName}:${version}:${occurredAt}`
    if (!(await this.observations.readAll()).some(item => item.id === observationId)) await this.observations.append({
      id: observationId,
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
      payload: { operation: 'rollback', version, ...(latestPromoted === undefined ? {} : { sourceProposalId: proposalRootId(latestPromoted.id) }), ...(targetProposal === undefined ? {} : { targetProposalId: proposalRootId(targetProposal.id) }), ...(pending === undefined ? (before === undefined ? {} : { fromVersion: before.manifest.version, fromContentHash: before.manifest.contentHash }) : { fromVersion: pending.from.version, fromContentHash: pending.from.contentHash }), toContentHash: published.manifest.contentHash },
      source: 'maintenance',
    })
    const decisionId = `decision:rollback:${skillName}:${version}:${occurredAt}`
    if (!(await this.decisions.readAll()).some(item => item.id === decisionId)) await this.decisions.append({
      id: decisionId,
      ...(latestPromoted === undefined ? {} : { proposalId: proposalRootId(latestPromoted.id) }),
      skillName,
      action: 'rollback',
      reason,
      evidenceIds: [],
      createdAt: occurredAt,
      actor: this.options.operator ?? 'maintainer',
    })
    if (latestPromoted !== undefined) {
      const currentLatest = latestProposalsByRoot(await this.proposals.readAll()).get(proposalRootId(latestPromoted.id)) ?? latestPromoted
      if (currentLatest.status === 'promoted') await this.ledger.transition(currentLatest, 'rolled-back', { reason, action: 'rollback' })
      else if (currentLatest.status === 'rolled-back') {
        const ledgerDecisionId = `decision:ledger:${currentLatest.id}`
        if (!(await this.decisions.readAll()).some(item => item.id === ledgerDecisionId)) await this.decisions.append({ id: ledgerDecisionId, proposalId: proposalRootId(currentLatest.id), skillName, action: 'rollback', reason, evidenceIds: [], createdAt: currentLatest.updatedAt, actor: this.options.operator ?? 'maintainer', fromStatus: 'promoted', toStatus: 'rolled-back', recordId: currentLatest.id, baseContentHash: currentLatest.expectedBase.contentHash, candidateContentHash: createContentHash(currentLatest.candidateContent) })
      }
    }
    await this.versions.finalizePublication(skillName)
  }

  async rejectProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    if (proposal.status === 'promoted' || proposal.status === 'rolled-back') throw new OperationError('invalid-transition', `proposal ${proposal.id} cannot be rejected from ${proposal.status}`)
    if (proposal.status === 'accepted' && await this.versions.hasPendingPublication(proposal.skillName)) {
      await this.versions.recoverPublication(proposal.skillName, true)
      const latest = latestProposalsByRoot(await this.proposals.readAll()).get(proposalRootId(proposal.id))
      if (latest?.status === 'promoted') throw new OperationError('invalid-transition', `proposal ${proposal.id} was promoted before rejection`)
      const artifact = (await this.evaluations.readAll()).filter(item => item.proposalId === proposalRootId(proposal.id)).at(-1)
      if (artifact !== undefined) {
        await this.promote(proposal, artifact.result, 'project')
        throw new OperationError('invalid-transition', `proposal ${proposal.id} was promoted before rejection`)
      }
    }
    return (await this.ledger.transition(proposal, 'rejected', { reason, action: 'rejected', evidenceIds })).record
  }

  async deferProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    return (await this.ledger.transition(proposal, 'deferred', { reason, action: 'deferred', evidenceIds })).record
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
    const derivationKey = createContentHash(JSON.stringify({ rules: FOLLOW_UP_RULES_VERSION, policy: INTENT_POLICY_VERSION, windowRules: 'skill-windows-v1', classifier: this.followUpClassifier?.version ?? 'none', memoCount: memoEntries.length, memoLastId: lastMemo?.id ?? null }))
    if (!options.force && cursor?.count === observations.length && cursor.lastId === lastId && cursor.fingerprint === fingerprint && cursor.derivationKey === derivationKey) {
      return {
        experiences: await this.experiences.readAll(),
        failures: await this.failures.readAll(),
        clusters: await this.clusters.readAll(),
        diagnoses: await this.diagnoses.readAll(),
        followUps: await this.followUps.readAll(),
      }
    }
    const workflow = new EvolutionWorkflow({ memo, ...(this.followUpClassifier === undefined ? {} : { classifierVersion: this.followUpClassifier.version }) })
    workflow.add(observations)
    const snapshot = workflow.snapshot()
    await this.skillWindows.replaceAll(buildSkillWindows(observations))
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
