import { FatalError } from "workflow"
import { dispatchMatchingSweep } from "@/lib/server/matching/dispatch"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { archiveCatalogDescriptions } from "@/lib/server/catalog/content"
import { retainCatalogObservations } from "@/lib/server/catalog/retention"
import {
  discoverProfileSource,
  prioritizeDiscoveryObservations,
} from "@/lib/server/catalog/discovery-search"
import {
  CatalogSourceError,
  type CatalogSource,
} from "@/lib/server/catalog/feeds"
import {
  jobSearchPatterns,
  selectSearchSources,
  type SearchSource,
} from "@/lib/server/catalog/search-plan"

type SearchRun = {
  id: string
  dispatch_token: string
  status: string
  created_at: string
  roles: string[]
  countries: string[]
  sources: string[] | null
  results: Record<
    string,
    { status: string; records: number; complete?: boolean }
  >
}

async function ownedSearch(id: string, token: string) {
  const db = supabaseServerClient(30_000)
  const result = await db
    .from("job_search_runs")
    .select(
      "id,dispatch_token,status,created_at,roles,countries,sources,results"
    )
    .eq("id", id)
    .single()
  if (result.error) throw result.error
  const run = result.data as SearchRun
  if (
    run.dispatch_token !== token ||
    !["queued", "running"].includes(run.status) ||
    Date.now() - Date.parse(run.created_at) >= 10 * 60000
  )
    throw new FatalError("Search is no longer active")
  return { db, run }
}

export async function jobSearchWorkflow(id: string, token: string) {
  "use workflow"
  try {
    const sources = (await planSearch(id, token)).filter(
      (source) => !source.startsWith("alexandria:")
    )
    if (!sources.length) {
      await finishSearch(id, token, "completed", "no_sources")
      return
    }
    for (let offset = 0; offset < sources.length; offset += 8) {
      const paused = await collectSearchBatch(
        id,
        token,
        sources.slice(offset, offset + 8)
      )
      if (paused) {
        await finishSearch(id, token, "paused", paused)
        return
      }
    }
    await finishSearch(id, token, "completed", null)
  } catch {
    await finishSearch(id, token, "failed", "unavailable")
  } finally {
    await refreshSearchMatches()
  }
}

async function refreshSearchMatches() {
  "use step"
  await dispatchMatchingSweep()
}

