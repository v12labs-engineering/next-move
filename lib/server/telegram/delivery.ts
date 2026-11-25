import { randomUUID } from "node:crypto"
import { start } from "workflow/api"
import { submitApplicationWorkflow } from "@/workflows/applications"
import {
  questionMessage,
  questionKeyboard,
  currentQuestion,
} from "@/lib/telegram"
import { missingAnswers } from "@/lib/applications"
import { continueAutomaticApplication } from "@/lib/server/applications/queue"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { telegramConfig, telegramEnabled } from "./config"
import { initializeRequest, parseRequest } from "./store"
import { sendTelegram } from "./api"
import { addTelegramAIDrafts } from "./drafts"
import { deliverTelegramAttention, sweepTelegramAttention } from "./attention"
import { recoverPendingApplicationDispatches } from "@/lib/server/applications/auto-apply"
import { purgeExpiredTelegramVerification } from "./verification"
import { sweepTelegramFollowups } from "./followup"
import {
  deliverTelegramSubmission,
  sweepTelegramSubmissions,
} from "./submission"

export async function dispatchTelegramSubmissions() {
  const db = supabaseServerClient()
  const result = await db
    .from("telegram_requests")
    .select("id,application_id,dispatch_revision")
    .eq("status", "completed")
    .not("dispatch_revision", "is", null)
    .is("dispatched_at", null)
    .order("created_at")
    .limit(50)
  if (result.error) throw result.error
  for (const row of result.data) {
    // Queue/claim CAS in the existing runner makes duplicate starts harmless.
    await start(submitApplicationWorkflow, [
      row.application_id,
      row.dispatch_revision,
    ])
    const saved = await db
      .from("telegram_requests")
      .update({ dispatched_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("dispatch_revision", row.dispatch_revision)
      .is("dispatched_at", null)
    if (saved.error) throw saved.error
  }
}
export async function deliverTelegram(
  userId: string,
  applicationId?: string
): Promise<boolean> {
  if (!telegramEnabled()) return false
  const config = telegramConfig()
  const db = supabaseServerClient()
  const token = randomUUID()
  const claimed = await db.rpc("claim_telegram_delivery", {
    p_user: userId,
    p_token: token,
  })
  if (claimed.error) throw claimed.error
  if (!claimed.data) return false
  const row = claimed.data
  const q = parseRequest(row)
  if (applicationId && q.application_id !== applicationId) {
    await db
      .from("telegram_requests")
      .update({ lease_token: null, lease_until: null })
      .eq("id", q.id)
      .eq("lease_token", token)
    return false
  }
  try {
    if (!q.state.initialized) {
      const initialized = await initializeRequest(q, row.thread_id)
      return initialized ? await deliverTelegram(userId, applicationId) : false
    }
    if (await addTelegramAIDrafts(q, token, row.thread_id)) {
      return await deliverTelegram(userId, applicationId)
    }
    // Recheck immediately before disclosing private data or sending a card.
    const current = await db
      .from("telegram_requests")
      .select("id,application:application_runs(status,message,automatic)")
      .eq("id", q.id)
      .eq("version", q.version)
      .eq("status", "pending")
      .eq("lease_token", token)
      .returns<
        {
          id: string
          application: {
            status: string
            message: string
            automatic: boolean
          } | null
        }[]
      >()
      .maybeSingle()
    if (current.error) throw current.error
    if (!current.data) return false
    q.automatic = current.data.application?.automatic === true
    if (q.automatic && !currentQuestion(q)) {
      // Permission was granted when the automatic application was requested.
      // A failed queue claim or an operational failure must never turn into a
      // second approval request. Existing recovery handles pending dispatches;
      // attention notifications report failures separately.
      if (
        current.data.application?.status === "ready" &&
        !missingAnswers(q.packet).length
      ) {
        const queued = await continueAutomaticApplication(q.application_id)
        if (queued !== null) return true
      }
      const released = await db
        .from("telegram_requests")
        .update({
          lease_token: null,
          lease_until: null,
          next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .eq("id", q.id)
        .eq("version", q.version)
        .eq("lease_token", token)
      if (released.error) throw released.error
      return false
    }
    const prompt = questionMessage(q, config.origin)
    const issue = current.data.application
    const messageId = await sendTelegram(
      row.thread_id,
      issue?.message ? `${prompt.text}\n\n${issue.message}` : prompt.text,
      questionKeyboard(q, prompt),
      prompt.forceReply
    )
    const saved = await db
      .from("telegram_requests")
      .update({
        delivered_version: q.version,
        provider_message_id: messageId,
        lease_token: null,
        lease_until: null,
        last_error: null,
        next_attempt_at: q.expires_at,
      })
      .eq("id", q.id)
      .eq("version", q.version)
      .eq("lease_token", token)
    if (saved.error) throw saved.error
    return true
  } catch {
    // A lost response can duplicate a notification, never an approval or send.
    await db
      .from("telegram_requests")
      .update({
        lease_token: null,
        lease_until: null,
        last_error: "delivery_failed",
        status: row.attempts >= 4 ? "paused" : "pending",
        next_attempt_at: new Date(
          Date.now() + 60_000 * 2 ** Math.min(row.attempts, 5)
        ).toISOString(),
      })
      .eq("id", q.id)
      .eq("version", q.version)
      .eq("lease_token", token)
    console.warn("Telegram delivery deferred")
    return false
  }
}
export async function notifyApplicationTelegram(id: string) {
  if (!telegramEnabled()) return
  try {
    await deliverTelegramSubmission(id)
  } catch {
    console.warn("Telegram submission notification remains queued")
  }
  try {
    await deliverTelegramAttention(id, deliverTelegram)
  } catch {
    console.warn("Telegram attention notification remains queued")
  }
  try {
    const result = await supabaseServerClient()
      .from("application_runs")
      .select("user_id")
      .eq("id", id)
      .maybeSingle()
    if (result.error) throw result.error
    if (result.data) await deliverTelegram(result.data.user_id)
  } catch {
    console.warn("Telegram notification remains queued")
  }
}
export async function sweepTelegram() {
  if (!telegramEnabled()) return { enabled: false }
  telegramConfig()
  const db = supabaseServerClient()
  await purgeExpiredTelegramVerification().catch(() => {
    console.warn("Expired Telegram verification cleanup deferred")
  })
  const attentionChecked = await sweepTelegramAttention(deliverTelegram)
  const submissionsChecked = await sweepTelegramSubmissions()
  await dispatchTelegramSubmissions()
  // Preparation retries persist their queued intent before dispatch. Recover a
  // lost start response using the same CAS-protected runner, never a new send.
  await recoverPendingApplicationDispatches().catch(() => {
    console.warn("Telegram preparation recovery remains queued")
  })
  const expired = await db
    .from("telegram_requests")
    .update({ status: "expired", lease_token: null, lease_until: null })
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString())
  if (expired.error) throw expired.error
  // Pending work stays queryable independently of open browser tabs.
  const result = await db
    .from("telegram_requests")
    .select("user_id")
    .eq("status", "pending")
    .lt("attempts", 5)
    .gt("expires_at", new Date().toISOString())
    .lt("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at")
    .limit(100)
  if (result.error) throw result.error
  const users = [...new Set(result.data.map((r) => r.user_id))]
  for (const user of users) await deliverTelegram(user)
  // Inbound replay IDs and old review snapshots have bounded retention.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString()
  const cleanup = await Promise.all([
    db.from("telegram_inbound").delete().lt("received_at", cutoff),
    db.from("telegram_links").delete().lt("expires_at", cutoff),
    db
      .from("telegram_requests")
      .delete()
      .lt("expires_at", cutoff)
      .not("status", "eq", "pending")
      .or("dispatch_revision.is.null,dispatched_at.not.is.null"),
  ])
  for (const result of cleanup) if (result.error) throw result.error
  const followupsSent = await sweepTelegramFollowups().catch(() => {
    console.warn("Telegram follow-up sweep deferred")
    return 0
  })
  return {
    enabled: true,
    accountsChecked: users.length,
    attentionChecked,
    submissionsChecked,
    followupsSent,
  }
}
