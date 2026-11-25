import { z } from "zod"
import { countryName } from "@/lib/location/countries"
import {
  catalogDate,
  catalogJson,
  catalogPosting,
  plain,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import type { CatalogPage } from "./index"

/** Country-wide aggregator feeds read a recent window, never a full census;
 * publication keeps unseen rows active and retention ages them out. */
export const adzunaCountries = [
  "at",
  "au",
  "be",
  "br",
  "ca",
  "ch",
  "de",
  "es",
  "fr",
  "gb",
  "in",
  "it",
  "mx",
  "nl",
  "nz",
  "pl",
  "sg",
  "us",
  "za",
] as const
export const windowedFeedKinds = ["adzuna", "jobtech"] as const

const adzunaResponse = z.object({
  results: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      title: z.string(),
      description: z.string(),
      redirect_url: z.string(),
      created: z.string().nullish(),
      company: z.object({ display_name: z.string().nullish() }).nullish(),
      location: z.object({ display_name: z.string().nullish() }).nullish(),
    })
  ),
})

function counted(options: FetchOptions) {
  let requests = 0
  return {
    options: {
      ...options,
      onRequest() {
        requests++
        options.onRequest?.()
      },
    },
    requests: () => requests,
  }
}

function page(
  records: unknown[],
  parse: (record: never) => CatalogPosting | null,
  requests: number,
  nextPage: number | null
): CatalogPage {
  let rejected = 0
  const jobs = records.flatMap((record) => {
    const row = parse(record as never)
    if (!row) rejected++
    return row ? [row] : []
  })
  return { jobs, fetched: records.length, rejected, requests, nextPage }
}

const positiveInt = (
  value: string | undefined,
  fallback: number,
  max: number
) => {
  const n = Number(value ?? fallback)
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : fallback
}

export async function fetchAdzunaPage(
  source: CatalogSource,
  pageNumber: number,
  options: FetchOptions = {}
): Promise<CatalogPage> {
  const id = process.env.ADZUNA_APP_ID,
    key = process.env.ADZUNA_APP_KEY
  if (!id || !key) throw new Error("Adzuna is not configured")
  const cc = z.enum(adzunaCountries).parse(source.board)
  const country = countryName(cc)
  if (!country) throw new Error("Unknown Adzuna country")
  const maxPages = positiveInt(process.env.ADZUNA_MAX_PAGES, 5, 20),
    days = positiveInt(process.env.ADZUNA_MAX_DAYS_OLD, 3, 30)
  const url = new URL(
    `https://api.adzuna.com/v1/api/jobs/${cc}/search/${pageNumber}`
  )
  url.search = new URLSearchParams({
    app_id: id,
    app_key: key,
    results_per_page: "50",
    category: "it-jobs",
    max_days_old: String(days),
    sort_by: "date",
  }).toString()
  const req = counted(options)
  const { results } = adzunaResponse.parse(
    await catalogJson(url.href, req.options)
  )
  return page(
    results,
    (job: (typeof results)[number]) => {
      const location = job.location?.display_name ?? null
      const description = plain(job.description)
      options.observePosting?.({
        title: plain(job.title),
        company: job.company?.display_name ?? "",
        url: job.redirect_url,
        description,
        locations: location ? [location] : [],
        countries: [country],
        postedAt: catalogDate(job.created ?? undefined),
      })
      return catalogPosting(
        {
          source: source.id,
          company: job.company?.display_name ?? "",
          title: plain(job.title),
          url: job.redirect_url,
          country,
          city: location,
          description,
          work_mode: /\bremote\b/i.test(job.title) ? "remote" : "unknown",
          posted_at: catalogDate(job.created ?? undefined),
        },
        undefined,
        options.jobCategories
      )
    },
    req.requests(),
    results.length === 50 && pageNumber < maxPages ? pageNumber + 1 : null
  )
}

// Arbetsförmedlingen occupation fields: Data/IT and Sales/marketing.
const jobtechFields = ["apaJ_2ja_LuF", "RPTn_bxG_ExZ"]
const jobtechResponse = z.object({
  hits: z.array(
    z.object({
      id: z.string(),
      headline: z.string(),
      webpage_url: z.string(),
      publication_date: z.string().nullish(),
      description: z.object({ text: z.string().nullish() }).nullish(),
      employer: z.object({ name: z.string().nullish() }).nullish(),
      workplace_address: z
        .object({
          municipality: z.string().nullish(),
          city: z.string().nullish(),
        })
        .nullish(),
      application_details: z.object({ url: z.string().nullish() }).nullish(),
    })
  ),
})

export async function fetchJobtechPage(
  source: CatalogSource,
  pageNumber: number,
  options: FetchOptions = {}
): Promise<CatalogPage> {
  if (source.board !== "se") throw new Error("Unknown JobTech region")
  const limit = 100,
    offset = (pageNumber - 1) * limit
  const url = new URL("https://jobsearch.api.jobtechdev.se/search")
  url.searchParams.set("published-after", String(7 * 24 * 60))
  for (const field of jobtechFields)
    url.searchParams.append("occupation-field", field)
  url.searchParams.set("limit", String(limit))
  url.searchParams.set("offset", String(offset))
  const req = counted(options)
  const { hits } = jobtechResponse.parse(
    await catalogJson(url.href, req.options)
  )
  return page(
    hits,
    (job: (typeof hits)[number]) => {
      const city =
        job.workplace_address?.municipality ??
        job.workplace_address?.city ??
        null
      const applyUrl = job.application_details?.url
      const description = plain(job.description?.text ?? "")
      options.observePosting?.({
        title: job.headline,
        company: job.employer?.name ?? "",
        url: job.webpage_url,
        description,
        locations: city ? [city] : [],
        countries: ["Sweden"],
        postedAt: catalogDate(job.publication_date ?? undefined),
      })
      return catalogPosting(
        {
          source: source.id,
          company: job.employer?.name ?? "",
          title: job.headline,
          url: applyUrl?.startsWith("https://") ? applyUrl : job.webpage_url,
          country: "Sweden",
          city,
          description,
          work_mode: "unknown",
          posted_at: catalogDate(job.publication_date ?? undefined),
        },
        undefined,
        options.jobCategories
      )
    },
    req.requests(),
    // The search API caps offset+limit at 2,100.
    hits.length === limit && offset + 2 * limit <= 2100 ? pageNumber + 1 : null
  )
}
