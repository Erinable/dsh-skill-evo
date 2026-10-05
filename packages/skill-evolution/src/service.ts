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
import type { ClassificationMemo, ClassificationMemoEntry, CorrectionClassifier, CorrectionClassificationMemoEntry, CorrectionEpisode, CorrectionPattern, FollowUpClassifier, FollowUpResolution } from './types.js'
import { OperationError } from './errors.js'
import { CORRECTION_POLICY_VERSION, CORRECTION_RULES_VERSION, correlateToolAttempts, episodeFromDraft, experienceForEpisode, groupPatterns, recognizeCorrections, validateEpisodeDraft, assessPattern, DEFAULT_CORRECTION_POLICY } from './correction.js'
import { readPublication } from './publication.js'
import { createPatternProposal, patternDesignerInput, selectPatternTarget, validateEnvironmentNeutralCandidate } from './pattern-design.js'
import type { PatternDesignerInput } from './workflow.js'
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
  readonly correctionClassifier?: CorrectionClassifier
  readonly correctionRulesVersion?: string
  readonly windowRulesVersion?: string
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
  readonly classifications: JsonlRecordStore<ClassificationMemo>
  readonly episodes: JsonlRecordStore<CorrectionEpisode>
  readonly patterns: JsonlRecordStore<CorrectionPattern>
  readonly followUps: JsonlRecordStore<FollowUpResolution>
  readonly feedback: JsonlRecordStore<FeedbackRecord>
  readonly evaluations: JsonlRecordStore<EvaluationArtifact>
  readonly versions: SkillVersionStore
  readonly evaluationPolicy: EvaluationPolicyInput | undefined
  private readonly projectionCursorPath: string
  readonly layout: ReturnType<typeof resolveLayout>
  readonly followUpClassifier: FollowUpClassifier | undefined
  readonly classifierTimeoutMs: number
  readonly correctionClassifier: CorrectionClassifier | undefined
  private correctionClassifierFailures = 0
  private correctionRejectedDrafts = 0

  constructor(private readonly options: EvolutionServiceOptions) {
    this.evaluationPolicy = options.evaluationPolicy
    this.followUpClassifier = options.followUpClassifier
    this.classifierTimeoutMs = options.classifierTimeoutMs ?? 10_000
    this.correctionClassifier = options.correctionClassifier
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
    this.episodes = new JsonlRecordStore(path('episodes'))
    this.patterns = new JsonlRecordStore(path('patterns'))
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
    const events = await this.observations.readAll()
    const names = [...new Set(events.map(item => item.skill?.name).filter((name): name is string => name !== undefined))]
    const currentSkills = (await Promise.all(names.map(async name => {
      try { const current = await this.versions.readCurrent(name); return current === undefined ? undefined : { name, content: current.content } }
      catch { return undefined }
    }))).filter((item): item is { name: string; content: string } => item !== undefined)
    const proposals = await this.proposals.readAll()
    return aggregateMetrics(events, proposals, await this.decisions.readAll(), snapshot.followUps, currentSkills, { episodes: snapshot.episodes ?? [], patterns: snapshot.patterns ?? [], proposals, classifierFailures: this.correctionClassifierFailures, rejectedDrafts: this.correctionRejectedDrafts })
  }

  async recordCorrectionClassifierFailure(): Promise<void> {
    await withLock(`${this.projectionCursorPath}.lock`, 'correction-failure', async () => {
      const cursor = await readCursor(this.projectionCursorPath)
      const failures = (cursor?.correctionClassifierFailures ?? 0) + 1
      this.correctionClassifierFailures = failures
      await writeCursor(this.projectionCursorPath, { ...(cursor ?? { count: 0, fingerprint: '' }), correctionClassifierFailures: failures })
    })
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

  async healthReport(): Promise<{ readonly jsonl: readonly JsonlHealth[]; readonly skillIssues: readonly string[]; readonly publications: readonly unknown[] }> {
    return { jsonl: await this.health(), skillIssues: await this.versions.healthIssues(), publications: await this.publicationReports() }
  }

  async repair(): Promise<EvolutionRepairReport> {
    const pendingPublications = await this.publicationReports()
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
    return { ...report, jsonl: [...jsonl, ...report.jsonl], projectionCursorRebuilt: true, publications: pendingPublications.map(item => ({ ...item, outcome: 'completed' })) }
  }

  private async publicationReports(): Promise<readonly Record<string, unknown>[]> {
    let entries: string[] = []
    try { entries = await readdir(this.layout.publicationsDir) } catch { return [] }
    const reports: Record<string, unknown>[] = []
    for (const entry of entries.filter(item => item.endsWith('.json'))) {
      const journal = await readPublication(join(this.layout.publicationsDir, entry))
      if (journal === undefined) continue
      reports.push({ skillName: journal.skillName, operation: journal.operation, proposalId: journal.proposalId, scope: journal.scope, fromVersion: journal.from.version, toVersion: journal.to.version, startedAt: journal.startedAt })
    }
    return reports
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
          if (proposal !== undefined) {
            await this.versions.recoverPublication(journal.skillName, true)
            if (proposal.status === 'promoted') await this.ensurePromoteLedgerDecision(proposal)
            else await this.completePromoteFromJournal(proposal, journal)
            await this.versions.finalizePublication(journal.skillName)
          }
        } else if (journal.operation === 'rollback') {
          await this.rollback(journal.skillName, journal.to.version)
        }
      } catch (error) { throw error }
    }
  }

  async proposeChange(clusterId: string, designer: Designer): Promise<SkillProposal> {
    await this.refreshDerived()
    const memo = new Map<string, ClassificationMemoEntry>((await this.classifications.readAll()).filter((entry): entry is ClassificationMemoEntry => (entry as CorrectionClassificationMemoEntry).judge !== 'correction').map(entry => [entry.id, entry]))
    const workflow = new EvolutionWorkflow({ memo, classifierVersion: this.followUpClassifier?.version })
    workflow.add(await this.observations.readAll())
    const proposal = await workflow.propose(clusterId, designer)
    return this.stageProposal(proposal)
  }

  /** Design a proposal from an aggregated correction pattern using bounded input. */
  async proposePattern(patternId: string, designer: (input: PatternDesignerInput) => string | Promise<string>, options: { readonly skillName?: string; readonly proposedVersion: string } ): Promise<SkillProposal> {
    await this.refreshDerived()
    const pattern = (await this.patterns.readAll()).find(item => item.id === patternId)
    if (pattern === undefined) throw new OperationError('not-found', `unknown correction pattern "${patternId}"`)
    const events = await this.observations.readAll()
    const episodeRecords = (await this.episodes.readAll()).filter(item => pattern.occurrences.some(occurrence => occurrence.episodeId === item.id))
    const evidenceByEpisode = new Map(episodeRecords.map(item => [item.id, [...item.failureObservationIds, ...item.correctionObservationIds, item.successObservationId] as readonly string[]]))
    const evidence = episodeRecords.flatMap(item => evidenceByEpisode.get(item.id) ?? []).slice(0, 64)
    const assessment = assessPattern({ pattern, policy: DEFAULT_CORRECTION_POLICY, now: new Date().toISOString(), proposals: await this.proposals.readAll() })
    if (!assessment.candidate) throw new OperationError(assessment.candidateReason === 'already-proposed' ? 'already-proposed' : 'insufficient-evidence', `pattern ${patternId} is not eligible: ${assessment.candidateReason}`)
    const loaded = new Map<string, number>()
    for (const event of events) if (event.kind === 'skill-loaded' && event.skill?.name !== undefined) loaded.set(event.skill.name, (loaded.get(event.skill.name) ?? 0) + 1)
    const promoted = (await this.proposals.readAll()).filter(item => item.status === 'promoted' && item.source?.patternId === patternId).at(-1)?.skillName
    const managedNames = await this.managedSkillNames()
    const skillNames = [...new Set([...managedNames, ...loaded.keys(), ...(await this.proposals.readAll()).filter(item => item.status === 'promoted').map(item => item.skillName)])]
    const similarities = new Map<string, number>()
    for (const skillName of skillNames) {
      const current = await this.versions.readCurrent(skillName)
      if (current !== undefined) similarities.set(skillName, tokenSimilarity(`${pattern.intent} ${pattern.errorSignature} ${pattern.correction.join(' ')}`, skillMetadata(current.content, skillName)))
    }
    const selection = selectPatternTarget({ explicitSkill: options.skillName, promotedTarget: promoted, loadedSkills: loaded, similarities })
    if (selection.reason === 'ambiguous') throw new OperationError('ambiguous-target', `ambiguous pattern target: ${selection.candidates?.join(', ')}`)
    const input = patternDesignerInput(pattern, evidenceByEpisode)
    let candidate: string
    try { candidate = await designer(input) } catch (error) { throw new OperationError('designer-failed', error instanceof Error ? error.message : String(error), error) }
    const observedMachineValues = events.flatMap(event => collectMachineValues(event.payload)).slice(0, 128)
    const validation = validateEnvironmentNeutralCandidate(candidate, observedMachineValues)
    if (!validation.valid) throw new OperationError('invalid-option', validation.errors.join('; '))
    const base = selection.target === undefined ? undefined : await this.versions.readCurrent(selection.target)
    const proposal = createPatternProposal({ pattern, skillName: selection.target, proposedVersion: options.proposedVersion, candidateContent: candidate, ...(base === undefined ? {} : { baseVersion: base.manifest.version, baseContent: base.content }), evidenceEventIds: evidence, targetReason: selection.reason, targetCandidates: selection.candidates })
    return this.stageProposal(proposal)
  }

  private async managedSkillNames(): Promise<readonly string[]> {
    try {
      return (await readdir(this.options.root, { withFileTypes: true })).filter(item => item.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.name)).map(item => item.name)
    } catch { return [] }
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
    const absentBase = proposal.expectedBase.contentHash === 'absent'
    if (current === undefined && !absentBase) throw new Error(`cannot evaluate without a current Skill: ${proposal.skillName}`)
    if (current !== undefined && current.manifest.contentHash !== proposal.expectedBase.contentHash) throw new Error(`proposal ${proposal.id} base no longer matches the current Skill`)
    if (this.options.evaluationPolicy !== undefined) validateEvaluationPolicy(this.options.evaluationPolicy)
    const input: EvaluateCandidateInput = {
      candidateId: proposalId,
      baseContent: current?.content ?? '',
      candidateContent: proposal.candidateContent,
      cases,
      runner,
      expectedSkillName: proposal.skillName,
      policy: this.options.evaluationPolicy,
      ...(absentBase ? { baseContentHash: 'absent' } : {}),
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
      ...(result.schemaVersion === 2 ? { schemaVersion: 2 as const, policy: result.policy, policyHash: result.policyHash, statisticId: result.statisticId } : {}),
      ...(result.policyHash === undefined ? {} : { policyHash: result.policyHash }),
      passedGate: result.passedGate,
      createdAt: result.createdAt,
      expiresAt,
      result: persistedResult,
    })
    await this.ledger.transition(evaluating, 'evaluated', {
      reason: 'evaluation completed',
      action: 'evaluated',
      policyVersion: result.policyVersion,
      ...(result.policyHash === undefined ? {} : { policyHash: result.policyHash }),
      comparisonCaseIds: result.caseIds,
      evidenceIds: result.caseResults.map(item => item.caseId),
    })
    return persistedResult
  }

  async acceptProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    if (proposal.source?.kind === 'pattern') {
      const artifact = (await this.evaluations.readAll()).filter(item => item.proposalId === proposalRootId(proposal.id)).at(-1)
      if (artifact === undefined) throw new OperationError('evaluation-missing', `pattern proposal ${proposal.id} requires an evaluation artifact before acceptance`)
      if (!artifact.passedGate || !artifact.result.passedGate) throw new OperationError('gate-failed', `pattern proposal ${proposal.id} failed the evaluation gate`)
    }
    return (await this.ledger.transition(proposal, 'accepted', { reason, action: 'accepted', evidenceIds })).record
  }

  async promote(
    proposal: SkillProposal,
    evaluation: SkillEvalResult,
    scope: PublicationScope,
    reason = 'evaluation gate passed',
  ): Promise<void> {
    assertPublicationScope(scope)
    if (scope === 'stable' && (proposal.operation === 'create-skill' || (proposal.source?.kind === 'pattern' && proposal.source.environmental === true))) {
      throw new OperationError('scope-not-allowed', `stable scope is not allowed for ${proposal.operation === 'create-skill' ? 'create-skill' : 'environmental pattern'} proposals`)
    }
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
    const pending = await this.versions.pendingPublication(proposal.skillName)
    if (pending?.proposalId !== rootId) checkPromotion({ proposal, artifact, current, policyVersion: defaultPolicyVersion(this.evaluationPolicy), policy: this.evaluationPolicy, now: Date.now() })
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
    if (latestAfterObservation.status !== 'promoted') await this.ledger.transition(latestAfterObservation, 'promoted', { reason, action: 'promoted', policyVersion: verifiedEvaluation.policyVersion, ...(verifiedEvaluation.policyHash === undefined ? {} : { policyHash: verifiedEvaluation.policyHash }), evidenceIds: verifiedEvaluation.caseResults.map(result => result.caseId) })
    await this.versions.finalizePublication(proposal.skillName)
  }

  async verifyEvaluation(proposal: SkillProposal, evaluation: SkillEvalResult): Promise<EvaluationArtifact> {
    return resolvePromotionArtifact(await this.evaluations.readAll(), proposal, evaluation)
  }

  async rollback(skillName: string, version: string, reason = 'manual rollback'): Promise<void> {
    const before = await this.versions.readCurrent(skillName)
    const pending = await this.versions.pendingPublication(skillName)
    const latestStates = latestProposalsByRoot(await this.proposals.readAll())
    const sourceVersion = pending?.from.version ?? before?.manifest.version
    if (pending?.operation === 'rollback') {
      await this.versions.recoverPublication(skillName, true)
    } else if (before?.manifest.version !== version) {
      await this.versions.rollback(skillName, version, { scope: 'project', retainJournal: true })
    } else {
      const alreadyRolledBack = (await this.proposals.readAll()).filter(item => item.skillName === skillName && item.status === 'rolled-back' && item.proposedVersion === version).at(-1)
      if (alreadyRolledBack !== undefined) {
        const id = `decision:ledger:${alreadyRolledBack.id}`
        if (!(await this.decisions.readAll()).some(item => item.id === id)) await this.decisions.append({ id, proposalId: proposalRootId(alreadyRolledBack.id), skillName, action: 'rollback', reason, evidenceIds: [], createdAt: alreadyRolledBack.updatedAt, actor: this.options.operator ?? 'maintainer', fromStatus: 'promoted', toStatus: 'rolled-back', recordId: alreadyRolledBack.id, baseContentHash: alreadyRolledBack.expectedBase.contentHash, candidateContentHash: createContentHash(alreadyRolledBack.candidateContent) })
      }
      return
    }
    const published = await this.versions.readCurrent(skillName)
    if (published === undefined) throw new Error(`rollback did not produce a current Skill: ${skillName}`)
    const latestPromoted = [...latestStates.values()].filter(item => item.skillName === skillName && (item.status === 'promoted' || item.status === 'rolled-back') && item.proposedVersion === sourceVersion).at(-1)
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
      else if (currentLatest.status === 'rolled-back') await this.ensureRollbackLedgerDecision(currentLatest, reason)
    }
    await this.versions.finalizePublication(skillName)
  }

  private async ensureRollbackLedgerDecision(proposal: SkillProposal, reason: string): Promise<void> {
    const id = `decision:ledger:${proposal.id}`
    if ((await this.decisions.readAll()).some(item => item.id === id)) return
    await this.decisions.append({ id, proposalId: proposalRootId(proposal.id), skillName: proposal.skillName, action: 'rollback', reason, evidenceIds: [], createdAt: proposal.updatedAt, actor: this.options.operator ?? 'maintainer', fromStatus: 'promoted', toStatus: 'rolled-back', recordId: proposal.id, baseContentHash: proposal.expectedBase.contentHash, candidateContentHash: createContentHash(proposal.candidateContent) })
  }

  private async ensurePromoteLedgerDecision(proposal: SkillProposal): Promise<void> {
    const id = `decision:ledger:${proposal.id}`
    if ((await this.decisions.readAll()).some(item => item.id === id)) return
    await this.decisions.append({ id, proposalId: proposalRootId(proposal.id), skillName: proposal.skillName, action: 'promoted', reason: 'evaluation gate passed', evidenceIds: [...proposal.comparisonCaseIds], createdAt: proposal.updatedAt, actor: this.options.operator ?? 'maintainer', fromStatus: 'accepted', toStatus: 'promoted', recordId: proposal.id, baseContentHash: proposal.expectedBase.contentHash, candidateContentHash: createContentHash(proposal.candidateContent), policyVersion: defaultPolicyVersion(this.evaluationPolicy) })
  }

  async rejectProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    if (proposal.status === 'promoted' || proposal.status === 'rolled-back') throw new OperationError('invalid-transition', `proposal ${proposal.id} cannot be rejected from ${proposal.status}`)
    const pending = await this.versions.pendingPublication(proposal.skillName)
    if (proposal.status === 'accepted' && pending?.proposalId === proposalRootId(proposal.id)) {
      await this.versions.recoverPublication(proposal.skillName, true)
      if (pending.operation === 'promote') {
        await this.completePromoteFromJournal(proposal, pending)
        throw new OperationError('invalid-transition', `proposal ${proposal.id} was promoted before rejection`)
      }
      const latest = latestProposalsByRoot(await this.proposals.readAll()).get(proposalRootId(proposal.id))
      if (latest?.status === 'promoted') throw new OperationError('invalid-transition', `proposal ${proposal.id} was promoted before rejection`)
    }
    return (await this.ledger.transition(proposal, 'rejected', { reason, action: 'rejected', evidenceIds })).record
  }

  private async completePromoteFromJournal(proposal: SkillProposal, journal: { readonly scope: PublicationScope; readonly to: { readonly version: string; readonly contentHash: string } }): Promise<void> {
    const rootId = proposalRootId(proposal.id)
    if (!(await this.observations.readAll()).some(item => item.id === `adoption:${rootId}`)) await this.observations.append({
      id: `adoption:${rootId}`,
      schemaVersion: 1,
      kind: 'adoption-applied',
      occurredAt: new Date().toISOString(),
      correlationIds: [rootId],
      skill: { name: proposal.skillName, provider: 'filesystem', source: journal.scope, contentHash: journal.to.contentHash, version: journal.to.version },
      payload: { proposalId: rootId, scope: journal.scope, effectiveAt: 'next-load' },
      source: 'maintenance',
    })
    const latest = latestProposalsByRoot(await this.proposals.readAll()).get(rootId) ?? proposal
    if (latest.status === 'accepted') await this.ledger.transition(latest, 'promoted', { reason: 'evaluation gate passed', action: 'promoted', policyVersion: defaultPolicyVersion(this.evaluationPolicy), evidenceIds: latest.comparisonCaseIds })
    await this.versions.finalizePublication(proposal.skillName)
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
    this.correctionClassifierFailures = cursor?.correctionClassifierFailures ?? this.correctionClassifierFailures
    const lastId = observations.at(-1)?.id
    const fingerprint = fingerprintOf(observations.map(item => item.id))
    const memoEntries = await this.classifications.readAll()
    const memo = new Map(memoEntries.filter((entry): entry is ClassificationMemoEntry => (entry as CorrectionClassificationMemoEntry).judge !== 'correction').map(entry => [entry.id, entry]))
    const lastMemo = memoEntries.at(-1)
    const derivationKey = createContentHash(JSON.stringify({ rules: FOLLOW_UP_RULES_VERSION, policy: INTENT_POLICY_VERSION, windowRules: this.options.windowRulesVersion ?? 'skill-windows-v1', classifier: this.followUpClassifier?.version ?? 'none', memoCount: memoEntries.length, memoLastId: lastMemo?.id ?? null, correction: { rules: this.options.correctionRulesVersion ?? CORRECTION_RULES_VERSION, policy: CORRECTION_POLICY_VERSION, classifier: this.correctionClassifier?.version ?? 'none' } }))
    if (!options.force && cursor?.count === observations.length && cursor.lastId === lastId && cursor.fingerprint === fingerprint && cursor.derivationKey === derivationKey) {
      this.correctionRejectedDrafts = cursor.correctionRejectedDrafts ?? 0
      this.correctionClassifierFailures = cursor.correctionClassifierFailures ?? 0
      return {
        experiences: await this.experiences.readAll(),
        failures: await this.failures.readAll(),
        clusters: await this.clusters.readAll(),
        diagnoses: await this.diagnoses.readAll(),
        followUps: await this.followUps.readAll(),
        episodes: await this.episodes.readAll(), patterns: await this.patterns.readAll(),
      }
    }
    const workflow = new EvolutionWorkflow({ memo, ...(this.followUpClassifier === undefined ? {} : { classifierVersion: this.followUpClassifier.version }) })
    workflow.add(observations)
    const snapshot = workflow.snapshot()
    const episodes: CorrectionEpisode[] = []
    let rejectedDrafts = 0
    const memoMap = new Map(memoEntries.filter((entry): entry is CorrectionClassificationMemoEntry => (entry as CorrectionClassificationMemoEntry).judge === 'correction').map(entry => [entry.id, entry]))
    const sessions = new Map<string, RuntimeObservation[]>()
    for (const event of observations) if (event.sessionId !== undefined) sessions.set(event.sessionId, [...sessions.get(event.sessionId) ?? [], event])
    for (const [sessionId, sessionEvents] of sessions) {
      const attempts = correlateToolAttempts(sessionEvents); const hash = createContentHash(JSON.stringify(attempts)); const version = this.correctionClassifier?.version ?? CORRECTION_RULES_VERSION
      const memoEntry = memoMap.get(`classification:correction:${version}:${hash}`)
      const rawDrafts = memoEntry?.drafts ?? recognizeCorrections(sessionId, attempts)
      const drafts = rawDrafts.filter(draft => validateEpisodeDraft(draft, attempts))
      rejectedDrafts += rawDrafts.length - drafts.length
      for (const draft of drafts) episodes.push(episodeFromDraft(sessionId, draft, attempts, observations, memoEntry ? version : CORRECTION_RULES_VERSION, memoEntry ? undefined : 'not-classified'))
    }
    const patterns = groupPatterns(episodes)
    await this.skillWindows.replaceAll(buildSkillWindows(observations))
    await this.experiences.replaceAll([...snapshot.experiences, ...episodes.map(experienceForEpisode)])
    await this.followUps.replaceAll(snapshot.followUps)
    await this.failures.replaceAll(snapshot.failures)
    await this.clusters.replaceAll(snapshot.clusters)
    await this.diagnoses.replaceAll(snapshot.diagnoses)
    await this.episodes.replaceAll(episodes)
    await this.patterns.replaceAll(patterns)
    this.correctionRejectedDrafts = rejectedDrafts
    await writeCursor(this.projectionCursorPath, { count: observations.length, ...(lastId === undefined ? {} : { lastId }), fingerprint, derivationKey, correctionRejectedDrafts: rejectedDrafts, correctionClassifierFailures: this.correctionClassifierFailures })
    return { ...snapshot, experiences: [...snapshot.experiences, ...episodes.map(experienceForEpisode)], episodes, patterns }
  }
}

