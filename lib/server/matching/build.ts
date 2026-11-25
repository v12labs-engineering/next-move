import { FatalError } from "workflow"
import { trackedCountriesFor } from "../account-store"
import { candidateSchema } from "@/lib/candidate"
import { supabaseServerClient } from "../supabase-server"
import { catalogJob, type CatalogRow } from "../catalog/job"
import { postingDetails } from "../catalog/posting-details"
import { hydrateCatalogDescriptions } from "../catalog/content"
import { readMatchingOverview } from "../catalog/health"
import { matchJob, relevantJobTitle } from "@/lib/matching"
import { createCoverageAssessment } from "@/lib/jobs/coverage"
import { deduplicateCountryLocations } from "@/lib/jobs/recommendations"
import type { Job, JobStatus } from "@/lib/jobs"
import { matchingMetric, measureMatching } from "./metrics"

export type MatchCursor = {
  token: string
  batch: number
  country: number
  after: string | null
  phase: "catalog" | "saved" | "done"
  measuredAt: string
}
type CoverageJob = Pick<
  Job,
  "country" | "url" | "visaSignal" | "isActive" | "lastCheckedAt"
>
type Batch = {
  jobs: Job[]
  coverage: CoverageJob[]
}

async function ownedBuild(userId: string, token: string, version: number) {
  const db = supabaseServerClient(30_000)
  const result = await db.rpc("begin_account_match_build", {
    p_user: userId,
    p_token: token,
  })
  if (result.error) throw result.error
  if (!result.data)
    return { db, profile: null, cursor: null, needsProfile: false }
  const context = result.data as {
    cursor: MatchCursor
    profile: {
      data: object
      version: number
      countries: { country: string; added_at: string }[]
    }
  }
  if (context.profile.version !== version)
    throw new FatalError("Matching profile superseded")
  const candidate = candidateSchema.safeParse({
    ...context.profile.data,
    targetCountries: context.profile.countries.map((row) => row.country),
  })
  if (!candidate.success) {
    // A profile row can predate completed onboarding (including old QA data).
    // Retrying schema validation cannot repair it. Release only this lease,
    // retain published matches, and never infer missing candidate preferences.
    const stopped = await db.rpc("fail_account_matching", {
      p_user: userId,
      p_token: token,
    })
    if (stopped.error) throw stopped.error
    matchingMetric("failed", { needsProfile: true }, token)
    return { db, profile: null, cursor: null, needsProfile: true }
  }
  const profile = {
    version,
    countries: context.profile.countries,
    candidate: candidate.data,
  }
  return { db, profile, cursor: context.cursor, needsProfile: false }
}

// Only fixed status values cross workflow boundaries. Public listing evidence
// checkpoints live in private Postgres rows, never in growing workflow arguments.
export async function processMatchBatch(
  userId: string,
  token: string,
  version: number
) {
  const { db, profile, cursor, needsProfile } = await ownedBuild(
    userId,
    token,
    version
  )
  if (needsProfile) return "needs_profile" as const
  if (!cursor || !profile || cursor.phase === "done") return true
  const size = 200
  const next: MatchCursor = { ...cursor, batch: cursor.batch + 1 }
  let rows: CatalogRow[] = []
  let states: { job_id: string; status: JobStatus }[] = []
  // The database does not promise country row order across separate requests.
  const countries = [...profile.candidate.targetCountries].sort()
  if (cursor.phase === "catalog") {
    const country = countries[cursor.country]
    if (country) {
      const page = await measureMatching(
        "metadata",
        async () => {
          const result = await db.rpc("catalog_matching_batch", {
            p_countries: [country],
            p_before: cursor.measuredAt,
            p_after: cursor.after,
            p_limit: size,
          })
          if (result.error) throw result.error
          const data = result.data as { items: CatalogRow[]; hasMore: boolean }
          if (
            !Array.isArray(data.items) ||
            typeof data.hasMore !== "boolean" ||
            (data.hasMore && !data.items.length)
          )
            throw new Error("Incomplete matching metadata")
          return data
        },
        token
      )
      rows = page.items
      if (page.hasMore) next.after = rows.at(-1)!.id
      else {
        next.country++
        next.after = null
      }
    }
    if (next.country >= countries.length) next.phase = "saved"
    if (rows.length) {
      const result = await db
        .from("account_job_states")
        .select("job_id,status")
        .eq("user_id", userId)
        .in(
          "job_id",
          rows.map((row) => row.id)
        )
      if (result.error) throw result.error
      states = result.data as typeof states
    }
  } else {
    // Include every saved job, including those outside destinations or current
    // availability. Duplicates collapse by ID at finalization; status changes
    // are also joined live on reads.
    let query = db
      .from("account_job_states")
      .select("job_id,status")
      .eq("user_id", userId)
      .order("job_id")
      .limit(size)
    if (cursor.after) query = query.gt("job_id", cursor.after)
    const result = await query
    if (result.error) throw result.error
    states = result.data as typeof states
    if (states.length) {
      const catalog = await db
        .from("job_catalog")
        .select("*")
        .in(
          "id",
          states.map((s) => s.job_id)
        )
      if (catalog.error) throw catalog.error
      rows = catalog.data as CatalogRow[]
    }
    next.after = states.at(-1)?.job_id ?? cursor.after
    if (states.length < size) next.phase = "done"
  }
  const status = new Map(states.map((s) => [s.job_id, s.status]))
  const metadata = rows.map((row) => catalogJob(row, status.get(row.id)))
  const coverage: CoverageJob[] =
    cursor.phase === "catalog"
      ? metadata.map((job) => ({
          country: job.country,
          url: job.url,
          visaSignal: job.visaSignal,
          isActive: job.isActive,
          lastCheckedAt: job.lastCheckedAt,
        }))
      : []
  const selected = metadata.filter(
    (job) =>
      cursor.phase === "saved" ||
      job.status !== "new" ||
      relevantJobTitle(
        job.title,
        profile.candidate.targetRoles,
        profile.candidate.skills
      )
  )
  const jobs = await measureMatching(
    "hydrate",
    async () => {
      if (!selected.length) return []
      const result = await db
        .from("job_catalog")
        .select("id,description,description_ref")
        .in(
          "id",
          selected.map((job) => job.id)
        )
      if (result.error) throw result.error
      const descriptions = await hydrateCatalogDescriptions(db, result.data)
      const byId = new Map(descriptions.map((row) => [row.id, row.description]))
      // A listing removed mid-scan is dropped, like a vanished saved job.
      return selected
        .filter((job) => byId.has(job.id))
        .map((job) => ({ ...job, description: byId.get(job.id) }))
    },
    token
  )
  await measureMatching(
    "inference",
    async () => {
      for (const job of jobs) {
        job.postingDetails ??= postingDetails(
          job.description ?? "",
          job.country
        )
        job.match = matchJob(job, profile.candidate)
      }
    },
    token
  )
  for (const job of jobs) delete job.description
  const payload: Batch = { jobs, coverage }
  const saved = await measureMatching(
    "checkpoint",
    async () => {
      const result = await db.rpc("checkpoint_account_match_batch", {
        p_user: userId,
        p_token: token,
        p_batch: cursor.batch,
        p_next: next,
        p_payload: payload,
      })
      if (result.error) throw result.error
      return result.data as MatchCursor
    },
    token
  )
  matchingMetric(
    "checkpoint",
    {
      batch: cursor.batch,
      scanned: rows.length,
      scored: jobs.length,
      retained: payload.jobs.length,
    },
    token
  )
  return saved.phase === "done"
}

