import { jobCategoryIds } from "@/lib/jobs/categories"
import {
  fetchCatalogPage,
  type CatalogSource,
  CatalogSourceError,
} from "@/lib/server/catalog/feeds"
import {
  catalogSourceFreshnessMs,
  discoveredBoards,
  prioritizeSources,
  dueSources,
} from "./directory"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { scanCatalog } from "./read"
import { readSourceHealth } from "./health"
import { archiveCatalogDescriptions } from "./content"
import { retainCatalogObservations } from "./retention"

type CatalogSyncOptions = {
  maxMs?: number
  maxPagesPerSource?: number
  maxSources?: number
  force?: boolean
  sourceIds?: string[]
  concurrency?: number
  maxDatabaseBytes?: number
  freshnessMs?: number
  maxSnapshotRecords?: number
  maxSnapshotBytes?: number
  maxResponseBytes?: number
  fetch?: typeof fetch
}

export async function syncCatalog(options: CatalogSyncOptions = {}) {
  return collectCatalog(options)
}

async function collectCatalog(options: CatalogSyncOptions) {
  const db = supabaseServerClient(30_000)
  // Fetch feeds concurrently, but keep CPU-heavy snapshot writes off each
  // other's statement deadlines on the shared staging database.
  let writeTail: Promise<unknown> = Promise.resolve()
  function writeSnapshot<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeTail.then(operation)
    writeTail = result.catch(() => undefined)
    return result
  }
  const concurrency = options.concurrency ?? 2
  const maxDatabaseBytes =
    options.maxDatabaseBytes ??
    Number(process.env.CATALOG_DATABASE_BUDGET_BYTES ?? 400 * 1024 * 1024)
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    !Number.isSafeInteger(maxDatabaseBytes) ||
    maxDatabaseBytes < 50 * 1024 * 1024
  )
    throw new Error("Invalid catalogue collection limits")
  async function checkCapacity(additional = 0) {
    const usage = await db.rpc("catalog_storage_usage")
    if (usage.error) throw usage.error
    if (Number(usage.data.database_bytes) + additional > maxDatabaseBytes)
      throw new Error(
        "Catalogue storage budget reached; collection paused to preserve database capacity"
      )
  }
  await checkCapacity()
  const deadline = Date.now() + (options.maxMs ?? 220000)
  const freshnessMs = options.freshnessMs ?? catalogSourceFreshnessMs()
  for (const limit of [
    freshnessMs,
    options.maxSnapshotRecords,
    options.maxSnapshotBytes,
    options.maxResponseBytes,
  ])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error("Invalid catalogue snapshot limits")
  const directory: CatalogSource[] = [],
    demand: { id: string; source: string; demand: number }[] = []
  let states: Awaited<ReturnType<typeof readSourceHealth>> = []
  const availability: {
    id: string
    lease_until: string | null
    retry_at: string | null
  }[] = []
  if (options.sourceIds) {
    if (options.sourceIds.length > 100)
      throw new Error("Use at most 100 scoped sources")
    const scoped = await db.rpc("catalog_collection_sources", {
      p_ids: options.sourceIds,
    })
    if (scoped.error) throw scoped.error
    const rows = scoped.data as (CatalogSource &
      (typeof states)[number] &
      (typeof availability)[number])[]
    directory.push(...rows)
    states = rows
    availability.push(...rows)
  } else {
    const [, health] = await Promise.all([
      scanCatalog<CatalogSource>(
        async (after) => {
          let query = db
            .from("job_source_directory")
            .select("id,kind,company,board,config")
            .eq("enabled", true)
            .order("id")
            .limit(500)
          if (after) query = query.gt("id", after)
          const result = await query
          if (result.error) throw result.error
          return result.data as CatalogSource[]
        },
        (page) => {
          directory.push(...page)
        }
      ),
      readSourceHealth(db),
      scanCatalog<{ id: string; source: string; demand: number }>(
        async (after) => {
          const result = await db.rpc("catalog_source_demand", {
            p_after: after,
            p_limit: 500,
          })
          if (result.error) throw result.error
          return (result.data as { source: string; demand: number }[]).map(
            (row) => ({ ...row, id: row.source })
          )
        },
        (page) => {
          demand.push(...page)
        }
      ),
    ])
    states = health
    await scanCatalog<(typeof availability)[number]>(
      async (after) => {
        const result = await db.rpc("catalog_collection_availability", {
          p_after: after,
          p_limit: 500,
        })
        if (result.error) throw result.error
        return result.data
      },
      (page) => {
        availability.push(...page)
      }
    )
  }
  if (
    options.sourceIds?.some(
      (id) => !directory.some((source) => source.id === id)
    )
  )
    throw new Error("Every requested source must exist and be enabled")
  const due = options.force
    ? directory.filter((source) => source.kind !== "alexandria")
    : dueSources(directory, states, Date.now(), freshnessMs)
  const blocked = new Map<string, string>()
  for (const row of availability) {
    if (Date.parse(row.lease_until ?? "") > Date.now())
      blocked.set(row.id, "leased")
    else if (Date.parse(row.retry_at ?? "") > Date.now())
      blocked.set(row.id, "backoff")
  }
  const eligible = due.filter((source) => !blocked.has(source.id))
  const order = prioritizeSources(
    eligible,
    states.map((source) => ({
      id: source.id,
      last_started_at: source.last_started_at ?? null,
    })),
    demand,
    options.maxSources ?? 12
  )
  const results: {
    source: string
    count?: number
    error?: string
    skipped?: boolean
    reason?: string
    retryAt?: string
    pending?: boolean
    runId?: string
  }[] = []
  async function collect(source: CatalogSource) {
    const previous = states.find((s) => s.id === source.id)
    if (
      !options.force &&
      previous?.last_success_at &&
      (previous.complete === true || source.kind === "linkedin") &&
      !previous.failed &&
      !previous.pending &&
      Date.now() - Date.parse(previous.last_success_at) < freshnessMs
    )
      return { source: source.id, skipped: true, reason: "fresh" }
    const claim = await db.rpc("begin_catalog_run", { p_source: source.id })
    if (claim.error)
      return { source: source.id, error: "Could not claim collection source" }
    if (!claim.data)
      return { source: source.id, skipped: true, reason: "leased" }
    if (claim.data.deferred)
      return {
        source: source.id,
        skipped: true,
        pending: true,
        reason: "backoff",
        retryAt: claim.data.retry_at as string,
      }
    const run = claim.data as {
      id: string
      token: string
      next_page: number | null
      started_at: string
    }
    let page = run.next_page,
      requests = 0
    try {
      let stagedRecords = 0,
        stagedBytes = 0
      if (
        options.maxSnapshotRecords !== undefined ||
        options.maxSnapshotBytes !== undefined
      ) {
        const size = await db.rpc("catalog_run_size", {
          p_run: run.id,
          p_token: run.token,
        })
        if (size.error) throw size.error
        stagedRecords = Number(size.data.records)
        stagedBytes = Number(size.data.bytes)
        if (
          stagedRecords > (options.maxSnapshotRecords ?? Infinity) ||
          stagedBytes > (options.maxSnapshotBytes ?? Infinity)
        )
          throw new Error(
            "Source exceeds the on-demand snapshot limit; no incomplete snapshot published"
          )
      }
      for (
        let completed = 0;
        page !== null &&
        completed < (options.maxPagesPerSource ?? 10) &&
        Date.now() < deadline - 65000;
        completed++
      ) {
        requests = 0
        const snapshot = await fetchCatalogPage(source, page, {
          jobCategories: jobCategoryIds,
          fetch: options.fetch,
          snapshotStartedAt: run.started_at,
          maxResponseBytes: options.maxResponseBytes,
          onRequest() {
            requests++
          },
        })
        const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot.jobs))
        if (
          stagedRecords + snapshot.jobs.length >
            (options.maxSnapshotRecords ?? Infinity) ||
          stagedBytes + snapshotBytes > (options.maxSnapshotBytes ?? Infinity)
        )
          throw new Error(
            "Source exceeds the on-demand snapshot limit; no incomplete snapshot published"
          )
        const retainedJobs = await retainCatalogObservations(db, snapshot.jobs)
        const storedJobs =
          process.env.CATALOG_CONTENT_ENABLED === "true"
            ? await archiveCatalogDescriptions(db, retainedJobs)
            : retainedJobs
        const storedBytes = Buffer.byteLength(JSON.stringify(storedJobs))
        // Reserve headroom for metadata; full text has been durably verified.
        await checkCapacity(storedBytes * 3)
        await writeSnapshot(async () => {
          const reserved = await db.rpc("reserve_catalog_storage", {
            p_run: run.id,
            p_token: run.token,
            p_operation: "checkpoint",
            p_bytes: storedBytes * 4 + 4096,
          })
          if (reserved.error) throw reserved.error
          const saved = await db.rpc("checkpoint_catalog_page", {
            p_run: run.id,
            p_token: run.token,
            p_page: page,
            p_next: snapshot.nextPage,
            p_jobs: storedJobs,
            p_fetched: snapshot.fetched,
            p_rejected: snapshot.rejected,
            p_requests: requests,
          })
          if (saved.error) throw saved.error
        })
        requests = 0
        stagedRecords += snapshot.jobs.length
        stagedBytes += snapshotBytes
        const discovered = discoveredBoards(snapshot.jobs)
        if (discovered.length) {
          const registered = await db
            .from("job_source_directory")
            .upsert(discovered, { onConflict: "id", ignoreDuplicates: true })
          if (registered.error) throw registered.error
        }
        page = snapshot.nextPage
      }
      if (page === null) {
        return await writeSnapshot(async () => {
          const reserved = await db.rpc("reserve_catalog_storage", {
            p_run: run.id,
            p_token: run.token,
            p_operation: "publish",
            p_bytes: 0,
          })
          if (reserved.error) throw reserved.error
          const finished = await db.rpc("finish_catalog_run", {
            p_run: run.id,
            p_token: run.token,
          })
          if (finished.error) throw finished.error
          return {
            source: source.id,
            count: finished.data.accepted_count - finished.data.duplicate_count,
            newRecords: finished.data.new_count ?? null,
            updatedRecords: finished.data.updated_count ?? null,
            expiredRecords: finished.data.expired_count ?? null,
            runId: run.id,
          }
        })
      }
      const paused = await db.rpc("pause_catalog_run", {
        p_run: run.id,
        p_token: run.token,
        p_error: null,
        p_requests: 0,
      })
      if (paused.error) throw paused.error
      return { source: source.id, pending: true, runId: run.id }
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String(error.message).slice(0, 300)
          : "Source collection failed"
      const paused = await db.rpc("defer_catalog_run", {
        p_run: run.id,
        p_token: run.token,
        p_error: message,
        p_requests: requests,
        p_retry_at:
          error instanceof CatalogSourceError
            ? error.retryAt
            : new Date(Date.now() + 15 * 60000).toISOString(),
      })
      return {
        source: source.id,
        error: paused.error
          ? "Collection failed; recovery state could not be saved"
          : message,
        runId: run.id,
      }
    }
  }
  for (
    let index = 0;
    index < order.length && Date.now() < deadline - 65000;
    index += concurrency
  )
    results.push(
      ...(await Promise.all(
        order.slice(index, index + concurrency).map(collect)
      ))
    )
  if (!eligible.length)
    results.push(
      ...due.map((source) => ({
        source: source.id,
        skipped: true,
        pending: true,
        reason: blocked.get(source.id),
      }))
    )
  return {
    ok: !results.some((r) => r.error),
    complete:
      due.length === order.length &&
      results.length === order.length &&
      !results.some((r) => r.pending || r.error || r.reason === "leased"),
    enabledSources: directory.length,
    plannedSources: order.length,
    remainingSources: Math.max(
      0,
      eligible.length - Math.min(results.length, order.length)
    ),
    deferredSources: due.length - eligible.length,
    results: [
      ...results,
      ...(options.sourceIds
        ? directory
            .filter((source) => !due.some((row) => row.id === source.id))
            .map((source): (typeof results)[number] => ({
              source: source.id,
              skipped: true,
              reason: "fresh",
            }))
        : []),
    ],
  }
}
