import { z } from "zod"
import { apiError, HttpError, privateJson } from "@/lib/server/http"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { findFollowupContacts, followupContactsSchema } from "./followup"

export const followupEmployerSchema = z.object({
  company: z.string().trim().min(1),
  title: z.string(),
  targetUrl: z.string(),
})

const reservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cached"), contacts: followupContactsSchema }),
  z.object({
    status: z.literal("reserved"),
    id: z.uuid(),
    employer: followupEmployerSchema.optional(),
  }),
  z.object({ status: z.enum(["ineligible", "recent", "daily_limit"]) }),
])

export class FollowupLookupDeferred extends HttpError {
  constructor(public reason: "recent" | "daily_limit") {
    super(
      429,
      reason === "recent"
        ? "A lookup was requested recently. Try again in a few minutes."
        : "Today’s contact lookup limit has been reached. Try again tomorrow."
    )
  }
}

export function followupLookupError(error: unknown) {
  if (error instanceof FollowupLookupDeferred && error.reason === "recent")
    return privateJson({ error: error.message }, 202)
  return apiError(error)
}

export const confirmedFollowupMessage =
  "Contact suggestions require a confirmed job application."
export const manualFollowupMessage =
  "Contact suggestions are available for your five most recently marked applied jobs."

export function lookupConfirmedFollowup(
  id: string,
  userId: string,
  employer: z.infer<typeof followupEmployerSchema>
) {
  return lookupFollowupContacts(
    (db) =>
      db.rpc("reserve_application_followup", { p_id: id, p_user_id: userId }),
    confirmedFollowupMessage,
    employer
  )
}

export function lookupManualFollowup(jobId: string, userId: string) {
  return lookupFollowupContacts(
    (db) =>
      db.rpc("reserve_manual_application_followup", {
        p_job_id: jobId,
        p_user_id: userId,
      }),
    manualFollowupMessage
  )
}

async function lookupFollowupContacts(
  reserve: (
    db: ReturnType<typeof supabaseServerClient>
  ) => PromiseLike<{ data: unknown; error: unknown }>,
  ineligibleMessage: string,
  confirmedEmployer?: z.infer<typeof followupEmployerSchema>
) {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim()
  if (!apiKey) throw new HttpError(503, "Contact suggestions are unavailable.")

  const db = supabaseServerClient()
  const reserved = await reserve(db)
  if (reserved.error) throw reserved.error
  const reservation = reservationSchema.parse(reserved.data)
  if (reservation.status === "cached") return reservation.contacts
  if (reservation.status === "recent" || reservation.status === "daily_limit")
    throw new FollowupLookupDeferred(reservation.status)
  if (reservation.status !== "reserved")
    throw new HttpError(409, ineligibleMessage)

  const employer = confirmedEmployer ?? reservation.employer
  if (!employer) throw new Error("Missing follow-up employer")
  const contacts = await findFollowupContacts(employer, apiKey).catch(() => {
    throw new HttpError(
      502,
      "Contact lookup is temporarily unavailable. Try again in a few minutes."
    )
  })
  const saved = await db
    .from("application_followup_lookups")
    .update({ contacts })
    .eq("id", reservation.id)
    .select("id")
    .single()
  if (saved.error) throw saved.error
  return contacts
}
