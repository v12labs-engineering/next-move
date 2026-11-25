import { validSourceId } from "@/lib/server/catalog/source-identity"
import { timingSafeEqual } from "node:crypto"
import { after } from "next/server"
import { dispatchMatchingSweep } from "@/lib/server/matching/dispatch"
import { dispatchCatalogRefresh } from "@/lib/server/catalog/dispatch"
import { syncCatalog } from "@/lib/server/catalog/sync"
import { cleanupCatalog } from "@/lib/server/catalog/retention"
import { CandidateStore } from "@/lib/server/catalog/discovery/store"
import { readSourceHealth } from "@/lib/server/catalog/health"
import { dueSources } from "@/lib/server/catalog/directory"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { apiError, HttpError, privateJson } from "@/lib/server/http"
export const runtime = "nodejs"
export const maxDuration = 300
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret || secret.length < 32)
      throw new HttpError(503, "Catalogue synchronization is not configured.")
    const supplied = Buffer.from(request.headers.get("authorization") ?? ""),
      expected = Buffer.from(`Bearer ${secret}`)
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(401, "Unauthorized.")
    const sourceIds = new URL(request.url).searchParams
      .get("sources")
      ?.split(",")
    if (
      sourceIds &&
      (sourceIds.length > 100 || sourceIds.some((id) => !validSourceId(id)))
    )
      throw new HttpError(
        400,
        "Use at most 100 canonical catalogue source IDs."
      )
    if (sourceIds) {
      const selected = await supabaseServerClient()
        .from("job_source_directory")
        .select("id")
        .eq("enabled", true)
        .in("id", sourceIds)
      if (selected.error) throw selected.error
      if (selected.data.length !== new Set(sourceIds).size)
        throw new HttpError(400, "Every requested source must be enabled.")
    }
    const deadline = Date.now() + 240_000
    const cleanup = await cleanupCatalog(supabaseServerClient(30_000))
    const snapshotCleanup = await supabaseServerClient(30_000).rpc(
      "prune_match_snapshots",
      { p_limit: 500 }
    )
    if (snapshotCleanup.error) throw snapshotCleanup.error
    let expansion
    if (!sourceIds && process.env.SOURCE_DISCOVERY_ENABLED === "true") {
      const configured = Number(process.env.SOURCE_DISCOVERY_BATCH_SIZE ?? 10)
      if (
        !Number.isSafeInteger(configured) ||
        configured < 1 ||
        configured > 50
      )
        throw new HttpError(503, "Source expansion batch size is invalid.")
      const health = await readSourceHealth(supabaseServerClient())
      const backlog = dueSources(
        health.filter((source) => source.enabled),
        health
      ).length
      expansion =
        backlog > 36
          ? {
              skipped: "Refresh backlog takes priority",
              dueSources: backlog,
              activatedSources: [],
            }
          : await new CandidateStore().expand({
              limit: configured,
              apply: true,
              maxMs: 45_000,
            })
    }
    if (process.env.CATALOG_DURABLE_REFRESH_ENABLED === "true") {
      const refresh = await dispatchCatalogRefresh(supabaseServerClient(), {
        sourceIds,
      })
      return privateJson(
        {
          ok: true,
          complete: false,
          accepted: true,
          results: [],
          cleanup,
          refresh,
          ...(expansion ? { expansion } : {}),
        },
        202
      )
    }
    const remaining = deadline - Date.now()
    if (remaining <= 65_000)
      throw new HttpError(
        503,
        "Source progress saved; collection needs another invocation."
      )
    const result = await syncCatalog({ maxMs: remaining, sourceIds })
    after(async () => {
      try {
        await dispatchMatchingSweep()
      } catch {
        console.error("Could not dispatch catalogue matching")
      }
    })
    return privateJson(
      { ...result, cleanup, ...(expansion ? { expansion } : {}) },
      result.ok ? 200 : 207
    )
  } catch (error) {
    return apiError(error)
  }
}
export const POST = GET
