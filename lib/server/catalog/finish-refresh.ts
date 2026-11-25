import type { SupabaseClient } from "@supabase/supabase-js"

const terminalStatuses = new Set([
  "completed",
  "partial",
  "paused",
  "failed",
  "interrupted",
])

/** Persist collection completion, then wake matching. A retry can observe a
 * committed terminal status after either response was lost. That status only
 * acknowledges collection; it is not evidence that matching was enqueued. */
export async function finishCatalogRefresh(
  db: SupabaseClient,
  id: string,
  status: string,
  result: Record<string, unknown>,
  enqueueMatching: () => Promise<void>
) {
  const saved = await db
    .from("catalog_refresh_runs")
    .select("status")
    .eq("id", id)
    .single()
  if (saved.error) throw saved.error

  if (!terminalStatuses.has(saved.data.status)) {
    const finished = await db.rpc("finish_catalog_refresh", {
      p_id: id,
      p_status: status,
      p_result: result,
    })
    if (finished.error) throw finished.error
  }

  // Matching admission is safe to repeat: account leases and profile/catalog
  // versions coalesce duplicate sweeps. A failed enqueue must remain retryable.
  await enqueueMatching()
}