function collectMachineValues(value: unknown, key = ''): string[] {
  if (typeof value === 'string') {
    if (/command|proxy/iu.test(key)) {
      const values: string[] = []
      for (const match of value.matchAll(/(?:https?|socks5?):\/\/([^\s]+)/giu)) {
        try {
          const url = new URL(match[0]!)
          for (const item of [url.hostname, url.host, url.username, url.password]) if (item.length > 0) values.push(item)
        } catch { /* malformed URLs are not machine facts */ }
      }
      for (const match of value.matchAll(/(?:proxy|http|https)[_ -]?(?:host|url)?=([^\s]+)/giu)) {
        const raw = match[1]!
        try {
          const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
          for (const item of [url.hostname, url.host, url.username, url.password]) if (item.length > 0) values.push(item)
        } catch { values.push(raw) }
      }
      return values
    }
    return /^(?:proxy(?:[-_].*)?|host|ip|address|username|password|user|pass)$/iu.test(key) ? [value] : []
  }
  if (Array.isArray(value)) return value.flatMap(item => collectMachineValues(item, key))
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([name, item]) => collectMachineValues(item, name))
  return []
}

function tokenSimilarity(left: string, right: string): number {
  const terms = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter(item => item.length > 2))
  const a = terms(left); const b = terms(right); const intersection = [...a].filter(item => b.has(item)).length
  return a.size === 0 ? 0 : intersection / a.size
}

function skillMetadata(content: string, name: string): string {
  const description = content.match(/^description:\s*(.+)$/imu)?.[1] ?? ''
  return `${name} ${description}`
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
