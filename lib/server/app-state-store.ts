import {
  freshnessOf,
  type Job,
  type JobStatus,
  type SimpleAppState,
  type TrackedCountry,
} from "@/lib/jobs"
import { sanitizeJobTitle } from "@/lib/jobs/title"
import { isSoftwareRole } from "@/lib/jobs/software-roles"
import { postingSponsorship } from "@/lib/jobs/sponsorship"
import {
  initialCountryScores,
  targetCountries,
  type Company,
  type CountryScore,
  type ImportPayload,
  type JobLead,
  type TargetCountry,
  type VisaConfidence,
} from "@/lib/location/relocation-data"
import { adapterForSourceId } from "@/lib/server/sponsor-sources/adapters"
import {
  isMissingTable,
  supabaseServerClient,
} from "@/lib/server/supabase-server"

interface JobRow {
  id: string
  company_id: string | null
  title: string
  country: string
  city: string | null
  work_mode: string | null
  source_url: string | null
  source_type: string | null
  visa_confidence: string | null
  relocation_signal: string | null
  status: string | null
  created_at: string | null
  refreshed_at: string | null
}

interface CompanyRow {
  id: string
  name: string
}

interface CountryScoreRow {
  country: string
  city: string
  score: number
  safety: number
  healthcare: number
  childcare: number
  spouse_rights: number
  english_friendly: number
  residence_path: number
  cost_pressure: string
  notes: string
}

interface TrackedCountryRow {
  country: string
  source_tier: string
  added_at: string
}

const supportedCountries = new Set<TargetCountry>(targetCountries)

export async function readAppState(): Promise<SimpleAppState> {
  const supabase = supabaseServerClient()
  const [jobsResult, companiesResult, scoresResult, trackedResult] =
    await Promise.all([
      supabase
        .from("jobs")
        .select(
          "id, company_id, title, country, city, work_mode, source_url, source_type, visa_confidence, relocation_signal, status, created_at, refreshed_at"
        ),
      supabase.from("companies").select("id, name"),
      supabase
        .from("country_scores")
        .select(
          "country, city, score, safety, healthcare, childcare, spouse_rights, english_friendly, residence_path, cost_pressure, notes"
        ),
      supabase
        .from("tracked_countries")
        .select("country, source_tier, added_at"),
    ])

  if (jobsResult.error) throw jobsResult.error
  if (companiesResult.error) throw companiesResult.error
  if (scoresResult.error) throw scoresResult.error
  if (trackedResult.error && !isMissingTable(trackedResult.error)) {
    throw trackedResult.error
  }

  return rowsToAppState({
    jobs: (jobsResult.data ?? []) as JobRow[],
    companies: (companiesResult.data ?? []) as CompanyRow[],
    countryScores: (scoresResult.data ?? []) as CountryScoreRow[],
    trackedCountries: trackedResult.error
      ? []
      : ((trackedResult.data ?? []) as TrackedCountryRow[]),
    now: new Date(),
  })
}

export function rowsToAppState({
  jobs,
  companies,
  countryScores,
  trackedCountries,
  now,
}: {
  jobs: JobRow[]
  companies: CompanyRow[]
  countryScores: CountryScoreRow[]
  trackedCountries: TrackedCountryRow[]
  now: Date
}): SimpleAppState {
  const companyNames = new Map(
    companies.map((company) => [company.id, company.name])
  )
  const scores = countryScores
    .map(countryScoreFromRow)
    .filter((score): score is CountryScore => score !== null)
  const scoreByCountry = new Map(scores.map((score) => [score.country, score]))
  const trackedByCountry = new Map(
    trackedCountries
      .map((row) => {
        const country = targetCountry(row.country)
        if (!country) return null
        return [country, row] as const
      })
      .filter(
        (entry): entry is readonly [TargetCountry, TrackedCountryRow] =>
          entry !== null
      )
  )
  const countriesWithJobs = new Set<TargetCountry>()

  const flatJobs: Job[] = jobs.flatMap((row) => {
    const country = targetCountry(row.country)
    if (!country || !row.source_url) return []
    countriesWithJobs.add(country)

    const postedDate = row.refreshed_at ?? row.created_at ?? undefined
    return [
      {
        id: row.id,
        title: sanitizeJobTitle(row.title),
        company: row.company_id
          ? (companyNames.get(row.company_id) ?? row.company_id)
          : "Unknown company",
        country,
        city: row.city ?? undefined,
        remote: remoteFromString(row.work_mode),
        url: row.source_url,
        visaSignal: visaConfidence(row.visa_confidence),
        visaSignalSource: "rules",
        visaSignalReason: row.relocation_signal ?? undefined,
        sponsorVerified: false,
        freshness: freshnessOf(postedDate, now),
        postedDate,
        source: row.source_type ?? "legacy",
        status: jobStatusFromRow(row.status),
        seenAt: row.created_at ?? now.toISOString(),
      },
    ]
  })

  const trackedCountriesByCountry = new Map<TargetCountry, TrackedCountry>()
  for (const [country, row] of trackedByCountry) {
    trackedCountriesByCountry.set(country, {
      country,
      score: scoreByCountry.get(country) ?? fallbackScore(country),
      sourceTier: sourceTierFromString(row.source_tier, country),
      addedAt: row.added_at,
    })
  }

  for (const country of countriesWithJobs) {
    if (!trackedCountriesByCountry.has(country)) {
      trackedCountriesByCountry.set(country, {
        country,
        score: scoreByCountry.get(country) ?? fallbackScore(country),
        sourceTier: sourceTierForCountry(country),
        addedAt: now.toISOString(),
      })
    }
  }

  return {
    jobs: flatJobs,
    trackedCountries: [...trackedCountriesByCountry.values()],
  }
}

