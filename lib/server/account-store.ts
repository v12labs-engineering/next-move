import type { Account } from "@/lib/server/session"

// Reads need only the account id, so the background runner can use them too.
export type AccountRef = {
  db: Account["db"]
  user: Pick<Account["user"], "id">
}
import { candidateSchema, type Candidate } from "@/lib/candidate"
import { HttpError } from "@/lib/server/http"
import { type Job, type JobStatus, type SimpleAppState } from "@/lib/jobs"
import { initialCountryScores } from "@/lib/location/relocation-data"
import { matchJob, relevantJobTitle } from "@/lib/matching"
import { deduplicateCountryLocations } from "@/lib/jobs/recommendations"
import { scanCatalog } from "@/lib/server/catalog/read"
import { catalogJob, type CatalogRow } from "@/lib/server/catalog/job"
import { createCoverageAssessment } from "@/lib/jobs/coverage"
import { readMatchingOverview } from "@/lib/server/catalog/health"
import { hydrateCatalogDescriptions } from "@/lib/server/catalog/content"

export async function getCandidate({ db, user }: AccountRef) {
  const [profile, countries] = await Promise.all([
    db
      .from("account_profiles")
      .select("data,version")
      .eq("user_id", user.id)
      .maybeSingle(),
    db
      .from("account_countries")
      .select("country,added_at")
      .eq("user_id", user.id),
  ])
  if (profile.error) throw profile.error
  if (countries.error) throw countries.error
  if (!profile.data) return null
  const candidate = candidateSchema.safeParse({
    ...profile.data.data,
    targetCountries: countries.data.map((c) => c.country),
  })
  if (!candidate.success)
    throw new HttpError(
      409,
      "Your profile needs updating. Open your profile to complete it."
    )
  return {
    candidate: candidate.data,
    version: profile.data.version as number,
    countries: countries.data,
  }
}

export async function saveCandidate(
  account: Account,
  candidate: Candidate,
  version: number
) {
  const { error } = await account.db.rpc("save_candidate", {
    p_data: candidate,
    p_version: version,
  })
  if (error?.code === "40001")
    throw new HttpError(
      409,
      "Your profile changed in another tab. Reload before saving again."
    )
  if (error) throw error
}

export async function readAccountState(
  account: AccountRef,
  scanBudgetMs = 60000,
  scanConcurrency = 3
): Promise<SimpleAppState> {
  const profile = await getCandidate(account)
  if (!profile) throw new HttpError(409, "Complete your profile first.")
  const measuredAt = new Date()
  const assessment = createCoverageAssessment(
    profile.candidate.targetCountries,
    measuredAt
  )
  const [overviewResult, recommendationsResult] = await Promise.allSettled([
    readMatchingOverview(account.db, profile.candidate.targetCountries),
    readMatchedJobs(
      account,
      profile,
      measuredAt,
      assessment,
      scanBudgetMs,
      scanConcurrency
    ),
  ])
  if (overviewResult.status === "rejected") throw overviewResult.reason
  if (recommendationsResult.status === "rejected")
    throw recommendationsResult.reason
  const overview = overviewResult.value
  const recommendations = recommendationsResult.value
  return {
    jobs: recommendations,
    catalog: {
      assessedAt: measuredAt.toISOString(),
      totalJobs: overview.totalJobs,
      lastUpdatedAt: overview.lastUpdatedAt,
      sources: overview.sources,
      failedSources: overview.failedSources,
      coverage: assessment.report(overview.health, recommendations).countries,
    },
    trackedCountries: trackedCountriesFor(profile),
  }
}

export function trackedCountriesFor(
  profile: NonNullable<Awaited<ReturnType<typeof getCandidate>>>
): SimpleAppState["trackedCountries"] {
  return profile.countries.map((c) => ({
    country: c.country,
    locations: (profile.candidate.targetLocations ?? []).filter(
      (place) => place.country === c.country
    ),
    score: initialCountryScores.find((s) => s.country === c.country) ?? null,
    sourceTier: ["Netherlands", "Denmark", "Ireland", "Japan"].includes(
      c.country
    )
      ? "official_register"
      : c.country === "Australia"
        ? "stale_register"
        : "discovery_proxy",
    addedAt: c.added_at,
  }))
}

