import { measureMatching } from "./metrics"
import {
  getCandidate,
  trackedCountriesFor,
  type AccountRef,
} from "@/lib/server/account-store"
import { HttpError } from "@/lib/server/http"
import { visaNeeded } from "@/lib/applications/auto-apply"
import { JOB_SEARCH_COUNTRY } from "@/lib/location/countries"
import { matchPageFilters, type MatchPage } from "@/lib/matching/page"

export async function readMatchPage(
  account: AccountRef,
  params: URLSearchParams
) {
  const filters = matchPageFilters.parse(Object.fromEntries(params))
  const profile = await getCandidate(account)
  if (!profile) throw new HttpError(409, "Complete your profile first.")
  const result = await measureMatching("read", async () => {
    const response = await account.db.rpc("read_account_matches", {
      p_filters: {
        ...filters,
        ...(filters.view === "jobs" ? { country: JOB_SEARCH_COUNTRY } : {}),
        visaExempt: profile.candidate.targetCountries.filter(
          (country) => !visaNeeded(profile.candidate)(country)
        ),
      },
    })
    if (response.error) throw response.error
    return response
  })
  const { jobs, catalog, ...page } = result.data
  return {
    ...page,
    state: {
      jobs,
      catalog: catalog ?? undefined,
      trackedCountries: trackedCountriesFor(profile),
    },
  } as MatchPage
}
