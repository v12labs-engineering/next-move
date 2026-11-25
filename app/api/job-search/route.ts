import { z } from "zod"
import { start } from "workflow/api"
import { requireAccount } from "@/lib/server/session"
import { getCandidate } from "@/lib/server/account-store"
import { apiError, HttpError, privateJson, readJson } from "@/lib/server/http"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { jobSearchWorkflow } from "@/workflows/job-search"
import type { JobSearchResponse } from "@/lib/jobs/search"
import { readCatalogCapacity } from "@/lib/server/catalog/health"

export const runtime = "nodejs"
export const maxDuration = 60

async function dispatchSearch(result: JobSearchResponse) {
  if (result.search?.status !== "queued") return
  const db = supabaseServerClient(30_000)
  const claim = await db.rpc("claim_job_search_dispatch", {
    p_id: result.search.id,
  })
  if (claim.error) throw claim.error
  if (!claim.data) return
  try {
    const run = await start(jobSearchWorkflow, [result.search.id, claim.data])
    const saved = await db
      .from("job_search_runs")
      .update({ workflow_id: run.runId })
      .eq("id", result.search.id)
      .eq("dispatch_token", claim.data)
    if (saved.error) throw saved.error
  } catch {
    // Polling recovers an unconfirmed enqueue after its dispatch lease expires.
    // Any late worker is fenced by the replaced token before further work.
  }
}

export async function GET() {
  try {
    const account = await requireAccount()
    if (!(await getCandidate(account)))
      throw new HttpError(409, "Complete your profile first.")
    if (process.env.ON_DEMAND_SEARCH_ENABLED !== "true")
      return privateJson({ search: null, blocked: "disabled" })
    const [result, capacity] = await Promise.all([
      account.db.rpc("read_job_search"),
      readCatalogCapacity(supabaseServerClient(30_000)),
    ])
    if (result.error) throw result.error
    const response = {
      search: result.data,
      ...(!capacity.available ? { blocked: "storage_limit" } : {}),
    } as JobSearchResponse
    if (capacity.available) await dispatchSearch(response)
    return privateJson(response)
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireAccount()
    z.object({})
      .strict()
      .parse(await readJson(request, 1024))
    if (!(await getCandidate(account)))
      throw new HttpError(409, "Complete your profile first.")
    if (process.env.ON_DEMAND_SEARCH_ENABLED !== "true")
      return privateJson({ search: null, blocked: "disabled" })
    const capacity = await readCatalogCapacity(supabaseServerClient(30_000))
    if (!capacity.available)
      return privateJson({ search: null, blocked: "storage_limit" })
    const admitted = await account.db.rpc("request_job_search")
    if (admitted.error) throw admitted.error
    const result = admitted.data as JobSearchResponse
    await dispatchSearch(result)
    return privateJson(
      result,
      result.search && ["queued", "running"].includes(result.search.status)
        ? 202
        : 200
    )
  } catch (error) {
    return apiError(error)
  }
}
