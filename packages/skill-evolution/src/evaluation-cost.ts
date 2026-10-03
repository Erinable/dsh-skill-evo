import { createHash } from 'node:crypto'
import type { EvaluationCategory, NormalizedEvaluationPolicy, SkillEvaluationCase } from './types.js'

export interface SkillContextCost {
  readonly estimator: 'utf8-bytes-div4-v1'
  readonly catalogTokens: number
  readonly loadTokens: number
}

export interface EvaluationSample {
  readonly caseId: string
  readonly category?: EvaluationCategory
  readonly exposure: 'base' | 'candidate'
  readonly sample: number
  readonly passed: boolean
  readonly status?: 'passed' | 'failed' | 'unknown'
  readonly toolCalls?: number
  readonly modelTurns?: number
  readonly tokenCost?: number
  readonly contextCost?: number
  readonly durationMs?: number
}

export interface MetricSummary {
  readonly n: number
  readonly mean?: number
  readonly variance?: number
  readonly min?: number
  readonly median?: number
  readonly max?: number
}

export interface MetricComparison {
  readonly status: 'ok' | 'no-data' | 'not-applicable'
  readonly base: MetricSummary
  readonly candidate: MetricSummary
  readonly comparableCases: number
  readonly relativeChange?: number
  readonly pValue?: number
}

export interface CostCheck {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'no-data' | 'not-applicable' | 'disabled'
  readonly detail: string
}

export interface EvaluationCostReport {
  readonly method: 'stratified-permutation-v1'
  readonly context: {
    readonly estimator: 'utf8-bytes-div4-v1'
    readonly base: SkillContextCost
    readonly candidate: SkillContextCost
    readonly delta: { readonly catalogTokens: number; readonly loadTokens: number }
  }
  readonly categories: Readonly<Record<EvaluationCategory, {
    readonly passRate: { readonly base: number; readonly candidate: number }
    readonly steps: MetricComparison
    readonly tokens: MetricComparison
    readonly modelTurns: MetricComparison
  }>>
  readonly checks: readonly CostCheck[]
  readonly unstable: readonly { readonly caseId: string; readonly exposure: 'base' | 'candidate'; readonly passRate: number }[]
}

export interface AnalyzeEvaluationCostInput {
  readonly cases: readonly SkillEvaluationCase[]
  readonly samples: readonly EvaluationSample[]
  readonly baseContent: string
  readonly candidateContent: string
  readonly candidateContentHash: string
  readonly policy: NormalizedEvaluationPolicy
}

export function measureSkillContext(content: string): SkillContextCost {
  const estimate = (value: string) => Math.ceil(Buffer.byteLength(value, 'utf8') / 4)
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? ''
  const values: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return { estimator: 'utf8-bytes-div4-v1', catalogTokens: estimate(values.name ?? '') + estimate(values.description ?? ''), loadTokens: estimate(content) }
}

