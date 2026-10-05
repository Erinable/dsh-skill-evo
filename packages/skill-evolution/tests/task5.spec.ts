import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateCandidate } from '../src/evaluator.js'
import { EvolutionService } from '../src/service.js'
import { createProposal } from '../src/proposal.js'
import { isPatternScopeAllowed } from '../src/correction.js'

const baseCases = [
  { id: 'failure', category: 'original-failure' as const, task: 'recover' },
  { id: 'boundary', category: 'boundary' as const, severity: 'high' as const, task: 'boundary' },
]
const skill = '---\nname: generated\ndescription: generated\n---\n\nUse the procedure.\n'

describe('Task 5 safety contracts', () => {
  it('runs absent-Base baseline and candidate for original and high-boundary cases, while preserving invocation policy checks', async () => {
    const calls: string[] = []
    const result = await evaluateCandidate({
      candidateId: 'absent', baseContent: '', candidateContent: skill, cases: baseCases,
      runner: async (content, item, context) => { calls.push(`${context!.exposure}:${item.id}:${content.length}`); return { passed: context!.exposure === 'candidate' } },
    })
    expect(calls).toEqual(expect.arrayContaining(['base:failure:0', 'base:boundary:0']))
    expect(calls.filter(call => call.startsWith('candidate:failure:'))).toHaveLength(1)
    expect(calls.filter(call => call.startsWith('candidate:boundary:'))).toHaveLength(1)
    expect(result.baseline['original-failure'].total).toBe(1)
    const changed = await evaluateCandidate({ candidateId: 'changed', baseContent: '', candidateContent: skill.replace('description:', 'disable-model-invocation: true\ndescription:'), cases: baseCases, runner: async () => ({ passed: true }) })
    expect(changed.invocationPolicyUnchanged).toBe(false)
    expect(changed.passedGate).toBe(false)
    expect(changed.gateReasons).toContain('invocation policy changed')
  })

  it('requires a passing artifact before accepting pattern proposals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task5-gate-'))
    await mkdir(join(root, 'generated'), { recursive: true }); await writeFile(join(root, 'generated', 'SKILL.md'), skill)
    const service = new EvolutionService({ root })
    const proposal = createProposal({ id: 'pattern-gate', skillName: 'generated', baseVersion: 'unversioned', baseContent: skill, proposedVersion: '1.0.0', candidateContent: skill.replace('procedure', 'changed'), intent: 'change', source: { kind: 'pattern', patternId: 'pattern:x' } })
    const proposed = await service.stageProposal(proposal)
    const evaluated = await service.evaluate(proposed, [{ id: 'failure', category: 'original-failure', task: 'recover' }], async () => ({ passed: false }))
    const record = (await service.proposals.readAll()).at(-1)!
    await expect(service.acceptProposal(record, 'review')).rejects.toMatchObject({ code: 'gate-failed' })
    expect((await service.proposals.readAll()).some(item => item.status === 'accepted')).toBe(false)
    expect(evaluated.passedGate).toBe(false)
  })

  it('uses the correction policy allowlist for create-skill and environmental publication scopes', () => {
    const create = { operation: 'create-skill' as const, source: { kind: 'pattern' as const } }
    const environmental = { operation: 'patch-content' as const, source: { kind: 'pattern' as const, environmental: true } }
    for (const proposal of [create, environmental]) {
      expect(isPatternScopeAllowed(proposal, 'stable')).toBe(false)
      expect(isPatternScopeAllowed(proposal, 'explicit-only')).toBe(false)
      expect(isPatternScopeAllowed(proposal, 'project')).toBe(true)
      expect(isPatternScopeAllowed(proposal, 'user')).toBe(true)
    }
  })

  it('keeps recognizer and designer modules independent of lifecycle mutation modules', async () => {
    for (const file of ['src/correction.ts', 'src/pattern-design.ts']) {
      const source = await readFile(join(dirname(new URL(import.meta.url).pathname), '..', file), 'utf8')
      expect(source).not.toMatch(/from ['"]\.\/(?:lifecycle|operations|service|publication)\.js['"]|from ['"]\.\.\/.*(?:lifecycle|operations|service|publication)/u)
    }
  })
})
