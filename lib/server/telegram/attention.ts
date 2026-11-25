import { randomUUID } from "node:crypto"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { telegramConfig, telegramEnabled } from "./config"
import { sendTelegram } from "./api"
import { applicationTelegramAction } from "@/lib/telegram/applications"
import { missingAnswers, type ApplicationPacket } from "@/lib/applications"

type DeliverReview = (
  userId: string,
  applicationId?: string
) => Promise<boolean>
export async function deliverTelegramAttention(
  applicationId: string,
  deliverReview: DeliverReview
) {
  if (!telegramEnabled()) return
  const config = telegramConfig()
  const db = supabaseServerClient(10_000)
  const token = randomUUID()
  const claimed = await db.rpc("claim_telegram_attention", {
    p_application: applicationId,
    p_token: token,
  })
  if (claimed.error) throw claimed.error
  if (!claimed.data) return
  const row = claimed.data
  try {
    // Status/revision changes and disconnects invalidate this claim via triggers.
    const current = await db
      .from("telegram_attention_notifications")
      .select(
        "application_id,revision,application:application_runs(status,automatic,packet,message)"
      )
      .eq("application_id", applicationId)
      .eq("version", row.version)
      .eq("lease_token", token)
      .is("delivered_at", null)
      .maybeSingle()
    if (current.error) throw current.error
    if (!current.data) return
    const application = current.data.application as unknown as {
      status: string
      automatic: boolean
      packet: ApplicationPacket | null
      message: string
    } | null
    let reviewed = false
    const waiting = application?.status === "ready"
    if (
      !waiting &&
      application?.automatic &&
      application.packet &&
      missingAnswers(application.packet).length
    ) {
      // Select the owned current revision using the existing transactional
      // review transition. This opens a question, never approves a send.
      const selected = await db.rpc("continue_telegram_application", {
        p_thread: row.thread_id,
        p_application: applicationId,
        p_revision: current.data.revision,
        p_action: "review",
        p_message: `attention:${applicationId}:${row.version}:${token}`,
      })
      if (selected.error) throw selected.error
      if (selected.data) {
        reviewed = await deliverReview(selected.data.userId, applicationId)
        if (!reviewed) throw new Error("Question delivery deferred")
      }
    }
    const label = [row.company, row.title].filter(Boolean).join(" · ")
    if (waiting && application.packet) {
      const count = missingAnswers(application.packet).length
      if (!count) return
      // Notify without selecting a different conversation or interpreting any
      // answers. The existing revision-fenced callback selects it on demand.
      await sendTelegram(
        row.thread_id,
        `${label || "Your application"} needs your answers.\n\n${count} required question${count === 1 ? " is" : "s are"} waiting. Open this application to answer and continue.`,
        [
          application.automatic
            ? {
                text: "Answer questions",
                callback_data: applicationTelegramAction(
                  applicationId,
                  current.data.revision,
                  "review"
                ),
              }
            : {
                text: "Answer questions",
                url: `${config.origin}/applications/${applicationId}`,
              },
        ]
      )
    } else if (!reviewed)
      await sendTelegram(
        row.thread_id,
        `${label || "Your application"} needs your attention.\n\n${application?.message || "The application could not continue. Check its current status for the available recovery action."}`,
        [
          {
            text: "Check status",
            callback_data: applicationTelegramAction(
              applicationId,
              current.data.revision,
              "status"
            ),
          },
        ]
      )
    const saved = await db
      .from("telegram_attention_notifications")
      .update({
        delivered_at: new Date().toISOString(),
        lease_token: null,
        lease_until: null,
        last_error: null,
      })
      .eq("application_id", applicationId)
      .eq("version", row.version)
      .eq("lease_token", token)
    if (saved.error) throw saved.error
  } catch {
    const failed = await db
      .from("telegram_attention_notifications")
      .update({
        lease_token: null,
        lease_until: null,
        last_error: "delivery_failed",
        next_attempt_at: new Date(
          Date.now() + 60_000 * 2 ** Math.min(row.attempts, 5)
        ).toISOString(),
      })
      .eq("application_id", applicationId)
      .eq("version", row.version)
      .eq("lease_token", token)
    if (failed.error) throw failed.error
    console.warn("Telegram attention notification deferred")
  }
}

export async function sweepTelegramAttention(deliverReview: DeliverReview) {
  const db = supabaseServerClient(10_000)
  const result = await db
    .from("telegram_attention_notifications")
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
      await deliverTelegramAttention(row.application_id, deliverReview)
      checked++
    } catch {
      console.warn("Telegram attention notification remains queued")
    }
  }
  return checked
}
