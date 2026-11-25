import { timingSafeEqual } from "node:crypto"
import { startAutoApplySweep } from "@/lib/server/applications/auto-apply"
import { apiError, HttpError, privateJson } from "@/lib/server/http"
import { sweepTelegram } from "@/lib/server/telegram/delivery"
export const runtime = "nodejs"
export const maxDuration = 300
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (!secret || secret.length < 32)
      throw new HttpError(503, "Auto-apply is not configured.")
    const supplied = Buffer.from(request.headers.get("authorization") ?? ""),
      expected = Buffer.from(`Bearer ${secret}`)
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(401, "Unauthorized.")
    const result = await startAutoApplySweep()
    await sweepTelegram()
    return privateJson(result, 202)
  } catch (e) {
    return apiError(e)
  }
}