export async function setJobStatus(
  id: string,
  status: JobStatus
): Promise<void> {
  const supabase = supabaseServerClient()
  const { error } = await supabase
    .from("jobs")
    .update({ status: rowStatusFromJobStatus(status) })
    .eq("id", id)
  if (error) throw error
}

export async function addTrackedCountry(
  country: TargetCountry
): Promise<TrackedCountry> {
  const score = fallbackScore(country)
  const trackedCountry: TrackedCountry = {
    country,
    score,
    sourceTier: sourceTierForCountry(country),
    addedAt: new Date().toISOString(),
  }

  const supabase = supabaseServerClient()
  const { error } = await supabase.from("tracked_countries").upsert({
    country,
    source_tier: trackedCountry.sourceTier,
    added_at: trackedCountry.addedAt,
  })
  if (error) throw error

  return trackedCountry
}

export async function removeTrackedCountry(
  country: TargetCountry
): Promise<void> {
  const supabase = supabaseServerClient()
  const { error } = await supabase
    .from("tracked_countries")
    .delete()
    .eq("country", country)
  if (error) throw error
}

export async function saveImportPayload(payload: ImportPayload): Promise<void> {
  const supabase = supabaseServerClient()
  const adapter = adapterForSourceId(payload.sourceId)
  const tier = adapter?.meta.tier ?? "discovery_proxy"
  const officialSourceUrl = adapter?.meta.officialSourceUrl ?? ""

  const companyRows = uniqueBy(
    payload.companies.map((company) =>
      companyToRow(company, officialSourceUrl)
    ),
    (company) => company.id
  )
  if (companyRows.length > 0) {
    const { error } = await supabase.from("companies").upsert(companyRows)
    if (error) throw error
  }

  const companiesById = new Map(
    payload.companies.map((company) => [company.id, company])
  )
  const jobRows = uniqueBy(
    payload.jobs.map((job) =>
      jobLeadToRow(job, companiesById, payload.sourceName, tier)
    ),
    (job) => job.id
  )
  if (jobRows.length > 0) {
    const { error } = await supabase.from("jobs").upsert(jobRows)
    if (error) throw error
  }
  // Publish listing facts only. Never copy legacy private status/notes/resumes.
  const catalogRows = uniqueBy(
    payload.jobs
      .filter(
        (job) =>
          /^https?:\/\//.test(job.sourceUrl) &&
          isSoftwareRole(job.title, job.description)
      )
      .map((job) => ({
        id: job.id,
        title: sanitizeJobTitle(job.title),
        company: companiesById.get(job.companyId)?.name ?? "Unknown company",
        country: job.country,
        city: job.city,
        url: job.sourceUrl,
        description: job.description ?? "",
        work_mode:
          job.workMode === "remote_no_relocation" ? "remote" : job.workMode,
        visa_signal: postingSponsorship(job.description ?? "").signal,
        sponsorship_evidence: postingSponsorship(job.description ?? "")
          .evidence,
        source: job.sourceType,
        // Crawl dates are not posting dates. Leave posted_at unset until sourced.
      })),
    (job) => job.id
  )
  for (let offset = 0; offset < catalogRows.length; offset += 100) {
    const { error } = await supabase
      .from("job_catalog")
      .upsert(catalogRows.slice(offset, offset + 100))
    if (error) throw error
  }
}

export async function listSavedCompanyIdsForSource(
  sourceName: string
): Promise<Set<string>> {
  const supabase = supabaseServerClient()
  const { data, error } = await supabase
    .from("companies")
    .select("id")
    .eq("sponsor_source", sourceName)

  if (error) throw error
  return new Set((data ?? []).map((company) => company.id as string))
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map<string, T>()
  for (const item of items) byKey.set(keyOf(item), item)
  return [...byKey.values()]
}

