import type { CatalogSource, FetchOptions } from "@/lib/server/catalog/feeds"
import { boardFromUrl } from "@/lib/server/catalog/source-identity"
import { fetchSourcePage } from "@/lib/server/catalog/connectors"
import {
  locationCountries,
  normalizedPosting,
  type ScrapedPosting,
} from "./registry-job-postings.mjs"

type AtsInventory = {
  jobs: ScrapedPosting[]
  complete: boolean
  method: string
  reason: string | null
}

function smartRecruitersIndia(url: URL) {
  return (
    url.hostname === "careers.smartrecruiters.com" &&
    (url.pathname.split("/")[2]?.toLowerCase() === "india" ||
      /^in(?:dia|d)?$/i.test(url.searchParams.get("country") ?? ""))
  )
}

function oracleListing(url: URL) {
  if (
    url.hostname === "fa-etbm-saasfaprod1.fa.ocs.oraclecloud.com" &&
    /^\/hcmUI\/CandidateExperience\/en\/sites\/CX_1(?:\/|$)/.test(url.pathname)
  )
    return {
      key: "oracle:ibs-software",
      board: "ibs-software",
      company: "IBS Software",
      scope: "global",
    }
  if (
    url.hostname === "careers.oracle.com" &&
    /^\/en\/sites\/jobsearch\/jobs\/?$/.test(url.pathname) &&
    /^india$/i.test(url.searchParams.get("location") ?? "")
  )
    return {
      key: "oracle:oracle-india",
      board: "oracle-india",
      company: "Oracle",
      scope: "india",
    }
  return null
}

export function registryBoardKey(url: URL) {
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    return null
  const board = boardFromUrl(url.href)
  if (board?.board && board.board !== "embed")
    return (
      board.id +
      (url.hostname.includes(".eu.") ? ":eu" : "") +
      (board.kind === "smartrecruiters" && smartRecruitersIndia(url)
        ? ":india"
        : "")
    )
  if (
    url.hostname === "www.amazon.jobs" &&
    url.pathname === "/en/search" &&
    url.searchParams.getAll("normalized_country_code[]").includes("IND")
  )
    return (
      "amazon:india:" + url.searchParams.getAll("category[]").sort().join(",")
    )
  return oracleListing(url)?.key ?? null
}

export async function scrapeRegistryBoard(
  url: URL,
  company: string,
  fetchOptions: FetchOptions = {}
): Promise<AtsInventory> {
  const board = boardFromUrl(url.href)
  const key = registryBoardKey(url)
  if (!key) throw new Error("Unknown public ATS board")
  const method = key
  const jobs = new Map<string, ScrapedPosting>()
  const signal = AbortSignal.any([
    AbortSignal.timeout(100_000),
    ...(fetchOptions.signal ? [fetchOptions.signal] : []),
  ])
  const options = {
    ...fetchOptions,
    signal,
    timeoutMs: 8_000,
    maxResponseBytes: 15_000_000,
    snapshotStartedAt:
      fetchOptions.snapshotStartedAt ?? new Date().toISOString(),
  }
  function add(
    title: string,
    href: string,
    location: string | null,
    description = "",
    postedAt: string | null = null,
    countries: string[] = [],
    employer = company
  ) {
    const posting = normalizedPosting({
      title,
      url: href,
      location,
      countries: [...countries, ...locationCountries(location)],
      company: employer,
      description,
      postedAt,
      evidence: url.href,
      method: "ats",
    })
    if (posting) jobs.set(posting.key, posting)
  }
  function result(complete: boolean, reason: string | null = null) {
    return { jobs: [...jobs.values()], complete, method, reason }
  }
  try {
    const oracle = oracleListing(url)
    const source: CatalogSource = oracle
      ? {
          id: oracle.key,
          kind: "oracle",
          board: oracle.board,
          company: oracle.company,
          config: { scope: oracle.scope, detail: "summary" },
        }
      : key.startsWith("amazon:india:")
        ? {
            id: key,
            kind: "amazon",
            board: "india",
            company: "Amazon",
            config: {
              categories: url.searchParams.getAll("category[]").sort(),
            },
          }
        : {
            ...board!,
            company,
            config:
              board?.kind === "smartrecruiters" && smartRecruitersIndia(url)
                ? { country: "IN" }
                : url.hostname.includes(".eu.")
                  ? { region: "eu" }
                  : undefined,
          }
    let cursor: number | null = 1
    let rejected = false
    const maxPages =
      source.kind === "amazon" ? 50 : source.kind === "oracle" ? 100 : 1000
    for (let pages = 0; cursor !== null && pages < maxPages; pages++) {
      signal.throwIfAborted()
      const page = await fetchSourcePage(source, cursor, options)
      const previous = new Set(jobs.keys())
      for (const job of page.postings) {
        const count = jobs.size
        add(
          job.title,
          job.url,
          job.locations.join("; ") || null,
          job.description,
          job.postedAt,
          job.countries,
          job.company
        )
        if (jobs.size === count) rejected = true
      }
      if (
        page.nextPage !== null &&
        (!Number.isSafeInteger(page.nextPage) || page.nextPage <= cursor)
      )
        return result(false, "ATS returned an invalid page cursor")
      if (
        page.postings.length &&
        [...jobs.keys()].every((key) => previous.has(key))
      )
        return result(false, "ATS returned repeated or unusable postings")
      cursor = page.nextPage
    }
    if (cursor !== null) return result(false, "ATS result limit reached")
    return result(
      !rejected,
      rejected ? "Some ATS rows could not be normalized" : null
    )
  } catch (error) {
    if (!jobs.size) throw error
    return result(
      false,
      error instanceof Error
        ? error.message
        : "ATS connection failed partway through"
    )
  }
}
