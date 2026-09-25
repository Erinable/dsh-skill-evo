import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createContentHash, parseObservation, redactSensitiveText } from './events.js'
import { JsonlEventStore } from './store.js'
import { JsonlRecordStore } from './records.js'
import { EvolutionWorkflow, type Designer } from './workflow.js'
import { DEFAULT_EVALUATION_POLICY, evaluateCandidate, type EvaluateCandidateInput, type EvaluationRunner } from './evaluator.js'
import { transitionProposal } from './proposal.js'
import { SkillVersionStore } from './lifecycle.js'
import { aggregateMetrics, type EvolutionMetrics } from './metrics.js'
import { repairEvolutionRoot, repairJsonlFile, type EvolutionRepairReport } from './repair.js'
import { inspectJsonlHealth, type JsonlHealth } from './health.js'
import { withFileLock } from './locking.js'
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
  EvaluationPolicy,
  Attribution,
  EvaluationArtifact,
} from './types.js'

export interface EvolutionServiceOptions {
  readonly root: string
  readonly store?: string
  readonly invalidate?: (skillName: string, scope: 'project' | 'user' | 'stable') => void | Promise<void>
  readonly evaluationPolicy?: EvaluationPolicy
  readonly operator?: string
  readonly evaluationTtlMs?: number
}

/** Maintainer-facing service for the full observe → diagnose → evaluate → publish loop. */
export class EvolutionService {
  readonly observations: JsonlEventStore
  readonly proposals: JsonlRecordStore<SkillProposal>
  readonly decisions: JsonlRecordStore<DecisionRecord>
  readonly experiences: JsonlRecordStore<Experience>
  readonly failures: JsonlRecordStore<SkillFailureCase>
  readonly clusters: JsonlRecordStore<FailureCluster>
  readonly diagnoses: JsonlRecordStore<SkillDiagnosis>
  readonly feedback: JsonlRecordStore<FeedbackRecord>
  readonly evaluations: JsonlRecordStore<EvaluationArtifact>
  readonly versions: SkillVersionStore
  private readonly projectionCursorPath: string

  constructor(private readonly options: EvolutionServiceOptions) {
    const state = join(options.root, '.skill-evolution')
    this.projectionCursorPath = join(state, 'projection-cursor.json')
    this.observations = new JsonlEventStore(options.store ?? join(state, 'observations.jsonl'))
    this.proposals = new JsonlRecordStore(join(state, 'proposals.jsonl'))
    this.decisions = new JsonlRecordStore(join(state, 'decisions.jsonl'))
    this.experiences = new JsonlRecordStore(join(state, 'experiences.jsonl'))
    this.failures = new JsonlRecordStore(join(state, 'failures.jsonl'))
    this.clusters = new JsonlRecordStore(join(state, 'clusters.jsonl'))
    this.diagnoses = new JsonlRecordStore(join(state, 'diagnoses.jsonl'))
    this.feedback = new JsonlRecordStore(join(state, 'feedback.jsonl'))
    this.evaluations = new JsonlRecordStore(join(state, 'evaluations.jsonl'))
    this.versions = new SkillVersionStore(options.root, { invalidate: options.invalidate })
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
      kind: input.kind,
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
    return aggregateMetrics(await this.observations.readAll(), await this.proposals.readAll(), await this.decisions.readAll())
  }

  async health(): Promise<readonly JsonlHealth[]> {
    return Promise.all([this.observations.filePath, this.proposals.filePath, this.decisions.filePath, this.experiences.filePath, this.failures.filePath, this.clusters.filePath, this.diagnoses.filePath, this.feedback.filePath, this.evaluations.filePath].map(inspectJsonlHealth))
  }

  async healthReport(): Promise<{ readonly jsonl: readonly JsonlHealth[]; readonly skillIssues: readonly string[] }> {
    return { jsonl: await this.health(), skillIssues: await this.versions.healthIssues() }
  }

