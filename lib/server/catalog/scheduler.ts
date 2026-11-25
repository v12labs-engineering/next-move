import type { SupabaseClient } from "@supabase/supabase-js"
import { start } from "workflow/api"
import { z } from "zod"
import {
  catalogMaintenanceWorkflow,
  catalogSourceWorkflow,
} from "@/workflows/catalog-source"
import { dispatchMatchingSweep } from "../matching/dispatch"
import { readCatalogCapacity } from "./health"

const intentSchema = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  dispatch_generation: z.number().int().positive(),
  lease_token: z.uuid(),
})

type SchedulerDependencies = {
  enqueueSource?: (taskId: string, generation: number) => Promise<string>
  enqueueMatching?: () => Promise<unknown>
  enqueueMaintenance?: (token: string) => Promise<unknown>
}

/** Minute ticks admit due sources and repair delivery; they do not scrape. */
export async function dispatchScheduledCatalog(
  db: SupabaseClient,
  dependencies: SchedulerDependencies = {}
) {
  const enqueueSource =
    dependencies.enqueueSource ??
    (async (id: string, generation: number) =>
      (await start(catalogSourceWorkflow, [id, generation, "bounded"])).runId)
  const enqueueMatching =
    dependencies.enqueueMatching ??
    (() => dispatchMatchingSweep({ autoApply: false }))
  const enqueueMaintenance =
    dependencies.enqueueMaintenance ??
    ((token: string) => start(catalogMaintenanceWorkflow, [token]))
  const problems: string[] = []
  let admitted = 0,
    recovered = 0,
    dispatched = 0,
    matchingDispatched = false,
    maintenanceDispatched = false

  async function rpc(name: string, args: Record<string, unknown> = {}) {
    const result = await db.rpc(name, args)
    if (result.error) throw result.error
    return result.data
  }

  try {
    const capacity = await readCatalogCapacity(db)
    if (!capacity.available) problems.push("storage_budget")
    else {
      recovered = z
        .array(z.unknown())
        .parse(
          await rpc("recover_catalog_source_tasks", { p_limit: 100 })
        ).length
      const admission = z
        .object({
          admitted: z.array(z.unknown()),
          errors: z.array(z.unknown()),
        })
        .parse(await rpc("admit_catalog_scheduled_tasks", { p_limit: 100 }))
      admitted = admission.admitted.length
      // SQL isolates failures per source. Preserve their count without logging
      // arbitrary database error text, and continue sending admitted work.
      problems.push(...admission.errors.map(() => "source_admission_failed"))
      const intents = z
        .array(intentSchema)
        .parse(await rpc("claim_catalog_scheduled_outbox", { p_limit: 4 }))
      // One failed enqueue must not suppress other independently claimed work.
      for (const intent of intents) {
        try {
          const message = await enqueueSource(
            intent.task_id,
            intent.dispatch_generation
          )
          const confirmed = await rpc("confirm_catalog_task_outbox", {
            p_id: intent.id,
            p_token: intent.lease_token,
            p_message_id: message,
          })
          if (!confirmed) {
            // A fast worker can commit the next generation before enqueue is
            // acknowledged. Its fenced task receipt is stronger than this ack.
            const task = await rpc("read_catalog_source_task", {
              p_id: intent.task_id,
            })
            if (
              !task ||
              (task.dispatch_generation <= intent.dispatch_generation &&
                !["running", "completed"].includes(task.state))
            )
              throw new Error("Delivery acknowledgement unavailable")
          }
          dispatched++
        } catch {
          // Keep the intent lease: the enqueue may have succeeded remotely.
          // Expiry/redelivery is safe because the source worker is fenced.
          problems.push("source_dispatch_failed")
        }
      }
    }
  } catch {
    problems.push("source_admission_failed")
  }

  // Sweep once per tick for all published sources. Account claims coalesce
  // requests with any matching builds already in progress.
  try {
    await enqueueMatching()
    matchingDispatched = true
  } catch {
    problems.push("matching_dispatch_failed")
  }
  try {
    const token = await rpc("claim_catalog_scheduler_maintenance")
    if (token) {
      await enqueueMaintenance(z.uuid().parse(token))
      maintenanceDispatched = true
    }
  } catch {
    problems.push("maintenance_dispatch_failed")
  }

  await rpc("record_catalog_scheduler_tick", {
    p_error: problems.length ? [...new Set(problems)].join(",") : null,
  })
  const health = await rpc("catalog_scheduler_health")
  const receipt = {
    mode: "source-tasks" as const,
    admitted,
    recovered,
    dispatched,
    dispatchErrors: problems.length,
    errors: [...new Set(problems)],
    matchingDispatched,
    maintenanceDispatched,
    health,
  }
  console.info("Catalog scheduler tick", receipt)
  return receipt
}
