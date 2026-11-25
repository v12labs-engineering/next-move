import { z } from "zod"
import { start } from "workflow/api"
import { prepareApplicationWorkflow } from "@/workflows/applications"
import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson, readJson, HttpError } from "@/lib/server/http"
import { ownedApplication, rpcError } from "@/lib/server/applications/store"
import { applicationStatusGroups } from "@/lib/applications/activity"
import { applicationTarget } from "@/lib/applications"
export const maxDuration = 60
export async function GET(request: Request) {
  try {
    const { db, user } = await requireAccount()
    const params = new URL(request.url).searchParams
    const { filter, offset, limit, country } = z
      .object({
        country: z.string().min(1).max(100).default("all"),
        filter: z
          .enum(["all", "needs", "queue", "flight", "submitted", "cancelled"])
          .default("all"),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(Object.fromEntries(params))
    let query = db
      .from("application_runs")
      .select(
        `id,status,title:packet->>title,company:packet->>company,updated_at,target_url,job:job_catalog${country === "all" ? "" : "!inner"}(title,company)`
      )
      .eq("user_id", user.id)
      .order(filter === "queue" ? "queue_entered_at" : "updated_at", {
        ascending: filter === "queue",
      })
      .order("id")
      .range(offset, offset + limit - 1)
    if (country !== "all") query = query.eq("job.country", country)
    if (filter !== "all")
      query = query.in("status", [...applicationStatusGroups[filter]])
    const [rows, ...totals] = await Promise.all([
      query.returns<
        {
          id: string
          status: string
          title: string | null
          company: string | null
          updated_at: string
          target_url: string
          job: { title: string; company: string } | null
        }[]
      >(),
      ...Object.values(applicationStatusGroups).map((statuses) => {
        let total = db
          .from("application_runs")
          .select(
            country === "all" ? "id" : "id,job:job_catalog!inner(country)",
            { count: "exact", head: true }
          )
          .eq("user_id", user.id)
          .in("status", [...statuses])
        if (country !== "all") total = total.eq("job.country", country)
        return total
      }),
    ])
    if (rows.error) throw rows.error
    for (const total of totals) if (total.error) throw total.error
    const counts = {
      needs: totals[0].count ?? 0,
      queue: totals[1].count ?? 0,
      flight: totals[2].count ?? 0,
      submitted: totals[3].count ?? 0,
      cancelled: totals[4].count ?? 0,
      all: totals.reduce((sum, result) => sum + (result.count ?? 0), 0),
    }
    return privateJson({
      counts,
      total: counts[filter],
      offset,
      limit,
      applications: rows.data.map((r) => ({
        id: r.id,
        status: r.status,
        title: r.title || r.job?.title || "Application being prepared",
        company: r.company || r.job?.company || new URL(r.target_url).hostname,
        updated_at: r.updated_at,
      })),
    })
  } catch (e) {
    return apiError(e)
  }
}
export async function POST(request: Request) {
  try {
    const account = await requireAccount()
    const { jobId, autoSubmit } = z
      .object({
        jobId: z.string().min(1).max(500),
        autoSubmit: z.boolean().optional(),
      })
      .strict()
      .parse(await readJson(request, 2000))
    const job = await account.db
      .from("job_catalog")
      .select("url")
      .eq("id", jobId)
      .maybeSingle()
    if (job.error) throw job.error
    if (!job.data || !applicationTarget(job.data.url))
      throw new HttpError(422, "A public HTTPS job link is required.")
    const created = await account.db.rpc(
      autoSubmit ? "request_automatic_application" : "create_application",
      { p_job: jobId }
    )
    rpcError(created.error)
    const run = await ownedApplication(account, created.data)
    if (
      run.status === "queued_prepare" ||
      (autoSubmit && run.status === "ready")
    )
      await start(prepareApplicationWorkflow, [run.id])
    return privateJson({ id: run.id, status: run.status }, 201)
  } catch (e) {
    return apiError(e)
  }
}
