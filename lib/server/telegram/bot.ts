import { z } from "zod"
import { editCode, parseAction, transition } from "@/lib/telegram"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import {
  activeRequest,
  changeRequest,
  initializeRequest,
  linkHash,
} from "./store"
import { deliverTelegram, dispatchTelegramSubmissions } from "./delivery"
import { sendTelegram, telegramApi } from "./api"
import { telegramConfig } from "./config"
import { applicationTelegramAction } from "@/lib/telegram/applications"
import {
  continueTelegramApplication,
  listTelegramApplications,
} from "./continuation"
import { handleTelegramVerification } from "./verification"

const userSchema = z.object({
  id: z.number().int().positive().safe(),
  is_bot: z.boolean().optional(),
})
const messageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  from: userSchema.optional(),
  text: z.string().max(10000).optional(),
  reply_to_message: z.object({ message_id: z.number().int() }).optional(),
})
export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: userSchema,
      data: z.string().max(64).optional(),
      message: messageSchema.optional(),
    })
    .optional(),
})
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>
export function privateTelegramEvent(update: TelegramUpdate) {
  const callback = update.callback_query
  const message = callback?.message ?? update.message
  const sender = callback?.from ?? message?.from
  if (
    !message ||
    !sender ||
    sender.is_bot ||
    message.chat.type !== "private" ||
    message.chat.id !== sender.id
  )
    return null
  return {
    thread: `telegram:${sender.id}`,
    message,
    text: callback ? "" : message.text || "",
    action: callback?.data,
    messageId: `update:${update.update_id}`,
    callbackId: callback?.id,
  }
}
export async function handleTelegramUpdate(input: unknown) {
  const update = telegramUpdateSchema.parse(input)
  const event = privateTelegramEvent(update)
  if (!event) return
  const { thread, messageId, callbackId, action } = event
  let text = event.text
  const db = supabaseServerClient()
  if (callbackId)
    await telegramApi(
      "answerCallbackQuery",
      { callback_query_id: callbackId },
      z.boolean()
    )
  const link = /^\/start ([a-f0-9]{32})$/i.exec(text.trim())
  if (link) {
    const result = await db.rpc("claim_telegram_link", {
      p_hash: linkHash(link[1].toLowerCase()),
      p_thread: thread,
      p_label: `Telegram …${thread.split(":").at(-1)!.slice(-6)}`,
    })
    if (result.error) throw result.error
    await sendTelegram(
      thread,
      result.data
        ? "Return to Preferences and confirm this Telegram account to enable application notifications."
        : "This connection code expired or was already used. Request a new code in Preferences."
    )
    return
  }
  if (/^(?:\/stop|STOP)$/i.test(text.trim())) {
    const result = await db.rpc("stop_telegram", { p_thread: thread })
    if (result.error) throw result.error
    await sendTelegram(
      thread,
      "Telegram notifications disconnected. Your applications remain available in the app."
    )
    return
  }
  if (/^\/(?:help|privacy)$/i.test(text.trim())) {
    await sendTelegram(
      thread,
      `Send /applications to check progress or answer missing questions. Auto-apply continues after the last required answer. Employer verification codes are requested here for the active application. Connect Telegram in Preferences: ${telegramConfig().origin}/preferences#telegram-notifications\nReply /stop to disconnect.`
    )
    return
  }
  const touched = await db
    .from("telegram_connections")
    .update({ last_inbound_at: new Date().toISOString() })
    .eq("thread_id", thread)
  if (touched.error) throw touched.error
  if (
    await handleTelegramVerification({
      thread,
      action,
      messageId,
      text,
      replyTo: event.message.reply_to_message?.message_id,
    })
  )
    return
  if (action?.startsWith("apps:")) {
    const page = /^apps:(0|[1-9][0-9]{0,6})$/.exec(action)
    if (page) await listTelegramApplications(thread, Number(page[1]))
    return
  }
  if (/^\/(?:applications|start|next)$/i.test(text.trim())) {
    await listTelegramApplications(thread)
    return
  }
  if (action?.startsWith("app:")) {
    await continueTelegramApplication(thread, action, messageId)
    return
  }
  let q = await activeRequest(thread)
  if (!q) {
    await sendTelegram(
      thread,
      "No question is selected here. Send /applications to choose a job and continue in Telegram."
    )
    return
  }
  q = await initializeRequest(q, thread)
  if (!q) return
  const parsed = action ? parseAction(action) : null
  if (
    action &&
    (!parsed || parsed.id !== q.id || parsed.version !== q.version)
  ) {
    await sendTelegram(
      thread,
      "That request changed, expired or belongs to another selected application. Send /applications to choose it again."
    )
    return
  }
  const directAnswer =
    q.automatic &&
    ((q.provider_message_id &&
      String(event.message?.reply_to_message?.message_id) ===
        q.provider_message_id) ||
      text.startsWith(`${editCode(q)}:`))
  if (!action && !q.state.editing && !directAnswer) {
    const changed = await changeRequest(q, thread, messageId, {
      state: q.state,
      finish: false,
      pause: false,
    })
    if (changed) await deliverTelegram(q.user_id)
    return
  }
  if (
    !action &&
    (q.state.editing || directAnswer) &&
    String(event.message.reply_to_message?.message_id) === q.provider_message_id
  )
    text = `${editCode(q)}:${text}`
  let change: ReturnType<typeof transition>
  try {
    change = transition(
      q,
      parsed?.action || "confirm",
      action ? undefined : text
    )
  } catch (error) {
    await sendTelegram(
      thread,
      error instanceof Error
        ? error.message
        : "Review this application in the app."
    )
    return
  }
  const changed = await changeRequest(q, thread, messageId, change)
  if (!changed) {
    await sendTelegram(
      thread,
      "That request was already handled or changed. Use the latest application before continuing."
    )
    return
  }
  if (change.finish) {
    await dispatchTelegramSubmissions()
    await sendTelegram(
      thread,
      "Your answers are saved. The application is queued to continue automatically. I’ll report success once the employer confirms receipt.",
      typeof changed.revision === "number"
        ? [
            {
              text: "Check application status",
              callback_data: applicationTelegramAction(
                q.application_id,
                changed.revision,
                "status"
              ),
            },
          ]
        : []
    )
  } else if (change.pause)
    await sendTelegram(
      thread,
      "Paused this Telegram request. Send /applications when you want to continue it here."
    )
  await deliverTelegram(q.user_id)
}
