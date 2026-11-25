import { randomBytes } from "node:crypto"
import { requireAccount } from "@/lib/server/session"
import { apiError, HttpError, privateJson, readJson } from "@/lib/server/http"
import { telegramConfig, telegramEnabled } from "@/lib/server/telegram/config"
import { linkHash } from "@/lib/server/telegram/store"
import { deliverTelegram } from "@/lib/server/telegram/delivery"
import { z } from "zod"

export const maxDuration = 60

export async function GET() {
  try {
    const account = await requireAccount()
    if (!telegramEnabled())
      return privateJson({ configured: false, connection: null, pending: null })
    telegramConfig()
    const [connection, pending] = await Promise.all([
      account.db
        .from("telegram_connections")
        .select("label,connected_at")
        .eq("user_id", account.user.id)
        .maybeSingle(),
      account.db.rpc("telegram_link_status"),
    ])
    if (connection.error) throw connection.error
    if (pending.error) throw pending.error
    return privateJson({
      configured: true,
      connection: connection.data,
      pending: pending.data,
    })
  } catch (error) {
    return apiError(error)
  }
}
export async function POST(request: Request) {
  try {
    const account = await requireAccount()
    const { action } = z
      .object({ action: z.enum(["connect", "confirm", "disconnect"]) })
      .strict()
      .parse(await readJson(request, 1000))
    if (action === "disconnect") {
      const result = await account.db.rpc("disconnect_telegram")
      if (result.error) throw result.error
      return privateJson({ ok: true })
    }
    const config = telegramConfig()
    if (action === "confirm") {
      const result = await account.db.rpc("confirm_telegram_link")
      if (result.error?.code === "23505")
        throw new HttpError(
          409,
          "This Telegram account is already connected to another account."
        )
      if (result.error) throw result.error
      if (!result.data)
        throw new HttpError(
          409,
          "Send your connection code from Telegram, then confirm before it expires."
        )
      await deliverTelegram(account.user.id)
      return privateJson({ ok: true })
    }
    const token = randomBytes(16).toString("hex")
    const result = await account.db.rpc("begin_telegram_link", {
      p_hash: linkHash(token),
    })
    if (result.error?.code === "P0001")
      throw new HttpError(
        429,
        "Wait a minute before requesting a new connection code."
      )
    if (result.error) throw result.error
    return privateJson({
      url: `https://t.me/${config.username}?start=${token}`,
      expiresInMinutes: 10,
    })
  } catch (error) {
    return apiError(error)
  }
}
