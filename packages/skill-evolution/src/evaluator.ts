import type { EvaluationSample } from './evaluation-cost.js'
import { analyzeEvaluationCost } from './evaluation-cost.js'
import type { CaseEvaluation, EvaluationCategory, EvaluationPolicy, EvaluationPolicyInput, SkillEvalResult, SkillEvaluationCase } from './types.js'
import { createContentHash } from './events.js'
import { normalizeEvaluationPolicy, normalizedPolicyHash } from './policy.js'

export const DEFAULT_EVALUATION_POLICY: EvaluationPolicy = {
  version: '1',
  maxRegressionCount: 0,
  maxSecurityViolations: 0,
  requireNoNewSideEffects: true,
  requireOriginalFailureImprovement: true,
}

export interface CaseRunResult {
  readonly passed: boolean
  readonly status?: 'passed' | 'failed' | 'unknown'
  readonly reason?: string
  readonly evidence?: readonly string[]
  readonly tokenCost?: number
  readonly contextCost?: number
  readonly toolCalls?: number
  readonly modelTurns?: number
  readonly sideEffects?: readonly string[]
  readonly securityViolations?: readonly string[]
  readonly positiveFeedback?: boolean
  readonly durationMs?: number
}

export type EvaluationRunner = (
  content: string,
  evaluationCase: SkillEvaluationCase,
  context?: { readonly exposure: 'base' | 'candidate'; readonly sample: number },
) => CaseRunResult | Promise<CaseRunResult>

export interface EvaluateCandidateInput {
  readonly candidateId: string
  readonly baseContent: string
  readonly candidateContent: string
  readonly cases: readonly SkillEvaluationCase[]
  readonly runner?: EvaluationRunner
  readonly expectedSkillName?: string
  readonly now?: () => number
  readonly policy?: EvaluationPolicyInput
}

