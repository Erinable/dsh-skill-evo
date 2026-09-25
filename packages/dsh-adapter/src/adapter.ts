import type {
  DshObservationInput,
  DshSkillRef,
  ObservationWriter,
  RuntimeObservationRecord,
} from './types.js'

/** Translate DSH facts to core-compatible observations and persist them. */
export class DshEvolutionAdapter {
  constructor(private readonly writer: ObservationWriter) {}

  /** Record one DSH fact. Catalog observations expand to one record per visible Skill. */
  async record(input: DshObservationInput): Promise<number> {
    if (input.kind === 'catalog-visible') {
      if (input.skills === undefined) throw new Error('catalog-visible observation requires skills')
      return this.recordCatalog(input as DshObservationInput & {
        readonly kind: 'catalog-visible'
        readonly skills: readonly DshSkillRef[]
        readonly catalogRevision?: string
      })
    }
    return (await this.writer.append(toObservation(input))) ? 1 : 0
  }

  /** Record a catalog snapshot without implying that any Skill was loaded or useful. */
  async recordCatalog(input: DshObservationInput & {
    readonly kind: 'catalog-visible'
    readonly skills: readonly DshSkillRef[]
    readonly catalogRevision?: string
  }): Promise<number> {
    let count = 0
    for (const [index, skill] of input.skills.entries()) {
      const event = toObservation({
        ...input,
        id: `${input.id}:${index}`,
        skill,
        skills: undefined,
        payload: {
          ...(input.catalogRevision === undefined ? {} : { catalogRevision: input.catalogRevision }),
          catalogSize: input.skills.length,
        },
      })
      if (await this.writer.append(event)) count += 1
    }
    return count
  }
}

function toObservation(input: DshObservationInput): RuntimeObservationRecord {
  const { id, kind, occurredAt, sessionId, taskId, agentId, scope, cwd, correlationIds, skill, payload, source } = input
  return {
    id,
    schemaVersion: 1,
    kind,
    occurredAt,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(scope === undefined ? {} : { scope }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(skill === undefined ? {} : { skill: cloneSkill(skill) }),
    correlationIds: [...correlationIds ?? []],
    payload: { ...payload ?? {} },
    source: source ?? sourceFor(kind),
  }
}

function cloneSkill(skill: DshSkillRef): DshSkillRef {
  return { ...skill }
}

function sourceFor(kind: DshObservationInput['kind']): RuntimeObservationRecord['source'] {
  switch (kind) {
    case 'skill-file-observed': return 'filesystem'
    case 'user-follow-up': return 'user'
    case 'adoption-applied': return 'maintenance'
    default: return 'runtime'
  }
}
