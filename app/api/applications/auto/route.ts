import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { getCandidate } from "@/lib/server/account-store"
import { apiError, privateJson, readJson, HttpError } from "@/lib/server/http"
import { requestAutoApplications } from "@/lib/server/applications/auto-apply"
import type { Job } from "@/lib/jobs"
import { dispatchAccountMatching } from "@/lib/server/matching/dispatch"
export const maxDuration = 60

export async function GET() {
  try {
    const { db } = await requireAccount()
    const usage = await db.rpc("account_usage").maybeSingle()
    if (usage.error) throw usage.error
    return privateJson({ usage: usage.data })
  } catch (e) {
    return apiError(e)
  }
}

// The client proposes IDs; only fresh server-produced scores and live listing
// availability can authorize eligibility. The browser never supplies a score.
export async function POST(request: Request) {
  try {
    const account = await requireAccount()
    const { jobIds } = z
      .object({
        jobIds: z.array(z.string().min(1).max(500)).min(1).max(20),
      })
      .strict()
      .parse(await readJson(request, 12000))
    const profile = await getCandidate(account)
    if (!profile?.candidate.autoApply?.enabled)
      throw new HttpError(409, "Auto-apply is turned off.")
    const result = await account.db.rpc("read_account_matches", {
      p_filters: { view: "jobs", datePosted: "month", limit: 20, jobIds },
    })
    if (result.error) throw result.error
    const page = result.data
    if (
      page.profileVersion !== profile.version ||
      !page.matching.profileCurrent
    ) {
      await dispatchAccountMatching(account.user.id)
      throw new HttpError(
        409,
        "Matches are updating. Automatic applications will continue when matching finishes."
      )
    }
    const jobs = page.jobs as Job[]
    return privateJson(
      await requestAutoApplications(
        account.db,
        account.user.id,
        profile.candidate,
        jobs,
        (jobId) =>
          account.db.rpc("request_automatic_application", { p_job: jobId })
      )
    )
  } catch (e) {
    return apiError(e)
  }
}
