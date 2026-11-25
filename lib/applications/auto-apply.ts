import type { Candidate } from "@/lib/candidate"
import { countryName } from "@/lib/location/countries"
import type { Job } from "@/lib/jobs"
import { applicationUnavailableReason } from "@/lib/applications"
import { applicationProfileFresh } from "@/lib/applications/profile"

export const DEFAULT_AUTO_APPLY_SCORE = 80
// Bound each sweep. Postgres enforces monthly plan limits.
export const AUTO_APPLY_BATCH = 5

export function homeCountry(candidate: Candidate | null) {
  return candidate?.currentLocation
    ?.split(",")
    .map((part) => countryName(part))
    .filter(Boolean)
    .at(-1)
}

export function visaNeeded(candidate: Candidate | null) {
  const home = homeCountry(candidate)
  return (country: string) => {
    const profile = candidate?.applicationProfile
    const eligibility =
      profile && applicationProfileFresh(profile)
        ? profile.eligibility.find((entry) => entry.country === country)
        : undefined
    if (eligibility?.sponsorshipNow === true) return true
    if (
      eligibility?.authorized === true &&
      eligibility.sponsorshipNow === false
    )
      return false
    return candidate?.sponsorshipRequired !== false && country !== home
  }
}

// Unattended sends only go where the candidate can plausibly be hired.
export function autoApplyEligible(candidate: Candidate | null, job: Job) {
  const settings = candidate?.autoApply
  if (!settings?.enabled || !job.match) return false
  const profile = candidate?.applicationProfile
  const eligibility =
    profile && applicationProfileFresh(profile)
      ? profile.eligibility.find((entry) => entry.country === job.country)
      : undefined
  if (eligibility?.authorized === false && eligibility.sponsorshipNow === false)
    return false
  return (
    job.status === "new" &&
    job.match.score >= settings.minScore &&
    job.match.eligible === true &&
    job.match.reviewable &&
    !applicationUnavailableReason(job)
  )
}
