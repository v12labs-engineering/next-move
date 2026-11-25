import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { getCandidate } from "@/lib/server/account-store"
import { apiError, HttpError, privateJson, readJson } from "@/lib/server/http"
import { tailorResume, tailoringConfig } from "@/lib/server/tailoring"
import { hydrateCatalogDescriptions } from "@/lib/server/catalog/content"
export const maxDuration = 60
const input = z.object({ jobId: z.string().min(1).max(500) }).strict()
export async function GET() {
  try {
    const { db, user } = await requireAccount()
    const { data, error } = await db
      .from("resume_drafts")
      .select("id,job_id,created_at,profile_version")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50)
    if (error) throw error
    return privateJson({ ok: true, drafts: data })
  } catch (error) {
    return apiError(error)
  }
}
export async function POST(request: Request) {
  try {
    const account = await requireAccount()
    const { jobId } = input.parse(await readJson(request, 2000))
    const profile = await getCandidate(account)
    if (!profile) throw new HttpError(409, "Complete your profile first.")
    const { data: storedJob, error } = await account.db
      .from("job_catalog")
      .select("id,title,company,description,description_ref")
      .eq("id", jobId)
      .maybeSingle()
    if (error) throw error
    if (!storedJob) throw new HttpError(404, "Job not found.")
    const [job] = await hydrateCatalogDescriptions(account.db, [storedJob])
    if (!job.description || job.description.length < 100)
      throw new HttpError(
        422,
        "This listing needs a full job description before we can tailor a resume."
      )
    tailoringConfig()
    const quota = await account.db.rpc("reserve_tailoring_attempt")
    if (quota.error) throw quota.error
    if (!quota.data)
      throw new HttpError(
        429,
        "You've used all AI requests in your plan for this 30-day period."
      )
    const result = await tailorResume(profile.candidate.resumeText, job)
    const saved = await account.db
      .from("resume_drafts")
      .insert({
        user_id: account.user.id,
        job_id: job.id,
        profile_version: profile.version,
        content: result.content,
        model: result.model,
        evidence: {
          highlights: result.highlights,
          keywordEvidence: result.keywordEvidence,
          usage: result.usage,
          job: { title: job.title, company: job.company },
        },
      })
      .select("id")
      .single()
    if (saved.error) throw saved.error
    return privateJson({ ok: true, id: saved.data.id }, 201)
  } catch (error) {
    return apiError(error)
  }
}
