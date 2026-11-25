import { z } from "zod"
import { isEarlyCareerPosting } from "../../../jobs/software-roles"
import {
  catalogDate,
  catalogJson,
  catalogPosting,
  catalogText,
  plain,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { robotsAllowed } from "../discovery/validate"

const origin = "https://www-api.ibm.com"
const path = "/search/api/v2"
const pageSize = 100
const maximumResults = 10_000
const day = 86_400_000

export const ibmIndiaSource: CatalogSource = {
  id: "ibm:india",
  kind: "ibm",
  company: "IBM",
  board: "india",
  config: {},
}

const posting = z.object({
  title: z.string().trim().min(1),
  url: z.string(),
  body: z.string().trim().min(100),
  dcdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  field_keyword_05: z.literal("India"),
  field_keyword_08: z.string().nullish(),
  field_keyword_17: z.string().nullish(),
  field_keyword_18: z.string().nullish(),
  field_keyword_19: z.string().trim().min(1),
})
const inventory = z.object({
  timed_out: z.literal(false),
  _shards: z.object({ failed: z.literal(0) }),
  hits: z.object({
    total: z.object({
      value: z.number().int().nonnegative().max(maximumResults),
      relation: z.literal("eq"),
    }),
    hits: z
      .array(
        z.object({
          _id: z.string().regex(/^[a-f0-9]{64}$/),
          _source: posting,
        })
      )
      .max(pageSize),
  }),
})
type Posting = z.infer<typeof posting> & { indexId: string }

function postingUrl(value: string) {
  const url = new URL(value)
  if (
    url.origin !== "https://careers.ibm.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !["/careers/JobDetail", "/en_US/careers/JobDetail"].includes(
      url.pathname
    ) ||
    [...url.searchParams.keys()].some((key) => key !== "jobId") ||
    url.searchParams.getAll("jobId").length !== 1 ||
    !/^[1-9]\d{0,11}$/.test(url.searchParams.get("jobId") ?? "")
  )
    throw new Error("Invalid IBM posting identity")
  return `https://careers.ibm.com/careers/JobDetail?jobId=${url.searchParams.get("jobId")}`
}

/** Only robots requests may follow redirects, and only on these IBM hosts.
 * IBM currently redirects API robots to its website, which ends in a 404.
 * RFC 9309 treats a 4xx robots resource as unavailable, except throttling.
 * The actual search request keeps catalogText's redirect refusal. */
async function searchRobots(options: FetchOptions) {
  return catalogText(`${origin}/robots.txt`, {
    ...options,
    maxResponseBytes: 512_000,
    fetch: async (input, init) => {
      let url = String(input)
      for (let redirects = 0; redirects <= 5; redirects++) {
        const target = new URL(url)
        if (
          target.protocol !== "https:" ||
          target.port ||
          target.username ||
          target.password ||
          !["www-api.ibm.com", "www.ibm.com"].includes(target.hostname)
        )
          throw new Error("Untrusted IBM robots redirect")
        if (redirects) options.onRequest?.()
        const response = await (options.fetch ?? fetch)(url, {
          ...init,
          redirect: "manual",
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location")
          await response.body?.cancel()
          if (!location) throw new Error("Invalid IBM robots redirect")
          url = new URL(location, url).href
          continue
        }
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          await response.body?.cancel()
          return new Response("")
        }
        if (
          response.ok &&
          response.headers.get("content-type")?.includes("text/html")
        ) {
          await response.body?.cancel()
          throw new Error("IBM robots resource returned HTML")
        }
        return response
      }
      throw new Error("Too many IBM robots redirects")
    },
  })
}

function assertDescending(rows: Posting[]) {
  for (let index = 1; index < rows.length; index++) {
    if (
      rows[index].dcdate > rows[index - 1].dcdate ||
      (rows[index].dcdate === rows[index - 1].dcdate &&
        rows[index].indexId <= rows[index - 1].indexId)
    )
      throw new Error(
        "IBM inventory is not sorted by date and unique identifier"
      )
  }
}

/** Public IBM careers search, with the full indexed body rather than its
 * truncated description. dcdate matches employer JobPosting.datePosted.
 * The complete scope is India postings in a fixed 30-day snapshot window. */