/** Evaluate a candidate against original, historical, and boundary evidence. */
export async function evaluateCandidate(input: EvaluateCandidateInput): Promise<SkillEvalResult> {
  validateEvaluationInput(input.cases)
  const normalizedPolicy = normalizeEvaluationPolicy(input.policy ?? DEFAULT_EVALUATION_POLICY)
  const started = input.now?.() ?? Date.now()
  const validation = validateSkillDocument(input.candidateContent, input.expectedSkillName)
  const baseValidation = validateSkillDocument(input.baseContent, input.expectedSkillName)
  const changeValidation = validateSkillCandidate(input.baseContent, input.candidateContent, input.expectedSkillName)
  const invocationPolicyUnchanged = sameInvocationPolicy(baseValidation.invocationPolicy, validation.invocationPolicy)
  const runner = input.runner ?? runContentChecks
  const runs = normalizedPolicy.sampling.runs; const createdAt = new Date().toISOString()
  const samples: EvaluationSample[] = []
  const raw = new Map<string, { base: CaseRunResult[]; candidate: CaseRunResult[] }>()
  const durations = new Map<string, number>()
  let securityViolations = 0; let candidateSideEffects = 0; let baselineSideEffects = 0; let positiveFeedback = false
  for (let sample = 0; sample < runs; sample++) for (const evaluationCase of input.cases) {
    const entry = raw.get(evaluationCase.id) ?? { base: [], candidate: [] }
    const call = async (exposure: 'base' | 'candidate', content: string, valid: boolean) => valid ? runner(content, evaluationCase, { exposure, sample }) : { passed: false, status: 'unknown' as const, reason: `${exposure} Skill document is invalid` }
    const baselineRun = await call('base', input.baseContent, baseValidation.valid); entry.base.push(baselineRun)
    const candidateStarted = Date.now()
    const candidateRun = await call('candidate', input.candidateContent, validation.valid); entry.candidate.push(candidateRun)
    durations.set(evaluationCase.id, (durations.get(evaluationCase.id) ?? 0) + (candidateRun.durationMs ?? Math.max(0, Date.now() - candidateStarted)))
    const addSample = (exposure: 'base' | 'candidate', result: CaseRunResult) => samples.push({ caseId: evaluationCase.id, category: evaluationCase.category, exposure, sample, passed: result.passed === true, status: result.status ?? (result.passed ? 'passed' : 'failed'), ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }), ...(result.modelTurns === undefined ? {} : { modelTurns: result.modelTurns }), ...(result.tokenCost === undefined ? {} : { tokenCost: result.tokenCost }), ...(result.contextCost === undefined ? {} : { contextCost: result.contextCost }) })
    addSample('base', baselineRun); addSample('candidate', candidateRun); raw.set(evaluationCase.id, entry)
    securityViolations += candidateRun.securityViolations?.length ?? 0; candidateSideEffects += candidateRun.sideEffects?.length ?? 0; baselineSideEffects += baselineRun.sideEffects?.length ?? 0; positiveFeedback ||= candidateRun.positiveFeedback === true
  }
  const baseline = emptyCategoryCounts(); const categories = emptyCategoryCounts(); const results: CaseEvaluation[] = []; const regressions: string[] = []
  for (const evaluationCase of input.cases) {
    const entry = raw.get(evaluationCase.id)!; const baseFold = foldSamples(entry.base); const candidateFold = foldSamples(entry.candidate)
    addCategory(baseline, evaluationCase.category, baseFold.passed); addCategory(categories, evaluationCase.category, candidateFold.passed)
    if (baseFold.passed && !candidateFold.passed && evaluationCase.category !== 'original-failure') regressions.push(evaluationCase.id)
    results.push({ caseId: evaluationCase.id, category: evaluationCase.category, passed: candidateFold.passed, status: candidateFold.status, reason: candidateFold.reason, evidence: [...candidateFold.evidence], durationMs: durations.get(evaluationCase.id) ?? 0 })
  }
  const cost = analyzeEvaluationCost({ cases: input.cases, samples, baseContent: input.baseContent, candidateContent: input.candidateContent, candidateContentHash: createContentHash(input.candidateContent), policy: normalizedPolicy })
  const gateReasons: string[] = []
  if (!validation.valid) gateReasons.push(...validation.errors.map(error => `schema: ${error}`)); gateReasons.push(...changeValidation.errors.map(error => `candidate: ${error}`))
  if (!invocationPolicyUnchanged) gateReasons.push('invocation policy changed'); if (securityViolations > normalizedPolicy.maxSecurityViolations) gateReasons.push('security violation limit exceeded'); if (normalizedPolicy.requireNoNewSideEffects && candidateSideEffects > baselineSideEffects) gateReasons.push('new side effects detected'); if (regressions.length > normalizedPolicy.maxRegressionCount) gateReasons.push('regression limit exceeded'); if (normalizedPolicy.requirePositiveFeedback && !positiveFeedback) gateReasons.push('positive feedback required')
  for (const check of cost.checks.filter(check => (check.status === 'failed' || check.status === 'no-data') && check.id !== 'original-failure-regressed')) gateReasons.push(costGateReason(check.id, check.detail, normalizedPolicy))
  const baseOriginalPassed = input.cases.filter(item => item.category === 'original-failure').filter(item => foldSamples(raw.get(item.id)!.base).passed).length
  const candidateOriginalPassed = input.cases.filter(item => item.category === 'original-failure').filter(item => foldSamples(raw.get(item.id)!.candidate).passed).length
  if (normalizedPolicy.schema === 1 && normalizedPolicy.originalFailure.requireImprovement && candidateOriginalPassed <= baseOriginalPassed) gateReasons.push('original-failure pass count did not improve')
  if (normalizedPolicy.schema === 1) { if (normalizedPolicy.legacy.maxTokenIncreaseRatio !== undefined && !hasMetric(samples, 'tokenCost')) gateReasons.push('token cost: no data'); if (normalizedPolicy.legacy.maxContextIncreaseRatio !== undefined && !hasMetric(samples, 'contextCost')) gateReasons.push('context cost: no data') }
  if (normalizedPolicy.schema === 1) {
    const sum = (key: 'tokenCost' | 'contextCost', exposure: 'base' | 'candidate') => samples.filter(item => item.exposure === exposure && item[key] !== undefined).reduce((total, item) => total + item[key]!, 0)
    const baseTokens = sum('tokenCost', 'base'); const candidateTokens = sum('tokenCost', 'candidate'); const baseContext = sum('contextCost', 'base'); const candidateContext = sum('contextCost', 'candidate')
    if (normalizedPolicy.legacy.maxTokenIncreaseRatio !== undefined && baseTokens > 0 && candidateTokens / baseTokens - 1 > normalizedPolicy.legacy.maxTokenIncreaseRatio) gateReasons.push('token cost increase exceeded policy')
    if (normalizedPolicy.legacy.maxContextIncreaseRatio !== undefined && baseContext > 0 && candidateContext / baseContext - 1 > normalizedPolicy.legacy.maxContextIncreaseRatio) gateReasons.push('context cost increase exceeded policy')
  }
  for (const evaluationCase of input.cases.filter(item => item.category === 'original-failure')) {
    const entry = raw.get(evaluationCase.id)!
    if (foldSamples(entry.base).passed && !foldSamples(entry.candidate).passed) gateReasons.push(`original-failure case regressed: ${evaluationCase.id}`)
  }
  const highBoundary = input.cases.filter(item => item.category === 'boundary' && item.severity === 'high')
  const baseBoundaryFailures = highBoundary.filter(item => !foldSamples(raw.get(item.id)!.base).passed).length
  const candidateBoundaryFailures = highBoundary.filter(item => !foldSamples(raw.get(item.id)!.candidate).passed).length
  if (candidateBoundaryFailures > baseBoundaryFailures) gateReasons.push('new high-severity boundary failure')
  if (categories['original-failure'].total === 0) gateReasons.push('no original-failure cases')
  const total = results.length; const passed = results.filter(result => result.passed).length; const unknown = results.filter(result => result.status === 'unknown').length; const hardReject = securityViolations > normalizedPolicy.maxSecurityViolations || regressions.length > normalizedPolicy.maxRegressionCount
  return { candidateId: input.candidateId, total, passed, failed: total - passed - unknown, unknown, categories, baseline, regressions, gateReasons, caseResults: results, durationMs: Math.max(0, (input.now?.() ?? Date.now()) - started), schemaValid: validation.valid, invocationPolicyUnchanged, passedGate: gateReasons.length === 0, decision: gateReasons.length === 0 ? 'passed' : (hardReject ? 'rejected' : 'needs-review'), policyVersion: normalizedPolicy.version, ...(normalizedPolicy.schema === 2 ? { schemaVersion: 2 as const, policy: normalizedPolicy, policyHash: normalizedPolicyHash(normalizedPolicy), statisticId: 'stratified-permutation-v1' } : {}), baseContentHash: createContentHash(input.baseContent), candidateContentHash: createContentHash(input.candidateContent), caseIds: input.cases.map(item => item.id), createdAt, cost, samples }
}

