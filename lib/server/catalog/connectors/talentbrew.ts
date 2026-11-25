import { load } from "cheerio"
import { z } from "zod"
import { structuredPostingDetails } from "../posting-details"
import { catalogRoleTitleScope } from "../../../jobs/categories"
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

const origin = "https://search.jobs.barclays"
const listingPath = "/location/india-jobs/13015/1269750/2/"
const pageSize = 16
const maximumResults = 10_000
const day = 86_400_000
export const barclaysIndiaSource: CatalogSource = {
  id: "talentbrew:barclays-india",
  kind: "talentbrew",
  company: "Barclays",
  board: "barclays-india",
  config: {},
}

function jobUrl(value: string) {
  const url = new URL(value, origin)
  const id = url.pathname.match(
    /^\/job\/[^/]+\/[^/]+\/13015\/([1-9][0-9]{0,14})$/
  )?.[1]
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !id ||
    /%2f|%5c|%2e|\.\./i.test(url.pathname)
  )
    throw new Error("Invalid TalentBrew posting identity")
  return { url: url.href, id }
}
const label = (value: string) => value.replace(/\s+/g, " ").trim()
function parseListing(html: string, page: number) {
  const $ = load(html)
  const metadata = $("#search-results")
  const total = Number(metadata.attr("data-total-results"))
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > maximumResults ||
    Number(metadata.attr("data-current-page")) !== page ||
    Number(metadata.attr("data-records-per-page")) !== pageSize ||
    Number(metadata.attr("data-total-pages")) !==
      Math.max(1, Math.ceil(total / pageSize)) ||
    metadata.attr("data-organization-ids") !== "13015"
  )
    throw new Error("TalentBrew pagination or employer metadata is invalid")
  const rows = $("#search-results-list a.job-title--link[data-job-id]")
    .toArray()
    .map((element) => {
      const anchor = $(element)
      const identity = jobUrl(anchor.attr("href") ?? "")
      const title = label(anchor.text())
      const location = label(
        anchor.closest(".list-item").find(".job-location").text()
      )
      if (
        !title ||
        anchor.attr("data-job-id") !== identity.id ||
        !location
          .split(";")
          .some((value) => /(?:^|,\s*)India$/i.test(value.trim()))
      )
        throw new Error(
          "TalentBrew listing identity or India location is missing"
        )
      return { ...identity, title }
    })
  const offset = (page - 1) * pageSize
  if (
    offset > total ||
    (offset > 0 && offset === total) ||
    rows.length !== Math.min(pageSize, total - offset) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new Error("TalentBrew returned an incomplete or duplicate page")
  const next = $("#pagination-bottom a.next:not(.disabled)").attr("href")
  if (
    offset + rows.length < total
      ? next !== `${listingPath}${page + 1}`
      : Boolean(next)
  )
    throw new Error("TalentBrew next-page link does not match its inventory")
  return { rows, total }
}
const posting = z.object({
  "@type": z.literal("JobPosting"),
  title: z.string().trim().min(1),
  url: z.string(),
  description: z.string().trim().min(100),
  employmentType: z.unknown().optional(),
  experienceLevel: z.unknown().optional(),
  experienceRequirements: z.unknown().optional(),
  baseSalary: z.unknown().optional(),
  datePosted: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // The official inventory retains pre-JR requisitions such as 90390427.
  // Canonical identity is independently checked against the numeric job URL.
  identifier: z.object({ value: z.string().regex(/^(?:JR-[0-9]+|[0-9]{8})$/) }),
  hiringOrganization: z.object({ name: z.literal("Barclays") }),
  jobLocation: z
    .array(
      z.object({
        address: z.object({
          addressCountry: z.string().min(1),
          addressLocality: z.string().min(1),
        }),
      })
    )
    .min(1),
})

/** Reviewed Barclays India TalentBrew HTML. Traverse only observed public
 * pagination and job URLs. Exact freshness comes from detail JobPosting data,
 * never the listing cards' incomplete day/month labels. */
