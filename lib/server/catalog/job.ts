import { freshnessOf, type Job, type JobStatus } from "@/lib/jobs"
import type { CatalogPosting } from "./feeds"

export interface CatalogRow extends CatalogPosting {
  is_active: boolean
  last_checked_at: string | null
  discovered_at: string
}

export function catalogJob(row: CatalogRow, status: JobStatus = "new"): Job {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    country: row.country,
    city: row.city || undefined,
    url: row.url,
    description: row.description,
    ...(row.posting_details ? { postingDetails: row.posting_details } : {}),
    remote: row.work_mode,
    visaSignal: row.visa_signal,
    visaSignalSource: "rules",
    visaSignalReason: row.sponsorship_evidence || undefined,
    sponsorVerified: row.sponsor_verified,
    freshness: freshnessOf(row.posted_at || undefined, new Date()),
    postedDate: row.posted_at || undefined,
    source: row.source,
    isActive: row.is_active,
    lastCheckedAt: row.last_checked_at ?? undefined,
    status,
    seenAt: row.discovered_at,
  }
}
