import type { SupabaseClient } from "@supabase/supabase-js"
import { start } from "workflow/api"
import { refreshCatalogWorkflow } from "@/workflows/catalog"

/** One shared database lease admits both scheduled and operator refreshes. */
export async function dispatchCatalogRefresh(
  db: SupabaseClient,
  options: { sourceIds?: string[]; scheduled?: boolean } = {},
  enqueue = async (id: string, scheduled: boolean) =>
    (await start(refreshCatalogWorkflow, [id, scheduled])).runId
) {
  const claim = await db.rpc("claim_catalog_refresh")
  if (claim.error) throw claim.error
  let workflowId: string | null = claim.data.workflow_id ?? null
  if (claim.data.claimed) {
    // Keep the lease on any dispatch error: start may have reached Vercel even
    // if its response was lost. A later claim recovers the expired lease.
    if (options.sourceIds) {
      const scoped = await db
        .from("catalog_refresh_runs")
        .update({ targets: options.sourceIds })
        .eq("id", claim.data.id)
      if (scoped.error) throw scoped.error
    }
    workflowId = await enqueue(claim.data.id, options.scheduled ?? false)
    const saved = await db
      .from("catalog_refresh_runs")
      .update({ workflow_id: workflowId })
      .eq("id", claim.data.id)
    if (saved.error) throw saved.error
  }
  return {
    id: claim.data.id,
    workflowRunId: workflowId,
    status: claim.data.status,
    reused: !claim.data.claimed,
  }
}