export async function fetchIbmPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  z.object({})
    .strict()
    .parse(source.config ?? {})
  if (
    source.id !== ibmIndiaSource.id ||
    source.kind !== ibmIndiaSource.kind ||
    source.board !== ibmIndiaSource.board ||
    source.company !== ibmIndiaSource.company ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > maximumResults / pageSize
  )
    throw new Error("Invalid IBM source or page")
  const snapshot = options.snapshotStartedAt
    ? Date.parse(options.snapshotStartedAt)
    : Date.now()
  if (!Number.isFinite(snapshot) || snapshot > Date.now() + 60_000)
    throw new Error("Invalid IBM snapshot date")
  const cutoff = snapshot - 30 * day
  let requests = 0
  const request = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const rules = await searchRobots(request)
  if (!robotsAllowed(rules, path))
    throw new Error("IBM search path excluded by robots rules")
  async function read(offset: number, size: number) {
    const result = inventory.parse(
      await catalogJson(`${origin}${path}`, request, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: "careers",
          scopes: ["careers2"],
          lang: "zz",
          query: {
            bool: {
              must: [{ term: { field_keyword_05: "India" } }],
              filter: [
                {
                  range: {
                    dcdate: {
                      gte: new Date(cutoff).toISOString(),
                      lte: new Date(snapshot).toISOString(),
                    },
                  },
                },
              ],
            },
          },
          from: offset,
          size,
          // Dates and titles are shared by many requisitions. The public API
          // supports _id sorting; URL is analyzed text and cannot be sorted.
          sort: [{ dcdate: "desc" }, { _id: "asc" }],
          _source: [
            "title",
            "url",
            "body",
            "dcdate",
            "field_keyword_05",
            "field_keyword_08",
            "field_keyword_17",
            "field_keyword_18",
            "field_keyword_19",
          ],
        }),
      })
    )
    const rows = result.hits.hits.map((hit) => ({
      ...hit._source,
      indexId: hit._id,
    }))
    const total = result.hits.total.value
    if (
      offset > total ||
      (offset > 0 && offset === total) ||
      rows.length !== Math.min(size, total - offset) ||
      new Set(rows.map((row) => postingUrl(row.url))).size !== rows.length
    )
      throw new Error("IBM returned an incomplete or duplicate inventory page")
    for (const row of rows) {
      const posted = Date.parse(row.dcdate)
      if (
        !Number.isFinite(posted) ||
        new Date(posted).toISOString().slice(0, 10) !== row.dcdate ||
        posted < cutoff ||
        posted > snapshot
      )
        throw new Error("IBM posting is outside the snapshot date window")
      const countryCode = row.field_keyword_19.match(/,\s*([A-Z]{2})$/)?.[1]
      if (countryCode && countryCode !== "IN")
        throw new Error("IBM posting location contradicts India country")
    }
    assertDescending(rows)
    return { rows, total }
  }
  const offset = (page - 1) * pageSize
  const result = await read(offset, pageSize)
  if (page > 1) {
    const preceding = await read(offset - 1, 1)
    if (
      preceding.total !== result.total ||
      result.rows.some(
        (row) => postingUrl(row.url) === postingUrl(preceding.rows[0].url)
      )
    )
      throw new Error("IBM inventory changed or repeated a page boundary")
    assertDescending([...preceding.rows, ...result.rows])
  }
  const jobs = result.rows.flatMap((row) => {
    const description = plain(row.body)
    if (description.length < 100)
      throw new Error("IBM posting body is incomplete")
    const url = postingUrl(row.url)
    const postedAt = catalogDate(row.dcdate)
    const city = /^Multiple Cities$/i.test(row.field_keyword_19)
      ? null
      : row.field_keyword_19.replace(/,\s*IN$/, "").trim()
    options.observePosting?.({
      title: row.title,
      company: "IBM",
      url,
      description,
      locations: [row.field_keyword_19],
      countries: ["India"],
      postedAt,
    })
    if (isEarlyCareerPosting(row.title)) return []
    const mode = row.field_keyword_17?.toLowerCase()
    const job = catalogPosting(
      {
        source: source.id,
        company: "IBM",
        title: row.title,
        url,
        country: "India",
        city,
        description,
        posted_at: postedAt,
        stated: { experience: row.field_keyword_18 },
        work_mode: mode === "remote" || mode === "hybrid" ? mode : "unknown",
      },
      undefined,
      options.jobCategories
    )
    return job ? [job] : []
  })
  return {
    jobs,
    fetched: result.rows.length,
    rejected: result.rows.length - jobs.length,
    requests,
    nextPage: offset + result.rows.length < result.total ? page + 1 : null,
    employer: "IBM",
    employerUrl: "https://www.ibm.com/in-en/careers",
    listingUrl:
      "https://www.ibm.com/in-en/careers/search?field_keyword_05%5B0%5D=India",
  }
}
