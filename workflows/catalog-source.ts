import { getWorkflowMetadata } from "workflow"
import { advanceCollection } from "@/lib/server/catalog/source-worker"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { dispatchMatchingSweep } from "@/lib/server/matching/dispatch"
import { cleanupCatalog } from "@/lib/server/catalog/retention"

/** Each source progresses independently; a waiting provider holds no worker. */
export async function catalogSourceWorkflow(
  taskId: string,
  dispatchGeneration: number,
  policy?: "bounded"
) {
  "use workflow"
  const { workflowRunId } = getWorkflowMetadata()
  // Keep the original step sequence for runs already in the durable ledger.
  const maxSegments = policy === "bounded" ? 32 : 1000
  let continuation = false
  for (let segment = 0; segment < maxSegments; segment++) {
    if (
      continuation &&
      !(await continueSourceDelivery(taskId, dispatchGeneration, workflowRunId))
    )
      return { taskId, status: "handed_off" }
    const receipt = await advanceSource(taskId, dispatchGeneration)
    if (receipt.status === "completed" && policy !== "bounded") {
      try {
        await matchPublishedCatalog()
      } catch {
        // The minute sweep repairs this independently; collection must keep
        // draining even while the matching queue is unavailable.
        console.warn("Catalog matching deferred to scheduler recovery", {
          taskId,
        })
      }
    }
    // The minute tick dispatches matching and can claim the unused outbox
    // intent in a fresh workflow. Stop before reserving any more work here.
    if (policy === "bounded" && segment === maxSegments - 1) return receipt
    if (receipt.status === "pending" && receipt.dispatchGeneration) {
      dispatchGeneration = receipt.dispatchGeneration
      continuation = true
      continue
    }
    if (receipt.status === "skipped") return receipt
    if (segment === maxSegments - 1) return receipt
    // Refill freed capacity immediately; minute ticks are for admission and
    // recovery, not a four-sources-per-minute throughput limit.
    const next = await nextSourceDelivery(workflowRunId)
    if (!next) return receipt
    taskId = next.task_id
    dispatchGeneration = next.dispatch_generation
    continuation = false
  }
  // The last release left an unsent durable intent for the next scheduler tick.
  return { taskId, status: "yielded" }
}

async function nextSourceDelivery(workflowId: string) {
  "use step"
  const result = await supabaseServerClient(15_000).rpc(
    "claim_catalog_workflow_delivery",
    { p_message_id: workflowId }
  )
  if (result.error) throw result.error
  return result.data as {
    task_id: string
    dispatch_generation: number
  } | null
}
nextSourceDelivery.maxRetries = 2

async function continueSourceDelivery(
  taskId: string,
  generation: number,
  workflowId: string
) {
  "use step"
  const result = await supabaseServerClient(15_000).rpc(
    "confirm_catalog_task_continuation",
    { p_task: taskId, p_generation: generation, p_message_id: workflowId }
  )
  if (result.error) throw result.error
  return result.data === true
}
continueSourceDelivery.maxRetries = 2

async function advanceSource(taskId: string, dispatchGeneration: number) {
  "use step"
  const receipt = await advanceCollection(
    { taskId, dispatchGeneration },
    {
      maxPages: 10,
      maxRequests: 40,
      maxMs: 120_000,
      publicationTimeoutMs: 55_000,
      maxResponseBytes: 15_000_000,
    }
  )
  console.info("Catalog source work settled", {
    taskId,
    dispatchGeneration,
    status: receipt.status,
  })
  return receipt
}
advanceSource.maxRetries = 2

async function matchPublishedCatalog() {
  "use step"
  // Feed collection refreshes recommendations; it does not submit applications.
  await dispatchMatchingSweep({ autoApply: false })
}
matchPublishedCatalog.maxRetries = 2

/** Retention cannot sit in front of the India collection queue. */
export async function catalogMaintenanceWorkflow(token: string) {
  "use workflow"
  await maintainCatalog(token)
}

async function maintainCatalog(token: string) {
  "use step"
  const db = supabaseServerClient(30_000)
  const cleanup = await cleanupCatalog(db, { maxMs: 20_000 })
  const snapshots = await db.rpc("prune_match_snapshots", { p_limit: 500 })
  if (snapshots.error) throw snapshots.error
  const finished = await db.rpc("finish_catalog_scheduler_maintenance", {
    p_token: token,
  })
  if (finished.error) throw finished.error
  console.info("Catalog maintenance finished", { cleanup })
}
maintainCatalog.maxRetries = 2
