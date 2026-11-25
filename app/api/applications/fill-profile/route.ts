import { z } from "zod"
import { continueAutomaticApplication } from "@/lib/server/applications/queue"
import { requireAccount } from "@/lib/server/session"
import { getCandidate } from "@/lib/server/account-store"
import { apiError, privateJson, readJson, HttpError } from "@/lib/server/http"
import {
  packetSchema,
  missingAnswers,
  type ApplicationPacket,
} from "@/lib/applications"
import { applicationProfileFresh } from "@/lib/applications/profile"
import { fillApplicationIdentity } from "@/lib/applications/answers"
import { fillApplicationMemory } from "@/lib/server/applications/question-memory"
import { resolvePacketAnswers } from "@/lib/server/applications/answer-resolver"
import { saveRefilledPacket } from "@/lib/server/applications/refill"

export const maxDuration = 300

export async function POST(request: Request) {
  try {
    const account = await requireAccount()
    const body = z
      .object({ continueAutomatic: z.boolean() })
      .strict()
      .parse(await readJson(request, 1000))
    const savedProfile = await getCandidate(account)
    const candidate = savedProfile?.candidate
    if (
      !candidate?.applicationProfile ||
      !applicationProfileFresh(candidate.applicationProfile)
    )
      throw new HttpError(
        409,
        "Confirm and save your application profile first."
      )
    const rows = await account.db
      .from("application_runs")
      .select("id,revision,packet,automatic,job_id")
      .eq("user_id", account.user.id)
      .eq("status", "ready")
      .order("updated_at")
      .limit(50)
    if (rows.error) throw rows.error
    const jobIds = rows.data.flatMap((row) =>
      row.job_id ? [row.job_id as string] : []
    )
    const jobs = jobIds.length
      ? await account.db
          .from("job_catalog")
          .select("id,country")
          .in("id", jobIds)
      : { data: [], error: null }
    if (jobs.error) throw jobs.error
    const countries = new Map(jobs.data.map((row) => [row.id, row.country]))
    let updated = 0,
      queued = 0,
      skipped = 0
    for (const row of rows.data) {
      const parsed = packetSchema.safeParse(row.packet)
      if (!parsed.success) {
        skipped++
        continue
      }
      try {
        let packet: ApplicationPacket = {
          ...parsed.data,
          applicationContext: {
            country: countries.get(row.job_id) || "",
            profile: candidate.applicationProfile,
            jobDescription:
              parsed.data.applicationContext?.jobDescription || "",
          },
        }
        packet = await resolvePacketAnswers(
          await fillApplicationMemory(row.id, packet)
        )
        packet = fillApplicationIdentity(packet, {
          fullName: candidate.fullName,
          resumeText: candidate.resumeText,
          email: account.user.email || "",
        })
        const changed = JSON.stringify(packet) !== JSON.stringify(parsed.data)
        const revision = changed
          ? await saveRefilledPacket(account, row.id, row.revision, packet)
          : row.revision
        if (revision === null) {
          skipped++
          continue
        }
        if (changed) updated++
        if (
          body.continueAutomatic &&
          row.automatic &&
          !missingAnswers(packet).length
        ) {
          const continued = await continueAutomaticApplication(row.id)
          if (continued === null) {
            skipped++
            continue
          }
          queued++
        }
      } catch {
        skipped++
      }
    }
    return privateJson({ updated, queued, skipped })
  } catch (error) {
    return apiError(error)
  }
}
