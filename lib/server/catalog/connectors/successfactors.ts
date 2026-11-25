import { load } from "cheerio"
import { z } from "zod"
import { catalogRoleTitleScope, isCatalogRole } from "../../../jobs/categories"
import { isEarlyCareerPosting } from "../../../jobs/software-roles"
import {
  catalogPosting,
  catalogText,
  plain,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { robotsAllowed } from "../discovery/validate"

const origin = "https://southasiacareers.deloitte.com"
const listingPath = "/go/Deloitte-India/718244/"
const pageSize = 25
const day = 86_400_000
const maximumResults = 10_000

export const deloitteIndiaSource: CatalogSource = {
  id: "successfactors:deloitte-india",
  kind: "successfactors",
  board: "deloitte-india",
  company: "Deloitte",
  config: {},
}

function jobUrl(value: string) {
  const url = new URL(value, origin)
  const id = url.pathname.match(/^\/job\/[^/]+\/([1-9][0-9]{0,11})\/$/)?.[1]
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !id ||
    /%2f|%5c|%2e|\.\./i.test(url.pathname)
  )
    throw new Error("Invalid SuccessFactors posting identity")
  return { url: url.href, id }
}

function label(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function parseListing(html: string, offset: number) {
  const $ = load(html)
  if (label($("h1").first().text()) !== "Deloitte India")
    throw new Error("SuccessFactors employer identity mismatch")
  const counts = label($(".paginationLabel").first().text()).match(
    /^Results ([0-9]+) [–-] ([0-9]+) of ([0-9]+)$/
  )
  if (!counts) throw new Error("SuccessFactors inventory count is unavailable")
  const [start, end, total] = counts.slice(1).map(Number)
  if (
    total > maximumResults ||
    start !== offset + 1 ||
    end !== Math.min(offset + pageSize, total)
  )
    throw new Error(
      "SuccessFactors ignored pagination or exceeded inventory bound"
    )
  const rows = $("#searchresults tbody tr.data-row")
    .toArray()
    .map((element) => {
      const row = $(element)
      const anchor = row.find("a.jobTitle-link").first()
      const title = label(anchor.text())
      const location = label(row.find("td.colLocation").text())
      const date = label(row.find("td.colDate").text())
      const posted = Date.parse(`${date} 00:00:00 GMT`)
      if (
        !title ||
        !/^[A-Z][a-z]{2} [0-9]{1,2}, [0-9]{4}$/.test(date) ||
        !Number.isFinite(posted)
      )
        throw new Error(
          "SuccessFactors listing lacks a title or valid posting date"
        )
      return { ...jobUrl(anchor.attr("href") ?? ""), title, location, posted }
    })
  if (
    rows.length !== end - start + 1 ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new Error("SuccessFactors returned an incomplete or duplicate page")
  for (let index = 1; index < rows.length; index++)
    if (rows[index].posted > rows[index - 1].posted)
      throw new Error("SuccessFactors inventory is not sorted newest first")
  const currentPage = Number(label($(".current-page").first().text()))
  if (currentPage !== offset / pageSize + 1)
    throw new Error("SuccessFactors page marker mismatch")
  return { rows, total }
}

/** Reviewed Deloitte India SuccessFactors HTML inventory. Only public /go and
 * /job pages are read; the provider explicitly disallows /services and apply
 * endpoints. Date-descending pagination covers the fixed 30-day window. */
export async function fetchSuccessFactorsPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  z.object({})
    .strict()
    .parse(source.config ?? {})
  if (
    source.id !== deloitteIndiaSource.id ||
    source.kind !== deloitteIndiaSource.kind ||
    source.board !== deloitteIndiaSource.board ||
    source.company !== deloitteIndiaSource.company ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > maximumResults / pageSize
  )
    throw new Error("Invalid SuccessFactors source or page")
  const started = options.snapshotStartedAt
    ? Date.parse(options.snapshotStartedAt)
    : Date.now()
  if (!Number.isFinite(started) || started > Date.now() + 60_000)
    throw new Error("Invalid SuccessFactors snapshot date")
  const cutoff = started - 30 * day
  const cutoffDay = Math.floor(cutoff / day) * day
  let requests = 0
  let sessionCookie: string | undefined
  const request = {
    ...options,
    // SAP's public pages explicitly use JSESSIONID for load-balancer stickiness.
    // Without it, concurrent replicas can return different totals for adjacent
    // pages. Keep only this provider-issued session cookie within this call.
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).origin !== origin)
        throw new Error("Untrusted SuccessFactors request origin")
      const headers = new Headers(init?.headers)
      if (sessionCookie) headers.set("Cookie", sessionCookie)
      const response = await (options.fetch ?? fetch)(input, {
        ...init,
        headers,
      })
      const cookies = response.headers.getSetCookie()
      for (const cookie of cookies) {
        const value = cookie.match(
          /^JSESSIONID=([A-Za-z0-9._~!-]{1,1024})(?:;|$)/
        )?.[1]
        if (value) sessionCookie = `JSESSIONID=${value}`
      }
      return response
    },
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const robots = await catalogText(`${origin}/robots.txt`, {
    ...request,
    maxResponseBytes: 512_000,
  })
  if (!robotsAllowed(robots, listingPath))
    throw new Error("SuccessFactors listing excluded by robots")
  function listingUrl(offset: number) {
    return `${origin}${listingPath}${offset ? `${offset}/` : ""}?q=&sortColumn=referencedate&sortDirection=desc`
  }
  async function readListing(offset: number) {
    return parseListing(await catalogText(listingUrl(offset), request), offset)
  }
  const offset = (page - 1) * pageSize
  const listing = await readListing(offset)
  // The public index can contain the same posting in adjacent positions. Accept
  // that only with identical facts and valid position markers; a repeated full
  // page or conflicting duplicate cannot authorize publication.
  if (offset > 0) {
    const preceding = await readListing(offset - pageSize)
    const previous = new Map(preceding.rows.map((row) => [row.id, row]))
    const overlaps = listing.rows.filter((row) => previous.has(row.id))
    if (
      preceding.total !== listing.total ||
      overlaps.length === listing.rows.length ||
      overlaps.some((row) => {
        const before = previous.get(row.id)!
        return (
          row.url !== before.url ||
          row.title !== before.title ||
          row.location !== before.location ||
          row.posted !== before.posted
        )
      }) ||
      listing.rows[0].posted > preceding.rows.at(-1)!.posted
    )
      throw new Error(
        "SuccessFactors inventory moved or repeated a page boundary"
      )
  }
  const jobs: CatalogPosting[] = []
  for (const summary of listing.rows) {
    if (summary.posted < cutoffDay) continue
    if (
      !options.observePosting &&
      (catalogRoleTitleScope(
        summary.title,
        options.jobCategories ?? ["software"]
      ) === "excluded" ||
        isEarlyCareerPosting(summary.title))
    )
      continue
    if (!robotsAllowed(robots, new URL(summary.url).pathname))
      throw new Error("SuccessFactors posting excluded by robots")
    const $ = load(await catalogText(summary.url, request))
    const canonical = $("link[rel='canonical']").attr("href")
    const title = label($("[itemprop='title']").first().text())
    const location = label(
      $("meta[itemprop='streetAddress']").attr("content") ?? ""
    )
    const employer = label(
      $("meta[itemprop='hiringOrganization']").attr("content") ?? ""
    )
    const posted = Date.parse(
      $("meta[itemprop='datePosted']").attr("content") ?? ""
    )
    const apply = $("a.apply")
      .toArray()
      .some((element) =>
        $(element)
          .attr("href")
          ?.startsWith(`/talentcommunity/apply/${summary.id}/`)
      )
    if (
      !canonical ||
      jobUrl(canonical).url !== summary.url ||
      !apply ||
      title !== summary.title ||
      employer.toLowerCase() !== "deloitte" ||
      location !== summary.location
    )
      throw new Error(
        "SuccessFactors posting identity or India location mismatch"
      )
    if (
      !Number.isFinite(posted) ||
      Math.floor(posted / day) * day !== summary.posted
    )
      throw new Error("SuccessFactors posting date is unavailable or changed")
    if (posted < cutoff || posted > started) continue
    const country = /(?:^|,\s*)IN$/.test(location) ? "India" : undefined
    const description = plain($(".jobdescription").html() ?? "")
    options.observePosting?.({
      title,
      company: "Deloitte",
      url: summary.url,
      description,
      locations: [location],
      countries: country ? [country] : [],
      postedAt: new Date(posted).toISOString(),
    })
    if (isEarlyCareerPosting(title)) continue
    if (
      !isCatalogRole(title, description, options.jobCategories ?? ["software"])
    )
      continue
    if (!country) {
      if (options.observePosting) continue
      throw new Error("SuccessFactors posting lacks explicit India location")
    }
    if (description.length < 100) {
      if (options.observePosting) continue
      throw new Error("SuccessFactors posting description is incomplete")
    }
    const job = catalogPosting(
      {
        source: source.id,
        title,
        company: "Deloitte",
        country: "India",
        city: location.replace(/(?:^|,\s*)IN$/, "") || null,
        url: summary.url,
        description,
        posted_at: new Date(posted).toISOString(),
        work_mode: "unknown",
      },
      undefined,
      options.jobCategories
    )
    if (job) jobs.push(job)
  }
  return {
    jobs,
    fetched: listing.rows.length,
    rejected: listing.rows.length - jobs.length,
    requests,
    nextPage:
      offset + listing.rows.length < listing.total &&
      listing.rows.at(-1)!.posted >= cutoffDay
        ? page + 1
        : null,
    employer: "Deloitte",
    employerUrl: `${origin}${listingPath}`,
    listingUrl: listingUrl(offset),
  }
}
