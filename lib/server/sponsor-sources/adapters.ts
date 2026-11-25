import type { TargetCountry } from "@/lib/location/relocation-data"
import type { SponsorAdapter } from "@/lib/server/sponsor-sources/types"
import { fetchIndSponsors, IND_REGISTER_URL } from "@/lib/server/sponsor-sources/registers/netherlands"
import { fetchSiriCertified, SIRI_REGISTER_URL } from "@/lib/server/sponsor-sources/registers/denmark"
import { fetchIrelandPermits } from "@/lib/server/sponsor-sources/registers/ireland"
import { fetchJetroOfp, JETRO_OFP_URL } from "@/lib/server/sponsor-sources/registers/japan"
import { fetchAuFoiSeed, AU_FOI_PDF_URL } from "@/lib/server/sponsor-sources/registers/australia"
import { discoverViaAts } from "@/lib/server/sponsor-sources/proxy/ats-discovery"
import { discoverEuJobs } from "@/lib/server/sponsor-sources/feeds/orchestrator"
import { EU_COUNTRIES } from "@/lib/server/sponsor-sources/profile"
import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"

/** The year used for the Ireland permits export; lives here for easy override. */
const CURRENT_YEAR = 2026

const FEEDS_SOURCE_URL =
  "Arbeitnow + Remotive + RemoteOK + The Muse + Greenhouse/Lever/Ashby boards"

/** Cache one EU feed run across the per-country adapters in a single request. */
let euFeedCache: { at: number; seeds: SponsorSeed[] } | null = null

async function euSeeds(): Promise<SponsorSeed[]> {
  // Re-use a run for 60s so hitting several country buttons in a row doesn't
  // re-fetch every feed each time.
  if (euFeedCache && Date.now() - euFeedCache.at < 60_000) return euFeedCache.seeds
  const result = await discoverEuJobs(EU_COUNTRIES)
  euFeedCache = { at: Date.now(), seeds: result.seeds }
  return result.seeds
}

/** Seeds whose jobs land in a single target country (per-country buttons). */
async function euSeedsForCountry(country: TargetCountry): Promise<SponsorSeed[]> {
  const seeds = await euSeeds()
  return seeds
    .map((s) => ({
      ...s,
      jobs: (s.jobs ?? []).filter((j) => j.country === country),
    }))
    .filter((s) => (s.jobs?.length ?? 0) > 0)
}

/**
 * Register-backed adapters. Only countries with an official sponsor source live
 * here; the newer EU targets (Spain, Portugal, Poland, France, Finland) are
 * served by the feed adapters below.
 */
export const sponsorAdapters: Partial<Record<TargetCountry, SponsorAdapter>> = {
  Netherlands: {
    meta: {
      country: "Netherlands",
      sourceId: "collect-netherlands",
      sourceName: "Netherlands IND recognised sponsors (live)",
      tier: "official_register",
      officialSourceUrl: IND_REGISTER_URL,
    },
    fetchSeeds: fetchIndSponsors,
  },
  Denmark: {
    meta: {
      country: "Denmark",
      sourceId: "collect-denmark",
      sourceName: "Denmark SIRI Fast-track certified (live)",
      tier: "official_register",
      officialSourceUrl: SIRI_REGISTER_URL,
    },
    fetchSeeds: fetchSiriCertified,
  },
  Ireland: {
    meta: {
      country: "Ireland",
      sourceId: "collect-ireland",
      sourceName: "Ireland employment permits issued (live)",
      tier: "official_register",
      officialSourceUrl:
        "https://enterprise.gov.ie/en/publications/publication-files/",
    },
    fetchSeeds: () => fetchIrelandPermits(CURRENT_YEAR),
  },
  Japan: {
    meta: {
      country: "Japan",
      sourceId: "collect-japan",
      sourceName: "Japan JETRO Open-for-Professionals (live)",
      tier: "official_register",
      officialSourceUrl: JETRO_OFP_URL,
    },
    fetchSeeds: fetchJetroOfp,
  },
  Australia: {
    meta: {
      country: "Australia",
      sourceId: "collect-australia",
      sourceName: "Australia accredited sponsors (STALE 2024 FOI)",
      tier: "stale_register",
      officialSourceUrl: AU_FOI_PDF_URL,
    },
    fetchSeeds: fetchAuFoiSeed,
  },
  Germany: {
    meta: {
      country: "Germany",
      sourceId: "collect-germany",
      sourceName: "Germany software hiring (ATS discovery — no register)",
      tier: "discovery_proxy",
      officialSourceUrl: "https://www.arbeitnow.com/visa-sponsorship-jobs",
    },
    fetchSeeds: () => discoverViaAts("Germany"),
  },
  Sweden: {
    meta: {
      country: "Sweden",
      sourceId: "collect-sweden",
      sourceName: "Sweden software hiring (ATS discovery — no register)",
      tier: "discovery_proxy",
      officialSourceUrl: "https://www.arbeitnow.com/",
    },
    fetchSeeds: () => discoverViaAts("Sweden"),
  },
  UAE: {
    meta: {
      country: "UAE",
      sourceId: "collect-uae",
      sourceName: "UAE software hiring (ATS discovery — no register)",
      tier: "discovery_proxy",
      officialSourceUrl: "https://www.arbeitnow.com/",
    },
    fetchSeeds: () => discoverViaAts("UAE"),
  },
}

/**
 * Feed-backed adapters: high-volume keyless job feeds, profile-matched to
 * Sharath. The master "all EU" adapter is the one-click "fetch thousands of EU
 * jobs" button; the per-country adapters slice the same cached run.
 */
const FEED_COUNTRIES: TargetCountry[] = [...EU_COUNTRIES]

export const feedAdapters: SponsorAdapter[] = [
  {
    meta: {
      country: "Netherlands", // representative; jobs carry their own country
      sourceId: "feeds-eu-all",
      sourceName: "All EU job feeds (profile-matched)",
      tier: "discovery_proxy",
      officialSourceUrl: FEEDS_SOURCE_URL,
      skipClassify: true,
    },
    fetchSeeds: euSeeds,
  },
  ...FEED_COUNTRIES.map<SponsorAdapter>((country) => ({
    meta: {
      country,
      sourceId: `feeds-${country.toLowerCase()}`,
      sourceName: `${country} job feeds (profile-matched)`,
      tier: "discovery_proxy",
      officialSourceUrl: FEEDS_SOURCE_URL,
      skipClassify: true,
    },
    fetchSeeds: () => euSeedsForCountry(country),
  })),
]

export function adapterForSourceId(sourceId: string): SponsorAdapter | null {
  return (
    Object.values(sponsorAdapters).find((a) => a.meta.sourceId === sourceId) ??
    feedAdapters.find((a) => a.meta.sourceId === sourceId) ??
    null
  )
}
