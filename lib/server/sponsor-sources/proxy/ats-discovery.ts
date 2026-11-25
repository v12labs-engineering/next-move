import type { TargetCountry } from "@/lib/location/relocation-data"
import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"

const ARBEITNOW_API = "https://www.arbeitnow.com/api/job-board-api"

/** Country → location substrings that indicate a job is in that country. */
const COUNTRY_LOCATION_HINTS: Partial<Record<TargetCountry, string[]>> = {
  Germany: [
    "berlin",
    "munich",
    "münchen",
    "hamburg",
    "frankfurt",
    "cologne",
    "köln",
    "stuttgart",
    "düsseldorf",
    "germany",
    "deutschland",
  ],
  Sweden: ["stockholm", "gothenburg", "göteborg", "malmö", "malmo", "sweden", "sverige"],
  UAE: ["dubai", "abu dhabi", "sharjah", "uae", "united arab emirates"],
}

const SOFTWARE_TAG_RE =
  /(software|engineer|developer|backend|frontend|full.?stack|devops|data|machine learning|ai|cloud|platform|python|java|typescript|golang|react|node)/i

interface ArbeitnowJob {
  company_name: string
  title: string
  location: string
  url: string
  tags?: string[]
  remote?: boolean
}

/**
 * Tier C discovery for countries with NO official sponsor register
 * (Germany, Sweden, UAE). Discovers software-hiring companies via the
 * arbeitnow public job-board API, filtered to the country + software roles.
 *
 * Returns company seeds (deduped). Coverage is strongest for Germany; Sweden
 * and UAE are best-effort. These earn visaSignal "possible" downstream, never
 * "strong", because there is no official sponsor backing.
 *
 * Fails loudly if the API is unreachable.
 */
export async function discoverViaAts(
  country: TargetCountry,
  maxPages = 5
): Promise<SponsorSeed[]> {
  const hints = COUNTRY_LOCATION_HINTS[country]
  if (!hints) {
    throw new Error(`No ATS discovery strategy configured for ${country}`)
  }

  const byCompany = new Map<string, SponsorSeed>()

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPageWithRetry(page)
    const json = (await res.json()) as { data?: ArbeitnowJob[] }
    const jobs = json.data ?? []
    if (jobs.length === 0) break

    for (const job of jobs) {
      const loc = (job.location ?? "").toLowerCase()
      if (!hints.some((h) => loc.includes(h))) continue
      const isSoftware =
        SOFTWARE_TAG_RE.test(job.title) ||
        (job.tags ?? []).some((t) => SOFTWARE_TAG_RE.test(t))
      if (!isSoftware) continue

      const key = job.company_name.toLowerCase().trim()
      if (!key) continue
      const existing = byCompany.get(key)
      const discovered = { title: job.title.trim(), url: job.url }
      if (existing) {
        existing.jobs = [...(existing.jobs ?? []), discovered]
      } else {
        byCompany.set(key, {
          name: job.company_name.trim(),
          city: job.location?.trim() || country,
          careersUrl: companyBoardUrl(job.url),
          note: `Discovered via arbeitnow software roles`,
          jobs: [discovered],
        })
      }
    }
  }

  return [...byCompany.values()]
}

async function fetchPageWithRetry(page: number, attempts = 3): Promise<Response> {
  let lastErr = ""
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${ARBEITNOW_API}?page=${page}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) return res
    lastErr = `${res.status} ${res.statusText}`
    if (res.status === 429) {
      await sleep(1500 * (i + 1))
      continue
    }
    break
  }
  throw new Error(`arbeitnow API failed: ${lastErr}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** arbeitnow job URLs are /jobs/companies/<slug>/<job-slug>; trim to the board. */
function companyBoardUrl(jobUrl: string): string | undefined {
  const m = jobUrl.match(/^(https:\/\/www\.arbeitnow\.com\/jobs\/companies\/[^/]+)\//)
  return m ? m[1] : undefined
}
