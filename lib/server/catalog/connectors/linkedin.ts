import { load } from "cheerio"
import { z } from "zod"
import { countryName } from "@/lib/location/countries"
import {
  catalogDate,
  catalogPosting,
  CatalogSourceError,
  catalogText,
  statedLocationCountry,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { robotsAllowed } from "../discovery/validate"

export const linkedinQuerySchema = z
  .object({
    keywords: z.string().trim().min(2).max(100),
    location: z.string().trim().min(2).max(160),
    country: z.string().transform((value, ctx) => {
      const country = countryName(value)
      if (country) return country
      ctx.addIssue({ code: "custom", message: "Choose a recognized country" })
      return z.NEVER
    }),
  })
  .strict()
export const linkedinConfigSchema = z
  .object({ queries: z.array(linkedinQuerySchema).min(1).max(8) })
  .strict()
export type LinkedInQuery = z.infer<typeof linkedinQuerySchema>
export class LinkedInPostingUnavailable extends Error {}

export type LinkedInCard = {
  id: string
  title: string
  company: string
  location: string
  postedAt?: string
}
function clean(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

export function linkedinJobId(value: string) {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !/^(?:www|[a-z]{2})\.linkedin\.com$/.test(url.hostname)
    )
      return null
    return (
      /^\/jobs\/view\/(?:[^/]*-)?([0-9]{5,20})\/?$/.exec(url.pathname)?.[1] ??
      null
    )
  } catch {
    return null
  }
}

export function parseLinkedInSearch(html: string): LinkedInCard[] {
  const $ = load(html)
  const cards = new Map<string, LinkedInCard>()
  const elements = $(
    ".job-search-card, [data-entity-urn^='urn:li:jobPosting:']"
  )
  if (!elements.length) {
    if (!html.trim() || $(".jobs-search-no-results-banner").length) return []
    throw new Error(
      "LinkedIn search returned a login/challenge page or unrecognized markup"
    )
  }
  if (elements.length > 25)
    throw new Error("LinkedIn search page exceeds the collection limit")
  elements.each((_, element) => {
    const card = $(element)
    const id = /^urn:li:jobPosting:([0-9]{5,20})$/.exec(
      card.attr("data-entity-urn") ?? ""
    )?.[1]
    const linkId = linkedinJobId(
      card.find("a.base-card__full-link").attr("href") ?? ""
    )
    const title = clean(card.find(".base-search-card__title").text())
    const company = clean(card.find(".base-search-card__subtitle").text())
    const location = clean(card.find(".job-search-card__location").text())
    if (
      !id ||
      linkId !== id ||
      !title ||
      !company ||
      !location ||
      title.length > 500 ||
      company.length > 300 ||
      location.length > 500
    )
      throw new Error("LinkedIn search card lacks corroborated job identity")
    cards.set(id, {
      id,
      title,
      company,
      location,
      postedAt: card.find("time[datetime]").attr("datetime"),
    })
  })
  return [...cards.values()]
}

export function parseLinkedInDetail(
  card: LinkedInCard,
  html: string,
  observePosting?: FetchOptions["observePosting"],
  jobCategories?: FetchOptions["jobCategories"]
): CatalogPosting {
  const $ = load(html)
  const ids = [...html.matchAll(/urn:li:jobPosting:([0-9]{5,20})/g)].map(
    (match) => match[1]
  )
  const canonical = $("link[rel='canonical']").attr("href")
  if (
    !ids.includes(card.id) &&
    (!canonical || linkedinJobId(canonical) !== card.id)
  )
    throw new Error("LinkedIn detail identity is unavailable")
  const title = clean($(".top-card-layout__title").first().text())
  const company = clean($(".topcard__org-name-link").first().text())
  if (
    !title ||
    !company ||
    title.toLowerCase() !== card.title.toLowerCase() ||
    company.toLowerCase() !== card.company.toLowerCase()
  )
    throw new Error("LinkedIn detail differs from the observed job card")
  const markup = $(".show-more-less-html__markup").first()
  markup.find("script,style").remove()
  markup.find("p,br,li,div,h1,h2,h3").before("\n")
  const description = markup
    .text()
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim()
    .slice(0, 60000)
  // The query location is a search hint, never country evidence for a posting.
  const detailLocation = clean($(".topcard__flavor--bullet").first().text())
  const detailHasCountry = detailLocation
    .split(",")
    .some((part) => statedLocationCountry(part.trim()))
  const parts = (detailHasCountry ? detailLocation : card.location)
    .split(",")
    .map((part) => part.trim())
  const country = parts.map(statedLocationCountry).find(Boolean)
  const postedAt =
    card.postedAt === undefined
      ? undefined
      : /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(card.postedAt)
        ? card.postedAt
        : undefined
  const datePart = postedAt?.slice(0, 10)
  const validDate = datePart && new Date(`${datePart}T00:00:00Z`)
  const exactDate =
    validDate &&
    !Number.isNaN(validDate.getTime()) &&
    validDate.toISOString().slice(0, 10) === datePart
      ? postedAt
      : undefined
  observePosting?.({
    title,
    company,
    url: `https://www.linkedin.com/jobs/view/${card.id}/`,
    description,
    locations: [detailLocation || card.location],
    countries: country ? [country] : [],
    postedAt: catalogDate(exactDate),
  })
  if (!country)
    throw new LinkedInPostingUnavailable(
      "LinkedIn posting has no explicit country"
    )
  const criteria = new Map<string, string>()
  $(".description__job-criteria-item").each((_, node) => {
    const title = clean(
      $(node).find(".description__job-criteria-subheader").text()
    ).toLowerCase()
    const value = clean($(node).find(".description__job-criteria-text").text())
    if (title && value) criteria.set(title, value)
  })
  const job = catalogPosting(
    {
      title,
      company,
      country,
      city:
        parts.filter((part) => countryName(part) !== country).join(", ") ||
        null,
      url: `https://www.linkedin.com/jobs/view/${card.id}/`,
      description,
      source: "linkedin",
      posted_at: catalogDate(exactDate),
      work_mode: "unknown",
      stated: {
        employment: criteria.get("employment type"),
        experience: criteria.get("seniority level"),
      },
    },
    undefined,
    jobCategories
  )
  if (!job)
    throw new LinkedInPostingUnavailable(
      "LinkedIn detail lacks a usable public description"
    )
  return job
}

