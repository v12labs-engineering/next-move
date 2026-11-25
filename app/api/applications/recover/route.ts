import { recoverPendingApplicationDispatches } from "@/lib/server/applications/auto-apply"
import { recoverBoatBatches } from "@/lib/server/applications/boat-batch"
import { timingSafeEqual } from "node:crypto"
import { apiError, HttpError, privateJson } from "@/lib/server/http"
import { supabaseServerClient } from "@/lib/server/supabase-server"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret || secret.length < 32)
      throw new HttpError(503, "Application recovery is not configured.")
    const supplied = Buffer.from(request.headers.get("authorization") ?? ""),
      expected = Buffer.from(`Bearer ${secret}`)
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(401, "Unauthorized.")
    const result = await supabaseServerClient().rpc(
      "recover_stale_applications"
    )
    if (result.error) throw result.error
    await recoverBoatBatches().catch(() =>
      console.warn("Boat batch recovery unavailable")
    )
    let cursor: string | null = null
    do {
      cursor = await recoverPendingApplicationDispatches(cursor)
    } while (cursor)
    return privateJson({ recovered: result.data })
  } catch (error) {
    return apiError(error)
  }
}
