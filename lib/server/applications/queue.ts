import { supabaseServerClient } from "@/lib/server/supabase-server"

// The database freezes a complete automatic packet and persists the queue intent
// before dispatch. A lost workflow start is recovered by the scheduled sweep.
export async function continueAutomaticApplication(id: string) {
  const { queuePreparedAutomaticApplication } = await import("./worker")
  const revision = await queuePreparedAutomaticApplication(id)
  if (revision === null) return null
  try {
    const { start } = await import("workflow/api")
    const { submitApplicationWorkflow } =
      await import("@/workflows/applications")
    await start(submitApplicationWorkflow, [id, revision])
  } catch {
    console.warn("Automatic application queued; dispatch recovery will retry", {
      id,
      revision,
    })
  }
  return revision
}

// A refused claim means the durable workflow waits, without opening a browser
// or using AI quota. Cancellation, edits and terminal outcomes stop the waiter.
export async function applicationQueueRetryAt(
  id: string,
  status: "queued_prepare" | "queued",
  revision?: number
) {
  let query = supabaseServerClient()
    .from("application_runs")
    .select("id,retry_after")
    .eq("id", id)
    .eq("status", status)
  if (revision !== undefined) query = query.eq("revision", revision)
  const result = await query.maybeSingle()
  if (result.error) throw result.error
  if (!result.data) return null
  return new Date(
    Math.max(
      Date.now() + 15_000,
      Date.parse(result.data.retry_after || "") || 0
    )
  ).toISOString()
}