function foldSamples(values: readonly CaseRunResult[]): { passed: boolean; status: 'passed' | 'failed' | 'unknown'; reason: string; evidence: readonly string[] } {
  const passed = values.filter(value => value.passed === true).length
  const unknown = values.filter(value => value.status === 'unknown').length
  if (unknown * 2 >= values.length && passed * 2 <= values.length) return { passed: false, status: 'unknown', reason: 'unknown', evidence: values.flatMap(value => value.evidence ?? []) }
  if (passed * 2 > values.length) return { passed: true, status: 'passed', reason: 'passed', evidence: values.flatMap(value => value.evidence ?? []) }
  return { passed: false, status: 'failed', reason: values.find(value => value.reason)?.reason ?? 'failed', evidence: values.flatMap(value => value.evidence ?? []) }
}
function hasMetric(samples: readonly EvaluationSample[], key: 'tokenCost' | 'contextCost'): boolean { return samples.some(sample => sample[key] !== undefined) }
function costGateReason(id: string, detail: string, policy: ReturnType<typeof normalizeEvaluationPolicy>): string {
  if (id === 'original-failure-improvement') return 'original-failure did not improve'
  if (id.endsWith('-no-data')) {
    const metric = id.replace(/^(?:original-failure|historical-success)-/, '').replace(/-no-data$/, '')
    return `${id.startsWith('original-failure') ? 'original-failure' : 'historical-success'} ${metric}: no data`
  }
  if (id === 'historical-success-pass-rate-schema2') return `historical-success pass rate regressed by more than ${policy.historicalSuccess.maxPassRateDrop}`
  if (id === 'historical-success-pass-rate-schema1') return 'historical-success pass rate regressed by more than five points'
  if (id === 'historical-success-steps') return 'historical-success steps increase exceeded policy'
  if (id === 'historical-success-tokens') return 'historical-success tokens increase exceeded policy'
  if (id === 'catalog-context') return 'catalog context increase exceeded policy'
  if (id === 'load-context') return 'load context increase exceeded policy'
  return detail
}