export function analyzeEvaluationCost(input: AnalyzeEvaluationCostInput): EvaluationCostReport {
  const byCase = new Map<string, { base: EvaluationSample[]; candidate: EvaluationSample[] }>()
  for (const item of input.samples) {
    const entry = byCase.get(item.caseId) ?? { base: [], candidate: [] }
    entry[item.exposure].push(item)
    byCase.set(item.caseId, entry)
  }
  for (const entry of byCase.values()) {
    entry.base.sort((a, b) => a.sample - b.sample)
    entry.candidate.sort((a, b) => a.sample - b.sample)
  }
  const unstable: EvaluationCostReport['unstable'][number][] = []
  for (const [caseId, entry] of byCase) for (const exposure of ['base', 'candidate'] as const) {
    const all = entry[exposure]; const rate = all.length ? all.filter(sample => sample.passed).length / all.length : 0
    if (all.some(sample => sample.passed) && all.some(sample => !sample.passed)) unstable.push({ caseId, exposure, passRate: rate })
  }
  const categories = {} as { -readonly [K in EvaluationCategory]: EvaluationCostReport['categories'][K] }
  for (const category of ['original-failure', 'historical-success', 'boundary'] as const) {
    const ids = input.cases.filter(item => item.category === category).map(item => item.id)
    const entries = ids.map(id => byCase.get(id) ?? { base: [], candidate: [] })
    categories[category] = {
      passRate: { base: passRate(entries.flatMap(item => item.base)), candidate: passRate(entries.flatMap(item => item.candidate)) },
      steps: compareMetric(entries, 'toolCalls', input.candidateContentHash, category),
      tokens: compareMetric(entries, 'tokenCost', input.candidateContentHash, category),
      modelTurns: compareMetric(entries, 'modelTurns', input.candidateContentHash, category),
    }
  }
  const baseContext = measureSkillContext(input.baseContent)
  const candidateContext = measureSkillContext(input.candidateContent)
  const context = { estimator: 'utf8-bytes-div4-v1' as const, base: baseContext, candidate: candidateContext, delta: { catalogTokens: candidateContext.catalogTokens - baseContext.catalogTokens, loadTokens: candidateContext.loadTokens - baseContext.loadTokens } }
  const checks: CostCheck[] = []
  const original = categories['original-failure']
  const historical = categories['historical-success']
  const originalEntries = input.cases.filter(item => item.category === 'original-failure').map(item => ({ id: item.id, ...(byCase.get(item.id) ?? { base: [], candidate: [] }) }))
  const basePassed = originalEntries.filter(item => majority(item.base)).length
  const candidatePassed = originalEntries.filter(item => majority(item.candidate)).length
  const regressed = originalEntries.find(item => majority(item.base) && !majority(item.candidate))
  checks.push(regressed
    ? { id: 'original-failure-regressed', status: 'failed', detail: `Base passed; Candidate passed samples = ${itemPassCount(regressed.candidate)} of ${regressed.candidate.length}` }
    : { id: 'original-failure-regressed', status: 'passed', detail: 'no original-failure case regressed' })
  const metricName = input.policy.originalFailure.costMetric
  if (!input.policy.originalFailure.requireImprovement || metricName === null) checks.push({ id: 'original-failure-improvement', status: input.policy.originalFailure.requireImprovement ? 'disabled' : 'disabled', detail: 'disabled by policy' })
  else if (candidatePassed > basePassed) checks.push({ id: 'original-failure-improvement', status: 'passed', detail: 'path (a) pass count increased' })
  else {
    const violation = originalEntries.find(item => itemPassCount(item.candidate) < itemPassCount(item.base))
    const comparison = metricComparisonFor(metricName, original)
    const significant = metricName === 'steps-or-tokens' ? (isGood(original.steps, input.policy.originalFailure.minCostReduction, input.policy.significance.alpha / 2) || isGood(original.tokens, input.policy.originalFailure.minCostReduction, input.policy.significance.alpha / 2))
      : metricName === 'steps-and-tokens' ? (isGood(original.steps, input.policy.originalFailure.minCostReduction, input.policy.significance.alpha) && isGood(original.tokens, input.policy.originalFailure.minCostReduction, input.policy.significance.alpha))
      : isGood(comparison, input.policy.originalFailure.minCostReduction, input.policy.significance.alpha)
    const status = !comparison || comparison.status === 'no-data' ? 'no-data' : violation || !significant ? 'failed' : 'passed'
    const detail = violation ? `path (a) pass count did not increase; path (b1) ${violation.id}: k_b = ${itemPassCount(violation.base)}, k_c = ${itemPassCount(violation.candidate)}` : status === 'no-data' ? `original-failure ${metricName}: no comparable passed Sample contains ${metricName}` : `path (b2) ${metricName}: relativeChange = ${comparison?.relativeChange}, pValue = ${comparison?.pValue}`
    checks.push({ id: 'original-failure-improvement', status, detail })
    if (status === 'no-data') checks.push({ id: `original-failure-${metricName}-no-data`, status: 'no-data', detail: `no comparable passed Sample contains ${metricName}` })
  }
  checks.push(...historicalChecks(historical, input.policy))
  checks.push(contextCheck('catalog-context', context.delta.catalogTokens, input.policy.context.maxCatalogIncreaseTokens, 'catalog context increase exceeded policy'))
  checks.push(contextCheck('load-context', context.delta.loadTokens, input.policy.context.maxLoadIncreaseTokens, 'load context increase exceeded policy'))
  return { method: 'stratified-permutation-v1', context, categories, checks, unstable }
}

