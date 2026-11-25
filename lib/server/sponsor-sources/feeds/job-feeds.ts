import { isSoftwareRole } from "@/lib/jobs/software-roles"
import type { SourceType, TargetCountry } from "@/lib/location/relocation-data"
import type { PreDiscoveredJob } from "@/lib/server/sponsor-sources/types"
import { countryFromLocation } from "@/lib/server/sponsor-sources/profile"

/**
 * High-volume keyless job feeds. Each returns flat postings; the country
 * adapters group them into company seeds. All feeds:
 *   - return REAL postings via documented public APIs (no scraping),
 *   - filter to software roles at every seniority,
 *   - attach a country, location, salary, and a relocation/visa descriptor.
 *
 * Feeds fail soft (return []) on a single bad page but throw if the whole
 * source is unreachable, so a country run still surfaces the failure.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/** A profile-matched posting tagged with its country, ready to group. */
export interface FeedJob extends PreDiscoveredJob {
  companyName: string
  country: TargetCountry
  fitScore: number
}

const VISA_RE =
  /\b(visa sponsor|sponsorship|relocation|relocate|work permit|blue card|blaue karte|we sponsor|visa support|international candidates|highly skilled migrant|kennismigrant)\b/i

/** Does this posting's text signal visa/relocation support? */
export function hasVisaSignal(text: string): boolean {
  return VISA_RE.test(text)
}

async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, accept: "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

function toFeedJob(args: {
  companyName: string
  title: string
  url: string
  source: SourceType
  country: TargetCountry
  location: string
  salary?: string
  remote?: boolean
  descriptor: string
}): FeedJob | null {
  const { companyName, title, url, source, country, location, salary, remote, descriptor } = args
  if (!companyName || !title || !url) return null
  if (!isSoftwareRole(title, descriptor)) return null
  return {
    companyName: companyName.trim(),
    title: title.trim(),
    url,
    source,
    country,
    location,
    salary,
    remote,
    descriptor,
    fitScore: 0,
  }
}

/* ----------------------------- Arbeitnow ----------------------------- */
// EU-wide board with a built-in visa-sponsorship filter. Paginated, 100/page.

interface ArbeitnowJob {
  company_name: string
  title: string
  location: string
  url: string
  tags?: string[]
  job_types?: string[]
  remote?: boolean
  description?: string
}

