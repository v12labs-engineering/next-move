import type {
  Company,
  ImportPayload,
  JobLead,
  TargetCountry,
  VisaConfidence,
} from "@/lib/location/relocation-data"
import { initialState } from "@/lib/location/relocation-data"
import { sanitizeJobTitle } from "@/lib/jobs/title"
import { isSoftwareRole } from "@/lib/jobs/software-roles"
import { classifyCompany } from "@/lib/server/sponsor-sources/classify"
import { resolveCareersUrl, resolveWebsite, normalizeWebsite } from "@/lib/server/sponsor-sources/enrich"
import { extractJobsFromCareers } from "@/lib/server/sponsor-sources/extract-jobs"
import type { ExtractedJob } from "@/lib/server/sponsor-sources/extract-jobs"
import { adapterForSourceId, sponsorAdapters } from "@/lib/server/sponsor-sources/adapters"
import { hasVisaSignal } from "@/lib/server/sponsor-sources/feeds/job-feeds"
import { matchProfile } from "@/lib/server/sponsor-sources/profile"
import type {
  CollectionProgress,
  SponsorAdapter,
  SponsorSeed,
  SponsorSourceTier,
} from "@/lib/server/sponsor-sources/types"

export interface CollectionOptions {
  /** Max software companies to deeply enrich (resolve careers + crawl jobs). */
  maxEnrich?: number
  /** Max job links to keep per company. */
  jobsPerCompany?: number
  /** Concurrency for the enrich/crawl step. */
  concurrency?: number
  onProgress?: (p: CollectionProgress) => void
  onCheckpoint?: (payload: ImportPayload) => void | Promise<void>
  skipCompanyIds?: ReadonlySet<string>
}

const DEFAULTS = { maxEnrich: 40, jobsPerCompany: 15, concurrency: 4 }
const CHECKPOINT_EVERY_COMPANIES = 10

/** A whole source's tier sets the ceiling on per-company visa confidence. */
function visaForTier(tier: SponsorSourceTier): VisaConfidence {
  switch (tier) {
    case "official_register":
      return "strong"
    case "stale_register":
      return "possible"
    case "discovery_proxy":
      return "possible"
  }
}

export async function runSponsorCollection(
  sourceId: string,
  options: CollectionOptions = {}
): Promise<ImportPayload> {
  const adapter = adapterForSourceId(sourceId)
  if (!adapter) throw new Error(`Unknown sponsor source: ${sourceId}`)
  return runWithAdapter(adapter, options)
}

export async function runSponsorCollectionForCountry(
  country: TargetCountry,
  options: CollectionOptions = {}
): Promise<ImportPayload> {
  const adapter = sponsorAdapters[country]
  if (!adapter) {
    throw new Error(`No official register adapter for ${country}; use a feed source instead.`)
  }
  return runWithAdapter(adapter, options)
}

