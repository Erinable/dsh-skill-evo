import type { ExposureView, RuntimeObservation, SkillRef } from './types.js'

/** Project catalog and load observations into a conservative exposure view. */
export function buildExposureView(events: readonly RuntimeObservation[]): ExposureView[] {
  const byKey = new Map<string, ExposureViewBuilder>()
  for (const event of events) {
    if (event.skill === undefined) continue
    const key = skillKey(event.skill)
    const current = byKey.get(key) ?? new ExposureViewBuilder(event.skill)
    current.observationIds.push(event.id)
    switch (event.kind) {
      case 'catalog-visible': current.catalogVisible = true; break
      case 'skill-load-requested': current.loadRequested = true; break
      case 'skill-loaded': current.loadSucceeded = true; break
      case 'skill-load-failed': current.loadFailed = true; break
      case 'user-follow-up': current.followUpObservationIds.push(event.id); break
      default: break
    }
    byKey.set(key, current)
  }
  return [...byKey.values()].map(value => value.toView())
}

function skillKey(skill: SkillRef): string {
  return [skill.name, skill.provider, skill.source, skill.version ?? '', skill.contentHash ?? ''].join('\u0000')
}

class ExposureViewBuilder {
  catalogVisible = false
  loadRequested = false
  loadSucceeded = false
  loadFailed = false
  readonly followUpObservationIds: string[] = []
  readonly observationIds: string[] = []

  constructor(readonly skill: SkillRef) {}

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
