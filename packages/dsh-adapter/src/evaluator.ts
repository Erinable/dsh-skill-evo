import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ProposalComparison {
  readonly proposalId: string
  readonly caseId: string
  readonly exposure: 'base' | 'candidate'
  readonly observedOutcome: 'improved' | 'regressed' | 'unchanged' | 'unknown'
  readonly status: 'passed' | 'failed' | 'unknown'
  readonly evidence: readonly string[]
  readonly confidence: 'low' | 'medium' | 'high'
  readonly toolCalls?: number
  readonly modelTurns?: number
  readonly tokenCost?: number
  readonly contextCost?: number
  readonly sideEffects?: readonly string[]
  readonly securityViolations?: readonly string[]
  readonly userFeedback: readonly string[]
  readonly positiveFeedback?: boolean
  readonly timedOut: boolean
}

export interface DshEvaluationCase {
  readonly id: string
  readonly task: string
}

export interface DshEvaluationRunInput {
  readonly proposalId: string
  readonly caseId: string
  readonly skillName: string
  readonly skillContent: string
  readonly task: string
  readonly cwd: string
  readonly signal: AbortSignal
  readonly exposure: 'base' | 'candidate'
  readonly sample: number
}

export interface DshEvaluationRunResult {
  readonly outcome: ProposalComparison['observedOutcome']
  readonly status?: ProposalComparison['status']
  readonly evidence?: readonly string[]
  readonly toolCalls?: number
  readonly tokenCost?: number
  readonly modelTurns?: number
  readonly contextCost?: number
  readonly sideEffects?: readonly string[]
  readonly securityViolations?: readonly string[]
  readonly userFeedback?: readonly string[]
  readonly positiveFeedback?: boolean
  readonly confidence?: 'low' | 'medium' | 'high'
}

export type DshEvaluationExecutor = (input: DshEvaluationRunInput) => DshEvaluationRunResult | Promise<DshEvaluationRunResult>

export interface DshComparisonOptions {
  readonly root?: string
  readonly timeoutMs?: number
}

/** Each core runner invocation executes exactly one isolated task. */
export function createDshEvaluationRunner(
  proposal: { readonly id: string; readonly skillName: string },
  baseContent: string,
  executor: DshEvaluationExecutor,
  options: DshComparisonOptions = {},
) {
  return async (content: string, evaluationCase: DshEvaluationCase, context?: { readonly exposure: 'base' | 'candidate'; readonly sample: number }) => {
    const result = await runDshCase(proposal, context?.exposure ?? (content === baseContent ? 'base' : 'candidate'), content, evaluationCase, executor, options, context?.sample ?? 0)
    return {
      passed: result.status === 'passed',
      status: result.status,
      reason: result.evidence.join('; ') || result.status,
      evidence: result.evidence,
      tokenCost: result.tokenCost,
      toolCalls: result.toolCalls,
      modelTurns: result.modelTurns,
      contextCost: result.contextCost,
      sideEffects: result.sideEffects,
      securityViolations: result.securityViolations,
      positiveFeedback: result.positiveFeedback,
    }
  }
}

/** Temporary workspaces isolate files; the executor must enforce OS/process permissions. */
export async function runDshComparison(
  proposal: { readonly id: string; readonly skillName: string },
  baseContent: string,
  candidateContent: string,
  cases: readonly DshEvaluationCase[],
  executor: DshEvaluationExecutor,
  options: DshComparisonOptions = {},
): Promise<ProposalComparison[]> {
  await cleanupEvaluationWorkspaces(options.root ?? tmpdir()).catch(() => undefined)
  const output: ProposalComparison[] = []
  for (const evaluationCase of cases) {
    output.push(await runDshCase(proposal, 'base', baseContent, evaluationCase, executor, options))
    output.push(await runDshCase(proposal, 'candidate', candidateContent, evaluationCase, executor, options))
  }
  return output
}

