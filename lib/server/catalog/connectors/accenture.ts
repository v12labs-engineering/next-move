import { z } from "zod"
import { catalogRoleTitleScope } from "../../../jobs/categories"
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

const origin = "https://www.accenture.com"
const path = "/api/accenture/elastic/findjobs"
const pageSize = 100

// Both display labels and response slugs were verified against the official
// search endpoint. These are provider query families, not user job categories.
export const accentureFamilies = {
  "Software Engineering": "software-engineering",
  "Artificial Intelligence (AI) & Data Science":
    "artificial-intelligence-ai-data-science",
  "Marketing & Communication": "marketing-communication",
  "Sales & Account Management": "sales-account-management",
  "Product Development": "product-development",
  "Creative & Design": "creative-design",
  "Customer & User Experience": "customer-user-experience",
  Cloud: "cloud",
  Security: "security",
  "Technology Platforms": "technology-platforms",
  "Programming Languages": "programming-languages",
} as const
export type AccentureFamily = keyof typeof accentureFamilies

export function accentureSource(family: AccentureFamily): CatalogSource {
  if (!Object.hasOwn(accentureFamilies, family))
    throw new Error("Unsupported Accenture family")
  const slug = accentureFamilies[family]
  return {
    id: `accenture:india-${slug}`,
    kind: "accenture",
    company: "Accenture",
    board: `india-${slug}`,
    config: { family },
  }
}

const configSchema = z.object({ family: z.string() }).strict()
const jobSchema = z.object({
  requisitionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/),
  guid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}_en$/),
  title: z.string().trim().min(1),
  country: z.literal("India"),
  areaOfInterest: z.array(z.string()).min(1),
  location: z.array(z.string().trim().min(1)),
  feedCity: z.string().nullish(),
  updateDate: z.string().nullish(),
  jobDetailUrl: z.string(),
  jobDescription: z.string().nullish(),
  qualification: z.string().nullish(),
})
const responseSchema = z.object({
  data: z.array(jobSchema).max(pageSize),
  totalHits: z.object({
    total: z.number().int().nonnegative(),
    overMaxHits: z.enum(["True", "False"]),
  }),
})
type Job = z.infer<typeof jobSchema>

// Explicit country is still required. The upstream India facet also included
// Buenos Aires; never promote a contradictory or newly unverified city as India.
const indiaCities = new Set([
  "Ahmedabad",
  "Bengaluru",
  "Bhubaneswar",
  "Chennai",
  "Coimbatore",
  "Gandhinagar",
  "Gurugram",
  "Hyderabad",
  "Indore",
  "Jaipur",
  "Kochi",
  "Kolkata",
  "Mumbai",
  "Nagpur",
  "Navi Mumbai",
  "New Delhi",
  "Noida",
  "Pune",
  "Thane",
  "Thiruvananthapuram",
  "Tiruchirappalli",
])

function providerUrl(job: Job) {
  const url = new URL(job.jobDetailUrl.replace("{0}", "in-en"))
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== "/in-en/careers/jobdetails" ||
    url.searchParams.getAll("id").length !== 1 ||
    url.searchParams.get("id") !== job.guid ||
    job.guid !== `${job.requisitionId}_en`
  )
    throw new Error("Invalid Accenture posting identity")
  // The title is mutable and not part of a vacancy's identity.
  return `${origin}/in-en/careers/jobdetails?id=${job.guid}`
}

function assertDescending(jobs: Job[]) {
  let previous = Infinity
  for (const job of jobs) {
    const time = Date.parse(job.updateDate ?? "")
    if (!Number.isFinite(time)) continue
    if (time > previous)
      throw new Error("Accenture inventory is not sorted newest first")
    previous = time
  }
}

/** Full inventory for one explicitly bounded India family. No date cutoff is
 * used to pretend a capped query is complete. updateDate is also the employer's
 * JSON-LD datePosted (three independently checked details); it does not prove
 * original vacancy creation. See docs/research/2026-11-17-india-high-volume-sources.md. */
