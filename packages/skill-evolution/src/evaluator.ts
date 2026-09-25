import type { CaseEvaluation, EvaluationCategory, SkillEvalResult, SkillEvaluationCase } from './types.js'

export interface CaseRunResult {
  readonly passed: boolean
  readonly status?: 'passed' | 'failed' | 'unknown'
  readonly reason?: string
  readonly evidence?: readonly string[]
}

export type EvaluationRunner = (
  content: string,
  evaluationCase: SkillEvaluationCase,
) => CaseRunResult | Promise<CaseRunResult>

export interface EvaluateCandidateInput {
  readonly candidateId: string
  readonly baseContent: string
  readonly candidateContent: string
  readonly cases: readonly SkillEvaluationCase[]
  readonly runner?: EvaluationRunner
  readonly expectedSkillName?: string
  readonly now?: () => number
}

/** Evaluate a candidate against original, historical, and boundary evidence. */
export async function evaluateCandidate(input: EvaluateCandidateInput): Promise<SkillEvalResult> {
  const started = input.now?.() ?? Date.now()
  const validation = validateSkillDocument(input.candidateContent, input.expectedSkillName)
  const baseValidation = validateSkillDocument(input.baseContent, input.expectedSkillName)
  const invocationPolicyUnchanged = sameInvocationPolicy(baseValidation.invocationPolicy, validation.invocationPolicy)
  const runner = input.runner ?? runContentChecks
  const baseline = emptyCategoryCounts()
  const categories = emptyCategoryCounts()
  const results: CaseEvaluation[] = []
  const regressions: string[] = []

  for (const evaluationCase of input.cases) {
    const baselineRun = baseValidation.valid
      ? await runner(input.baseContent, evaluationCase)
      : { passed: false, status: 'unknown' as const, reason: 'base Skill document is invalid' }
    const candidateStarted = input.now?.() ?? Date.now()
    const candidateRun = validation.valid
      ? await runner(input.candidateContent, evaluationCase)
      : { passed: false, status: 'unknown' as const, reason: 'candidate Skill document is invalid' }
    const durationMs = Math.max(0, (input.now?.() ?? Date.now()) - candidateStarted)
    addCategory(baseline, evaluationCase.category, baselineRun.passed === true)
    addCategory(categories, evaluationCase.category, candidateRun.passed === true)
    if (baselineRun.passed && !candidateRun.passed && evaluationCase.category !== 'original-failure') {
      regressions.push(evaluationCase.id)
    }
    results.push({
      caseId: evaluationCase.id,
      category: evaluationCase.category,
      passed: candidateRun.passed === true,
      status: candidateRun.status ?? (candidateRun.passed ? 'passed' : 'failed'),
      reason: candidateRun.reason ?? (candidateRun.passed ? 'passed' : 'failed'),
      evidence: [...candidateRun.evidence ?? []],
      durationMs,
    })
  }

  const gateReasons: string[] = []
  if (!validation.valid) gateReasons.push(...validation.errors.map(error => `schema: ${error}`))
  if (!invocationPolicyUnchanged) gateReasons.push('invocation policy changed')
  const originalBaseline = baseline['original-failure']
  const originalCandidate = categories['original-failure']
  if (originalCandidate.total === 0) {
    gateReasons.push('no original-failure cases')
  } else if (originalCandidate.passed <= originalBaseline.passed) {
    gateReasons.push('original-failure pass count did not improve')
  }
  const historicalBaseline = baseline['historical-success']
  const historicalCandidate = categories['historical-success']
  if (rate(historicalCandidate) + 0.05 < rate(historicalBaseline)) {
    gateReasons.push('historical-success pass rate regressed by more than five points')
  }
  const boundaryBaseline = await boundaryHighFailures(input.cases, input.baseContent, runner, baseValidation.valid)
  const boundaryCandidateFailures = results.filter(result => result.category === 'boundary'
    && !result.passed
    && input.cases.find(item => item.id === result.caseId)?.severity === 'high').length
  if (boundaryCandidateFailures > boundaryBaseline) gateReasons.push('new high-severity boundary failure')

  const total = results.length
  const passed = results.filter(result => result.passed).length
  const unknown = results.filter(result => result.status === 'unknown').length
  return {
    candidateId: input.candidateId,
    total,
    passed,
    failed: total - passed - unknown,
    unknown,
    categories,
    baseline,
    regressions,
    gateReasons,
    caseResults: results,
    durationMs: Math.max(0, (input.now?.() ?? Date.now()) - started),
    schemaValid: validation.valid,
    invocationPolicyUnchanged,
    passedGate: gateReasons.length === 0,
  }
}

