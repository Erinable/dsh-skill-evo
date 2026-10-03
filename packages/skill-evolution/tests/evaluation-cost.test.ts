import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { analyzeEvaluationCost, measureSkillContext, type EvaluationSample } from '../src/evaluation-cost.js'
import { normalizeEvaluationPolicy } from '../src/policy.js'

const policy = (extra: Record<string, unknown> = {}) => normalizeEvaluationPolicy({ schema: 2 as const, version: '2', maxRegressionCount: 0, maxSecurityViolations: 0, requireNoNewSideEffects: true, ...extra } as never)
const cases = (ids: string[], category: 'original-failure' | 'historical-success' = 'original-failure') => ids.map(id => ({ id, category, task: id }))
function samples(caseId: string, base: number[], candidate: number[], key: 'toolCalls' | 'tokenCost' = 'toolCalls'): EvaluationSample[] {
  return [...base.map((value, sample) => ({ caseId, exposure: 'base' as const, sample, passed: true, [key]: value })), ...candidate.map((value, sample) => ({ caseId, exposure: 'candidate' as const, sample, passed: true, [key]: value }))]
}
function report(inputSamples: EvaluationSample[], inputCases = cases(['case']), configured = {}) {
  return analyzeEvaluationCost({ cases: inputCases, samples: inputSamples, baseContent: '---\nname: x\ndescription: old\n---\nbody', candidateContent: '---\nname: x\ndescription: new\n---\nbody', candidateContentHash: 'hash', policy: policy(configured) })
}

describe('evaluation cost analysis', () => {
  it('estimates UTF-8 bytes divided by four and catalog/load separately', () => {
    const result = measureSkillContext('---\nname: 你\ndescription: ab\n---\n正文')
    expect(result.estimator).toBe('utf8-bytes-div4-v1')
    expect(result.catalogTokens).toBe(Math.ceil(Buffer.byteLength('你', 'utf8') / 4) + Math.ceil(Buffer.byteLength('ab', 'utf8') / 4))
    expect(result.loadTokens).toBe(Math.ceil(Buffer.byteLength('---\nname: 你\ndescription: ab\n---\n正文', 'utf8') / 4))
  })

  it('filters to comparable passed cases and weights each case equally', () => {
    const result = report([...samples('a', [10, 10, 10, 10, 10], [10]), ...samples('b', [0], [0, 0, 0, 0, 0])], cases(['a', 'b'], 'historical-success'))
    expect(result.categories['historical-success'].steps.base.mean).toBe(5)
    expect(result.categories['historical-success'].steps.candidate.mean).toBe(5)
    expect(result.categories['historical-success'].steps.comparableCases).toBe(2)
  })

  it('reports summaries and no-data checks', () => {
    const result = report(samples('case', [6, 6, 6, 6, 6], [2, 2, 2, 2, 2]).map(item => ({ ...item, toolCalls: undefined })))
    expect(result.categories['original-failure'].steps.status).toBe('no-data')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'original-failure-steps-no-data', status: 'no-data' }))
  })

  it('uses stable ids and schema-specific detail messages', () => {
    const historical = report(samples('h', [4, 4, 4, 4, 4], [5, 5, 5, 5, 5], 'toolCalls'), cases(['h'], 'historical-success'), { historicalSuccess: { maxStepIncrease: 0.1 } })
    expect(historical.checks).toContainEqual(expect.objectContaining({ id: 'historical-success-pass-rate-schema2', detail: expect.stringContaining('limit = 0.05') }))
    const original = report(samples('case', [6, 6, 6, 6, 6], [2, 2, 2, 2, 2]))
    expect(original.checks).toContainEqual(expect.objectContaining({ id: 'original-failure-improvement', detail: expect.stringContaining('path (a) pass count did not increase;') }))
  })

  it('returns exact 1/252 for a constant 6-to-2 reduction', () => {
    const result = report(samples('case', [6, 6, 6, 6, 6], [2, 2, 2, 2, 2]))
    expect(result.categories['original-failure'].steps.pValue).toBe(1 / 252)
  })

  it('applies alpha correctly to compound metrics', () => {
    const input = samples('case', [6, 6, 6, 6, 6], [2, 2, 2, 2, 2]).map((item, index) => ({ ...item, tokenCost: item.exposure === 'base' ? 100 : 50 }))
    const either = report(input, cases(['case']), { originalFailure: { costMetric: 'steps-or-tokens', minCostReduction: 0.2 }, significance: { alpha: 0.01 } })
    const both = report(input, cases(['case']), { originalFailure: { costMetric: 'steps-and-tokens', minCostReduction: 0.2 }, significance: { alpha: 0.01 } })
    expect(either.checks.find(check => check.id === 'original-failure-improvement')?.status).toBe('passed')
    expect(both.checks.find(check => check.id === 'original-failure-improvement')?.status).toBe('passed')
  })

  it('matches an independently implemented sampled reference vector', () => {
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const input = [...samples('a', [6, 6, 6, 6, 6], [2, 2, 2, 2, 2]), ...samples('b', [4, 4, 4, 4, 4], [3, 3, 3, 3, 3])]
    const result = analyzeEvaluationCost({ cases: cases(['a', 'b']), samples: input, baseContent: '', candidateContent: '', candidateContentHash: hash, policy: policy() })
    expect(result.categories['original-failure'].steps.pValue).toBe(0.00009999000099990002)
    expect(referenceSampledPValue(hash, [[6, 6, 6, 6, 6], [4, 4, 4, 4, 4]], [[2, 2, 2, 2, 2], [3, 3, 3, 3, 3]])).toBe(0.00009999000099990002)
  })
})

function referenceSampledPValue(hash: string, baseLayers: number[][], candidateLayers: number[][]): number {
  const seed = createHash('sha256').update(`${hash}\noriginal-failure\nsteps`).digest()
  let block = 0
  let bytes = Buffer.alloc(0)
  const nextInt = (size: number) => {
    const limit = 0x100000000 - (0x100000000 % size)
    while (true) {
      if (bytes.length < 4) bytes = Buffer.concat([bytes, createHash('sha256').update(Buffer.concat([seed, uint32(block++)])).digest()])
      const value = bytes.readUInt32BE(0)
      bytes = bytes.subarray(4)
      if (value < limit) return value % size
    }
  }
  const observed = baseLayers.reduce((sum, values, index) => sum + average(values) - average(candidateLayers[index]!), 0)
  let tail = 0
  for (let draw = 0; draw < 10000; draw++) {
    const statistic = baseLayers.reduce((sum, values, index) => {
      const all = [...values, ...candidateLayers[index]!]
      for (let k = all.length - 1; k > 0; k--) {
        const j = nextInt(k + 1)
        ;[all[k], all[j]] = [all[j]!, all[k]!]
      }
      return sum + average(all.slice(0, values.length)) - average(all.slice(values.length))
    }, 0)
    if (statistic >= observed - 1e-9) tail++
  }
  return (1 + tail) / 10001
}
function uint32(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32BE(value); return result }
function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length }
