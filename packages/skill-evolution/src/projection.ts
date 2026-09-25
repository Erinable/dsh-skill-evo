import type { ExposureView, RuntimeObservation, SkillRef } from './types.js'

/** Project catalog and load observations into a conservative exposure view. */
export function buildExposureView(events: readonly RuntimeObservation[]): ExposureView[] {
  const builders: ExposureViewBuilder[] = []
  for (const event of events) {
    const skill = event.skill
    if (skill === undefined) continue
    const current = builders.find(builder => canMerge(builder.skill, skill))
    if (current === undefined) {
      builders.push(new ExposureViewBuilder({ ...event, skill }))
    } else {
      current.add(event)
    }
  }
  return builders.map(value => value.toView())
}

/** Merge an incomplete runtime identity into its later concrete observation. */
function canMerge(left: SkillRef, right: SkillRef): boolean {
  return left.name === right.name
    && compatible(left.provider, right.provider)
    && compatible(left.source, right.source)
    && compatible(left.version, right.version)
    && (left.contentHash === undefined
      || right.contentHash === undefined
      || left.contentHash === right.contentHash)
}

function compatible(left: string | undefined, right: string | undefined): boolean {
  return left === right || left === undefined || right === undefined || left === 'unknown' || right === 'unknown'
}

class ExposureViewBuilder {
  skill: SkillRef
  catalogVisible = false
  loadRequested = false
  loadSucceeded = false
  loadFailed = false
  readonly followUpObservationIds: string[] = []
  readonly observationIds: string[] = []

  constructor(event: RuntimeObservation) {
    this.skill = { ...event.skill! }
    this.add(event)
  }

  add(event: RuntimeObservation): void {
    if (this.skill.contentHash === undefined && event.skill?.contentHash !== undefined) {
      this.skill = { ...event.skill }
    }
    this.observationIds.push(event.id)
    switch (event.kind) {
      case 'catalog-visible': this.catalogVisible = true; break
      case 'skill-load-requested': this.loadRequested = true; break
      case 'skill-loaded': this.loadSucceeded = true; break
      case 'skill-load-failed': this.loadFailed = true; break
      case 'user-follow-up': this.followUpObservationIds.push(event.id); break
      default: break
    }
  }

  toView(): ExposureView {
    return {
      skill: { ...this.skill },
      catalogVisible: this.catalogVisible,
      loadRequested: this.loadRequested,
      loadSucceeded: this.loadSucceeded,
      loadFailed: this.loadFailed,
      followUpObservationIds: [...this.followUpObservationIds],
      observationIds: [...this.observationIds],
    }
  }
}
