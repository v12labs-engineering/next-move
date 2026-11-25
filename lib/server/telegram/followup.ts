import { randomUUID } from "node:crypto"
import { z } from "zod"
import { followupMessage } from "@/lib/applications/followup"
import {
  followupEmployerSchema,
  FollowupLookupDeferred,
  lookupConfirmedFollowup,
  lookupManualFollowup,
} from "@/lib/server/applications/followup-request"
import { HttpError } from "@/lib/server/http"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { sendTelegram } from "./api"
import { telegramEnabled } from "./config"

export async function queueTelegramFollowup(
  userId: string,
  jobId: string,
  applicationId: string | null = null
) {
  if (!telegramEnabled() || !process.env.FIRECRAWL_API_KEY?.trim()) return
  const result = await supabaseServerClient().rpc("queue_telegram_followup", {
    p_user_id: userId,
    p_job_id: jobId,
    p_application_id: applicationId,
  })
  if (result.error) console.warn("Telegram follow-up could not be queued")
}

const targetSchema = z.object({
  userId: z.uuid(),
  jobId: z.string(),
  applicationId: z.uuid().nullable(),
  thread: z.string(),
  attempts: z.number().int(),
  employer: followupEmployerSchema,
})

function nextAttempt(error: unknown) {
  const now = new Date()
  if (
    error instanceof FollowupLookupDeferred &&
    error.reason === "daily_limit"
  ) {
    now.setUTCHours(24, 5, 0, 0)
    return now.toISOString()
  }
  if (error instanceof FollowupLookupDeferred && error.reason === "recent")
    return new Date(now.getTime() + 2 * 60_000).toISOString()
  // A failed Firecrawl reservation has a ten-minute cooldown.
  return new Date(now.getTime() + 11 * 60_000).toISOString()
}

async function deliverTelegramFollowup(
  db: ReturnType<typeof supabaseServerClient>,
  id: string
) {
  const token = randomUUID()
  const params = { p_id: id, p_token: token }
  const claim = await db.rpc("claim_telegram_followup", params)
  if (claim.error) throw claim.error
  if (!claim.data) return false

  const row = db.from("telegram_followup_notifications")
  async function target() {
    const result = await db.rpc("telegram_followup_target", params)
    if (result.error) throw result.error
    return targetSchema.nullable().parse(result.data)
  }
  async function remove() {
    const result = await row.delete().eq("id", id).eq("lease_token", token)
    if (result.error) throw result.error
    return false
  }
  const release = { lease_token: null, lease_until: null }
  let current: z.infer<typeof targetSchema> | null = null
  try {
    current = await target()
    if (!current) return await remove()
    const { applicationId, userId, jobId, thread, employer } = current
    const contacts = applicationId
      ? await lookupConfirmedFollowup(applicationId, userId, employer)
      : await lookupManualFollowup(jobId, userId)

    if (contacts.length) {
      const recipient = await target()
      if (!recipient || recipient.thread !== thread) return await remove()
      const { title, company } = employer
      const message = [
        `Follow-up suggestions for ${title ? `${title} at ` : ""}${company}`,
        ...contacts.map(
          (person) =>
            `${person.name} · ${person.title} (${person.reason})\n${followupMessage(person, title, company)}`
        ),
      ].join("\n\n")
      await sendTelegram(
        thread,
        message,
        contacts.map((person) => [
          {
            text: `LinkedIn · ${person.name.slice(0, 45)}`,
            url: person.profileUrl,
          },
        ])
      )
    }

    const completed = await row
      .update({ ...release, completed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("lease_token", token)
    if (completed.error) throw completed.error
    return contacts.length > 0
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return remove()
    const deferred = await row
      .update({
        ...release,
        next_attempt_at: nextAttempt(error),
        // A concurrent UI lookup can resolve without using another attempt.
        ...(current &&
        error instanceof FollowupLookupDeferred &&
        error.reason === "recent"
          ? { attempts: current.attempts - 1 }
          : {}),
      })
      .eq("id", id)
      .eq("lease_token", token)
    if (deferred.error) throw deferred.error
    return false
  }
}

export async function sweepTelegramFollowups() {
  if (!process.env.FIRECRAWL_API_KEY?.trim()) return 0
  const db = supabaseServerClient(10_000)
  const now = new Date().toISOString()
  const due = await db
    .from("telegram_followup_notifications")
    .select("id")
    .is("completed_at", null)
    .lt("attempts", 5)
    .lte("next_attempt_at", now)
    .or(`lease_until.is.null,lease_until.lte.${now}`)
    .order("next_attempt_at")
    .limit(10)
  if (due.error) throw due.error
  const deadline = Date.now() + 45_000
  let sent = 0
  for (const { id } of due.data) {
    if (Date.now() >= deadline) break
    try {
      if (await deliverTelegramFollowup(db, id)) sent++
    } catch {
      console.warn("Telegram follow-up notification remains queued")
    }
  }
  return sent
}
