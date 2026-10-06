import { buildExperiences, buildFailureCases, clusterFailureCases, diagnoseFailureCluster, type ExperienceProjectionOptions } from './experience.js'
import { resolveFollowUps } from './follow-up.js'
import type { ClassificationMemoEntry } from './types.js'
import { createProposal, type ProposalInput } from './proposal.js'
import type { FailureCluster, RuntimeObservation, SkillDiagnosis, SkillFailureCase, SkillProposal, Experience, CorrectionEpisode, CorrectionPattern, ProposalSource } from './types.js'

export type DesignerInput = ({
  readonly source: 'cluster'
  readonly diagnosis: SkillDiagnosis
  readonly cluster: FailureCluster
} | {
  readonly source: 'pattern'
  readonly pattern: PatternDesignerInput
}) & {
  readonly cases: readonly SkillFailureCase[]
  readonly experiences: readonly Experience[]
}

/** Bounded, redacted information exposed to a Designer for pattern proposals. */
export interface PatternDesignerInput {
  readonly id: string
  readonly signatureKey: string
  readonly intent: string
  readonly errorSignature: string
  readonly correction: readonly string[]
  readonly environmental: boolean
  readonly retryOnly: boolean
  readonly episodes: readonly { readonly id: string; readonly sessionId: string; readonly occurredAt: string; readonly evidenceEventIds: readonly string[] }[]
}

export type Designer = (input: DesignerInput) => Omit<ProposalInput, 'intent' | 'addressedExperienceIds'> | Promise<Omit<ProposalInput, 'intent' | 'addressedExperienceIds'>>

export interface WorkflowSnapshot {
  readonly experiences: readonly Experience[]
  readonly failures: readonly SkillFailureCase[]
  readonly clusters: readonly FailureCluster[]
  readonly diagnoses: readonly SkillDiagnosis[]
  readonly followUps: readonly import('./types.js').FollowUpResolution[]
  readonly episodes?: readonly CorrectionEpisode[]
  readonly patterns?: readonly CorrectionPattern[]
}

/** Phase 2/3 orchestration: facts to experiences, clusters, diagnoses, and isolated proposals. */
export class EvolutionWorkflow {
  private readonly events: RuntimeObservation[] = []

  constructor(private readonly options: ExperienceProjectionOptions & { readonly memo?: ReadonlyMap<string, ClassificationMemoEntry>; readonly classifierVersion?: string } = {}) {}

  add(events: readonly RuntimeObservation[]): void {
    this.events.push(...events)
  }

  snapshot(): WorkflowSnapshot {
    const experiences = buildExperiences(this.events, this.options)
    const followUps = resolveFollowUps(this.events, this.options)
    const failures = buildFailureCases(this.events, followUps)
    const clusters = clusterFailureCases(failures)
    const diagnoses = clusters.map(cluster => diagnoseFailureCluster(cluster, failures, experiences))
    return { experiences, failures, clusters, diagnoses, followUps }
  }

  async propose(clusterId: string, designer: Designer): Promise<SkillProposal> {
    const snapshot = this.snapshot()
    const cluster = snapshot.clusters.find(item => item.id === clusterId)
    if (cluster === undefined) throw new Error(`unknown failure cluster "${clusterId}"`)
    if (cluster.occurrenceCount < 2 && !snapshot.failures.some(item => cluster.caseIds.includes(item.id) && item.severity === 'high')) {
      throw new Error(`failure cluster "${clusterId}" does not have enough evidence`)
    }
    const diagnosis = snapshot.diagnoses.find(item => item.clusterId === clusterId)
    if (diagnosis === undefined) throw new Error(`missing diagnosis for cluster "${clusterId}"`)
    const input = await designer({
      source: 'cluster',
      diagnosis,
      cluster,
      cases: snapshot.failures.filter(item => cluster.caseIds.includes(item.id)),
      experiences: snapshot.experiences,
    })
    return createProposal({
      ...input,
      diagnosisId: diagnosis.id,
      clusterId: cluster.id,
      evidenceEventIds: snapshot.failures
        .filter(item => cluster.caseIds.includes(item.id))
        .flatMap(item => item.evidenceEventIds),
      intent: diagnosis.hypothesis,
      addressedExperienceIds: diagnosis.supportingExperienceIds,
      source: { kind: 'cluster', evidenceEventIds: snapshot.failures.filter(item => cluster.caseIds.includes(item.id)).flatMap(item => item.evidenceEventIds) },
    })
  }
}