  async repair(): Promise<EvolutionRepairReport> {
    const paths = [this.observations.filePath, this.proposals.filePath, this.decisions.filePath, this.experiences.filePath, this.failures.filePath, this.clusters.filePath, this.diagnoses.filePath, this.feedback.filePath, this.evaluations.filePath]
    const jsonl = []
    for (const path of paths) {
      jsonl.push(await repairJsonlFile(path, path === this.observations.filePath ? {
        parse: value => {
          try { parseObservation(JSON.stringify(value)); return true } catch { return false }
        },
      } : undefined))
    }
    const report = await repairEvolutionRoot(this.options.root, { jsonlPaths: [], observationsPath: this.observations.filePath })
    await writeFile(this.projectionCursorPath, '{}\n', 'utf8')
    await this.refreshDerived()
    return { ...report, jsonl, projectionCursorRebuilt: true }
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
    if (!['proposed', 'evaluating', 'replayed', 'observed'].includes(proposal.status)) {
      throw new Error(`proposal ${proposal.id} is not ready for evaluation from status ${proposal.status}`)
    }
    const evaluating = proposal.status === 'proposed' ? transitionProposal(proposal, 'evaluating') : proposal
    const proposalId = proposalRootId(proposal.id)
    if (evaluating !== proposal) {
      await this.proposals.append({ ...evaluating, id: `${proposalId}:evaluating` })
      await this.recordDecision(evaluating, 'evaluating', proposal.status, 'evaluating', 'evaluation started')
    }
    const current = await this.versions.readCurrent(proposal.skillName)
    if (current === undefined) throw new Error(`cannot evaluate without a current Skill: ${proposal.skillName}`)
    if (current.manifest.contentHash !== proposal.expectedBase.contentHash) throw new Error(`proposal ${proposal.id} base no longer matches the current Skill`)
    validateEvaluationPolicy(this.options.evaluationPolicy)
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
    await this.proposals.append({ ...evaluated, id: `${proposalId}:evaluated` })
    await this.recordDecision(evaluated, 'evaluated', 'evaluating', 'evaluated', 'evaluation completed', result.policyVersion)
    await this.decisions.append({
      id: `decision:evaluate:${proposalId}:${result.policyVersion}`,
      proposalId,
      skillName: proposal.skillName,
      action: 'evaluated',
      reason: result.gateReasons.join('; ') || 'evaluation policy passed',
      evidenceIds: result.caseResults.map(item => item.caseId),
      createdAt: new Date().toISOString(),
      actor: this.options.operator ?? 'evaluator',
      policyVersion: result.policyVersion,
    })
    return persistedResult
  }

