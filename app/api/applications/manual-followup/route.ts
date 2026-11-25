import { z } from "zod"
import { after } from "next/server"
import { requireAccount } from "@/lib/server/session"
import { privateJson, readJson } from "@/lib/server/http"
import {
  followupLookupError,
  lookupManualFollowup,
} from "@/lib/server/applications/followup-request"
import { queueTelegramFollowup } from "@/lib/server/telegram/followup"

export async function POST(request: Request) {
  try {
    const { jobId } = z
      .strictObject({ jobId: z.string().min(1).max(500) })
      .parse(await readJson(request, 2048))
    const { user } = await requireAccount()
    const contacts = await lookupManualFollowup(jobId, user.id)
    if (contacts.length) after(() => queueTelegramFollowup(user.id, jobId))
    return privateJson({ contacts })
  } catch (error) {
    return followupLookupError(error)
  }
}
