import { getStepMetadata } from "workflow"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { syncCatalog } from "@/lib/server/catalog/sync"
import {
  readCatalogCapacity,
  readSourceHealth,
} from "@/lib/server/catalog/health"
import { dueSources, refreshOrder } from "@/lib/server/catalog/directory"
import { startAutoApplySweep } from "@/lib/server/applications/auto-apply"
import { dispatchMatchingSweep } from "@/lib/server/matching/dispatch"
import { cleanupCatalog } from "@/lib/server/catalog/retention"
import { CandidateStore } from "@/lib/server/catalog/discovery/store"
import { runAutomaticDiscovery } from "@/lib/server/catalog/discovery/automatic"
import { runScheduledArchive } from "@/lib/server/catalog/discovery/scheduled-archive"
import { finishCatalogRefresh } from "@/lib/server/catalog/finish-refresh"

export async function refreshCatalogWorkflow(id: string, scheduled = false) {
  "use workflow"
  try {
    const preparation = scheduled ? await prepareRefresh(id) : null
    const archive = []
    if (scheduled) {
      for (let slot = 0; slot < 3; slot++)
        archive.push(await archiveDiscoveryStep(id, slot))
    }
    const expansion = scheduled ? await expandSourcesStep(id) : null
    const targets = await refreshTargets(id, expansion?.activatedSources ?? [])
    let incomplete = 0
    for (let offset = 0; offset < targets.length; offset += 100) {
      const sources = targets.slice(offset, offset + 100)
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await refreshBatch(id, sources)
        if (result.paused) {
          await finishRefresh(id, "paused", {
            reason: result.paused,
            archive,
            expansion,
          })
          return
        }
        if (result.complete) break
        if (!result.pending || attempt === 2) {
          incomplete++
          break
        }
      }
    }
    const discovery = scheduled ? await automaticDiscoveryStep(id) : null
    if (discovery?.activatedSources.length) {
      const collected = await refreshBatch(id, discovery.activatedSources)
      if (collected.paused) {
        await finishRefresh(id, "paused", {
          reason: collected.paused,
          discovery,
        })
        return
      }
      if (!collected.complete) incomplete++
    }
    await finishRefresh(id, incomplete ? "partial" : "completed", {
      targetSources: targets.length,
      incompleteBatches: incomplete,
      ...(preparation ? { preparation } : {}),
      ...(scheduled ? { archive, expansion } : {}),
      ...(discovery ? { discovery } : {}),
    })
  } catch {
    await finishRefresh(id, "failed", {
      reason: "Refresh interrupted; committed source snapshots retained",
    })
    throw new Error(
      "Catalogue refresh failed; inspect persisted operator state"
    )
  }
  // Scheduled scraping does not submit applications; the separate sweep owns that.
  if (!scheduled) await autoApplyStep()
}

async function automaticDiscoveryStep(id: string) {
  "use step"
  try {
    const renewed = await supabaseServerClient(30_000).rpc(
      "heartbeat_catalog_refresh",
      { p_id: id }
    )
    if (renewed.error) throw renewed.error
    return await runAutomaticDiscovery({ requestKey: `catalog:${id}` })
  } catch {
    console.error(
      "Automatic source discovery interrupted; existing snapshots retained"
    )
    return {
      status: "failed",
      reason: "discovery_interrupted",
      activatedSources: [] as string[],
    }
  }
}
// Reservations/intake persist before each paid request. A later scheduled run
// recovers candidate work; this step must not blindly retry an external request.
automaticDiscoveryStep.maxRetries = 0

async function archiveDiscoveryStep(id: string, slot: number) {
  "use step"
  try {
    const renewed = await supabaseServerClient(30_000).rpc(
      "heartbeat_catalog_refresh",
      { p_id: id }
    )
    if (renewed.error) throw renewed.error
    return await runScheduledArchive({
      requestKey: `catalog:${id}:archive:${slot}`,
    })
  } catch {
    return { status: "failed", reason: "archive_interrupted" }
  }
}
// Admission and cursor settlement are persisted, including ambiguous failures.
archiveDiscoveryStep.maxRetries = 0

async function expandSourcesStep(id: string) {
  "use step"
  if (
    process.env.SOURCE_DISCOVERY_ENABLED !== "true" &&
    process.env.AUTOMATIC_DISCOVERY_ENABLED !== "true"
  )
    return { skipped: "disabled", activatedSources: [] as string[] }
  const db = supabaseServerClient(30_000)
  const renewed = await db.rpc("heartbeat_catalog_refresh", { p_id: id })
  if (renewed.error) throw renewed.error
  const capacity = await readCatalogCapacity(db)
  if (capacity.bytes + 16 * 1024 * 1024 >= capacity.limit)
    return { skipped: "storage_budget", activatedSources: [] as string[] }
  const limit = Number(process.env.SOURCE_DISCOVERY_BATCH_SIZE ?? 14)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Source expansion batch size is invalid")
  try {
    return await new CandidateStore(db).expand({
      limit,
      apply: true,
      maxMs: 120_000,
      requireRecent: true,
    })
  } catch {
    return {
      skipped: "expansion_interrupted",
      activatedSources: [] as string[],
    }
  }
}
expandSourcesStep.maxRetries = 0