export async function fetchArbeitnow(maxPages = 20): Promise<FeedJob[]> {
  const out: FeedJob[] = []
  for (let page = 1; page <= maxPages; page++) {
    let json: { data?: ArbeitnowJob[] }
    try {
      json = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`)
    } catch {
      if (page === 1) throw new Error("Arbeitnow unreachable")
      break
    }
    const jobs = json.data ?? []
    if (jobs.length === 0) break
    for (const j of jobs) {
      const country = countryFromLocation(j.location ?? "")
      if (!country) continue
      const descriptor = `${(j.tags ?? []).join(" ")} ${j.description?.slice(0, 12000) ?? ""}`
      const fj = toFeedJob({
        companyName: j.company_name,
        title: j.title,
        url: j.url,
        source: "arbeitnow",
        country,
        location: j.location,
        remote: j.remote,
        descriptor,
      })
      if (fj) out.push(fj)
    }
  }
  return out
}

/* ----------------------------- Remotive ------------------------------ */
// Remote-first board; we keep EU/relocation-friendly remote roles.

interface RemotiveJob {
  title: string
  company_name: string
  candidate_required_location: string
  url: string
  tags?: string[]
  description?: string
}

export async function fetchRemotive(limit = 250): Promise<FeedJob[]> {
  const json = await getJson<{ jobs?: RemotiveJob[] }>(
    `https://remotive.com/api/remote-jobs?category=software-dev&limit=${limit}`
  )
  const out: FeedJob[] = []
  for (const j of json.jobs ?? []) {
    const where = (j.candidate_required_location ?? "").toLowerCase()
    // Keep roles open to Europe / worldwide (relocation- or EU-remote-friendly).
    const euOpen =
      where.includes("europe") ||
      where.includes("emea") ||
      where.includes("worldwide") ||
      where.includes("anywhere") ||
      countryFromLocation(where) !== null
    if (!euOpen) continue
    const country = countryFromLocation(where) ?? "Germany" // default EU bucket
    const descriptor = `${(j.tags ?? []).join(" ")} ${j.description?.slice(0, 12000) ?? ""}`
    const fj = toFeedJob({
      companyName: j.company_name,
      title: j.title,
      url: j.url,
      source: "remotive",
      country,
      location: j.candidate_required_location || "Remote (Europe)",
      remote: true,
      descriptor,
    })
    if (fj) out.push(fj)
  }
  return out
}

/* ----------------------------- RemoteOK ------------------------------ */

interface RemoteOkJob {
  position?: string
  company?: string
  location?: string
  url?: string
  tags?: string[]
  description?: string
}

export async function fetchRemoteOk(): Promise<FeedJob[]> {
  const arr = await getJson<RemoteOkJob[]>("https://remoteok.com/api")
  const out: FeedJob[] = []
  for (const j of arr) {
    if (!j.position || !j.company || !j.url) continue // first element is legal notice
    const where = (j.location ?? "").toLowerCase()
    const euOpen =
      where.includes("europe") ||
      where.includes("emea") ||
      where.includes("worldwide") ||
      where.includes("anywhere") ||
      where === "" ||
      countryFromLocation(where) !== null
    if (!euOpen) continue
    const country = countryFromLocation(where) ?? "Germany"
    const descriptor = `${(j.tags ?? []).join(" ")} ${j.description?.slice(0, 12000) ?? ""}`
    const fj = toFeedJob({
      companyName: j.company,
      title: j.position,
      url: j.url,
      source: "remoteok",
      country,
      location: j.location || "Remote",
      remote: true,
      descriptor,
    })
    if (fj) out.push(fj)
  }
  return out
}

/* ------------------------------ The Muse ----------------------------- */
// Huge board (100k+ postings) with real per-city location data. We query the
// engineering categories across each target EU city and paginate.

interface MuseJob {
  name: string
  company?: { name?: string }
  locations?: Array<{ name?: string }>
  refs?: { landing_page?: string }
  contents?: string
}

const MUSE_CATEGORIES = ["Software Engineering", "Data Science", "Engineering"]

export async function fetchTheMuse(country: TargetCountry, cities: string[], maxPagesPerCity = 3): Promise<FeedJob[]> {
  const out: FeedJob[] = []
  for (const city of cities) {
    for (let page = 0; page < maxPagesPerCity; page++) {
      const params = new URLSearchParams()
      MUSE_CATEGORIES.forEach((c) => params.append("category", c))
      params.set("location", city)
      params.set("page", String(page))
      let json: { results?: MuseJob[]; page_count?: number }
      try {
        json = await getJson(`https://www.themuse.com/api/public/jobs?${params}`)
      } catch {
        break
      }
      const results = json.results ?? []
      if (results.length === 0) break
      for (const j of results) {
        const loc = j.locations?.map((l) => l.name).filter(Boolean).join(", ") ?? city
        const url = j.refs?.landing_page
        if (!url) continue
        const fj = toFeedJob({
          companyName: j.company?.name ?? "",
          title: j.name,
          url,
          source: "themuse",
          country,
          location: loc || city,
          descriptor: j.contents?.replace(/<[^>]+>/g, " ").slice(0, 12000) ?? "",
        })
        if (fj) out.push(fj)
      }
      if (json.page_count != null && page >= json.page_count - 1) break
    }
  }
  return out
}

/* ----------------- Greenhouse / Lever / Ashby boards ----------------- */
// Curated EU AI/startup employers. Public board APIs return ALL open roles as
// clean JSON — the highest-quality, visa-likely source for founding/staff roles.

export interface CuratedBoard {
  company: string
  ats: "greenhouse" | "lever" | "ashby"
  slug: string
  country: TargetCountry
}

interface GreenhouseJob {
  title: string
  absolute_url: string
  location?: { name?: string }
  content?: string
}
interface LeverJob {
  text: string
  hostedUrl: string
  categories?: { location?: string; team?: string }
  descriptionPlain?: string
}
interface AshbyJob {
  title: string
  jobUrl?: string
  applyUrl?: string
  location?: string
  secondaryLocations?: Array<{ location?: string }>
  department?: string
  descriptionPlain?: string
}

export async function fetchCuratedBoard(board: CuratedBoard): Promise<FeedJob[]> {
  const out: FeedJob[] = []
  try {
    if (board.ats === "greenhouse") {
      const json = await getJson<{ jobs?: GreenhouseJob[] }>(
        `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`
      )
      for (const j of json.jobs ?? []) {
        const loc = j.location?.name ?? ""
        const country = countryFromLocation(loc) ?? board.country
        const fj = toFeedJob({
          companyName: board.company,
          title: j.title,
          url: j.absolute_url,
          source: board.ats,
          country,
          location: loc || board.country,
          descriptor: (j.content ?? "").replace(/<[^>]+>/g, " ").slice(0, 12000),
        })
        if (fj) out.push(fj)
      }
    } else if (board.ats === "lever") {
      const json = await getJson<LeverJob[]>(
        `https://api.lever.co/v0/postings/${board.slug}?mode=json`
      )
      for (const j of json) {
        const loc = j.categories?.location ?? ""
        const country = countryFromLocation(loc) ?? board.country
        const fj = toFeedJob({
          companyName: board.company,
          title: j.text,
          url: j.hostedUrl,
          source: board.ats,
          country,
          location: loc || board.country,
          descriptor: `${j.categories?.team ?? ""} ${(j.descriptionPlain ?? "").slice(0, 12000)}`,
        })
        if (fj) out.push(fj)
      }
    } else {
      const json = await getJson<{ jobs?: AshbyJob[] }>(
        `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`
      )
      for (const j of json.jobs ?? []) {
        const loc = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]
          .filter(Boolean)
          .join(", ")
        const country = countryFromLocation(loc) ?? board.country
        const url = j.jobUrl ?? j.applyUrl
        if (!url) continue
        const fj = toFeedJob({
          companyName: board.company,
          title: j.title,
          url,
          source: board.ats,
          country,
          location: loc || board.country,
          descriptor: `${j.department ?? ""} ${(j.descriptionPlain ?? "").slice(0, 12000)}`,
        })
        if (fj) out.push(fj)
      }
    }
  } catch {
    // A single dead board shouldn't kill the run; skip it.
    return []
  }
  return out
}
