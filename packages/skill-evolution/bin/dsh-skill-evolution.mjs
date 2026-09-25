#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  EvolutionService,
  renderFailuresMarkdown,
  renderProposalMarkdown,
  createProposal,
  MaintenanceWorker,
  rotateJsonl,
} from '../lib/index.js'

const args = process.argv.slice(2)
const command = args.shift()
const root = resolve(value('--root') ?? process.env.DSH_SKILL_EVOLUTION_ROOT ?? process.cwd())
const storePath = value('--store')
const policyPath = value('--policy')
const service = new EvolutionService({ root, ...(storePath === undefined ? {} : { store: resolve(storePath) }), ...(policyPath === undefined ? {} : { evaluationPolicy: JSON.parse(readFileSync(resolve(policyPath), 'utf8')) }) })

try {
  if (command === 'version') {
    console.log(JSON.stringify({ name: '@dsh-skill-evo/core', version: '0.1.0', schemaVersion: 1 }, null, 2))
    process.exit(0)
  }
  switch (command) {
    case 'observe': await observe(); break
    case 'failures': await failures(); break
    case 'metrics': await metrics(); break
    case 'health': await health(); break
    case 'feedback': await feedback(); break
    case 'propose': await propose(); break
    case 'evaluate': await evaluate(); break
    case 'accept': await accept(); break
    case 'reject': await reject(); break
    case 'defer': await defer(); break
    case 'promote': await promote(); break
    case 'rollback': await rollback(); break
    case 'repair': await repair(); break
    case 'worker': await worker(); break
    case 'rotate': await rotate(); break
    default: usage(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

function value(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const result = args[index + 1]
  args.splice(index, result === undefined ? 1 : 2)
  return result
}

function required(name) {
  const result = value(name)
  if (result === undefined || result.length === 0) throw new Error(`missing ${name}`)
  return result
}

async function observe() {
  const snapshot = await service.refreshDerived()
  console.log(JSON.stringify({ root, observations: (await service.observations.readAll()).length, ...snapshot }, null, 2))
}

async function failures() {
  const records = await service.listFailures()
  const format = value('--format') ?? 'markdown'
  if (format === 'json') console.log(JSON.stringify(records, null, 2))
  else console.log(renderFailuresMarkdown(records))
}

async function metrics() {
  console.log(JSON.stringify(await service.metrics(), null, 2))
}

async function health() {
  console.log(JSON.stringify(await service.healthReport(), null, 2))
}

async function feedback() {
  const kind = assertOneOf(required('--kind'), ['incorrect', 'constraint', 'retry', 'dissatisfied', 'satisfied', 'goal-changed', 'other'], '--kind')
  const attribution = value('--attribution')
  const record = await service.recordFeedback({
    sessionId: required('--session'),
    skillName: value('--skill'),
    kind,
    ...(attribution === undefined ? {} : { attribution: assertOneOf(attribution, ['routing', 'content', 'composition', 'model', 'tool', 'task-change', 'not-attributable', 'unknown'], '--attribution') }),
    note: required('--note'),
    source: 'maintainer',
  })
  console.log(JSON.stringify(record, null, 2))
}

async function propose() {
  const skillName = required('--skill')
  const baseFile = required('--base-file')
  const candidateFile = required('--candidate-file')
  const baseContent = await readFile(resolve(baseFile), 'utf8')
  const candidateContent = await readFile(resolve(candidateFile), 'utf8')
  const current = await service.versions.readCurrent(skillName)
  if (current === undefined) throw new Error(`current Skill not found: ${skillName}`)
  if (current.content !== baseContent) throw new Error('base file does not match the current Skill content')
  const proposal = createProposal({
    id: value('--id'),
    skillName,
    baseVersion: value('--base-version') ?? current.manifest.version,
    baseContent,
    proposedVersion: required('--proposed-version'),
    candidateContent,
    intent: required('--intent'),
    generatedBy: 'human',
  })
  const proposed = await service.stageProposal(proposal)
  const snapshot = await service.refreshDerived()
  const output = value('--output') ?? resolve(root, '.skill-evolution', 'proposals', `${proposal.id}.md`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, renderProposalMarkdown({ proposal, failures: snapshot.failures, clusters: snapshot.clusters, diagnosis: snapshot.diagnoses.find(item => item.id === proposal.diagnosisId) }), 'utf8')
  console.log(JSON.stringify({ proposal: proposed, markdown: output }, null, 2))
}

async function evaluate() {
  const proposal = await findProposal(required('--proposal'))
  const cases = JSON.parse(await readFile(resolve(required('--cases')), 'utf8'))
  const result = await service.evaluate(proposal, cases)
  const output = value('--output') ?? resolve(root, '.skill-evolution', 'evaluations', `${proposal.id}.json`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(resolve(output), JSON.stringify(result, null, 2), 'utf8')
  const report = value('--report') ?? resolve(root, '.skill-evolution', 'proposals', `${proposal.id.replace(/(?::(?:evaluating|evaluated|accepted|promoted|rolled-back|replayed|observed|rejected|deferred))+$/, '')}.md`)
  const snapshot = await service.refreshDerived()
  await mkdir(dirname(report), { recursive: true })
  await writeFile(resolve(report), renderProposalMarkdown({ proposal, failures: snapshot.failures, clusters: snapshot.clusters, diagnosis: snapshot.diagnoses.find(item => item.id === proposal.diagnosisId), evaluation: result }), 'utf8')
  console.log(JSON.stringify(result, null, 2))
}

async function promote() {
  const proposal = await findProposal(required('--proposal'))
  const evaluation = JSON.parse(await readFile(resolve(required('--evaluation')), 'utf8'))
  const scope = assertOneOf(value('--scope') ?? 'project', ['explicit-only', 'project', 'user', 'stable'], '--scope')
  if (hasFlag('--dry-run')) {
    await service.verifyEvaluation(proposal, evaluation)
    console.log(JSON.stringify({ dryRun: true, proposal, evaluation }, null, 2))
    return
  }
  await service.promote(proposal, evaluation, scope)
  if (value('--format') === 'json') console.log(JSON.stringify({ promoted: true, skillName: proposal.skillName, version: proposal.proposedVersion }, null, 2))
  else console.log(`Promoted ${proposal.skillName} ${proposal.proposedVersion}`)
}

async function accept() {
  const proposal = await findProposal(required('--proposal'))
  const accepted = await service.acceptProposal(proposal, required('--reason'))
  console.log(JSON.stringify(accepted, null, 2))
}

async function reject() {
  const proposal = await findProposal(required('--proposal'))
  console.log(JSON.stringify(await service.rejectProposal(proposal, required('--reason')), null, 2))
}

async function defer() {
  const proposal = await findProposal(required('--proposal'))
  console.log(JSON.stringify(await service.deferProposal(proposal, required('--reason')), null, 2))
}

async function rollback() {
  const skillName = required('--skill')
  const version = required('--version')
  await service.rollback(skillName, version)
  if (value('--format') === 'json') console.log(JSON.stringify({ rolledBack: true, skillName, version }, null, 2))
  else console.log(`Rolled back ${skillName} to ${version}`)
}

async function repair() {
  console.log(JSON.stringify(await service.repair(), null, 2))
}

async function worker() {
  const intervalMs = assertPositiveNumber(value('--interval-ms') ?? '60000', '--interval-ms')
  const maintenance = new MaintenanceWorker({ service, intervalMs })
  console.log(JSON.stringify(await maintenance.runOnce(), null, 2))
  if (!hasFlag('--watch')) return
  maintenance.start()
  await new Promise(resolve => process.once('SIGINT', resolve))
  maintenance.stop()
}

async function rotate() {
  const file = resolve(value('--file') ?? `${root}/.skill-evolution/observations.jsonl`)
  console.log(JSON.stringify(await rotateJsonl(file, { maxBytes: assertPositiveNumber(required('--max-bytes'), '--max-bytes'), retentionDays: assertPositiveNumber(value('--retention-days') ?? '30', '--retention-days') }), null, 2))
}

async function findProposal(id) {
  const records = await service.proposals.readAll()
  const matches = records.filter(record => record.id === id || record.id.startsWith(`${id}:`))
  const proposal = matches.at(-1)
  if (proposal === undefined) throw new Error(`proposal not found: ${id}`)
  return proposal
}

function usage(code) {
  console.error(`Usage: dsh-skill-evolution <observe|failures|metrics|health|feedback|propose|evaluate|accept|reject|defer|promote|rollback|repair|worker|rotate> [options]\n\nExamples:\n  dsh-skill-evolution observe --root .\n  dsh-skill-evolution failures --format markdown\n  dsh-skill-evolution metrics --root .\n  dsh-skill-evolution health --root .\n  dsh-skill-evolution feedback --session SESSION --kind incorrect --skill api-debugging --note "..."\n  dsh-skill-evolution propose --skill api-debugging --base-file SKILL.md --candidate-file candidate.md --proposed-version 1.1.0 --intent "..."\n  dsh-skill-evolution evaluate --proposal proposal-id --cases cases.json --output evaluation.json\n  dsh-skill-evolution accept --proposal proposal-id --reason "Reviewed evaluation"\n  dsh-skill-evolution reject --proposal proposal-id --reason "Unsafe change"\n  dsh-skill-evolution defer --proposal proposal-id --reason "Need more evidence"\n  dsh-skill-evolution promote --proposal proposal-id --evaluation evaluation.json --scope project\n  dsh-skill-evolution rollback --skill api-debugging --version 1.0.0\n  dsh-skill-evolution repair --root .\n  dsh-skill-evolution worker --root . --watch --interval-ms 60000\n  dsh-skill-evolution rotate --root . --max-bytes 10485760 --retention-days 30`)
  process.exitCode = code
}

function hasFlag(name) {
  const index = args.indexOf(name)
  if (index < 0) return false
  args.splice(index, 1)
  return true
}

function assertOneOf(value, allowed, flag) {
  if (!allowed.includes(value)) throw new Error(`${flag} must be one of: ${allowed.join(', ')}`)
  return value
}

function assertPositiveNumber(value, flag) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be a positive number`)
  return number
}
