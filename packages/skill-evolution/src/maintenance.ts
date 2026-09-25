import { EvolutionService } from './service.js'
import type { EvolutionWorkflow } from './workflow.js'

export interface MaintenanceCycle {
  readonly startedAt: string
  readonly finishedAt: string
  readonly observations: number
  readonly experiences: number
  readonly failures: number
  readonly clusters: number
  readonly diagnoses: number
}

export interface MaintenanceWorkerOptions {
  readonly service: EvolutionService
  readonly intervalMs?: number
  readonly onCycle?: (cycle: MaintenanceCycle) => void | Promise<void>
  readonly onError?: (error: unknown) => void | Promise<void>
}

/** Long-running projection worker. Proposal generation stays explicit and reviewable. */
export class MaintenanceWorker {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(private readonly options: MaintenanceWorkerOptions) {}

  async runOnce(): Promise<MaintenanceCycle> {
    const startedAt = new Date().toISOString()
    const snapshot = await this.options.service.refreshDerived()
    const cycle: MaintenanceCycle = {
      startedAt,
      finishedAt: new Date().toISOString(),
      observations: (await this.options.service.observations.readAll()).length,
      experiences: snapshot.experiences.length,
      failures: snapshot.failures.length,
      clusters: snapshot.clusters.length,
      diagnoses: snapshot.diagnoses.length,
    }
    await this.options.onCycle?.(cycle)
    return cycle
  }

  start(): void {
    if (this.timer !== undefined) return
    const intervalMs = this.options.intervalMs ?? 60_000
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      void this.runOnce().catch(error => this.options.onError?.(error)).finally(() => { this.running = false })
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}

export type MaintenanceSnapshot = ReturnType<EvolutionWorkflow['snapshot']>
