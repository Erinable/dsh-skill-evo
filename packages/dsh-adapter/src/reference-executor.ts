import type { DshEvaluationExecutor, DshEvaluationRunInput, DshEvaluationRunResult } from './evaluator.js'
import { spawn } from 'node:child_process'

export interface ReferenceExecutorOptions {
  readonly tokenCostPerCharacter?: number
  readonly sideEffectMarkers?: readonly string[]
}

/**
 * Deterministic executor for local development and E2E tests.
 * A task containing `require:<text>` succeeds when the Skill contains that text.
 */
export function createReferenceExecutor(options: ReferenceExecutorOptions = {}): DshEvaluationExecutor {
  const tokenCostPerCharacter = options.tokenCostPerCharacter ?? 0.25
  const sideEffectMarkers = options.sideEffectMarkers ?? ['write-file', 'send-email', 'delete-resource']
  return async input => {
    if (input.signal.aborted) throw input.signal.reason ?? new Error('evaluation aborted')
    const required = input.task.match(/require:([^\s]+)/g)?.map(item => item.slice('require:'.length)) ?? []
    const missing = required.filter(value => !input.skillContent.includes(value))
    const sideEffects = sideEffectMarkers.filter(marker => input.task.includes(marker) && input.skillContent.includes(marker))
    return {
      outcome: missing.length === 0 ? 'improved' : 'regressed',
      evidence: missing.length === 0 ? required : [`missing:${missing.join(',')}`],
      toolCalls: input.task.includes('tool:') ? 1 : 0,
      tokenCost: Math.ceil(input.skillContent.length * tokenCostPerCharacter),
      sideEffects,
      securityViolations: input.skillContent.includes('unsafe:') ? ['unsafe marker'] : [],
      userFeedback: [],
      confidence: missing.length === 0 ? 'high' : 'medium',
    }
  }
}

export interface ProcessReferenceExecutorOptions {
  readonly command?: string
  readonly commandArgs?: readonly string[]
  readonly profile?: string
  readonly extraArgs?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly maxOutputBytes?: number
  readonly judge?: (result: { readonly stdout: string; readonly stderr: string; readonly input: DshEvaluationRunInput }) => DshEvaluationRunResult | Promise<DshEvaluationRunResult>
}

/** Real headless process binding. A successful exit alone never proves task success. */
export function createProcessReferenceDshExecutor(options: ProcessReferenceExecutorOptions = {}): DshEvaluationExecutor {
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('maxOutputBytes must be positive')
  return async input => {
    input.signal.throwIfAborted()
    const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(options.command ?? 'dsh', [
        ...options.commandArgs ?? [], '--profile', options.profile ?? 'headless', ...options.extraArgs ?? [], input.task,
      ], {
        cwd: input.cwd,
        env: { ...process.env, ...options.env },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let failure: Error | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) child.kill(signal)
        }
      }
      const terminate = () => {
        kill('SIGTERM')
        killTimer ??= setTimeout(() => kill('SIGKILL'), 500)
      }
      const capture = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxOutputBytes) {
          failure ??= new Error('DSH evaluation output limit exceeded')
          terminate()
        } else target.push(Buffer.from(chunk))
      }
      child.stdout.on('data', capture(stdout))
      child.stderr.on('data', capture(stderr))
      const abort = () => { failure = new Error('DSH evaluation aborted'); terminate() }
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
      const cleanup = () => {
        input.signal.removeEventListener('abort', abort)
        if (killTimer !== undefined) clearTimeout(killTimer)
      }
      child.once('error', error => { cleanup(); reject(error) })
      child.once('close', code => {
        cleanup()
        if (failure !== undefined) reject(failure)
        else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      })
    })
    input.signal.throwIfAborted()
    if (output.code !== 0) return { outcome: 'unknown', status: 'unknown', evidence: [`DSH process exited with ${output.code}`], confidence: 'low' }
    if (options.judge === undefined) return { outcome: 'unknown', status: 'unknown', evidence: ['DSH exited successfully; no task verifier configured'], confidence: 'low' }
    // The deployment verifier owns task success and measured telemetry; logs are not parsed with heuristics.
    return options.judge({ stdout: output.stdout, stderr: output.stderr, input })
  }
}

/** Named reference binding for a real local DSH installation. */
export const createReferenceDshExecutor = createProcessReferenceDshExecutor