function validateEvaluationInput(cases: readonly SkillEvaluationCase[]): void {
  if (cases.length === 0) throw new Error('evaluation requires at least one case')
  const ids = new Set<string>()
  for (const item of cases) {
    if (item.id.length === 0 || ids.has(item.id)) throw new Error(`evaluation case IDs must be unique and non-empty: ${item.id}`)
    ids.add(item.id)
    if (!['original-failure', 'historical-success', 'boundary'].includes(item.category)) throw new Error(`invalid evaluation category for ${item.id}`)
  }
}

export interface SkillDocumentValidation {
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly name?: string
  readonly invocationPolicy: Readonly<Record<string, string>>
}

export interface SkillCandidateValidation {
  readonly valid: boolean
  readonly errors: readonly string[]
}

/** Enforce the file and frontmatter boundary before a candidate can be published. */
export function validateSkillCandidate(baseContent: string, candidateContent: string, expectedName?: string): SkillCandidateValidation {
  const errors: string[] = []
  if (Buffer.byteLength(candidateContent, 'utf8') > 256 * 1024) errors.push('candidate exceeds 256 KiB')
  if (/<\/?script\b/i.test(candidateContent)) errors.push('script tags are not allowed')
  if (baseContent.length === 0) return { valid: errors.length === 0, errors }
  const baseFrontmatter = frontmatterBlock(baseContent)
  const candidateFrontmatter = frontmatterBlock(candidateContent)
  if (baseFrontmatter === undefined || candidateFrontmatter === undefined) errors.push('frontmatter boundary is invalid')
  else {
    const baseValues = parseFrontmatter(baseFrontmatter)
    const candidateValues = parseFrontmatter(candidateFrontmatter)
    if (candidateValues.name !== baseValues.name) errors.push('frontmatter name cannot change')
    if (expectedName !== undefined && candidateValues.name !== expectedName) errors.push(`frontmatter name must be ${expectedName}`)
    for (const key of ['disable-model-invocation', 'user-invocable', 'model-invocable']) {
      if (candidateValues[key] !== baseValues[key]) errors.push(`invocation policy field ${key} cannot change`)
    }
  }
  return { valid: errors.length === 0, errors }
}

/** Validate the small frontmatter contract without depending on a YAML runtime. */
export function validateSkillDocument(content: string, expectedName?: string): SkillDocumentValidation {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)
  if (match === null) return { valid: false, errors: ['missing YAML frontmatter'], invocationPolicy: {} }
  const values = parseFrontmatter(match[1]!)
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

function frontmatterBlock(content: string): string | undefined {
  return content.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)?.[1]
}

function parseFrontmatter(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    values[key] = value
  }
  return values
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
