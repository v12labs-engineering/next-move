import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { apiError, HttpError, privateJson, readJson } from "@/lib/server/http"
import { analyzeResume } from "@/lib/server/resume/profile"
import { tailoringConfig } from "@/lib/server/tailoring"
export const runtime = "nodejs"
export const maxDuration = 60
const input = z
  .object({ resumeText: z.string().trim().min(100).max(30_000) })
  .strict()
export async function POST(request: Request) {
  try {
    const { db } = await requireAccount()
    const { resumeText } = input.parse(await readJson(request, 130_000))
    tailoringConfig()
    const quota = await db.rpc("reserve_tailoring_attempt")
    if (quota.error) throw quota.error
    if (!quota.data)
      throw new HttpError(
        429,
        "You've used all AI requests in your plan for this 30-day period."
      )
    return privateJson({ ok: true, candidate: await analyzeResume(resumeText) })
  } catch (error) {
    return apiError(error)
  }
}
