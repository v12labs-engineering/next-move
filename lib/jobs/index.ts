import type {
  Company,
  CountryScore,
  ImportPayload,
  JobLead,
  VisaConfidence,
} from "@/lib/location/relocation-data"

export type JobStatus = "new" | "interested" | "applied" | "dismissed"

export interface Job {
  id: string
  title: string
  company: string
  country: string
  city?: string
  remote: "remote" | "hybrid" | "onsite" | "unknown"
  url: string
  visaSignal: VisaConfidence
  visaSignalSource: "rules" | "llm"
  visaSignalReason?: string
  sponsorVerified: boolean
  freshness: "fresh" | "ok" | "stale"
  postedDate?: string
  source: string
  lastCheckedAt?: string
  isActive?: boolean
  description?: string
  postingDetails?: import("@/lib/jobs/posting-details").JobPostingDetails
  match?: import("@/lib/matching").Match
  status: JobStatus
  seenAt: string
}

export interface TrackedCountry {
  country: string
  locations?: import("@/lib/candidate").TargetLocation[]
  score: CountryScore | null
  sourceTier: "official_register" | "stale_register" | "discovery_proxy"
  addedAt: string
}

export interface SimpleAppState {
  jobs: Job[]
  trackedCountries: TrackedCountry[]
  catalog?: {
    assessedAt?: string
    totalJobs: number
    lastUpdatedAt: string | null
    sources: number
    failedSources: number
    coverage?: import("@/lib/jobs/coverage").CountryCoverage[]
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

export function freshnessOf(
  postedDate: string | undefined,
  now: Date
): Job["freshness"] {
  if (!postedDate) return "stale"
  const posted = new Date(postedDate).getTime()
  if (Number.isNaN(posted)) return "stale"
  const ageDays = (now.getTime() - posted) / DAY_MS
  if (ageDays <= 3) return "fresh"
  if (ageDays <= 30) return "ok"
  return "stale"
}

export function verifyAgainstRegister(
  company: string,
  registerNames: Set<string>
): boolean {
  return registerNames.has(company.trim().toLowerCase())
}

function remoteOf(workMode: JobLead["workMode"]): Job["remote"] {
  if (workMode === "remote" || workMode === "remote_no_relocation")
    return "remote"
  if (workMode === "hybrid") return "hybrid"
  if (workMode === "onsite") return "onsite"
  return "unknown"
}

export function normalizePayload(
  payload: ImportPayload,
  opts: {
    tier: TrackedCountry["sourceTier"]
    registerNames: Set<string>
    now: Date
  }
): Job[] {
  const companyById = new Map<string, Company>(
    payload.companies.map((c) => [c.id, c])
  )
  return payload.jobs.map((lead) => {
    const companyName =
      companyById.get(lead.companyId)?.name ?? "Unknown company"
    return {
      id: lead.id,
      title: lead.title,
      company: companyName,
      country: lead.country,
      city: lead.city || undefined,
      remote: remoteOf(lead.workMode),
      url: lead.sourceUrl,
      visaSignal: lead.visaConfidence,
      visaSignalSource: "rules" as const,
      sponsorVerified:
        opts.tier === "official_register" &&
        verifyAgainstRegister(companyName, opts.registerNames),
      freshness: freshnessOf(lead.refreshedAt ?? lead.createdAt, opts.now),
      postedDate: lead.refreshedAt ?? lead.createdAt,
      source: lead.sourceType,
      status: "new" as const,
      seenAt: opts.now.toISOString(),
    }
  })
}

function jobKey(j: Job): string {
  return j.url?.trim()
    ? j.url.trim().toLowerCase()
    : `${j.company}|${j.title}`.toLowerCase()
}

export function mergeJobs(existing: Job[], incoming: Job[]): Job[] {
  const byKey = new Map<string, Job>(existing.map((j) => [jobKey(j), j]))
  for (const inc of incoming) {
    const key = jobKey(inc)
    const prev = byKey.get(key)
    if (prev) {
      byKey.set(key, {
        ...inc,
        status: prev.status,
        seenAt: prev.seenAt,
      })
    } else {
      byKey.set(key, inc)
    }
  }
  return [...byKey.values()]
}
