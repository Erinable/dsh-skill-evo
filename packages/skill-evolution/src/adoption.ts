import type { AdoptionCandidate, AdoptionContext, AdoptionValidation } from './types.js'
import { StaleAdoptionBaseError } from './types.js'

/** Validate that a candidate still targets the exact Skill snapshot it was based on. */
export function validateAdoptionBase(
  candidate: AdoptionCandidate,
  context: AdoptionContext,
): AdoptionValidation {
  if (candidate.expectedBase.name !== context.current.name
    || candidate.expectedBase.contentHash !== context.current.contentHash) {
    throw new StaleAdoptionBaseError(candidate.expectedBase, context.current)
  }
  return { ok: true, candidate }
}
