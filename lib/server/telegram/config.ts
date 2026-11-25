import { HttpError } from "@/lib/server/http"
import { timingSafeEqual } from "node:crypto"

export function verifyTelegramWebhook(request: Request, secret: string) {
  const actual = Buffer.from(
    request.headers.get("x-telegram-bot-api-secret-token") || ""
  )
  const expected = Buffer.from(secret)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HttpError(401, "Unauthorized.")
}

export function telegramEnabled() {
  return process.env.TELEGRAM_ENABLED === "true"
}
export function telegramConfig() {
  const env = process.env
  if (
    !telegramEnabled() ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN || "") ||
    !/^(?=.{5,32}$)[A-Za-z0-9_]+bot$/i.test(env.TELEGRAM_BOT_USERNAME || "") ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || "") ||
    !env.TELEGRAM_APP_ORIGIN
  )
    throw new HttpError(503, "Telegram notifications are not configured.")
  const origin = new URL(env.TELEGRAM_APP_ORIGIN)
  if (origin.protocol !== "https:" || origin.origin !== env.TELEGRAM_APP_ORIGIN)
    throw new HttpError(503, "Telegram notifications are not configured.")
  return {
    origin: origin.origin,
    token: env.TELEGRAM_BOT_TOKEN!,
    username: env.TELEGRAM_BOT_USERNAME!,
    secret: env.TELEGRAM_WEBHOOK_SECRET!,
  }
}
