import type { TargetCountry } from "@/lib/location/relocation-data"
import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"
import {
  fetchArbeitnow,
  fetchCuratedBoard,
  fetchRemoteOk,
  fetchRemotive,
  fetchTheMuse,
  type FeedJob,
} from "@/lib/server/sponsor-sources/feeds/job-feeds"
import { CURATED_BOARDS } from "@/lib/server/sponsor-sources/feeds/curated-boards"
import { EU_COUNTRIES } from "@/lib/server/sponsor-sources/profile"

export interface FeedRunResult {
  /** Company seeds with profile-matched jobs attached, ready for the pipeline. */
  seeds: SponsorSeed[]
  /** Per-feed counts for the run log. */
  perFeed: Record<string, number>
  /** Total profile-matched jobs across all feeds, pre-grouping. */
  totalJobs: number
  /** Feeds that threw / were unreachable. */
  failures: string[]
}

/** Muse cities to query per EU country. */
const MUSE_CITIES: Partial<Record<TargetCountry, string[]>> = {
  Germany: ["Berlin, Germany", "Munich, Germany", "Hamburg, Germany", "Frankfurt, Germany"],
  Netherlands: ["Amsterdam, Netherlands", "Rotterdam, Netherlands", "Eindhoven, Netherlands"],
  Ireland: ["Dublin, Ireland"],
  Sweden: ["Stockholm, Sweden", "Gothenburg, Sweden"],
  Denmark: ["Copenhagen, Denmark"],
  Spain: ["Barcelona, Spain", "Madrid, Spain", "Valencia, Spain"],
  Portugal: ["Lisbon, Portugal", "Porto, Portugal"],
  Poland: ["Warsaw, Poland", "Kraków, Poland", "Wrocław, Poland"],
  France: ["Paris, France", "Lyon, France"],
  Finland: ["Helsinki, Finland"],
}

/** Pages to pull per Muse city (20 jobs/page). */
const MUSE_PAGES_PER_CITY = 5

async function settle<T>(label: string, p: Promise<T[]>, failures: string[]): Promise<T[]> {
  try {
    return await p
  } catch {
    failures.push(label)
    return []
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out.push(await fn(items[idx]))
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Run the public feeds, profile-match, and
 * group the resulting postings into company seeds. Throws only if EVERY feed
 * fails; otherwise it logs partial failures and returns what it found.
 */
export async function discoverEuJobs(
  countries: TargetCountry[] = EU_COUNTRIES
): Promise<FeedRunResult> {
  const failures: string[] = []
  const perFeed: Record<string, number> = {}

  // Build all feed tasks, then run them concurrently (capped). The Muse cities
  // and curated boards each become their own task so nothing is serialized.
  const museTasks = countries
    .map((country) => ({ country, cities: MUSE_CITIES[country] }))
    .filter((t): t is { country: TargetCountry; cities: string[] } => Boolean(t.cities))
    .map((t) => () =>
      settle(`themuse:${t.country}`, fetchTheMuse(t.country, t.cities, MUSE_PAGES_PER_CITY), failures)
    )

  const boardTasks = CURATED_BOARDS.map((b) => () =>
    settle(`board:${b.slug}`, fetchCuratedBoard(b), failures)
  )

  const [arbeitnow, remotive, remoteok, museChunks, boardChunks] = await Promise.all([
    settle("arbeitnow", fetchArbeitnow(40), failures),
    settle("remotive", fetchRemotive(300), failures),
    settle("remoteok", fetchRemoteOk(), failures),
    mapLimit(museTasks, 8, (fn) => fn()),
    mapLimit(boardTasks, 8, (fn) => fn()),
  ])

  const museJobs = museChunks.flat()
  const curated = boardChunks.flat()

  perFeed.arbeitnow = arbeitnow.length
  perFeed.remotive = remotive.length
  perFeed.remoteok = remoteok.length
  perFeed.themuse = museJobs.length
  perFeed.curated_boards = curated.length

  const allJobs = [...arbeitnow, ...remotive, ...remoteok, ...museJobs, ...curated]

  // Keep only target countries.
  const wanted = new Set(countries)
  const filtered = allJobs.filter((j) => wanted.has(j.country))

  // Dedupe by URL.
  const byUrl = new Map<string, FeedJob>()
  for (const j of filtered) {
    if (!byUrl.has(j.url)) byUrl.set(j.url, j)
  }
  const deduped = [...byUrl.values()]

  // Group into company seeds (company+country is the seed key).
  const seedMap = new Map<string, SponsorSeed>()
  for (const j of deduped) {
    const key = `${j.companyName.toLowerCase()}|${j.country}`
    const existing = seedMap.get(key)
    const job = {
      title: j.title,
      url: j.url,
      source: j.source,
      location: j.location,
      country: j.country,
      salary: j.salary,
      remote: j.remote,
      descriptor: j.descriptor,
    }
    if (existing) {
      existing.jobs!.push(job)
    } else {
      seedMap.set(key, {
        name: j.companyName,
        city: j.location,
        note: `Discovered via job feeds (${j.country})`,
        jobs: [job],
      })
    }
  }

  if (failures.length > 0 && deduped.length === 0) {
    throw new Error(`All job feeds failed: ${failures.join(", ")}`)
  }

  return {
    seeds: [...seedMap.values()],
    perFeed,
    totalJobs: deduped.length,
    failures,
  }
}