function contextCheck(id: string, delta: number, limit: number | null, message: string): CostCheck {
  if (limit === null) return { id, status: 'disabled', detail: 'disabled by policy' }
  return delta > limit ? { id, status: 'failed', detail: `delta = ${delta}, limit = ${limit}` } : { id, status: 'passed', detail: `delta = ${delta}, limit = ${limit}` }
}

function historicalChecks(category: EvaluationCostReport['categories'][EvaluationCategory], policy: NormalizedEvaluationPolicy): CostCheck[] {
  const checks: CostCheck[] = []
  const drop = category.passRate.base - category.passRate.candidate
  const passLimit = policy.historicalSuccess.maxPassRateDrop
  checks.push(drop > passLimit ? { id: `historical-success-pass-rate-schema${policy.schema}`, status: 'failed', detail: `schema ${policy.schema}; base = ${category.passRate.base}, candidate = ${category.passRate.candidate}, drop = ${drop}, limit = ${passLimit}` } : { id: `historical-success-pass-rate-schema${policy.schema}`, status: 'passed', detail: `schema ${policy.schema}; base = ${category.passRate.base}, candidate = ${category.passRate.candidate}, drop = ${drop}, limit = ${passLimit}` })
  for (const [metric, limit, comparison] of [['steps', policy.historicalSuccess.maxStepIncrease, category.steps], ['tokens', policy.historicalSuccess.maxTokenIncrease, category.tokens] ] as const) {
    const id = `historical-success-${metric}`
    if (limit === null) checks.push({ id, status: 'disabled', detail: 'disabled by policy' })
    else if (comparison.status === 'no-data') checks.push({ id: `${id}-no-data`, status: 'no-data', detail: `no comparable passed Sample contains ${metric}` })
    else if (comparison.status === 'not-applicable') checks.push({ id, status: 'not-applicable', detail: 'no comparable passed cases' })
    else checks.push(comparison.relativeChange !== undefined && comparison.relativeChange > limit ? { id, status: 'failed', detail: `relativeChange = ${comparison.relativeChange}, limit = ${limit}` } : { id, status: 'passed', detail: `relativeChange = ${comparison.relativeChange}, limit = ${limit}` })
  }
  return checks
}

function compareMetric(entries: { base: EvaluationSample[]; candidate: EvaluationSample[] }[], key: 'toolCalls' | 'tokenCost' | 'modelTurns', hash: string, category: EvaluationCategory): MetricComparison {
  const comparable = entries.filter(entry => majority(entry.base) && majority(entry.candidate))
  if (comparable.length === 0) return { status: 'not-applicable', base: summary([]), candidate: summary([]), comparableCases: 0 }
  const baseValues = comparable.flatMap(entry => entry.base.filter(sample => sample.passed && sample[key] !== undefined).map(sample => sample[key]!))
  const candidateValues = comparable.flatMap(entry => entry.candidate.filter(sample => sample.passed && sample[key] !== undefined).map(sample => sample[key]!))
  if (baseValues.length !== comparable.reduce((n, entry) => n + entry.base.filter(sample => sample.passed).length, 0) || candidateValues.length !== comparable.reduce((n, entry) => n + entry.candidate.filter(sample => sample.passed).length, 0)) return { status: 'no-data', base: summary(baseValues), candidate: summary(candidateValues), comparableCases: comparable.length }
  const base = summary(baseValues); const candidate = summary(candidateValues)
  const relativeChange = base.mean === 0 ? (candidate.mean === 0 ? 0 : undefined) : (candidate.mean! - base.mean!) / base.mean!
  return { status: 'ok', base, candidate, comparableCases: comparable.length, ...(relativeChange === undefined ? {} : { relativeChange }), pValue: permutation(comparable, key, hash, category) }
}

function summary(values: number[]): MetricSummary {
  if (!values.length) return { n: 0 }
  const sorted = [...values].sort((a, b) => a - b); const mean = values.reduce((a, b) => a + b, 0) / values.length
  return { n: values.length, mean, variance: values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : undefined, min: sorted[0], median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2, max: sorted[sorted.length - 1] }
}

