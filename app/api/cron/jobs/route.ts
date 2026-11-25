import { timingSafeEqual } from "node:crypto"
import { dispatchCatalogRefresh } from "@/lib/server/catalog/dispatch"
import { dispatchScheduledCatalog } from "@/lib/server/catalog/scheduler"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { apiError, HttpError, privateJson } from "@/lib/server/http"

export const maxDuration = 60

/** Authenticated ticks only admit work; durable source tasks do collection. */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret || secret.length < 32)
      throw new HttpError(503, "Job collection is not configured.")
    const supplied = Buffer.from(request.headers.get("authorization") ?? ""),
      expected = Buffer.from(`Bearer ${secret}`)
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(401, "Unauthorized.")
    if (process.env.CATALOG_TASK_SCHEDULER_ENABLED === "true") {
      const scheduler = await dispatchScheduledCatalog(
        supabaseServerClient(10_000)
      )
      return privateJson(
        {
          ok: scheduler.dispatchErrors === 0,
          accepted: true,
          complete: false,
          scheduler,
        },
        scheduler.dispatchErrors ? 503 : 202
      )
    }
    const refresh = await dispatchCatalogRefresh(supabaseServerClient(), {
      scheduled: true,
    })
    console.info("Scheduled job collection accepted", {
      refreshId: refresh.id,
      reused: refresh.reused,
    })
    return privateJson(
      { ok: true, accepted: true, complete: false, refresh },
      202
    )
  } catch (error) {
    return apiError(error)
  }
}