export async function fetchAccenturePage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  const { family } = configSchema.parse(source.config)
  if (!Object.hasOwn(accentureFamilies, family))
    throw new Error("Unsupported Accenture family")
  const expected = accentureSource(family as AccentureFamily)
  if (
    source.kind !== expected.kind ||
    source.id !== expected.id ||
    source.board !== expected.board ||
    source.company !== expected.company ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100
  )
    throw new Error("Invalid Accenture source or page")
  const slug = accentureFamilies[family as AccentureFamily]
  // Two official facet values contain a significant trailing space.
  const filterLabel =
    family === "Sales & Account Management" ||
    family === "Customer & User Experience"
      ? `${family} `
      : family
  let requests = 0
  const requestOptions = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const rules = await catalogText(`${origin}/robots.txt`, requestOptions)
  if (!robotsAllowed(rules, path))
    throw new Error("Accenture search path excluded by robots rules")
  async function read(offset: number, size: number) {
    const body = new FormData()
    for (const [key, value] of Object.entries({
      startIndex: String(offset),
      maxResultSize: String(size),
      jobKeyword: "",
      jobCountry: "India",
      jobLanguage: "en",
      countrySite: "in-en",
      sortBy: "1",
      searchType: "vectorSearch",
      enableQueryBoost: "true",
      minScore: "0.6",
      getFeedbackJudgmentEnabled: "true",
      useCleanEmbedding: "true",
      score: "true",
      totalHits: "true",
      debugQuery: "false",
      jobFilters: JSON.stringify([
        {
          fieldName: "areaOfInterestTitle.keyword",
          items: [filterLabel],
          multiSelect: false,
        },
      ]),
    }))
      body.set(key, value)
    const result = responseSchema.parse(
      await catalogJson(`${origin}${path}`, requestOptions, {
        method: "POST",
        headers: { "CSRF-Token": "" },
        body,
      })
    )
    if (
      result.totalHits.overMaxHits !== "False" ||
      result.totalHits.total > 10000
    )
      throw new Error("Accenture inventory exceeds provider result cap")
    if (
      offset > result.totalHits.total ||
      (offset > 0 && offset === result.totalHits.total) ||
      result.data.length !== Math.min(size, result.totalHits.total - offset)
    )
      throw new Error("Accenture returned an incomplete inventory page")
    if (
      new Set(result.data.map((job) => job.requisitionId)).size !==
      result.data.length
    )
      throw new Error("Duplicate Accenture requisition identity")
    for (const job of result.data) {
      providerUrl(job)
      if (!job.areaOfInterest.includes(slug))
        throw new Error("Accenture returned jobs outside the configured family")
    }
    assertDescending(result.data)
    return result
  }
  const offset = (page - 1) * pageSize
  const result = await read(offset, pageSize)
  if (page > 1) {
    // A bounded preceding record checks the boundary even when a durable worker
    // resumes in a new process. It is validation only, never emitted twice.
    const preceding = await read(offset - 1, 1)
    if (
      preceding.totalHits.total !== result.totalHits.total ||
      result.data.some(
        (job) => job.requisitionId === preceding.data[0].requisitionId
      )
    )
      throw new Error("Accenture inventory changed or repeated a page boundary")
    assertDescending([...preceding.data, ...result.data])
  }
  const jobs = result.data.flatMap((job) => {
    const description = plain(
      [job.jobDescription, job.qualification].filter(Boolean).join("\n")
    )
    const locations = [
      ...new Set(
        [...job.location, job.feedCity?.trim()].filter(
          (value): value is string => Boolean(value)
        )
      ),
    ]
    const postedAt = catalogDate(job.updateDate ?? undefined)
    const url = providerUrl(job)
    options.observePosting?.({
      title: job.title,
      company: "Accenture",
      url,
      description,
      locations,
      countries: [job.country],
      postedAt,
    })
    if (isEarlyCareerPosting(job.title)) return []
    if (!locations.length || locations.some((city) => !indiaCities.has(city)))
      return []
    if (
      !options.observePosting &&
      description.length < 100 &&
      catalogRoleTitleScope(
        job.title,
        options.jobCategories ?? ["software"]
      ) !== "excluded"
    )
      throw new Error("Accenture eligible posting description is incomplete")
    const posting = catalogPosting(
      {
        title: job.title,
        company: "Accenture",
        url,
        description,
        country: "India",
        city: locations.join("; "),
        posted_at: postedAt,
        work_mode: "unknown",
        source: source.id,
      },
      undefined,
      options.jobCategories
    )
    return posting ? [posting] : []
  })
  return {
    jobs,
    fetched: result.data.length,
    rejected: result.data.length - jobs.length,
    requests,
    nextPage:
      offset + result.data.length < result.totalHits.total ? page + 1 : null,
    employer: "Accenture",
    employerUrl: `${origin}/in-en/careers`,
    listingUrl: `${origin}/in-en/careers/jobsearch`,
  }
}
