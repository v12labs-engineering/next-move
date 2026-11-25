import { z } from "zod"
import { isEarlyCareerPosting } from "@/lib/jobs/software-roles"
import {
  catalogDate,
  catalogJson,
  catalogPosting,
  catalogText,
  plain,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { AMZ_INDIA_SOFTWARE_SOURCE } from "../source-identity"
import { robotsAllowed } from "../discovery/validate"

const origin = "https://www.amazon.jobs"
const pageSize = 100
const locationFields = z.object({
  normalizedCountryCode: z.string().nullish(),
  city: z.string().nullish(),
})
const locationEntry = z.union([
  locationFields,
  z.string().transform((value) => {
    try {
      return locationFields.safeParse(JSON.parse(value)).data ?? null
    } catch {
      return null
    }
  }),
])
const jobSummary = z.object({
  // Amazon also publishes Salesforce-backed requisitions such as SF260123206.
  // Both forms have stable /en/jobs/{id} URLs; arbitrary paths remain invalid.
  id_icims: z.string().regex(/^(?:\d+|SF\d+)$/),
  title: z.string(),
  country_code: z.literal("IND"),
  job_category: z.string().nullish(),
  city: z.string().nullish(),
  locations: z.array(locationEntry).nullish(),
  description: z.string().nullish(),
  basic_qualifications: z.string().nullish(),
  preferred_qualifications: z.string().nullish(),
  posted_date: z.string().nullish(),
  is_intern: z.boolean().nullish(),
  university_job: z.boolean().nullish(),
})
const inventory = z.object({
  error: z.null(),
  hits: z.number().int().nonnegative(),
  jobs: z.array(jobSummary).max(pageSize),
})
const catalogJob = jobSummary.extend({
  description: z.string(),
  posted_date: z.string(),
})
const softwareJob = catalogJob.extend({
  job_category: z.literal("Software Development"),
})
const rawConfig = z
  .object({
    categories: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,99}$/)).max(20),
  })
  .strict()

export async function fetchAmazonIndiaPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions
) {
  const softwareSource =
    source.id === AMZ_INDIA_SOFTWARE_SOURCE && source.board === "india-software"
  const indiaSource = source.id === "amazon:india" && source.board === "india"
  const catalogSource = softwareSource || indiaSource
  let categories = softwareSource ? ["software-development"] : []
  if (indiaSource)
    z.object({})
      .strict()
      .parse(source.config ?? {})
  if (!catalogSource) {
    const config = rawConfig.parse(source.config)
    categories = [...config.categories].sort()
    if (
      !options.observePosting ||
      source.board !== "india" ||
      source.id !== `amazon:india:${categories.join(",")}`
    )
      throw new Error("Invalid Amazon India source")
  }
  if (source.kind !== "amazon") throw new Error("Invalid Amazon India source")
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid Amazon page")
  const query = new URLSearchParams({
    "normalized_country_code[]": "IND",
    sort: "recent",
    result_limit: String(pageSize),
    offset: String(offset),
  })
  for (const category of categories) query.append("category[]", category)
  let requests = 0
  const request: FetchOptions = {
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
  if (!robotsAllowed(robots, "/en/search.json"))
    throw new Error("Amazon search path excluded by robots rules")
  const result = inventory.parse(
    await catalogJson(`${origin}/en/search.json?${query}`, request)
  )
  if (catalogSource)
    result.jobs.forEach((job) =>
      (softwareSource ? softwareJob : catalogJob).parse(job)
    )
  const fetched = result.jobs.length
  if (
    offset > result.hits ||
    fetched !== Math.min(pageSize, result.hits - offset) ||
    new Set(result.jobs.map((job) => job.id_icims)).size !== fetched
  )
    throw new Error("Amazon returned an incomplete inventory page")

  const jobs = result.jobs.flatMap((job) => {
    const cities = new Set<string>()
    if (job.city) cities.add(job.city.trim())
    for (const location of job.locations ?? [])
      if (location?.normalizedCountryCode === "IND" && location.city)
        cities.add(location.city.trim())
    const description = plain(
      [
        job.description,
        job.basic_qualifications &&
          `Basic qualifications:\n${job.basic_qualifications}`,
        job.preferred_qualifications &&
          `Preferred qualifications:\n${job.preferred_qualifications}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    // The employer supplies a calendar date without a timezone.
    const postedAt = job.posted_date
      ? catalogDate(`${job.posted_date} UTC`)
      : null
    const url = `${origin}/en/jobs/${job.id_icims}`
    options.observePosting?.({
      title: job.title,
      company: source.company,
      url,
      description,
      locations: [...cities].filter(Boolean),
      countries: ["India"],
      postedAt,
    })
    if (job.is_intern || job.university_job || isEarlyCareerPosting(job.title))
      return []
    const row = catalogPosting(
      {
        source: source.id,
        company: source.company,
        title: job.title,
        country: "India",
        city: [...cities].filter(Boolean).join("; ") || null,
        // Amazon resolves this requisition URL even if a posting's title changes.
        url,
        description,
        posted_at: postedAt,
        work_mode: "unknown",
      },
      undefined,
      options.jobCategories
    )
    return row ? [row] : []
  })
  return {
    jobs,
    fetched,
    rejected: fetched - jobs.length,
    requests,
    nextPage: offset + fetched < result.hits ? page + 1 : null,
  }
}
