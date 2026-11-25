import { timingSafeEqual } from "node:crypto"
import { apiError, HttpError, privateJson } from "@/lib/server/http"
import { sweepTelegram } from "@/lib/server/telegram/delivery"

export const runtime = "nodejs"
export const maxDuration = 300
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET
    const supplied = Buffer.from(request.headers.get("authorization") || "")
    const expected = Buffer.from(`Bearer ${secret}`)
    if (!secret || secret.length < 32)
      throw new HttpError(503, "Notification recovery is not configured.")
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(401, "Unauthorized.")
    return privateJson(await sweepTelegram())
  } catch (error) {
    return apiError(error)
  }
}