function majority(values: EvaluationSample[]): boolean { return values.length > 0 && values.filter(item => item.passed).length * 2 > values.length }
function itemPassCount(values: EvaluationSample[]): number { return values.filter(item => item.passed).length }
function passRate(values: EvaluationSample[]): number { return values.length ? itemPassCount(values) / values.length : 0 }
function metricComparisonFor(metric: NonNullable<NormalizedEvaluationPolicy['originalFailure']['costMetric']>, category: EvaluationCostReport['categories'][EvaluationCategory]): MetricComparison | undefined { return metric === 'tokens' ? category.tokens : category.steps }
function isGood(comparison: MetricComparison | undefined, reduction: number, alpha: number): boolean { return comparison?.status === 'ok' && comparison.relativeChange !== undefined && comparison.relativeChange <= -reduction && comparison.pValue !== undefined && comparison.pValue <= alpha }

function permutation(entries: { base: EvaluationSample[]; candidate: EvaluationSample[] }[], key: 'toolCalls' | 'tokenCost' | 'modelTurns', hash: string, category: EvaluationCategory): number {
  const layers = entries.map(entry => ({ base: entry.base.filter(item => item.passed).map(item => item[key]!), candidate: entry.candidate.filter(item => item.passed).map(item => item[key]!) }))
  const total = layers.reduce((product, layer) => product * binomial(layer.base.length + layer.candidate.length, layer.base.length), 1)
  const observed = statistic(layers)
  if (total <= 10000) { let extreme = 0; enumerate(layers, 0, [], value => { if (value >= observed - 1e-9) extreme++ }); return extreme / total }
  const seed = createHash('sha256').update(`${hash}\n${category}\n${key === 'toolCalls' ? 'steps' : key === 'tokenCost' ? 'tokens' : 'modelTurns'}`).digest(); let counter = 0; let buffer = Buffer.alloc(0); let extreme = 0
  const nextInt = (n: number) => { const limit = 0x100000000 - (0x100000000 % n); while (true) { if (buffer.length < 4) { buffer = Buffer.concat([buffer, createHash('sha256').update(Buffer.concat([seed, uint32(counter++)])).digest()]) } const value = buffer.readUInt32BE(0); buffer = buffer.subarray(4); if (value < limit) return value % n } }
  for (let draw = 0; draw < 10000; draw++) { const sampled = layers.map(layer => { const values = [...layer.base, ...layer.candidate]; for (let k = values.length - 1; k > 0; k--) { const j = nextInt(k + 1); [values[k], values[j]] = [values[j]!, values[k]!] } return { base: values.slice(0, layer.base.length), candidate: values.slice(layer.base.length) } }); if (statistic(sampled) >= observed - 1e-9) extreme++ }
  return (1 + extreme) / 10001
}

function uint32(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32BE(value); return result }
function statistic(layers: { base: number[]; candidate: number[] }[]): number { return layers.reduce((sum, layer) => sum + mean(layer.base) - mean(layer.candidate), 0) }
function mean(values: number[]): number { return values.reduce((a, b) => a + b, 0) / values.length }
function binomial(n: number, k: number): number { let result = 1; for (let i = 1; i <= k; i++) result = result * (n - k + i) / i; return Math.round(result) }
function enumerate(layers: { base: number[]; candidate: number[] }[], index: number, chosen: { base: number[]; candidate: number[] }[], callback: (value: number) => void): void {
  if (index === layers.length) { callback(statistic(chosen)); return }
  const layer = layers[index]!; const all = [...layer.base, ...layer.candidate]; const choose = layer.base.length
  for (const indices of combinationIndices(all.length, choose)) { const selectedSet = new Set(indices); enumerate(layers, index + 1, [...chosen, { base: indices.map(i => all[i]!), candidate: all.filter((_, i) => !selectedSet.has(i)) }], callback) }
}
function combinationIndices(length: number, count: number, start = 0, prefix: number[] = []): number[][] { if (prefix.length === count) return [prefix]; const result: number[][] = []; for (let i = start; i <= length - (count - prefix.length); i++) result.push(...combinationIndices(length, count, i + 1, [...prefix, i])); return result }
