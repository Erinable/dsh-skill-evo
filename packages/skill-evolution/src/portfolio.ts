import { randomUUID } from 'node:crypto'
import type { ArtifactLifecycleState, DecisionAction, DecisionRecord, PortfolioEntry } from './types.js'

export interface PortfolioOverlap {
  readonly left: string
  readonly right: string
  readonly score: number
  readonly sharedTerms: readonly string[]
}

export interface PortfolioAnalysis {
  readonly entries: readonly PortfolioEntry[]
  readonly overlaps: readonly PortfolioOverlap[]
  readonly totalContextCost: number
  readonly dormantCandidates: readonly string[]
  readonly retiredCandidates: readonly string[]
}

/** Identify overlapping descriptions and maintenance signals without changing Skills. */
export function analyzePortfolio(entries: readonly PortfolioEntry[], threshold = 0.5): PortfolioAnalysis {
  const overlaps: PortfolioOverlap[] = []
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]!
      const right = entries[rightIndex]!
      const leftTerms = terms(left)
      const rightTerms = terms(right)
      const sharedTerms = [...leftTerms].filter(term => rightTerms.has(term))
      const union = new Set([...leftTerms, ...rightTerms]).size
      const score = union === 0 ? 0 : sharedTerms.length / union
      if (score >= threshold) overlaps.push({ left: left.name, right: right.name, score, sharedTerms })
    }
  }
  return {
    entries: entries.map(entry => ({ ...entry, relatedSkills: [...entry.relatedSkills] })),
    overlaps,
    totalContextCost: entries.reduce((total, entry) => total + entry.contextCost, 0),
    dormantCandidates: entries.filter(entry => entry.state === 'stable' && entry.usageCount === 0).map(entry => entry.name),
    retiredCandidates: entries.filter(entry => entry.state === 'dormant' && entry.usageCount === 0).map(entry => entry.name),
  }
}

/** Apply a curator decision to one portfolio row without deleting its history. */
export function transitionPortfolio(
  entry: PortfolioEntry,
  state: ArtifactLifecycleState,
  now = new Date().toISOString(),
): PortfolioEntry {
  if (!allowedState(entry.state, state)) throw new Error(`invalid portfolio transition ${entry.state} -> ${state}`)
  return { ...entry, state, updatedAt: now }
}

/** Create the durable decision record for a portfolio operation. */
export function portfolioDecision(
  entry: PortfolioEntry,
  action: DecisionAction,
  reason: string,
  evidenceIds: readonly string[] = [],
  now = new Date().toISOString(),
): DecisionRecord {
  return {
    id: `decision:${entry.name}:${now}:${randomUUID()}`,
    skillName: entry.name,
    action,
    reason,
    evidenceIds: [...evidenceIds],
    createdAt: now,
  }
}

/** Merge related Skills while retaining retired source rows for history. */
export function mergePortfolioEntries(
  entries: readonly PortfolioEntry[],
  targetName: string,
  sourceNames: readonly string[],
  now = new Date().toISOString(),
): PortfolioEntry[] {
  if (sourceNames.includes(targetName)) throw new Error('merge target must differ from source Skills')
  const sources = entries.filter(entry => sourceNames.includes(entry.name))
  if (sources.length !== sourceNames.length) throw new Error('merge source Skill is missing')
  if (entries.some(entry => entry.name === targetName && !sourceNames.includes(entry.name))) throw new Error(`portfolio Skill already exists: ${targetName}`)
  const target = entries.find(entry => entry.name === targetName)
  const combined = target ?? sources[0]!
  const relatedSkills = [...new Set([
    ...combined.relatedSkills,
    ...sources.flatMap(entry => [entry.name, ...entry.relatedSkills]),
  ].filter(name => name !== targetName))]
  const merged: PortfolioEntry = {
    ...combined,
    name: targetName,
    state: 'observed',
    relatedSkills,
    usageCount: sources.reduce((total, entry) => total + entry.usageCount, 0) + (target?.usageCount ?? 0),
    contextCost: sources.reduce((total, entry) => total + entry.contextCost, 0) + (target?.contextCost ?? 0),
    updatedAt: now,
  }
  return [
    ...entries.filter(entry => entry.name !== targetName && !sourceNames.includes(entry.name)),
    merged,
    ...sources.filter(entry => entry.name !== targetName).map(entry => ({ ...entry, state: 'retired' as const, updatedAt: now })),
  ]
}

/** Split one Skill into observed child rows; the source remains retired for auditability. */
export function splitPortfolioEntry(
  entry: PortfolioEntry,
  parts: readonly Pick<PortfolioEntry, 'name' | 'description' | 'relatedSkills'>[],
  now = new Date().toISOString(),
): PortfolioEntry[] {
  if (parts.length < 2) throw new Error('split requires at least two Skills')
  const cost = Math.ceil(entry.contextCost / parts.length)
  const usage = Math.floor(entry.usageCount / parts.length)
  return [
    { ...entry, state: 'retired', updatedAt: now },
    ...parts.map(part => ({
      ...entry,
      ...part,
      state: 'observed' as const,
      usageCount: usage,
      contextCost: cost,
      updatedAt: now,
    })),
  ]
}

function allowedState(from: ArtifactLifecycleState, to: ArtifactLifecycleState): boolean {
  if (from === to) return true
  const transitions: Record<ArtifactLifecycleState, readonly ArtifactLifecycleState[]> = {
    draft: ['observed', 'retired'],
    observed: ['canary', 'stable', 'dormant', 'retired'],
    canary: ['stable', 'observed', 'dormant', 'retired'],
    stable: ['canary', 'dormant', 'retired'],
    dormant: ['observed', 'stable', 'retired'],
    retired: ['observed'],
  }
  return transitions[from].includes(to)
}

function terms(entry: PortfolioEntry): Set<string> {
  return new Set(`${entry.name} ${entry.description ?? ''} ${entry.relatedSkills.join(' ')}`
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .filter(term => term.length > 1))
}
