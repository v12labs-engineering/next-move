import type { MatchPage } from "@/lib/matching/page"
import { dispatchAccountMatching } from "../matching/dispatch"
import { start } from "workflow/api"
import {
  prepareApplicationWorkflow,
  submitApplicationWorkflow,
} from "@/workflows/applications"
import type { Account } from "@/lib/server/session"
import type { Candidate } from "@/lib/candidate"
import type { Job } from "@/lib/jobs"
import { AUTO_APPLY_BATCH, autoApplyEligible } from "@/lib/applications/auto-apply"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { getCandidate } from "@/lib/server/account-store"

type RpcResult = {
  data: unknown
  error: { code?: string; message: string } | null
}

// Keep selection identical across page boundaries, including stable score ties.
export function selectAutoApplicationCandidates(
  candidate: Candidate,
  jobs: Job[],
  taken: ReadonlySet<string> = new Set()
) {
  const tracked = new Set(candidate.targetCountries)
  return jobs
    .filter(
      (job) =>
        !taken.has(job.id) &&
        tracked.has(job.country) &&
        autoApplyEligible(candidate, job)
    )
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .slice(0, 50)
}

// Shared by the signed-in trigger and the background sweep. Callers pass jobs
// scored server-side; the database enforces the plan's monthly limits.
export async function requestAutoApplications(
  db: Account["db"],
  userId: string,
  candidate: Candidate,
  jobs: Job[],
  request: (jobId: string) => PromiseLike<RpcResult>
) {
  if (!jobs.length) return { started: [], limited: false }
  const runs = await db
    .from("application_runs")
    .select("job_id")
    .eq("user_id", userId)
    .in(
      "job_id",
      jobs.map((job) => job.id)
    )
  if (runs.error) throw runs.error
  // Existing runs may be waiting on the user's review; never authorize them.
  const taken = new Set(runs.data.map((r) => r.job_id))

  const started: { jobId: string; id: string }[] = []
  let limited = false
  for (const job of selectAutoApplicationCandidates(candidate, jobs, taken)) {
    if (started.length >= AUTO_APPLY_BATCH) break
    const created = await request(job.id)
    if (created.error?.code === "P0001") {
      if (/limit/i.test(created.error.message)) {
        limited = true
        break
      }
      continue
    }
    if (created.error) throw created.error
    const id = created.data as string
    await start(prepareApplicationWorkflow, [id])
    started.push({ jobId: job.id, id })
  }
  return { started, limited }
}

export async function autoApplyForAccount(userId: string) {
  const db = supabaseServerClient(30_000)
  const account = { db, user: { id: userId } }
  const profile = await getCandidate(account)
  if (!profile?.candidate.autoApply?.enabled)
    return { started: [], limited: false }
  let jobs: Job[] = []
  let generation: string | null = null
  for (let offset = 0; ; offset += 200) {
    const result = await db.rpc("read_account_matches_for", {
      p_user: userId,
      p_filters: {
        view: "jobs",
        sort: "score",
        datePosted: "month",
        limit: 200,
        offset,
      },
    })
    if (result.error) throw result.error
    const page = result.data as Omit<MatchPage, "state"> & {
      jobs: Job[]
      profileVersion: number
    }
    // Catalog drift alone does not invalidate a published current-profile generation.
    if (
      page.profileVersion !== profile.version ||
      !page.matching.profileCurrent
    ) {
      await dispatchAccountMatching(userId)
      return { started: [], limited: false }
    }
    if (offset && generation !== page.generation)
      return { started: [], limited: false }
    generation = page.generation
    // Exclude existing runs before retaining the bounded top 50. Waiting and
    // failed runs can still have a "new" tracker status.
    const existing = page.jobs.length
      ? await db
          .from("application_runs")
          .select("job_id")
          .eq("user_id", userId)
          .in(
            "job_id",
            page.jobs.map((job) => job.id)
          )
      : { data: [], error: null }
    if (existing.error) throw existing.error
    jobs = selectAutoApplicationCandidates(
      profile.candidate,
      [...jobs, ...page.jobs],
      new Set(existing.data.map((row) => row.job_id))
    )
    if (offset + page.jobs.length >= page.total) break
    if (!page.jobs.length)
      throw new Error("Incomplete automatic application match page")
  }
  return await requestAutoApplications(
    db,
    userId,
    profile.candidate,
    jobs,
    (jobId) =>
      db.rpc("request_automatic_application_for", {
        p_user: userId,
        p_job: jobId,
      })
  )
}

// The sweep itself is durable and paginated; it no longer truncates at 1,000 accounts.
export async function startAutoApplySweep() {
  const { autoApplySweepWorkflow } = await import("@/workflows/auto-apply")
  const run = await start(autoApplySweepWorkflow, [])
  return { accepted: true, workflowRunId: run.runId }
}

// Queued records are the durable dispatch intent. A lost start() response is
// safe to replay: preparation and submission workers both claim with CAS.
// Only queued revisions are dispatched. A new automatic send with an unknown
// result can enter this queue once through the database retry transition.
export async function recoverPendingApplicationDispatches(
  after: string | null = null,
  userId?: string,
  dispatch = async (run: { id: string; status: string; revision: number }) => {
    if (run.status === "queued")
      await start(submitApplicationWorkflow, [run.id, run.revision])
    else await start(prepareApplicationWorkflow, [run.id])
  }
) {
  if (!after) {
    const recovered = await supabaseServerClient(30_000).rpc(
      "recover_application_preparation",
      { p_user: userId ?? null }
    )
    if (recovered.error) throw recovered.error
  }
  let query = supabaseServerClient(30_000)
    .from("application_runs")
    .select("id,status,revision,retry_after")
    .or(
      "status.in.(queued_prepare,queued),and(status.eq.ready,automatic.eq.true)"
    )
    .lt("updated_at", new Date(Date.now() - 60_000).toISOString())
    .order("id")
    .limit(100)
  if (after) query = query.gt("id", after)
  if (userId) query = query.eq("user_id", userId)
  const result = await query
  if (result.error) throw result.error
  for (const run of result.data) {
    if (run.retry_after && Date.parse(run.retry_after) > Date.now()) continue
    try {
      await dispatch(run)
    } catch {
      console.warn(
        "Application dispatch pending; scheduled recovery will retry"
      )
    }
  }
  return result.data.at(-1)?.id ?? null
}
