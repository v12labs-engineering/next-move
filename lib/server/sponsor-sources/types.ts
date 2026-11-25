import type { ImportPayload, SourceType, TargetCountry } from "@/lib/location/relocation-data"

/**
 * A raw company surfaced from an official sponsor register or a discovery proxy,
 * before website/careers enrichment and job extraction.
 */
export interface PreDiscoveredJob {
  title: string
  url: string
  /** Which feed/ATS this posting came from (adzuna, themuse, greenhouse, …). */
  source?: SourceType
  /** Free-text location string from the feed, when available. */
  location?: string
  /** Per-job country override (feeds can span multiple countries). */
  country?: TargetCountry
  /** Salary text from the feed, when available. */
  salary?: string
  /** Whether the feed marks this as remote. */
  remote?: boolean
  /** Description/tags blob used for profile matching and visa-signal detection. */
  descriptor?: string
}

export interface SponsorSeed {
  name: string
  /** Official business-register id when the source provides one (KvK, CVR, etc.). */
  registryId?: string
  website?: string
  careersUrl?: string
  city?: string
  /** Free-text note about where/how this seed was found. */
  note?: string
  /**
   * Jobs already known from the discovery step (Tier C ATS proxy). When present,
   * the pipeline uses these directly instead of crawling a careers page —
   * job boards expose real postings via their API but render nav-heavy HTML
   * that doesn't crawl cleanly.
   */
  jobs?: PreDiscoveredJob[]
}

/** How strong the visa/sponsorship signal is for a whole source. */
export type SponsorSourceTier =
  | "official_register" // real government sponsor/permit register
  | "stale_register" // real but outdated official dump (e.g. FOI PDF)
  | "discovery_proxy" // no official register exists; ATS/job-board discovery

export interface SponsorSourceMeta {
  country: TargetCountry
  /** Stable id used by the API + UI source buttons. */
  sourceId: string
  sourceName: string
  tier: SponsorSourceTier
  /** The official URL the data came from, for display + audit. */
  officialSourceUrl: string
  /**
   * Skip the name-based software classifier. Set for feed adapters whose seeds
   * are already filtered to engineering roles (classifying by company name would
   * wrongly drop AI-native companies that lack a keyword in their name).
   */
  skipClassify?: boolean
}

/**
 * A country adapter. Tier A/B return real sponsor seeds from an official source.
 * Tier C (discovery_proxy) returns seeds discovered via ATS/job boards.
 *
 * Adapters MUST throw if their source is unreachable or its layout changed.
 * We fail loudly rather than serve stale fixtures as if they were fresh.
 */
export interface SponsorAdapter {
  meta: SponsorSourceMeta
  fetchSeeds(): Promise<SponsorSeed[]>
}

export interface CollectionProgress {
  phase:
    | "fetching_source"
    | "classifying"
    | "enriching"
    | "crawling_jobs"
    | "scoring"
    | "done"
    | "error"
  seedsFound: number
  softwareSeeds: number
  companiesEnriched: number
  jobsFound: number
  message: string
}

export interface CollectionRun {
  runId: string
  country: TargetCountry
  sourceId: string
  startedAt: string
  finishedAt?: string
  ok: boolean
  error?: string
  progress: CollectionProgress
  payload?: ImportPayload
}