/** Public guest pages only. No cookies, session tokens, proxy rotation or
 * retries around access controls. Search windows are observations, not inventories. */
export async function fetchLinkedInPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {},
  pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000))
) {
  if (
    source.id !== "linkedin" ||
    source.kind !== "linkedin" ||
    source.board !== null
  )
    throw new Error("Invalid LinkedIn source")
  const config = linkedinConfigSchema.parse(source.config)
  const queryIndex = Math.floor((page - 1) / 1000),
    offset = (page - 1) % 1000
  const query = config.queries[queryIndex]
  if (!Number.isSafeInteger(page) || page < 1 || !query || offset >= 75)
    throw new Error("Invalid LinkedIn continuation")
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(
      Math.max(1, Math.min(options.timeoutMs ?? 45000, 45000))
    ),
  ])
  let requests = 0
  const request: FetchOptions = {
    ...options,
    signal,
    retries: 0,
    maxResponseBytes: Math.min(options.maxResponseBytes ?? 2000000, 2000000),
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  async function read(path: string) {
    if (requests) await pause()
    try {
      return await catalogText(`https://www.linkedin.com${path}`, request, {
        headers: { Accept: "text/html" },
      })
    } catch (error) {
      if (!(error instanceof TypeError) || signal.aborted) throw error
      throw new CatalogSourceError(
        "LinkedIn public request failed",
        new Date(Date.now() + 900000).toISOString()
      )
    }
  }
  const robots = await read("/robots.txt")
  if (
    !robotsAllowed(robots, "/jobs-guest/jobs/api/seeMoreJobPostings/search") ||
    !robotsAllowed(robots, "/jobs-guest/jobs/api/jobPosting/")
  )
    throw new CatalogSourceError(
      "LinkedIn guest job paths excluded by robots rules",
      new Date(Date.now() + 86400000).toISOString()
    )
  const params = new URLSearchParams({
    keywords: query.keywords,
    location: query.location,
    start: String(offset),
    f_TPR: "r604800",
  })
  const searchHtml = await read(
    `/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`
  )
  const cards = parseLinkedInSearch(searchHtml)
  // Pagination uses returned cards, including duplicates, rather than assuming
  // LinkedIn always returns 25 results or advancing by the deduplicated count.
  const rawCount = load(searchHtml)(
    ".job-search-card, [data-entity-urn^='urn:li:jobPosting:']"
  ).length
  const jobs: CatalogPosting[] = []
  for (const card of cards) {
    const html = await read(`/jobs-guest/jobs/api/jobPosting/${card.id}`)
    try {
      const job = parseLinkedInDetail(
        card,
        html,
        options.observePosting,
        options.jobCategories
      )
      if (job.country === query.country) jobs.push(job)
    } catch (error) {
      // Skipping an unusable observation does not imply the posting closed.
      // Access failures and identity errors still stop the entire page.
      if (!(error instanceof LinkedInPostingUnavailable)) throw error
    }
  }
  const nextQuery =
    queryIndex + 1 < config.queries.length ? (queryIndex + 1) * 1000 + 1 : null
  return {
    jobs,
    fetched: rawCount,
    rejected: rawCount - jobs.length,
    requests,
    nextPage: rawCount && offset + rawCount < 75 ? page + rawCount : nextQuery,
  }
}