export async function finalizeMatchBuild(
  userId: string,
  token: string,
  version: number
) {
  const { db, profile, cursor, needsProfile } = await ownedBuild(
    userId,
    token,
    version
  )
  if (needsProfile) return false
  if (!cursor || !profile) return true // Publication already committed before an interrupted response.
  if (cursor.phase !== "done") throw new Error("Incomplete matching build")
  const assessment = createCoverageAssessment(
    profile.candidate.targetCountries,
    new Date(cursor.measuredAt)
  )
  const jobsById = new Map<string, Job>()
  let after = -1,
    count = 0
  for (;;) {
    const result = await db
      .from("account_match_batches")
      .select("batch,payload")
      .eq("user_id", userId)
      .eq("token", token)
      .gt("batch", after)
      .order("batch")
      .limit(100)
    if (result.error) throw result.error
    if (!result.data.length) break
    for (const row of result.data) {
      if (row.batch !== count++) throw new Error("Missing matching checkpoint")
      const payload = row.payload as Batch
      assessment.add(payload.coverage)
      for (const job of payload.jobs) jobsById.set(job.id, job)
      after = row.batch
    }
  }
  if (count !== cursor.batch) throw new Error("Incomplete matching checkpoints")
  const jobs = [...jobsById.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  const recommendations = deduplicateCountryLocations(jobs)
  const overview = await readMatchingOverview(
    db,
    profile.candidate.targetCountries
  )
  // Finalization is cheap and replayable; reset only final staging, never receipts.
  const reset = await db.rpc("reset_account_matches", {
    p_user: userId,
    p_token: token,
  })
  if (reset.error) throw reset.error
  for (let offset = 0; offset < recommendations.length; offset += 200) {
    const result = await db.rpc("stage_account_matches", {
      p_user: userId,
      p_token: token,
      p_jobs: recommendations.slice(offset, offset + 200),
    })
    if (result.error) throw result.error
  }
  const result = await measureMatching(
    "publish",
    async () => {
      const published = await db.rpc("publish_account_matches", {
        p_user: userId,
        p_token: token,
        p_count: recommendations.length,
        p_summary: {
          trackedCountries: trackedCountriesFor(profile),
          catalog: {
            assessedAt: cursor.measuredAt,
            totalJobs: overview.totalJobs,
            lastUpdatedAt: overview.lastUpdatedAt,
            sources: overview.sources,
            failedSources: overview.failedSources,
            coverage: assessment.report(overview.health, recommendations)
              .countries,
          },
        },
      })
      if (published.error) throw published.error
      return published.data
    },
    token
  )
  matchingMetric(
    "publish",
    {
      published: result === true,
      batches: count,
      jobs: recommendations.length,
      buildMs: Date.now() - Date.parse(cursor.measuredAt),
    },
    token
  )
  return result === true
}