export async function planSearch(id: string, token: string) {
  "use step"
  const { db, run } = await ownedSearch(id, token)
  if (run.sources) return run.sources
  const pool = await db.rpc("job_search_source_pool", {
    p_id: id,
    p_patterns: jobSearchPatterns(run.roles),
  })
  if (pool.error) throw pool.error
  const sources = selectSearchSources(
    pool.data as SearchSource[],
    run.roles,
    run.countries,
    Math.floor(Date.parse(run.created_at) / 3600000)
  )
  const saved = await db
    .from("job_search_runs")
    .update({
      sources,
      status: "running",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("dispatch_token", token)
    .in("status", ["queued", "running"])
    .select("id")
    .maybeSingle()
  if (saved.error) throw saved.error
  if (!saved.data) throw new FatalError("Search is no longer active")
  console.log("Job search planned", { id, sources: sources.length })
  return sources
}
planSearch.maxRetries = 2

export async function collectSearchBatch(
  id: string,
  token: string,
  sources: string[]
) {
  "use step"
  const { db, run } = await ownedSearch(id, token)
  if (Date.now() - Date.parse(run.created_at) >= 8 * 60000) return "time_limit"
  if (
    sources.some((source) => !run.sources?.includes(source)) ||
    sources.length > 8
  )
    throw new FatalError("Invalid source plan")
  const unfinished = sources.filter((source) => !run.results[source])
  if (!unfinished.length) return null
  let paused: string | null = null
  const directory = await db
    .from("job_source_directory")
    .select("id,kind,company,board,config")
    .in("id", unfinished)
    .eq("enabled", true)
  if (directory.error) throw directory.error
  const pool = await db.rpc("job_search_source_pool", {
    p_id: id,
    p_patterns: jobSearchPatterns(run.roles),
  })
  if (pool.error) throw pool.error
  const cursors = new Map(
    (pool.data as SearchSource[]).map((source) => [
      source.id,
      source.cursor ?? 1,
    ])
  )
  const backoffs = await db
    .from("job_search_provider_backoff")
    .select("kind,retry_at")
    .gt("retry_at", new Date().toISOString())
  if (backoffs.error) throw backoffs.error
  const blocked = new Set<string>(backoffs.data.map((row) => row.kind))
  const deadline = Date.now() + 150000
  const collect = async (source: CatalogSource, fetcher: typeof fetch) => {
    await ownedSearch(id, token)
    if (blocked.has(source.kind)) {
      const deferred = await db.rpc("record_job_search_source", {
        p_id: id,
        p_token: token,
        p_source: source.id,
        p_result: {
          status: "deferred",
          records: 0,
          newRecords: 0,
          complete: false,
        },
      })
      if (deferred.error) throw deferred.error
      return
    }
    try {
      const observed = await discoverProfileSource(source, run, {
        fetch: fetcher,
        page: cursors.get(source.id) ?? 1,
      })
      const retained = await retainCatalogObservations(db, observed.jobs)
      const selected = await prioritizeDiscoveryObservations(db, retained)
      const jobs = await archiveCatalogDescriptions(db, selected)
      const published = await db.rpc("publish_job_search_source", {
        p_id: id,
        p_token: token,
        p_source: source.id,
        p_jobs: jobs,
        p_complete:
          observed.complete && selected.length === observed.jobs.length,
        p_next_page: observed.nextPage,
        p_requests: observed.requests,
      })
      if (published.error) throw published.error
    } catch (error) {
      const storage = String((error as Error).message).includes(
        "storage budget"
      )
      if (storage) paused = "storage_limit"
      const throttle =
        error instanceof CatalogSourceError && error.message.includes("429")
      if (throttle) blocked.add(source.kind)
      const recorded = await db.rpc("record_job_search_source", {
        p_id: id,
        p_token: token,
        p_source: source.id,
        p_result: {
          status: storage ? "limited" : "failed",
          records: 0,
          newRecords: 0,
          complete: false,
          ...(error instanceof CatalogSourceError
            ? { retryAt: error.retryAt }
            : {}),
          ...(throttle ? { providerBackoffUntil: error.retryAt } : {}),
        },
      })
      if (recorded.error) throw recorded.error
    }
  }
  for (let offset = 0; offset < directory.data.length; offset += 2) {
    if (Date.now() >= deadline - 65000) {
      paused = "time_limit"
      break
    }
    await Promise.all(
      (directory.data as CatalogSource[])
        .slice(offset, offset + 2)
        .map((source) => collect(source, fetch))
    )
    if (paused) break
  }
  console.log("Job search batch finished", {
    id,
    planned: directory.data.length,
    paused,
  })
  return paused
}
collectSearchBatch.maxRetries = 2

export async function finishSearch(
  id: string,
  token: string,
  status: string,
  reason: string | null
) {
  "use step"
  const db = supabaseServerClient(30_000)
  const current = await db
    .from("job_search_runs")
    .select("sources,results")
    .eq("id", id)
    .eq("dispatch_token", token)
    .in("status", ["queued", "running"])
    .maybeSingle()
  if (current.error) throw current.error
  if (!current.data) return
  const { sources, results } = current.data as Pick<
    SearchRun,
    "sources" | "results"
  >
  if (
    status === "completed" &&
    (sources ?? [])
      .filter((source) => !source.startsWith("alexandria:"))
      .some((source) => {
        const result = results[source]
        return (
          !result ||
          !["published", "fresh"].includes(result.status) ||
          result.complete === false
        )
      })
  )
    status = "partial"
  const saved = await db
    .from("job_search_runs")
    .update({ status, reason, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("dispatch_token", token)
    .in("status", ["queued", "running"])
  if (saved.error) throw saved.error
  console.log("Job search finished", { id, status, reason })
}
finishSearch.maxRetries = 2