async function runWithAdapter(
  adapter: SponsorAdapter,
  options: CollectionOptions
): Promise<ImportPayload> {
  // Feed adapters already hold real jobs per seed (no per-company crawl), so we
  // can keep far more companies + jobs than the crawl-bound register defaults.
  const defaults = adapter.meta.skipClassify
    ? { maxEnrich: 5000, jobsPerCompany: 50, concurrency: 8 }
    : DEFAULTS
  const opts = { ...defaults, ...options }
  const { country, sourceId, sourceName, tier, officialSourceUrl } = adapter.meta
  const today = new Date().toISOString().slice(0, 10)
  const visaCeiling = visaForTier(tier)
  const countryScore =
    initialState.countries.find((c) => c.country === country)?.score ?? 70

  const report = (p: CollectionProgress) => options.onProgress?.(p)

  // 1. Fetch the official source (throws loudly on failure).
  report(progress("fetching_source", 0, 0, 0, 0, `Fetching ${sourceName}…`))
  const seeds = await adapter.fetchSeeds()

  // 2. Classify down to software/tech companies. Feed-sourced seeds are already
  // filtered to engineering roles, so they skip the name-based classifier (which
  // would wrongly drop e.g. "Mistral AI" for lacking a signal word).
  report(progress("classifying", seeds.length, 0, 0, 0, "Filtering to software companies…"))
  const software = adapter.meta.skipClassify
    ? seeds
    : seeds.filter((s) => classifyCompany(s.name, s.website).isSoftware)

  // 3. Enrich a capped subset: resolve careers page + crawl jobs.
  const skipCompanyIds = opts.skipCompanyIds ?? new Set<string>()
  const eligibleForEnrich = skipCompanyIds.size
    ? software.filter((seed) => !skipCompanyIds.has(companyIdForSeed(country, seed)))
    : software
  const skippedCompanies = software.length - eligibleForEnrich.length
  const toEnrich = eligibleForEnrich.slice(0, opts.maxEnrich)
  const enrichedCompanies: Company[] = []
  const jobs: JobLead[] = []
  let enrichedCount = 0
  let jobCount = 0

  if (skippedCompanies > 0) {
    report(
      progress(
        "enriching",
        seeds.length,
        software.length,
        0,
        0,
        `Skipping ${skippedCompanies} companies already saved from a failed run…`
      )
    )
  }

  await mapLimit(toEnrich, opts.concurrency, async (seed) => {
    const { company, companyJobs } = await enrichSeed(
      seed,
      country,
      sourceId,
      sourceName,
      officialSourceUrl,
      visaCeiling,
      countryScore,
      tier,
      today,
      opts.jobsPerCompany
    )
    enrichedCompanies.push(company)
    jobs.push(...companyJobs)
    enrichedCount++
    jobCount += companyJobs.length
    report(
      progress(
        "crawling_jobs",
        seeds.length,
        software.length,
        enrichedCount,
        jobCount,
        `Enriched ${enrichedCount}/${toEnrich.length} remaining companies, ${jobCount} jobs so far…`
      )
    )
    if (
      enrichedCount % CHECKPOINT_EVERY_COMPANIES === 0 ||
      enrichedCount === toEnrich.length
    ) {
      await options.onCheckpoint?.(
        payloadForCheckpoint(
          sourceId,
          sourceName,
          enrichedCompanies,
          jobs,
          seeds.length,
          software.length,
          enrichedCount,
          jobCount
        )
      )
    }
  })

  // Software companies beyond the enrich cap: keep as leads without crawled jobs.
  const remaining = eligibleForEnrich.slice(opts.maxEnrich).map<Company>((seed) =>
    baseCompany(seed, country, sourceId, sourceName, officialSourceUrl, visaCeiling, tier, today, 0)
  )

  const companies = [...enrichedCompanies, ...remaining]

  const cappedNote =
    eligibleForEnrich.length > opts.maxEnrich
      ? ` ${eligibleForEnrich.length - opts.maxEnrich} more software companies were added as leads but not yet crawled for jobs (enrich cap ${opts.maxEnrich}).`
      : ""

  report(progress("done", seeds.length, software.length, enrichedCount, jobCount, "Done."))

  return {
    sourceId,
    sourceName,
    companies,
    jobs,
    people: [],
    log:
      `${sourceName}: fetched ${seeds.length} sponsors, ${software.length} classified software, ` +
      `skipped ${skippedCompanies} checkpointed companies, enriched ${enrichedCount}, ` +
      `found ${jobCount} real career-page jobs.${cappedNote}`,
  }
}

function payloadForCheckpoint(
  sourceId: string,
  sourceName: string,
  companies: Company[],
  jobs: JobLead[],
  seedsFound: number,
  softwareSeeds: number,
  enrichedCount: number,
  jobCount: number
): ImportPayload {
  return {
    sourceId,
    sourceName,
    companies: [...companies],
    jobs: [...jobs],
    people: [],
    log:
      `${sourceName}: checkpoint saved ${enrichedCount} enriched companies, ` +
      `${jobCount} jobs from ${seedsFound} sponsors and ${softwareSeeds} software companies.`,
  }
}

