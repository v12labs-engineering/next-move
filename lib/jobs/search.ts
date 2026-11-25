import type { Job } from "@/lib/jobs"
import type { MatchPage } from "@/lib/matching/page"
import {
  deduplicateLocations,
  visibleRecommendations,
} from "@/lib/jobs/recommendations"

export type JobSearchStatus = {
  id: string
  status: "queued" | "running" | "completed" | "partial" | "paused" | "failed"
  reason: string | null
  roles: string[]
  countries: string[]
  createdAt: string
  updatedAt: string
  retryAt: string
  version: number
  plannedSources: number
  processedSources: number
  publishedSources: number
  publishedRecords: number
  newRecords?: number | null
}

export type JobSearchResponse = {
  search: JobSearchStatus | null
  blocked?: string
  retryAt?: string
  reused?: boolean
}

export function searchIsActive(search: JobSearchStatus | null) {
  return search?.status === "queued" || search?.status === "running"
}

export function searchMatchesReady(
  search: Pick<JobSearchStatus, "updatedAt"> | null,
  assessedAt?: string,
  matching?: Pick<MatchPage["matching"], "status" | "stale">
) {
  if (!search) return false
  // A search can publish no changes. In that case the existing generation is
  // current without being rebuilt, so its assessment timestamp stays older.
  if (matching) return matching.status === "ready" && !matching.stale
  return Boolean(
    assessedAt && Date.parse(assessedAt) >= Date.parse(search.updatedAt)
  )
}

export function newMatchingJobs(jobs: Job[], since: string) {
  const firstSeen = new Map<string, number>()
  for (const job of jobs) {
    const seen = Date.parse(job.seenAt ?? "")
    firstSeen.set(
      job.url,
      Math.min(
        firstSeen.get(job.url) ?? Infinity,
        Number.isFinite(seen) ? seen : -Infinity
      )
    )
  }
  return deduplicateLocations(
    visibleRecommendations(jobs, false, false)
  ).filter(
    (job) =>
      job.match?.reviewable &&
      (firstSeen.get(job.url) ?? -Infinity) >= Date.parse(since)
  )
}

export function jobSearchMessage(
  result: JobSearchResponse,
  newMatches?: number
) {
  if (result.blocked === "storage_limit")
    return "Fresh job collection is paused because catalogue storage is full. Reloading matches only shows saved listings."
  if (result.blocked === "busy")
    return "Another live check is running. Try again shortly; your existing matches are available."
  if (result.blocked === "disabled")
    return "Live checks are temporarily unavailable."
  if (result.blocked)
    return "Live search limit reached. Your existing matches remain available; try again after the cooldown."
  const search = result.search
  if (!search)
    return "Check job sources in India using your saved search preferences."
  if (search.status === "queued")
    return "Live search queued. Your existing matches stay available."
  if (search.status === "running")
    return `Checking job sources: ${search.processedSources} of ${search.plannedSources}. Your existing matches stay available.`
  if (search.reason === "storage_limit")
    return "Live checks paused to stay within the free storage limit. Your existing matches remain available."
  if (search.reason === "no_sources")
    return "No additional eligible sources found for this search. Existing matches remain available."
  if (search.status === "failed")
    return "Live checks could not finish. Your existing matches remain available."
  if (typeof search.newRecords === "number") {
    const matches =
      newMatches === undefined
        ? "Updating your matches."
        : `${newMatches} new ${newMatches === 1 ? "match" : "matches"} for your profile.`
    const progress =
      search.status === "partial" || search.status === "paused"
        ? " Some sources could not finish."
        : ""
    return `${search.newRecords} newly discovered listings across ${search.processedSources} sources. ${matches}${progress}`
  }
  if (search.status === "partial" || search.status === "paused")
    return `Processed ${search.processedSources} job sources. Some checks could not finish; available results have been kept.`
  return `Live checks finished: ${search.processedSources} job sources checked. Matches use the latest available results.`
}
