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
