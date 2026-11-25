import { DEFAULT_AUTO_APPLY_SCORE } from "../applications/auto-apply"
import { candidateSchema, emptyCandidate, type Candidate } from "./index"
import { JOB_SEARCH_COUNTRY } from "../location/countries"

export const MIN_ONBOARDING_EXPERIENCE_YEARS = 2
export const onboardingExperienceMessage = `New profiles require at least ${MIN_ONBOARDING_EXPERIENCE_YEARS} years of professional experience.`

export function meetsOnboardingExperience(years: Candidate["experienceYears"]) {
  return (
    candidateSchema.shape.experienceYears.safeParse(years).success &&
    years !== null &&
    years >= MIN_ONBOARDING_EXPERIENCE_YEARS
  )
}

// Only new onboarding opts in by default. Reading an existing profile must
// never enable unattended submissions or overwrite an explicit opt-out.
export function newOnboardingCandidate(): Candidate {
  return {
    ...emptyCandidate,
    targetCountries: [JOB_SEARCH_COUNTRY],
    autoApply: {
      enabled: true,
      minScore: DEFAULT_AUTO_APPLY_SCORE,
    },
  }
}