export async function fetchTalentBrewPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  z.object({})
    .strict()
    .parse(source.config ?? {})
  if (
    source.id !== barclaysIndiaSource.id ||
    source.kind !== barclaysIndiaSource.kind ||
    source.company !== barclaysIndiaSource.company ||
    source.board !== barclaysIndiaSource.board ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > Math.ceil(maximumResults / pageSize)
  )
    throw new Error("Invalid TalentBrew source or page")
  const started = options.snapshotStartedAt
    ? Date.parse(options.snapshotStartedAt)
    : Date.now()
  if (!Number.isFinite(started) || started > Date.now() + 60_000)
    throw new Error("Invalid TalentBrew snapshot date")
  let requests = 0
  const request = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const robots = await catalogText(`${origin}/robots.txt`, {
    ...request,
    maxResponseBytes: 512_000,
  })
  if (/<(?:!doctype|html)\b/i.test(robots))
    throw new Error("TalentBrew robots resource returned HTML")
  if (!robotsAllowed(robots, `${listingPath}${page}`))
    throw new Error("TalentBrew listing excluded by robots")
  async function read(number: number) {
    return parseListing(
      await catalogText(`${origin}${listingPath}${number}`, request),
      number
    )
  }
  const listing = await read(page)
  if (page > 1) {
    const preceding = await read(page - 1)
    const ids = new Set(preceding.rows.map((row) => row.id))
    if (
      listing.total !== preceding.total ||
      listing.rows.some((row) => ids.has(row.id))
    )
      throw new Error("TalentBrew inventory moved or repeated a page boundary")
  }
  const jobs: CatalogPosting[] = []
  for (const row of listing.rows) {
    if (
      !options.observePosting &&
      (isEarlyCareerPosting(row.title) ||
        catalogRoleTitleScope(row.title, options.jobCategories) === "excluded")
    )
      continue
    if (!robotsAllowed(robots, new URL(row.url).pathname))
      throw new Error("TalentBrew posting excluded by robots")
    const $ = load(await catalogText(row.url, request))
    const candidates = $("script[type='application/ld+json']")
      .toArray()
      .flatMap((element) => {
        const value: unknown = JSON.parse($(element).text())
        return (Array.isArray(value) ? value : [value]).filter(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            value["@type"] === "JobPosting"
        )
      })
    if (candidates.length !== 1)
      throw new Error("TalentBrew JobPosting data is unavailable or ambiguous")
    const data = posting.parse(candidates[0])
    if (
      jobUrl(data.url).url !== row.url ||
      label(plain(data.title)) !== row.title
    )
      throw new Error("TalentBrew detail identity changed")
    const posted = Date.parse(data.datePosted)
    if (
      !Number.isFinite(posted) ||
      new Date(posted).toISOString().slice(0, 10) !== data.datePosted
    )
      throw new Error("Invalid TalentBrew posting date")
    const locations = data.jobLocation.filter((location) =>
      /^India$/i.test(location.address.addressCountry)
    )
    if (!locations.length)
      throw new Error("TalentBrew detail lacks an explicit India location")
    const description = plain(data.description)
    if (description.length < 100)
      throw new Error("TalentBrew posting body is incomplete")
    if (posted < started - 30 * day || posted > started) continue
    const cities = [
      ...new Set(
        locations.map((location) => label(location.address.addressLocality))
      ),
    ]
    const postedAt = new Date(posted).toISOString()
    options.observePosting?.({
      title: row.title,
      company: source.company,
      url: row.url,
      description,
      locations: cities.map((city) => `${city}, India`),
      countries: ["India"],
      postedAt,
    })
    if (isEarlyCareerPosting(row.title)) continue
    const job = catalogPosting(
      {
        source: source.id,
        company: source.company,
        title: row.title,
        url: row.url,
        country: "India",
        city: cities.join("; "),
        description,
        posted_at: postedAt,
        work_mode: "unknown",
        stated: structuredPostingDetails(data),
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
    nextPage: page * pageSize < listing.total ? page + 1 : null,
    employer: source.company,
    employerUrl: "https://search.jobs.barclays/",
    listingUrl: `${origin}${listingPath}1`,
  }
}
