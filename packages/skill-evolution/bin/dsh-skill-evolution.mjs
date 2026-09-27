#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  EvolutionService,
  renderFailuresMarkdown,
  MaintenanceWorker,
  rotateJsonl,
  resolveLayout,
  assertFeedbackKind,
  proposeSkillChange,
  evaluateProposal,
  reviewProposal,
  promoteProposal,
  rollbackSkill,
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
    case '--help':
    case 'help': usage(0); break
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
    default:
      if (command !== undefined) console.error(`Unknown command: ${command}`)
      usage(2)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error && typeof error === 'object' && 'code' in error ? `${error.code}: ${message}` : message)
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
  const kind = assertFeedbackKind(required('--kind'))
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
  const id = value('--id')
  const baseVersion = value('--base-version')
  const output = value('--output')
  const result = await proposeSkillChange(service, {
    root,
    skillName: required('--skill'),
    baseFile: resolve(required('--base-file')),
    candidateFile: resolve(required('--candidate-file')),
    proposedVersion: required('--proposed-version'),
    intent: required('--intent'),
    ...(id === undefined ? {} : { id }),
    ...(baseVersion === undefined ? {} : { baseVersion }),
    ...(output === undefined ? {} : { reportPath: resolve(output) }),
  })
  console.log(JSON.stringify({ proposal: result.proposal, markdown: result.reportPath }, null, 2))
}

async function evaluate() {
  const output = value('--output')
  const report = value('--report')
  const result = await evaluateProposal(service, {
    root,
    proposalRef: required('--proposal'),
    casesFile: resolve(required('--cases')),
    ...(output === undefined ? {} : { evaluationPath: resolve(output) }),
    ...(report === undefined ? {} : { reportPath: resolve(report) }),
  })
  console.log(JSON.stringify(result.result, null, 2))
}

async function promote() {
  const evaluationPath = value('--evaluation')
  const reason = value('--reason')
  const dryRun = hasFlag('--dry-run')
  const result = await promoteProposal(service, {
    proposalRef: required('--proposal'),
    scope: value('--scope') ?? 'project',
    dryRun,
    ...(evaluationPath === undefined ? {} : { evaluationPath: resolve(evaluationPath) }),
    ...(reason === undefined ? {} : { reason }),
  })
  if (result.dryRun === true || value('--format') === 'json') console.log(JSON.stringify(result, null, 2))
  else console.log(`Promoted ${result.skillName} ${result.version}`)
}

async function accept() {
  const result = await reviewProposal(service, { proposalRef: required('--proposal'), decision: 'accept', reason: required('--reason') })
  console.log(JSON.stringify(result.proposal, null, 2))
}

async function reject() {
  const result = await reviewProposal(service, { proposalRef: required('--proposal'), decision: 'reject', reason: required('--reason') })
  console.log(JSON.stringify(result.proposal, null, 2))
}

async function defer() {
  const result = await reviewProposal(service, { proposalRef: required('--proposal'), decision: 'defer', reason: required('--reason') })
  console.log(JSON.stringify(result.proposal, null, 2))
}

async function rollback() {
  const skillName = required('--skill')
  const version = required('--version')
  const reason = value('--reason')
  const result = await rollbackSkill(service, { skillName, version, ...(reason === undefined ? {} : { reason }) })
  if (value('--format') === 'json') console.log(JSON.stringify({ rolledBack: true, ...result }, null, 2))
  else console.log(`Rolled back ${result.skillName} to ${result.version}`)
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
  const fileFlag = value('--file')
  const storeFlag = storePath
  const file = fileFlag === undefined
    ? resolveLayout({ root, ...(storeFlag === undefined ? {} : { observationStore: resolve(storeFlag) }) }).observations.path
    : resolve(fileFlag)
  const retentionFlag = value('--retention-days')
  const options = { maxBytes: assertPositiveNumber(required('--max-bytes'), '--max-bytes'), ...(retentionFlag === undefined ? {} : { retentionDays: assertPositiveNumber(retentionFlag, '--retention-days') }) }
  console.log(JSON.stringify(await rotateJsonl(file, options), null, 2))
}

function usage(code) {
  const message = `Usage: dsh-skill-evolution <version|observe|failures|metrics|health|feedback|propose|evaluate|accept|reject|defer|promote|rollback|repair|worker|rotate> [options]\n\nExamples:\n  dsh-skill-evolution observe --root .\n  dsh-skill-evolution failures --format markdown\n  dsh-skill-evolution metrics --root .\n  dsh-skill-evolution health --root .\n  dsh-skill-evolution feedback --session SESSION --kind incorrect --skill api-debugging --note "..."\n  dsh-skill-evolution propose --skill api-debugging --base-file SKILL.md --candidate-file candidate.md --proposed-version 1.1.0 --intent "..."\n  dsh-skill-evolution evaluate --proposal proposal-id --cases cases.json --output evaluation.json\n  dsh-skill-evolution accept --proposal proposal-id --reason "Reviewed evaluation"\n  dsh-skill-evolution reject --proposal proposal-id --reason "Unsafe change"\n  dsh-skill-evolution defer --proposal proposal-id --reason "Need more evidence"\n  dsh-skill-evolution promote --proposal proposal-id --evaluation evaluation.json --scope project\n  dsh-skill-evolution rollback --skill api-debugging --version 1.0.0\n  dsh-skill-evolution repair --root .\n  dsh-skill-evolution worker --root . --watch --interval-ms 60000\n  dsh-skill-evolution rotate --root . --max-bytes 10485760 --retention-days 30`
  if (code === 0) console.log(message)
  else console.error(message)
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
