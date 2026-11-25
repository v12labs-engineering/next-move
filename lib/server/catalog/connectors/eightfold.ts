import { z } from "zod"
import { catalogRoleTitleScope } from "../../../jobs/categories"
import { isEarlyCareerPosting } from "../../../jobs/software-roles"
import {
  catalogJson,
  catalogPosting,
  catalogText,
  plain,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { robotsAllowed } from "../discovery/validate"

const origin = "https://careers.qualcomm.com"
const pageSize = 10
const maximumResults = 10_000
const day = 86_400_000
const searchPath = "/api/pcsx/search"
const detailPath = "/api/pcsx/position_details"

export const qualcommIndiaSource: CatalogSource = {
  id: "eightfold:qualcomm-india",
  kind: "eightfold",
  company: "Qualcomm",
  board: "qualcomm-india",
  config: {},
}

const summary = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  displayJobId: z.string().regex(/^[1-9][0-9]{0,14}$/),
  name: z.string().trim().min(1),
  locations: z.array(z.string().trim().min(1)).min(1),
  standardizedLocations: z.array(z.string().trim().min(1)).min(1),
  postedTs: z.number().int().positive().max(8_640_000_000_000),
  positionUrl: z.string(),
})
const inventory = z.object({
  status: z.literal(200),
  error: z.object({ message: z.literal(""), body: z.literal("") }),
  data: z.object({
    positions: z.array(summary).max(pageSize),
    count: z.number().int().nonnegative().max(maximumResults),
    sortBy: z.literal("timestamp"),
    resultsMetaData: z.object({ usedFuzzSearch: z.literal(false) }),
  }),
})
const detail = z.object({
  status: z.literal(200),
  error: z.object({ message: z.literal(""), body: z.literal("") }),
  data: summary.extend({
    publicUrl: z.string(),
    jobDescription: z.string().trim().min(100),
  }),
})
type Summary = z.infer<typeof summary>

function jobUrl(value: string, id: number) {
  const url = new URL(value, origin)
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/careers/job/${id}`
  )
    throw new Error("Invalid Eightfold posting identity")
  return url.href
}

function validateSummary(row: Summary) {
  jobUrl(row.positionUrl, row.id)
  // A free-text search for India is not country evidence. Both source fields
  // must independently say India; foreign and ambiguous locations fail closed.
  if (
    !row.locations.every((location) => /(?:^|,\s*)India$/i.test(location)) ||
    !row.standardizedLocations.every((location) => /,\s*IN$/.test(location))
  )
    throw new Error("Eightfold posting lacks explicit India locations")
  if (!Number.isFinite(new Date(row.postedTs * 1000).getTime()))
    throw new Error("Invalid Eightfold posting date")
}

function descending(rows: Summary[]) {
  for (let index = 1; index < rows.length; index++)
    if (rows[index].postedTs > rows[index - 1].postedTs)
      throw new Error("Eightfold inventory is not sorted newest first")
}

/** Public Qualcomm Eightfold search, using the same India/latest parameters
 * as the official UI. No credentials or unrestricted tenant URLs are accepted.
 * The complete published scope is explicitly located India jobs from 30 days. */
export async function fetchEightfoldPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  z.object({})
    .strict()
    .parse(source.config ?? {})
  if (
    source.id !== qualcommIndiaSource.id ||
    source.kind !== qualcommIndiaSource.kind ||
    source.company !== qualcommIndiaSource.company ||
    source.board !== qualcommIndiaSource.board ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > maximumResults / pageSize
  )
    throw new Error("Invalid Eightfold source or page")
  const started = options.snapshotStartedAt
    ? Date.parse(options.snapshotStartedAt)
    : Date.now()
  if (!Number.isFinite(started) || started > Date.now() + 60_000)
    throw new Error("Invalid Eightfold snapshot date")
  const cutoff = started - 30 * day
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
    throw new Error("Eightfold robots resource returned HTML")
  if (!robotsAllowed(robots, searchPath) || !robotsAllowed(robots, detailPath))
    throw new Error("Eightfold public API excluded by robots")
  async function read(offset: number) {
    const response = inventory.parse(
      await catalogJson(
        `${origin}${searchPath}?domain=qualcomm.com&query=&location=India&start=${offset}&sort_by=timestamp&`,
        request
      )
    ).data
    const rows = response.positions
    if (
      offset > response.count ||
      (offset > 0 && offset === response.count) ||
      rows.length !== Math.min(pageSize, response.count - offset) ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw new Error("Eightfold returned an incomplete or duplicate page")
    rows.forEach(validateSummary)
    descending(rows)
    return { rows, total: response.count }
  }
  const offset = (page - 1) * pageSize
  const listing = await read(offset)
  if (offset > 0) {
    const preceding = await read(offset - pageSize)
    const precedingIds = new Set(preceding.rows.map((row) => row.id))
    if (
      preceding.total !== listing.total ||
      listing.rows.some((row) => precedingIds.has(row.id))
    )
      throw new Error("Eightfold inventory moved or repeated a page boundary")
    descending([...preceding.rows, ...listing.rows])
  }
  const jobs: CatalogPosting[] = []
  for (const row of listing.rows) {
    if (row.postedTs * 1000 < cutoff || row.postedTs * 1000 > started) continue
    if (
      !options.observePosting &&
      (isEarlyCareerPosting(row.name) ||
        catalogRoleTitleScope(row.name, options.jobCategories) === "excluded")
    )
      continue
    const posting = detail.parse(
      await catalogJson(
        `${origin}${detailPath}?position_id=${row.id}&domain=qualcomm.com&hl=en`,
        request
      )
    ).data
    validateSummary(posting)
    const url = jobUrl(posting.publicUrl, row.id)
    if (
      posting.id !== row.id ||
      posting.displayJobId !== row.displayJobId ||
      posting.name !== row.name ||
      posting.postedTs !== row.postedTs ||
      JSON.stringify(posting.locations) !== JSON.stringify(row.locations) ||
      JSON.stringify(posting.standardizedLocations) !==
        JSON.stringify(row.standardizedLocations)
    )
      throw new Error("Eightfold posting identity, location or date changed")
    const description = plain(posting.jobDescription)
    if (description.length < 100)
      throw new Error("Eightfold posting body is incomplete")
    const postedAt = new Date(posting.postedTs * 1000).toISOString()
    options.observePosting?.({
      title: row.name,
      company: source.company,
      url,
      description,
      locations: row.locations,
      countries: ["India"],
      postedAt,
    })
    if (isEarlyCareerPosting(row.name)) continue
    const cities = [
      ...new Set(
        row.locations
          .map((location) => location.replace(/,?\s*India$/i, "").trim())
          .filter(Boolean)
      ),
    ]
    const job = catalogPosting(
      {
        source: source.id,
        company: source.company,
        title: row.name,
        url,
        country: "India",
        city: cities.length ? cities.join("; ") : null,
        description,
        posted_at: postedAt,
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
      listing.rows.at(-1)!.postedTs * 1000 >= cutoff
        ? page + 1
        : null,
    employer: source.company,
    employerUrl: "https://www.qualcomm.com/company/careers",
    listingUrl: `${origin}/careers?location=India&sort_by=timestamp`,
  }
}
