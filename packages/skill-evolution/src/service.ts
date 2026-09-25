import { join } from 'node:path'
import { createContentHash } from './events.js'
import { JsonlEventStore } from './store.js'
import { JsonlRecordStore } from './records.js'
import { EvolutionWorkflow, type Designer } from './workflow.js'
import { evaluateCandidate, type EvaluateCandidateInput, type EvaluationRunner } from './evaluator.js'
import { transitionProposal } from './proposal.js'
import { SkillVersionStore } from './lifecycle.js'
import type {
  DecisionRecord,
  Experience,
  FailureCluster,
  RuntimeObservation,
  SkillEvalResult,
  SkillEvaluationCase,
  SkillDiagnosis,
  SkillFailureCase,
  SkillProposal,
} from './types.js'

export interface EvolutionServiceOptions {
  readonly root: string
  readonly invalidate?: (skillName: string, scope: 'project' | 'user' | 'stable') => void | Promise<void>
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
  readonly versions: SkillVersionStore

  constructor(private readonly options: EvolutionServiceOptions) {
    const state = join(options.root, '.skill-evolution')
    this.observations = new JsonlEventStore(join(state, 'observations.jsonl'))
    this.proposals = new JsonlRecordStore(join(state, 'proposals.jsonl'))
    this.decisions = new JsonlRecordStore(join(state, 'decisions.jsonl'))
    this.experiences = new JsonlRecordStore(join(state, 'experiences.jsonl'))
    this.failures = new JsonlRecordStore(join(state, 'failures.jsonl'))
    this.clusters = new JsonlRecordStore(join(state, 'clusters.jsonl'))
    this.diagnoses = new JsonlRecordStore(join(state, 'diagnoses.jsonl'))
    this.versions = new SkillVersionStore(options.root, { invalidate: options.invalidate })
  }

  async recordObservation(event: RuntimeObservation): Promise<boolean> {
    return this.observations.append(event)
  }

  async listFailures(): Promise<SkillFailureCase[]> {
    return [...(await this.refreshDerived()).failures]
  }

  async proposeChange(clusterId: string, designer: Designer): Promise<SkillProposal> {
    await this.refreshDerived()
    const workflow = new EvolutionWorkflow()
    workflow.add(await this.observations.readAll())
    const proposal = await workflow.propose(clusterId, designer)
    await this.versions.writeCandidate(proposal)
    await this.proposals.append(proposal)
    return proposal
  }

  async evaluate(
    proposal: SkillProposal,
    cases: readonly SkillEvaluationCase[],
    runner?: EvaluationRunner,
  ): Promise<SkillEvalResult> {
    const current = await this.versions.readCurrent(proposal.skillName)
    if (current === undefined) throw new Error(`cannot evaluate without a current Skill: ${proposal.skillName}`)
    const input: EvaluateCandidateInput = {
      candidateId: proposal.id,
      baseContent: current.content,
      candidateContent: proposal.candidateContent,
      cases,
      runner,
      expectedSkillName: proposal.skillName,
    }
    return evaluateCandidate(input)
  }

  async promote(
    proposal: SkillProposal,
    evaluation: SkillEvalResult,
    scope: 'explicit-only' | 'project' | 'user' | 'stable',
    reason = 'evaluation gate passed',
  ): Promise<void> {
    if (!evaluation.passedGate) throw new Error(`proposal ${proposal.id} failed evaluation gate: ${evaluation.gateReasons.join('; ')}`)
    await this.versions.promote(proposal, { scope })
    await this.observations.append({
      id: `adoption:${proposal.id}`,
      schemaVersion: 1,
      kind: 'adoption-applied',
      occurredAt: new Date().toISOString(),
      correlationIds: [proposal.id],
      skill: {
        name: proposal.skillName,
        provider: 'filesystem',
        source: scope,
        contentHash: createContentHash(proposal.candidateContent),
        version: proposal.proposedVersion,
      },
      payload: { proposalId: proposal.id, scope, effectiveAt: 'next-load' },
      source: 'maintenance',
    })
    const evaluated = proposal.status === 'draft' ? transitionProposal(proposal, 'replayed') : proposal
    const accepted = transitionProposal(evaluated, 'accepted')
    await this.proposals.append({ ...accepted, id: `${proposal.id}:accepted` })
    await this.decisions.append({
      id: `decision:promote:${proposal.id}`,
      proposalId: proposal.id,
      skillName: proposal.skillName,
      action: 'promoted',
      reason,
      evidenceIds: evaluation.caseResults.map(result => result.caseId),
      createdAt: new Date().toISOString(),
    })
  }

  async rollback(skillName: string, version: string, reason = 'manual rollback'): Promise<void> {
    const published = await this.versions.rollback(skillName, version, { scope: 'project' })
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
      payload: { operation: 'rollback', version },
      source: 'maintenance',
    })
    await this.decisions.append({
      id: `decision:rollback:${skillName}:${version}:${Date.now()}`,
      skillName,
      action: 'rollback',
      reason,
      evidenceIds: [],
      createdAt: new Date().toISOString(),
    })
  }

  async refreshDerived(): Promise<ReturnType<EvolutionWorkflow['snapshot']>> {
    const workflow = new EvolutionWorkflow()
    workflow.add(await this.observations.readAll())
    const snapshot = workflow.snapshot()
    await this.experiences.appendMany(snapshot.experiences)
    await this.failures.appendMany(snapshot.failures)
    await this.clusters.appendMany(snapshot.clusters)
    await this.diagnoses.appendMany(snapshot.diagnoses)
    return snapshot
  }
}
