import { handleTelegramUpdate } from "@/lib/server/telegram/bot"
import {
  telegramConfig,
  verifyTelegramWebhook,
} from "@/lib/server/telegram/config"
import { apiError, readJson } from "@/lib/server/http"

export const runtime = "nodejs"
export const maxDuration = 120
export async function POST(request: Request) {
  try {
    verifyTelegramWebhook(request, telegramConfig().secret)
    await handleTelegramUpdate(await readJson(request, 1_000_000))
    return Response.json({ ok: true })
  } catch (error) {
    return apiError(error)
  }
}