  async acceptProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    if (proposal.status !== 'evaluated') throw new Error(`proposal ${proposal.id} requires evaluation before acceptance`)
    const accepted = transitionProposal(proposal, 'accepted')
    const proposalId = proposalRootId(proposal.id)
    await this.proposals.append({ ...accepted, id: `${proposalId}:accepted` })
    await this.recordDecision(accepted, 'accepted', 'evaluated', 'accepted', reason, undefined, evidenceIds)
    await this.decisions.append({
      id: `decision:accept:${proposalId}:${Date.now()}`,
      proposalId,
      skillName: proposal.skillName,
      action: 'accepted',
      reason,
      evidenceIds: [...evidenceIds],
      createdAt: new Date().toISOString(),
      actor: this.options.operator ?? 'maintainer',
    })
    return accepted
  }

  async promote(
    proposal: SkillProposal,
    evaluation: SkillEvalResult,
    scope: 'explicit-only' | 'project' | 'user' | 'stable',
    reason = 'evaluation gate passed',
  ): Promise<void> {
    if (proposal.status !== 'accepted') throw new Error(`proposal ${proposal.id} requires an accepted review before promotion`)
    const artifact = await this.requireEvaluationArtifact(proposal, evaluation)
    const verifiedEvaluation = artifact.result
    if (!verifiedEvaluation.passedGate) throw new Error(`proposal ${proposal.id} failed evaluation gate: ${verifiedEvaluation.gateReasons.join('; ')}`)
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
    await this.proposals.append({ ...promoted, id: `${proposalId}:promoted` })
    await this.recordDecision(promoted, 'promoted', 'accepted', 'promoted', reason, verifiedEvaluation.policyVersion, verifiedEvaluation.caseResults.map(result => result.caseId))
    await this.decisions.append({
      id: `decision:promote:${proposalId}`,
      proposalId,
      skillName: proposal.skillName,
      action: 'promoted',
      reason,
      evidenceIds: verifiedEvaluation.caseResults.map(result => result.caseId),
      createdAt: new Date().toISOString(),
      actor: this.options.operator ?? 'maintainer',
      fromStatus: 'accepted',
      toStatus: 'promoted',
      baseContentHash: proposal.expectedBase.contentHash,
      candidateContentHash: createContentHash(proposal.candidateContent),
      policyVersion: verifiedEvaluation.policyVersion,
    })
  }

  async verifyEvaluation(proposal: SkillProposal, evaluation: SkillEvalResult): Promise<EvaluationArtifact> {
    return this.requireEvaluationArtifact(proposal, evaluation)
  }

  private async requireEvaluationArtifact(proposal: SkillProposal, supplied: SkillEvalResult): Promise<EvaluationArtifact> {
    const artifactId = supplied.artifactId
    if (artifactId === undefined) throw new Error(`proposal ${proposal.id} requires a persisted evaluation artifact`)
    const artifact = (await this.evaluations.readAll()).find(item => item.id === artifactId)
    const proposalId = proposalRootId(proposal.id)
    if (artifact === undefined) throw new Error(`evaluation artifact not found: ${artifactId}`)
    const current = await this.versions.readCurrent(proposal.skillName)
    const expectedPolicy = this.options.evaluationPolicy?.version ?? DEFAULT_EVALUATION_POLICY.version
    const candidateHash = createContentHash(proposal.candidateContent)
    if (artifact.proposalId !== proposalId || artifact.candidateId !== proposalId || artifact.result.candidateId !== proposalId) throw new Error('evaluation artifact belongs to a different proposal')
    if (current === undefined || artifact.baseContentHash !== current.manifest.contentHash || artifact.baseContentHash !== proposal.expectedBase.contentHash) throw new Error('evaluation artifact base hash does not match the current Skill')
    if (artifact.candidateContentHash !== candidateHash || artifact.result.candidateContentHash !== candidateHash) throw new Error('evaluation artifact candidate hash does not match the proposal')
    if (artifact.policyVersion !== expectedPolicy) throw new Error(`evaluation policy mismatch: expected ${expectedPolicy}, got ${artifact.policyVersion}`)
    if (Date.parse(artifact.expiresAt) <= Date.now()) throw new Error(`evaluation artifact expired: ${artifactId}`)
    if (proposal.comparisonCaseIds.length > 0 && JSON.stringify([...proposal.comparisonCaseIds]) !== JSON.stringify([...artifact.caseIds])) throw new Error('evaluation artifact cases do not match the proposal')
    if (artifact.result.passedGate !== supplied.passedGate || artifact.result.candidateContentHash !== supplied.candidateContentHash) throw new Error('supplied evaluation does not match the persisted artifact')
    return artifact
  }

  async rollback(skillName: string, version: string, reason = 'manual rollback'): Promise<void> {
    const before = await this.versions.readCurrent(skillName)
    const published = await this.versions.rollback(skillName, version, { scope: 'project' })
    const latestStates = new Map<string, SkillProposal>()
    for (const item of await this.proposals.readAll()) latestStates.set(proposalRootId(item.id), item)
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
      await this.proposals.append({ ...rolledBack, id: `${proposalRootId(latestPromoted.id)}:rolled-back` })
      await this.recordDecision(rolledBack, 'rollback', 'promoted', 'rolled-back', reason)
    }
  }

  async rejectProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    if (!['proposed', 'evaluating', 'evaluated', 'observed', 'replayed', 'deferred'].includes(proposal.status)) throw new Error(`proposal ${proposal.id} cannot be rejected from ${proposal.status}`)
    const rejected = transitionProposal(proposal, 'rejected')
    const rootId = proposalRootId(proposal.id)
    await this.proposals.append({ ...rejected, id: `${rootId}:rejected` })
    await this.recordDecision(rejected, 'rejected', proposal.status, 'rejected', reason, undefined, evidenceIds)
    return rejected
  }

  async deferProposal(proposal: SkillProposal, reason: string, evidenceIds: readonly string[] = []): Promise<SkillProposal> {
    if (!['proposed', 'evaluating', 'evaluated', 'observed', 'replayed'].includes(proposal.status)) throw new Error(`proposal ${proposal.id} cannot be deferred from ${proposal.status}`)
    const deferred = transitionProposal(proposal, 'deferred')
    const rootId = proposalRootId(proposal.id)
    await this.proposals.append({ ...deferred, id: `${rootId}:deferred` })
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

  async refreshDerived(): Promise<ReturnType<EvolutionWorkflow['snapshot']>> {
    return withFileLock(`${this.projectionCursorPath}.lock`, () => this.refreshDerivedUnlocked())
  }

  private async refreshDerivedUnlocked(): Promise<ReturnType<EvolutionWorkflow['snapshot']>> {
    const observations = await this.observations.readAll()
    const cursor = await readCursor(this.projectionCursorPath)
    const lastId = observations.at(-1)?.id
    const fingerprint = createContentHash(observations.map(item => item.id).join('\n'))
    if (cursor?.count === observations.length && cursor.lastId === lastId && cursor.fingerprint === fingerprint) {
      return {
        experiences: await this.experiences.readAll(),
        failures: await this.failures.readAll(),
        clusters: await this.clusters.readAll(),
        diagnoses: await this.diagnoses.readAll(),
      }
    }
    const workflow = new EvolutionWorkflow()
    workflow.add(observations)
    const snapshot = workflow.snapshot()
    await this.experiences.replaceAll(snapshot.experiences)
    await this.failures.replaceAll(snapshot.failures)
    await this.clusters.replaceAll(snapshot.clusters)
    await this.diagnoses.replaceAll(snapshot.diagnoses)
    await writeFile(this.projectionCursorPath, `${JSON.stringify({ count: observations.length, lastId, fingerprint })}\n`, 'utf8')
    return snapshot
  }
}


/** Return the stable logical ID for a proposal lifecycle record. */
function proposalRootId(id: string): string {
  return id.replace(/(?::(?:evaluating|evaluated|accepted|promoted|rolled-back|replayed|observed|rejected|deferred))+$/, '')
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

function validateEvaluationPolicy(policy: EvaluationPolicy | undefined): void {
  if (policy === undefined) return
  if (!policy.version || !Number.isFinite(policy.maxRegressionCount) || policy.maxRegressionCount < 0 || !Number.isFinite(policy.maxSecurityViolations) || policy.maxSecurityViolations < 0) throw new Error('invalid evaluation policy thresholds')
  for (const value of [policy.maxTokenIncreaseRatio, policy.maxContextIncreaseRatio]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('evaluation cost ratios must be non-negative numbers')
}

async function readCursor(path: string): Promise<{ count: number; lastId?: string; fingerprint?: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { count?: unknown; lastId?: unknown; fingerprint?: unknown }
    return typeof value.count === 'number' ? { count: value.count, ...(typeof value.lastId === 'string' ? { lastId: value.lastId } : {}), ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}) } : undefined
  } catch {
    return undefined
  }
}