async function enrichSeed(
  seed: SponsorSeed,
  country: TargetCountry,
  sourceId: string,
  sourceName: string,
  officialSourceUrl: string,
  visaCeiling: VisaConfidence,
  countryScore: number,
  tier: SponsorSourceTier,
  today: string,
  jobsPerCompany: number
): Promise<{ company: Company; companyJobs: JobLead[] }> {
  let website = normalizeWebsite(seed.website ?? "")
  let careersUrl = seed.careersUrl ?? ""

  // Tier C (discovery proxy) + feed seeds arrive with real jobs already known
  // from a job-board/ATS API — use them directly rather than crawling HTML.
  let extracted: ExtractedJob[]
  if (seed.jobs && seed.jobs.length > 0) {
    extracted = seed.jobs
      .slice(0, jobsPerCompany)
      // Preserve the feed/ATS provenance (adzuna, themuse, greenhouse, …) so the
      // job's sourceType reflects where it actually came from, not "career_page".
      .map((j) => ({
        title: sanitizeJobTitle(j.title),
        url: j.url,
        ats: j.source ?? ("career_page" as const),
      }))
  } else {
    if (!website) {
      website = await resolveWebsite(seed.name).catch(() => "")
    }
    if (!careersUrl && website) {
      careersUrl = await resolveCareersUrl(website).catch(() => "")
    }
    extracted = careersUrl
      ? await extractJobsFromCareers(careersUrl, jobsPerCompany).catch(() => [])
      : []
  }

  const company = baseCompany(
    seed,
    country,
    sourceId,
    sourceName,
    officialSourceUrl,
    visaCeiling,
    tier,
    today,
    extracted.length,
    website,
    careersUrl
  )

  // Index the original feed jobs by URL so we can recover per-job country,
  // salary, location, and the descriptor used for profile + visa matching.
  const feedByUrl = new Map((seed.jobs ?? []).map((j) => [j.url, j]))

  const companyJobs = extracted.filter((job) =>
    isSoftwareRole(job.title, feedByUrl.get(job.url)?.descriptor)
  ).map<JobLead>((job) => {
    const feed = feedByUrl.get(job.url)
    const jobCountry = feed?.country ?? country
    const descriptor = feed?.descriptor ?? ""
    const title = sanitizeJobTitle(job.title)
    const match = matchProfile(title, descriptor)

    // A role that explicitly mentions sponsorship/relocation beats the source
    // ceiling and is marked "confirmed"; otherwise inherit the source's ceiling.
    const visaConfidence: VisaConfidence = hasVisaSignal(`${title} ${descriptor}`)
      ? "confirmed"
      : visaCeiling
    const relocationSignal =
      visaConfidence === "confirmed"
        ? "Posting explicitly mentions visa sponsorship / relocation support."
        : relocationSignalFor(tier)

    const jobCountryScore =
      initialState.countries.find((c) => c.country === jobCountry)?.score ?? countryScore

    return {
      id: `j-${slug(jobCountry)}-${slug(seed.name)}-${slug(title)}-${slug(job.url).slice(-12)}`,
      title,
      description: descriptor,
      companyId: company.id,
      country: jobCountry,
      city: feed?.location ?? seed.city ?? jobCountry,
      workMode: feed?.remote ? "remote" : "hybrid",
      sourceUrl: job.url,
      sourceType: job.ats,
      roleType: match.roleType,
      seniority: match.seniority,
      visaConfidence,
      relocationSignal,
      salary: feed?.salary ?? "Unknown",
      jobScore: match.fitScore,
      countryScore: jobCountryScore,
      status: "discovered",
      resumeVariant: match.resumeVariant,
      notes: `${match.roleType} via ${sourceName}: ${job.url}`,
      createdAt: today,
      refreshedAt: today,
    }
  })

  return { company, companyJobs }
}

function baseCompany(
  seed: SponsorSeed,
  country: TargetCountry,
  sourceId: string,
  sourceName: string,
  officialSourceUrl: string,
  visaCeiling: VisaConfidence,
  tier: SponsorSourceTier,
  today: string,
  jobCount: number,
  website = normalizeWebsite(seed.website ?? ""),
  careersUrl = seed.careersUrl ?? ""
): Company {
  return {
    id: companyIdForSeed(country, seed),
    name: seed.name,
    country,
    city: seed.city ?? country,
    website,
    careersUrl: careersUrl || website || "#",
    sponsorSource: sourceName,
    sponsorCategory: sponsorCategoryFor(tier),
    officialSourceUrl,
    lastChecked: today,
    visaSignal: visaCeiling,
    hiringHistorySignal: jobCount
      ? `Found ${jobCount} live career-page job link${jobCount === 1 ? "" : "s"}.`
      : seed.note ?? "On official source; careers/jobs not yet crawled.",
    relevanceScore: jobCount ? 75 : 60,
    openRoles: jobCount,
    outreachStatus: "not_started",
    confidence: tier === "official_register" ? "high" : "medium",
    notes: seed.note ?? "",
  }
}

function companyIdForSeed(country: TargetCountry, seed: SponsorSeed): string {
  return `c-${slug(country)}-${slug(seed.name)}`
}

function sponsorCategoryFor(tier: SponsorSourceTier): string {
  switch (tier) {
    case "official_register":
      return "Official sponsor register + careers crawl"
    case "stale_register":
      return "Stale official register + careers crawl"
    case "discovery_proxy":
      return "ATS/job-board discovery (no official register)"
  }
}

function relocationSignalFor(tier: SponsorSourceTier): string {
  switch (tier) {
    case "official_register":
      return "Company is on an official sponsor register; role-level sponsorship still needs confirmation."
    case "stale_register":
      return "Company appeared on a stale official sponsor list; verify it still sponsors."
    case "discovery_proxy":
      return "Discovered via job board; no official sponsor backing — confirm sponsorship directly."
  }
}

function progress(
  phase: CollectionProgress["phase"],
  seedsFound: number,
  softwareSeeds: number,
  companiesEnriched: number,
  jobsFound: number,
  message: string
): CollectionProgress {
  return { phase, seedsFound, softwareSeeds, companiesEnriched, jobsFound, message }
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Run async fn over items with a concurrency limit. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}