function companyToRow(company: Company, fallbackOfficialSourceUrl: string) {
  return {
    id: company.id,
    name: company.name,
    country: company.country,
    city: company.city,
    website: company.website,
    careers_url: company.careersUrl,
    sponsor_source: company.sponsorSource,
    sponsor_category: company.sponsorCategory,
    official_source_url: company.officialSourceUrl || fallbackOfficialSourceUrl,
    last_checked: company.lastChecked || null,
    visa_signal: company.visaSignal,
    hiring_history_signal: company.hiringHistorySignal,
    relevance_score: company.relevanceScore,
    open_roles: company.openRoles,
    outreach_status: company.outreachStatus,
    confidence: company.confidence,
    notes: company.notes,
  }
}

function jobLeadToRow(
  job: JobLead,
  companiesById: Map<string, Company>,
  sourceName: string,
  tier: string
) {
  const company = companiesById.get(job.companyId)
  return {
    id: job.id,
    company_id: job.companyId,
    title: sanitizeJobTitle(job.title),
    country: job.country,
    city: job.city || company?.city || job.country,
    work_mode: job.workMode,
    source_url: job.sourceUrl,
    source_type: job.sourceType,
    role_type: job.roleType,
    seniority: job.seniority,
    visa_confidence: job.visaConfidence,
    relocation_signal: job.relocationSignal,
    salary: job.salary,
    job_score: job.jobScore,
    country_score: job.countryScore,
    status: "discovered",
    resume_variant: job.resumeVariant,
    notes: `${job.notes}${tier === "official_register" ? " Verified against official-register source." : ""}`,
    created_at: job.createdAt,
    refreshed_at: job.refreshedAt,
  }
}

function targetCountry(country: string): TargetCountry | null {
  return supportedCountries.has(country as TargetCountry)
    ? (country as TargetCountry)
    : null
}

function visaConfidence(value: string | null): VisaConfidence {
  if (
    value === "confirmed" ||
    value === "strong" ||
    value === "possible" ||
    value === "weak" ||
    value === "no"
  ) {
    return value
  }
  return "weak"
}

function remoteFromString(value: string | null): Job["remote"] {
  if (value === "remote" || value === "hybrid" || value === "onsite")
    return value
  return "unknown"
}

function jobStatusFromRow(status: string | null): JobStatus {
  if (status === "applied") return "applied"
  if (status === "rejected" || status === "archived") return "dismissed"
  if (
    status === "shortlisted" ||
    status === "needs_tailoring" ||
    status === "follow_up_due" ||
    status === "recruiter_replied" ||
    status === "interviewing" ||
    status === "offer"
  ) {
    return "interested"
  }
  return "new"
}

function rowStatusFromJobStatus(status: JobStatus): string {
  if (status === "new") return "discovered"
  if (status === "interested") return "shortlisted"
  if (status === "dismissed") return "archived"
  return status
}

function sourceTierForCountry(
  country: TargetCountry
): TrackedCountry["sourceTier"] {
  if (
    country === "Netherlands" ||
    country === "Denmark" ||
    country === "Ireland" ||
    country === "Japan"
  ) {
    return "official_register"
  }
  if (country === "Australia") return "stale_register"
  return "discovery_proxy"
}

function sourceTierFromString(
  value: string,
  country: TargetCountry
): TrackedCountry["sourceTier"] {
  if (
    value === "official_register" ||
    value === "stale_register" ||
    value === "discovery_proxy"
  ) {
    return value
  }
  return sourceTierForCountry(country)
}

function fallbackScore(country: TargetCountry): CountryScore {
  const score = initialCountryScores.find(
    (candidate) => candidate.country === country
  )
  if (score) return score
  return {
    country,
    city: country,
    score: 70,
    safety: 7,
    healthcare: 7,
    childcare: 7,
    spouseRights: 7,
    englishFriendly: 7,
    residencePath: 7,
    costPressure: "medium",
    notes: "Fallback score; update country_scores for richer local context.",
  }
}

function countryScoreFromRow(row: CountryScoreRow): CountryScore | null {
  const country = targetCountry(row.country)
  if (!country) return null
  return {
    country,
    city: row.city,
    score: row.score,
    safety: row.safety,
    healthcare: row.healthcare,
    childcare: row.childcare,
    spouseRights: row.spouse_rights,
    englishFriendly: row.english_friendly,
    residencePath: row.residence_path,
    costPressure: costPressure(row.cost_pressure),
    notes: row.notes,
  }
}

function costPressure(value: string): CountryScore["costPressure"] {
  if (value === "low" || value === "medium" || value === "high") return value
  return "medium"
}
