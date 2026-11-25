import { candidateSchema } from "@/lib/candidate"
import { JOB_SEARCH_COUNTRY } from "@/lib/location/countries"
import { z } from "zod"
import { after } from "next/server"
import { dispatchAccountMatching } from "@/lib/server/matching/dispatch"
import { getCandidate, saveCandidate } from "@/lib/server/account-store"
import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson, readJson, HttpError } from "@/lib/server/http"
import { confirmApplicationProfile } from "@/lib/applications/profile"
import {
  meetsOnboardingExperience,
  onboardingExperienceMessage,
} from "@/lib/candidate/onboarding"
export async function GET() {
  try {
    return privateJson({
      ok: true,
      profile: await getCandidate(await requireAccount()),
    })
  } catch (error) {
    return apiError(error)
  }
}
export async function PUT(request: Request) {
  try {
    const account = await requireAccount()
    const version = z.coerce
      .number()
      .int()
      .min(0)
      .parse(request.headers.get("if-match"))
    const candidate = candidateSchema.parse(await readJson(request))
    candidate.targetCountries = [JOB_SEARCH_COUNTRY]
    candidate.targetLocations = candidate.targetLocations?.filter(
      (location) => location.country === JOB_SEARCH_COUNTRY
    )
    const previous = await getCandidate(account)
    if ((previous?.version ?? 0) !== version)
      throw new HttpError(
        409,
        "Your profile changed in another tab. Reload before saving again."
      )
    if (!previous && !meetsOnboardingExperience(candidate.experienceYears))
      throw new HttpError(422, onboardingExperienceMessage)
    if (candidate.applicationProfile) {
      candidate.applicationProfile = confirmApplicationProfile(
        candidate.applicationProfile,
        previous?.candidate.applicationProfile
      )
    }
    await saveCandidate(account, candidate, version)
    after(async () => {
      try {
        await dispatchAccountMatching(account.user.id)
      } catch {
        console.error("Could not dispatch profile matching")
      }
    })
    return privateJson({ ok: true, version: version + 1 })
  } catch (error) {
    return apiError(error)
  }
}
