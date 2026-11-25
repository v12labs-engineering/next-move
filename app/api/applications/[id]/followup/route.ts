import { z } from "zod"
import { after } from "next/server"
import { requireAccount } from "@/lib/server/session"
import { HttpError, privateJson, readJson } from "@/lib/server/http"
import { ownedApplication } from "@/lib/server/applications/store"
import {
  confirmedFollowupMessage,
  followupLookupError,
  lookupConfirmedFollowup,
} from "@/lib/server/applications/followup-request"
import { queueTelegramFollowup } from "@/lib/server/telegram/followup"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    z.strictObject({}).parse(await readJson(request, 1024))
    const account = await requireAccount()
    const run = await ownedApplication(account, (await params).id)
    const company = run.packet?.company.trim()
    const jobId = run.job_id
    if (run.status !== "submitted" || !run.receipt || !jobId || !company)
      throw new HttpError(409, confirmedFollowupMessage)

    const contacts = await lookupConfirmedFollowup(run.id, account.user.id, {
      company,
      title: run.packet?.title ?? "",
      targetUrl: run.target_url,
    })
    if (contacts.length)
      after(() => queueTelegramFollowup(account.user.id, jobId, run.id))
    return privateJson({ contacts })
  } catch (error) {
    return followupLookupError(error)
  }
}
