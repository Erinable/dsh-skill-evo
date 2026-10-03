export interface DshSkillRef {
  readonly name: string
  readonly provider: string
  readonly source: string
  readonly path?: string
  readonly version?: string
  readonly contentHash?: string
  readonly resourceHash?: string
}

export type DshObservationKind =
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

export interface DshObservationContext {
  readonly id: string
  readonly kind: DshObservationKind
  readonly occurredAt: string
  readonly sessionId?: string
  readonly taskId?: string
  readonly agentId?: string
  readonly scope?: string
  readonly cwd?: string
  readonly correlationIds?: readonly string[]
}

export type DshObservationInput = DshObservationContext & {
  readonly skill?: DshSkillRef
  readonly skills?: readonly DshSkillRef[]
  readonly payload?: Readonly<Record<string, unknown>>
  readonly source?: 'runtime' | 'filesystem' | 'user' | 'maintenance'
}

export interface RuntimeObservationRecord {
  readonly id: string
  readonly schemaVersion: 1
  readonly kind: DshObservationKind
  readonly occurredAt: string
  readonly sessionId?: string
  readonly taskId?: string
  readonly agentId?: string
  readonly scope?: string
  readonly cwd?: string
  readonly skill?: DshSkillRef
  readonly correlationIds: readonly string[]
  readonly payload: Readonly<Record<string, unknown>>
  readonly source: 'runtime' | 'filesystem' | 'user' | 'maintenance'
}

export interface ObservationWriter {
  append(event: RuntimeObservationRecord): Promise<boolean>
}

export interface CatalogVisibleInput extends DshObservationContext {
  readonly kind: 'catalog-visible'
  readonly skills: readonly DshSkillRef[]
  readonly catalogRevision?: string
}