/** Remove abandoned evaluation workspaces older than the safety TTL. */
export async function cleanupEvaluationWorkspaces(root = tmpdir(), maxAgeMs = 24 * 86_400_000): Promise<readonly string[]> {
  const removed: string[] = []
  const cutoff = Date.now() - maxAgeMs
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-skill-eval-')) continue
    const path = join(root, entry.name)
    const info = await stat(path).catch(() => undefined)
    if (info?.mtimeMs !== undefined && info.mtimeMs < cutoff) {
      await rm(path, { recursive: true, force: true })
      removed.push(path)
    }
  }
  return removed
}

async function runDshCase(
  proposal: { readonly id: string; readonly skillName: string },
  exposure: 'base' | 'candidate',
  skillContent: string,
  evaluationCase: DshEvaluationCase,
  executor: DshEvaluationExecutor,
  options: DshComparisonOptions,
  sample = 0,
): Promise<ProposalComparison> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proposal.skillName)) throw new Error('invalid Skill name')
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  const workspace = await mkdtemp(join(options.root ?? tmpdir(), 'dsh-skill-eval-'))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = true
  let execution: Promise<DshEvaluationRunResult> | undefined
  const identity = { proposalId: proposal.id, caseId: evaluationCase.id, exposure }
  try {
    const skillDirectory = join(workspace, '.dsh', 'skills', proposal.skillName)
    await mkdir(skillDirectory, { recursive: true })
    const skillPath = join(skillDirectory, 'SKILL.md')
    await writeFile(skillPath, skillContent, 'utf8')
    settled = false
    execution = Promise.resolve().then(() => executor({
      proposalId: proposal.id, caseId: evaluationCase.id, skillName: proposal.skillName,
      skillContent, task: evaluationCase.task, cwd: workspace, signal: controller.signal, exposure, sample,
    })).finally(() => { settled = true })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('evaluation timeout'))
        reject(controller.signal.reason)
      }, timeoutMs)
    })
    const run = await Promise.race([execution, timeout])
    const status = run.status ?? (run.outcome === 'improved' || run.outcome === 'unchanged' ? 'passed' : run.outcome === 'regressed' ? 'failed' : 'unknown')
    const effects = await listWorkspaceEffects(workspace, skillPath)
    if (await readFile(skillPath, 'utf8').catch(() => '') !== skillContent) effects.push('modified evaluation Skill')
    return {
      ...identity, status, observedOutcome: run.outcome,
      evidence: [...run.evidence ?? []], confidence: run.confidence ?? 'low',
      toolCalls: run.toolCalls, modelTurns: run.modelTurns, tokenCost: run.tokenCost, contextCost: run.contextCost,
      // Unknown external effects remain unknown; filesystem scanning is only supplemental.
      sideEffects: run.sideEffects === undefined ? undefined : [...new Set([...run.sideEffects, ...effects])],
      securityViolations: run.securityViolations,
      userFeedback: [...run.userFeedback ?? []], positiveFeedback: run.positiveFeedback, timedOut: false,
    }
  } catch (error) {
    return {
      ...identity, observedOutcome: 'unknown', status: 'unknown',
      evidence: [controller.signal.aborted ? 'evaluation timed out' : error instanceof Error ? error.message : String(error)],
      confidence: 'low', sideEffects: [], securityViolations: [], userFeedback: [], timedOut: controller.signal.aborted,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Never delete a workspace while a non-cooperative executor is still writing into it.
    if (settled) await rm(workspace, { recursive: true, force: true })
    else void execution!.then(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(workspace, { recursive: true, force: true }),
    ).catch(() => undefined)
  }
}

async function listWorkspaceEffects(root: string, skillPath: string): Promise<string[]> {
  const effects: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (path === skillPath) continue
      if (entry.isDirectory()) await walk(path)
      else effects.push(path.slice(root.length + 1))
    }
  }
  await walk(root)
  return effects
}
