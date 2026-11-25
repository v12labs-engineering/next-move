import { randomUUID } from "node:crypto"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { telegramConfig, telegramEnabled } from "./config"
import { sendTelegram } from "./api"
import { applicationTelegramAction } from "@/lib/telegram/applications"

export async function deliverTelegramSubmission(applicationId: string) {
  if (!telegramEnabled()) return
  telegramConfig()
  const db = supabaseServerClient(10_000)
  const token = randomUUID()
  const claimed = await db.rpc("claim_telegram_submission", {
    p_application: applicationId,
    p_token: token,
  })
  if (claimed.error) throw claimed.error
  if (!claimed.data) return
  const row = claimed.data
  try {
    // Disconnect deletes the outbox row. Recheck the receipt, lease and current
    // destination immediately before disclosing the confirmation.
    const current = await db
      .from("telegram_submission_notifications")
      .select(
        "revision,application:application_runs(status,revision,receipt),connection:telegram_connections(thread_id)"
      )
      .eq("application_id", applicationId)
      .eq("lease_token", token)
      .is("delivered_at", null)
      .maybeSingle()
    if (current.error) throw current.error
    const value = current.data as unknown as {
      revision: number
      application: {
        status: string
        revision: number
        receipt: { text?: string; confirmedAt?: string } | null
      } | null
      connection: { thread_id: string } | null
    } | null
    const application = value?.application
    if (
      !value ||
      application?.status !== "submitted" ||
      application.revision !== value.revision ||
      value.connection?.thread_id !== row.thread_id ||
      !application.receipt?.text?.trim() ||
      !application.receipt.confirmedAt
    )
      return
    const label = [row.company, row.title].filter(Boolean).join(" · ")
    // Keep a confirmation in one message. Full employer evidence stays in the
    // saved receipt; neither resume data nor answers are included in this alert.
    const messageId = await sendTelegram(
      row.thread_id,
      `Application submitted successfully.\n\n${label.slice(0, 600) || "Your application"}\n\nEmployer confirmation: ${application.receipt.text.slice(0, 1000)}`,
      [
        {
          text: "View confirmation",
          callback_data: applicationTelegramAction(
            applicationId,
            value.revision,
            "status"
          ),
        },
      ]
    )
    const saved = await db
      .from("telegram_submission_notifications")
      .update({
        delivered_at: new Date().toISOString(),
        provider_message_id: messageId,
        lease_token: null,
        lease_until: null,
        last_error: null,
      })
      .eq("application_id", applicationId)
      .eq("lease_token", token)
    if (saved.error) throw saved.error
  } catch {
    // Telegram has no sendMessage idempotency key: a lost send response can
    // duplicate an alert. This retry never changes or resubmits an application.
    const failed = await db
      .from("telegram_submission_notifications")
      .update({
        lease_token: null,
        lease_until: null,
        last_error: "delivery_failed",
        next_attempt_at: new Date(
          Date.now() + 60_000 * 2 ** Math.min(row.attempts, 5)
        ).toISOString(),
      })
      .eq("application_id", applicationId)
      .eq("lease_token", token)
    if (failed.error) throw failed.error
    console.warn("Telegram submission notification deferred")
  }
}

export async function sweepTelegramSubmissions() {
  const db = supabaseServerClient(10_000)
  const result = await db
    .from("telegram_submission_notifications")
    .select("application_id")
    .is("delivered_at", null)
    .lt("attempts", 5)
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at")
    .limit(20)
  if (result.error) throw result.error
  const deadline = Date.now() + 60_000
  let checked = 0
  for (const row of result.data) {
    if (Date.now() >= deadline) break
    try {
      await deliverTelegramSubmission(row.application_id)
      checked++
    } catch {
      console.warn("Telegram submission notification remains queued")
    }
  }
  return checked
}
