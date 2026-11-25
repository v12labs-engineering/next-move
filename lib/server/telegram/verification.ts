import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
import { z } from "zod"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { chatId, sendTelegram, type TelegramButton } from "./api"
import { telegramConfig } from "./config"
const key = () =>
  createHash("sha256")
    .update("nextmove-verification-code-v1\0" + telegramConfig().secret)
    .digest()
export function sealVerificationCode(value: string) {
  if (!/^[a-z0-9]{4,12}$/i.test(value))
    throw new Error("Invalid verification code")
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv)
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url")
}
export function openVerificationCode(value: string) {
  const bytes = Buffer.from(value, "base64url")
  const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8")
}
export async function sendVerificationPhoto(
  thread: string,
  image: Buffer,
  caption: string,
  buttons: TelegramButton[][]
) {
  const form = new FormData()
  form.set("chat_id", chatId(thread))
  form.set("caption", caption.slice(0, 1024))
  form.set("protect_content", "true")
  form.set(
    "photo",
    new Blob([new Uint8Array(image)], { type: "image/png" }),
    "verification.png"
  )
  if (buttons.length)
    form.set("reply_markup", JSON.stringify({ inline_keyboard: buttons }))
  const { token } = telegramConfig()
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
  } catch {
    throw new Error("Telegram verification delivery failed")
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.ok)
    throw new Error("Telegram verification delivery failed")
  return String(
    z.object({ message_id: z.number().int() }).parse(data.result).message_id
  )
}
const challengeSchema = z.object({
  id: z.uuid(),
  mode: z.enum(["code", "challenge", "unsupported"]),
  replyMessageId: z.string().optional(),
})
export async function purgeExpiredTelegramVerification() {
  const removed = await supabaseServerClient()
    .from("application_tasks")
    .update({ output: null })
    .not("output->telegramChallenge", "is", null)
    .lte("output->browserAssistance->>expiresAt", new Date().toISOString())
  if (removed.error) throw removed.error
}
export async function handleTelegramVerification(event: {
  thread: string
  action?: string
  messageId: string
  text: string
  replyTo?: number
}) {
  const callback = event.action
    ? /^hv:([a-f0-9-]{36}):click:(0|[1-9][0-9]?)$/.exec(event.action)
    : null
  if (event.action && !event.action.startsWith("hv:")) return false
  if (!event.action && !event.replyTo) return false
  const db = supabaseServerClient()
  const connection = await db
    .from("telegram_connections")
    .select("user_id")
    .eq("thread_id", event.thread)
    .maybeSingle()
  if (connection.error) throw connection.error
  if (!connection.data) return false
  let query = db
    .from("application_tasks")
    .select(
      "application_id,revision,output,application:application_runs!inner(user_id)"
    )
    .eq("state", "running")
    .eq("error_code", "telegram_verification_required")
    .eq("application.user_id", connection.data.user_id)
  if (callback) query = query.eq("output->telegramChallenge->>id", callback[1])
  else if (!event.action)
    query = query.eq(
      "output->telegramChallenge->>replyMessageId",
      String(event.replyTo)
    )
  else {
    await sendTelegram(
      event.thread,
      "That verification control changed. Use the latest picture."
    )
    return true
  }
  const found = await query.limit(1).maybeSingle()
  if (found.error) throw found.error
  const challenge = challengeSchema.safeParse(
    found.data?.output?.telegramChallenge
  )
  if (!challenge.success) {
    if (event.action) {
      await sendTelegram(
        event.thread,
        "This verification step changed or expired. No browser or application was restarted."
      )
      return true
    }
    return false
  }
  let value: string | null = null
  if (!callback) {
    const code = event.text.trim()
    if (challenge.data.mode !== "code" || !/^[a-z0-9]{4,12}$/i.test(code)) {
      await sendTelegram(
        event.thread,
        "Reply with only the employer's 4–12 character verification code. Never send a password."
      )
      return true
    }
    value = sealVerificationCode(code)
  }
  const queued = await db.rpc("queue_telegram_verification", {
    p_thread: event.thread,
    p_challenge: challenge.data.id,
    p_action: callback ? "click" : "code",
    p_target: callback ? Number(callback[2]) : null,
    p_value: value,
    p_reply: event.replyTo ? String(event.replyTo) : null,
    p_update: event.messageId,
  })
  if (queued.error) throw queued.error
  console.info("Application verification relay", {
    applicationId: found.data?.application_id,
    revision: found.data?.revision,
    outcome: queued.data ? "response_queued" : "response_rejected",
  })
  await sendTelegram(
    event.thread,
    queued.data
      ? "Your response is queued for this verification step. Wait for the updated picture or result."
      : "That verification step changed, expired, or already has a response. Nothing was restarted or resent."
  )
  return true
}
