import type { Job } from "@/lib/jobs"

export interface CountryCoverage {
  country: string
  state:
    | "observed_supply"
    | "no_observed_supply"
    | "no_configured_source"
    | "unmeasured"
    | "failed"
    | "partial"
    | "stale"
    | "checked_empty"
  activeVacancies: number
  relevantVacancies: number
  confirmedSponsorship: number
  unknownSponsorship: number
  relevantConfirmedSponsorship: number
  relevantUnknownSponsorship: number
  lastCheckedAt: string | null
  olderThanTarget: number
}

export interface CatalogSourceHealth {
  id: string
  countries: string[]
  enabled: boolean
  last_success_at: string | null
  last_started_at?: string | null
  failed: boolean
  complete: boolean | null
  pending: boolean
}

export const coverageLabels: Record<CountryCoverage["state"], string> = {
  observed_supply: "Listings observed",
  no_observed_supply: "Supply has not been verified",
  no_configured_source: "No sources assigned to this destination yet",
  unmeasured: "Source coverage has not been measured",
  failed: "Some assigned sources could not refresh",
  partial: "An assigned source scan is incomplete",
  stale: "Source checks are beyond the six-hour target",
  checked_empty: "Assigned sources were checked; no current listings observed",
}

export function createCoverageAssessment(
  countries: readonly string[],
  now = new Date()
) {
  const rows = new Map<string, CountryCoverage>(
    countries.map((country) => [
      country,
      {
        country,
        state: "no_observed_supply",
        activeVacancies: 0,
        relevantVacancies: 0,
        confirmedSponsorship: 0,
        unknownSponsorship: 0,
        lastCheckedAt: null,
        olderThanTarget: 0,
        relevantConfirmedSponsorship: 0,
        relevantUnknownSponsorship: 0,
      },
    ])
  )
  const seen = new Set<string>(),
    relevant = new Set<string>()
  return {
    add(
      jobs: Pick<
        Job,
        | "country"
        | "url"
        | "visaSignal"
        | "isActive"
        | "lastCheckedAt"
        | "match"
      >[]
    ) {
      for (const job of jobs) {
        const row = rows.get(job.country)
        if (
          !row ||
          job.isActive === false ||
          !job.lastCheckedAt ||
          new Date(job.lastCheckedAt).getTime() < now.getTime() - 7 * 86400000
        )
          continue
        const key = `${job.country}\n${job.url}`
        if (job.match?.reviewable && !relevant.has(key)) {
          relevant.add(key)
          row.relevantVacancies++
          if (job.visaSignal === "confirmed" || job.visaSignal === "strong")
            row.relevantConfirmedSponsorship++
          else if (job.visaSignal !== "no") row.relevantUnknownSponsorship++
        }
        if (seen.has(key)) continue
        seen.add(key)
        row.state = "observed_supply"
        row.activeVacancies++
        if (job.visaSignal === "confirmed" || job.visaSignal === "strong")
          row.confirmedSponsorship++
        else if (job.visaSignal !== "no") row.unknownSponsorship++
        if (Date.parse(job.lastCheckedAt) < now.getTime() - 6 * 3600000)
          row.olderThanTarget++
        if (!row.lastCheckedAt || job.lastCheckedAt > row.lastCheckedAt)
          row.lastCheckedAt = job.lastCheckedAt
      }
    },
    report(sources?: CatalogSourceHealth[], candidateJobs?: Job[]) {
      if (candidateJobs)
        for (const row of rows.values()) {
          const relevant = candidateJobs.filter(
            (job) =>
              job.country === row.country &&
              job.match?.reviewable &&
              job.isActive !== false &&
              job.lastCheckedAt &&
              Date.parse(job.lastCheckedAt) >= now.getTime() - 7 * 86400000
          )
          row.relevantVacancies = relevant.length
          row.relevantConfirmedSponsorship = relevant.filter(
            (job) =>
              job.visaSignal === "confirmed" || job.visaSignal === "strong"
          ).length
          row.relevantUnknownSponsorship = relevant.filter(
            (job) => !["no", "confirmed", "strong"].includes(job.visaSignal)
          ).length
        }
      if (sources)
        for (const row of rows.values()) {
          const scoped = sources.filter(
            (source) => source.enabled && source.countries.includes(row.country)
          )
          if (!scoped.length)
            row.state = row.activeVacancies
              ? "unmeasured"
              : "no_configured_source"
          else if (scoped.some((source) => source.failed)) row.state = "failed"
          else if (
            scoped.some((source) => source.pending || source.complete === false)
          )
            row.state = "partial"
          else if (
            scoped.some(
              (source) => !source.last_success_at || source.complete === null
            )
          )
            row.state = "unmeasured"
          else if (
            scoped.some(
              (source) =>
                Date.parse(source.last_success_at!) <
                now.getTime() - 6 * 3600000
            )
          )
            row.state = "stale"
          else
            row.state = row.activeVacancies
              ? "observed_supply"
              : "checked_empty"
        }
      return {
        measuredAt: now.toISOString(),
        candidateAssessed: candidateJobs !== undefined,
        countries: [...rows.values()],
      }
    },
  }
}