async function prepareRefresh(id: string) {
  "use step"
  const db = supabaseServerClient(30_000)
  const renewed = await db.rpc("heartbeat_catalog_refresh", { p_id: id })
  if (renewed.error) throw renewed.error
  const cleanup = await cleanupCatalog(db)
  const snapshots = await db.rpc("prune_match_snapshots", { p_limit: 500 })
  if (snapshots.error) throw snapshots.error
  console.info("Scheduled catalogue preparation finished", {
    refreshId: id,
    cleanup,
  })
  return { cleanup }
}
prepareRefresh.maxRetries = 2

async function refreshTargets(
  id: string,
  activatedSources: string[] = []
): Promise<string[]> {
  "use step"
  const db = supabaseServerClient()
  const renewed = await db.rpc("heartbeat_catalog_refresh", { p_id: id })
  if (renewed.error) throw renewed.error
  const saved = await db
    .from("catalog_refresh_runs")
    .select("targets")
    .eq("id", id)
    .single()
  if (saved.error) throw saved.error
  if (saved.data.targets) return saved.data.targets
  const health = await readSourceHealth(db)
  const due = refreshOrder(
    dueSources(
      health.filter((row) => row.enabled),
      health
    )
  ).map((row) => row.id)
  const targets = [...new Set([...activatedSources, ...due])]
  const stored = await db
    .from("catalog_refresh_runs")
    .update({ targets })
    .eq("id", id)
    .eq("status", "running")
  if (stored.error) throw stored.error
  return targets
}
refreshTargets.maxRetries = 2

export async function refreshBatch(id: string, sources: string[]) {
  "use step"
  const db = supabaseServerClient(),
    stepId = getStepMetadata().stepId
  const saved = await db
    .from("catalog_refresh_runs")
    .select("last_step_id,last_result,started_at")
    .eq("id", id)
    .single()
  if (saved.error) throw saved.error
  if (saved.data.last_step_id === stepId)
    return saved.data.last_result as RefreshBatchResult
  const renewed = await db.rpc("heartbeat_catalog_refresh", { p_id: id })
  if (renewed.error) throw renewed.error
  let report: RefreshBatchResult
  try {
    if (Date.now() - Date.parse(saved.data.started_at) >= 6 * 3600000) {
      const paused: RefreshBatchResult = {
        published: 0,
        records: 0,
        complete: false,
        pending: false,
        deferred: sources.length,
        errors: [],
        paused: "Refresh cycle reached its six-hour budget",
      }
      const recorded = await db.rpc("record_catalog_refresh_step", {
        p_id: id,
        p_step_id: stepId,
        p_result: paused,
      })
      if (recorded.error) throw recorded.error
      return recorded.data as RefreshBatchResult
    }
    const result = await syncCatalog({
      sourceIds: sources,
      maxSources: 100,
      concurrency: Math.min(
        Math.max(Number(process.env.CATALOG_CONCURRENCY) || 4, 1),
        32
      ),
      maxMs: 240000,
      // Large bounded employer feeds (for example Accenture India: 98 pages)
      // must fit within the three durable attempts. The time budget still
      // checkpoints and resumes slow sources without publishing partial data.
      maxPagesPerSource: 100,
    })
    const published = result.results.filter(
      (row) => typeof row.count === "number"
    )
    report = {
      published: published.length,
      records: published.reduce((n, row) => n + (row.count ?? 0), 0),
      complete: result.complete,
      pending:
        result.remainingSources > 0 ||
        result.results.some((row) => row.pending && !row.skipped),
      deferred: result.deferredSources,
      errors: result.results
        .filter((row) => row.error)
        .map((row) => ({ source: row.source, error: row.error! })),
      paused: result.results.some((row) =>
        row.error?.includes("storage budget")
      )
        ? "Catalogue storage budget reached"
        : null,
    }
  } catch (error) {
    if (!String((error as Error).message).includes("storage budget"))
      throw error
    report = {
      published: 0,
      records: 0,
      complete: false,
      pending: false,
      deferred: 0,
      errors: [],
      paused: "Catalogue storage budget reached",
    }
  }
  const recorded = await db.rpc("record_catalog_refresh_step", {
    p_id: id,
    p_step_id: stepId,
    p_result: report,
  })
  if (recorded.error) throw recorded.error
  return recorded.data as RefreshBatchResult
}
refreshBatch.maxRetries = 2

type RefreshBatchResult = {
  published: number
  records: number
  complete: boolean
  pending: boolean
  deferred: number
  errors: { source: string; error: string }[]
  paused: string | null
}

async function finishRefresh(
  id: string,
  status: string,
  result: Record<string, unknown>
) {
  "use step"
  await finishCatalogRefresh(
    supabaseServerClient(),
    id,
    status,
    result,
    dispatchMatchingSweep
  )
}
finishRefresh.maxRetries = 2

async function autoApplyStep() {
  "use step"
  // New listings are live; apply for accounts whose threshold they meet.
  await startAutoApplySweep()
}
autoApplyStep.maxRetries = 1