export interface SkillDocumentValidation {
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly name?: string
  readonly invocationPolicy: Readonly<Record<string, string>>
}

/** Validate the small frontmatter contract without depending on a YAML runtime. */
export function validateSkillDocument(content: string, expectedName?: string): SkillDocumentValidation {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)
  if (match === null) return { valid: false, errors: ['missing YAML frontmatter'], invocationPolicy: {} }
  const values: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    values[key] = value
  }
  const errors: string[] = []
  if (typeof values.name !== 'string' || values.name.length === 0) errors.push('frontmatter name is required')
  if (typeof values.description !== 'string' || values.description.length === 0) errors.push('frontmatter description is required')
  if (expectedName !== undefined && values.name !== expectedName) errors.push(`frontmatter name must be ${expectedName}`)
  const invocationPolicy = Object.fromEntries(
    ['disable-model-invocation', 'user-invocable', 'model-invocable']
      .filter(key => values[key] !== undefined)
      .map(key => [key, values[key]!]),
  )
  return { valid: errors.length === 0, errors, name: values.name, invocationPolicy }
}

async function boundaryHighFailures(
  cases: readonly SkillEvaluationCase[],
  baseContent: string,
  runner: EvaluationRunner,
  valid: boolean,
): Promise<number> {
  if (!valid) return cases.filter(item => item.category === 'boundary' && item.severity === 'high').length
  let failed = 0
  for (const evaluationCase of cases.filter(item => item.category === 'boundary' && item.severity === 'high')) {
    const result = await runner(baseContent, evaluationCase)
    if (!result.passed) failed += 1
  }
  return failed
}

function runContentChecks(content: string, evaluationCase: SkillEvaluationCase): CaseRunResult {
  const expected = evaluationCase.expected
  if (expected === undefined) return { passed: false, status: 'unknown', reason: 'no deterministic expectation supplied' }
  const missing = expected.contains?.filter(value => !content.includes(value)) ?? []
  const forbidden = expected.excludes?.filter(value => content.includes(value)) ?? []
  if (missing.length > 0) return { passed: false, reason: `missing required text: ${missing.join(', ')}` }
  if (forbidden.length > 0) return { passed: false, reason: `contains forbidden text: ${forbidden.join(', ')}` }
  return { passed: true, reason: 'content checks passed', evidence: [...expected.contains ?? []] }
}

function sameInvocationPolicy(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every(key => left[key] === right[key])
}

function emptyCategoryCounts(): Record<EvaluationCategory, { total: number; passed: number; failed: number }> {
  return {
    'original-failure': { total: 0, passed: 0, failed: 0 },
    'historical-success': { total: 0, passed: 0, failed: 0 },
    boundary: { total: 0, passed: 0, failed: 0 },
  }
}

function addCategory(
  categories: Record<EvaluationCategory, { total: number; passed: number; failed: number }>,
  category: EvaluationCategory,
  passed: boolean,
): void {
  categories[category].total += 1
  if (passed) categories[category].passed += 1
  else categories[category].failed += 1
}

function rate(category: { total: number; passed: number }): number {
  return category.total === 0 ? 1 : category.passed / category.total
}