// Source health and catalogue totals are independent of candidate matching.
// Keep them off its critical path while still failing on incomplete reads.
async function readMatchedJobs(
  account: AccountRef,
  profile: NonNullable<Awaited<ReturnType<typeof getCandidate>>>,
  measuredAt: Date,
  assessment: ReturnType<typeof createCoverageAssessment>,
  scanBudgetMs: number,
  scanConcurrency: number
) {
  const states = await account.db
    .from("account_job_states")
    .select("job_id,status,updated_at")
    .eq("user_id", account.user.id)
    .order("updated_at", { ascending: false })
    .limit(1000)
  if (states.error) throw states.error
  const status = new Map(
    states.data.map((s) => [s.job_id, s.status as JobStatus])
  )
  const jobs: Job[] = []
  const ids = new Set<string>()
  const scanStartedAt = Date.now()
  const countries = [...profile.candidate.targetCountries]
  let scanFailed = false
  const scans = await Promise.allSettled(
    Array.from(
      { length: Math.min(3, Math.max(1, scanConcurrency), countries.length) },
      async () => {
        try {
          for (
            let country = countries.shift();
            country;
            country = countries.shift()
          ) {
            if (scanFailed) break
            let complete = false
            let pageSize = 1000
            await scanCatalog<CatalogRow>(
              async (after) => {
                if (complete || scanFailed) return []
                for (;;) {
                  if (scanFailed) return []
                  // Fail explicitly instead of returning a silently truncated candidate pool.
                  if (Date.now() - scanStartedAt > scanBudgetMs)
                    throw new HttpError(
                      503,
                      "Matching could not scan the catalogue completely. Please try again."
                    )
                  const page = await account.db.rpc("catalog_matching_batch", {
                    p_countries: [country],
                    p_before: measuredAt.toISOString(),
                    p_after: after,
                    p_limit: pageSize,
                  })
                  if (page.error?.code === "57014" && pageSize > 125) {
                    pageSize = Math.max(125, Math.floor(pageSize / 2))
                    console.warn(
                      "Matching metadata batch reduced after timeout",
                      { pageSize }
                    )
                    continue
                  }
                  if (page.error) throw page.error
                  const batch = page.data as {
                    items: Omit<CatalogRow, "description">[]
                    hasMore: boolean
                  }
                  if (
                    !Array.isArray(batch.items) ||
                    typeof batch.hasMore !== "boolean"
                  )
                    throw new HttpError(
                      503,
                      "Matching returned incomplete catalogue data. Please try again."
                    )
                  complete = batch.hasMore === false
                  return batch.items.map((row) => ({
                    ...row,
                    description: "",
                  })) as CatalogRow[]
                }
              },
              (page) => {
                const metadata = page.map((row) =>
                  catalogJob(row, status.get(row.id))
                )
                assessment.add(metadata)
                for (const job of metadata) {
                  ids.add(job.id)
                  if (
                    relevantJobTitle(
                      job.title,
                      profile.candidate.targetRoles,
                      profile.candidate.skills
                    ) ||
                    job.status !== "new"
                  )
                    jobs.push({ ...job, description: undefined })
                }
              }
            )
          }
        } catch (error) {
          // Drain outstanding reads before a workflow retries the complete scan.
          scanFailed = true
          throw error
        }
      }
    )
  )
  const failure = scans.find((result) => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
  // Preserve stable tie-breaking when destinations finish in a different order.
  jobs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // Role relevance depends on the title. Load description evidence only after
  // the complete metadata scan, preserving scoring for relevant and saved jobs.
  for (let offset = 0; offset < jobs.length; offset += 400) {
    const batch = jobs.slice(offset, offset + 400)
    const descriptions = await Promise.all(
      [0, 100, 200, 300]
        .filter((start) => start < batch.length)
        .map(async (start) => {
          const result = await account.db
            .from("job_catalog")
            .select("id,description,description_ref")
            .in(
              "id",
              batch.slice(start, start + 100).map((job) => job.id)
            )
          if (result.error) throw result.error
          return hydrateCatalogDescriptions(account.db, result.data)
        })
    )
    const byId = new Map(
      descriptions.flat().map((row) => [row.id, row.description])
    )
    for (const job of batch) {
      if (!byId.has(job.id))
        throw new HttpError(
          503,
          "A matching listing changed during the scan. Please try again."
        )
      job.description = byId.get(job.id)
      job.match = matchJob(job, profile.candidate)
    }
    for (const job of batch) job.description = undefined
  }
  const missing = states.data
    .filter((s) => !ids.has(s.job_id))
    .map((s) => s.job_id)
  const extra = missing.length
    ? await account.db.from("job_catalog").select("*").in("id", missing)
    : { data: [], error: null }
  if (extra.error) throw extra.error
  for (const row of await hydrateCatalogDescriptions(
    account.db,
    (extra.data ?? []) as CatalogRow[]
  )) {
    const job = catalogJob(row, status.get(row.id))
    job.match = matchJob(job, profile.candidate)
    job.description = undefined
    jobs.push(job)
  }
  return deduplicateCountryLocations(jobs).filter(
    (job) => job.status !== "new" || job.match?.inScope === true
  )
}

export async function setAccountJobStatus(
  account: Account,
  jobId: string,
  status: JobStatus
) {
  const { error } = await account.db.from("account_job_states").upsert({
    user_id: account.user.id,
    job_id: jobId,
    status,
    updated_at: new Date().toISOString(),
  })
  if (error?.code === "23503") throw new HttpError(404, "Job not found.")
  if (error) throw error
}
