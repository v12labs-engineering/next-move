import { z } from "zod"
import type { JobCategory } from "@/lib/jobs/categories"
import { ashbySalary, leverSalary } from "../posting-details"
import {
  catalogDate,
  catalogJson,
  catalogPosting,
  explicitCountry,
  plain,
  statedLocationCountry,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"

const postal = z
  .object({
    addressCountry: z.string().optional(),
    addressLocality: z.string().optional(),
  })
  .passthrough()
const address = z
  .object({
    postalAddress: postal.optional(),
    addressCountry: z.string().optional(),
    addressLocality: z.string().optional(),
  })
  .passthrough()
const ashbyJob = z
  .object({
    title: z.string(),
    jobUrl: z.string(),
    isListed: z.boolean(),
    location: z.string().optional(),
    workplaceType: z.string().nullish(),
    isRemote: z.boolean().nullish(),
    employmentType: z.unknown().optional(),
    compensation: z.unknown().optional(),
    descriptionPlain: z.string().optional(),
    descriptionHtml: z.string().optional(),
    publishedAt: z.string().optional(),
    address: address.nullish(),
    secondaryLocations: z
      .array(
        z
          .object({
            location: z.string().optional(),
            address: address.nullish(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough()
const ashbyResponse = z.object({ jobs: z.array(ashbyJob) }).passthrough()
const optionalSourceText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
const emptySourceText = z
  .string()
  .nullish()
  .transform((value) => value ?? "")
const rawAshbyResponse = ashbyResponse.extend({
  jobs: z.array(
    ashbyJob.extend({
      location: optionalSourceText,
      descriptionPlain: optionalSourceText,
      descriptionHtml: optionalSourceText,
      publishedAt: optionalSourceText,
    })
  ),
})
const arbeitnowResponse = z
  .object({
    data: z.array(
      z
        .object({
          slug: z.string(),
          company_name: z.string(),
          title: z.string(),
          description: z.string(),
          location: z.string(),
          url: z.string(),
          remote: z.boolean().optional(),
          created_at: z.number().optional(),
        })
        .passthrough()
    ),
  })
  .passthrough()
const rawArbeitnowResponse = arbeitnowResponse.extend({
  data: z.array(
    arbeitnowResponse.shape.data.element.extend({
      description: emptySourceText,
      location: emptySourceText,
      created_at: z
        .number()
        .nullish()
        .transform((value) => value ?? undefined),
    })
  ),
})
export function parseAshby(
  source: CatalogSource,
  input: unknown,
  observePosting?: FetchOptions["observePosting"],
  jobCategories?: readonly JobCategory[]
): CatalogPosting[] {
  const parsed = (observePosting ? rawAshbyResponse : ashbyResponse).parse(
    input
  )
  const rows: CatalogPosting[] = []
  for (const job of parsed.jobs) {
    if (!job.isListed) continue
    const locations = [
      { location: job.location, address: job.address },
      ...(job.secondaryLocations ?? []),
    ]
    const citiesByCountry = new Map<string, Set<string>>()
    for (const location of locations) {
      const a = location.address?.postalAddress ?? location.address
      const country = explicitCountry(a?.addressCountry)
      if (!country) continue
      const cities = citiesByCountry.get(country) ?? new Set<string>()
      const city = a?.addressLocality?.trim() || location.location?.trim()
      if (city) cities.add(city)
      citiesByCountry.set(country, cities)
    }
    observePosting?.({
      title: job.title,
      company: source.company,
      url: job.jobUrl,
      description:
        job.descriptionPlain?.trim() || plain(job.descriptionHtml ?? ""),
      locations: locations
        .map(
          (location) =>
            location.location ??
            (location.address?.postalAddress ?? location.address)
              ?.addressLocality ??
            ""
        )
        .filter(Boolean),
      countries: [...citiesByCountry.keys()],
      postedAt: catalogDate(job.publishedAt),
    })
    // Keep the existing country-level identity while retaining every stated
    // city for location matching and saved/application history.
    for (const [country, cities] of citiesByCountry) {
      const mode = job.workplaceType?.toLowerCase()
      const row = catalogPosting(
        {
          source: source.id,
          company: source.company,
          title: job.title,
          url: job.jobUrl,
          country,
          city: [...cities].join("; ") || null,
          description: (
            job.descriptionPlain?.trim() || plain(job.descriptionHtml ?? "")
          ).slice(0, 60000),
          work_mode:
            mode === "onsite" || mode === "hybrid" || mode === "remote"
              ? mode
              : "unknown",
          posted_at: catalogDate(job.publishedAt),
          stated: {
            employment: job.employmentType,
            salary: ashbySalary(job.compensation),
          },
        },
        undefined,
        jobCategories
      )
      if (row) rows.push(row)
    }
  }
  return rows
}
const cityCountries: Record<string, string> = {
  berlin: "Germany",
  munich: "Germany",
  münchen: "Germany",
  hamburg: "Germany",
  frankfurt: "Germany",
  cologne: "Germany",
  köln: "Germany",
  düsseldorf: "Germany",
  stuttgart: "Germany",
  amsterdam: "Netherlands",
  rotterdam: "Netherlands",
  eindhoven: "Netherlands",
  dublin: "Ireland",
  cork: "Ireland",
  copenhagen: "Denmark",
  stockholm: "Sweden",
  sydney: "Australia",
  melbourne: "Australia",
  tokyo: "Japan",
  dubai: "UAE",
  "abu dhabi": "UAE",
}
export function parseArbeitnow(
  input: unknown,
  observePosting?: FetchOptions["observePosting"],
  jobCategories?: readonly JobCategory[]
): CatalogPosting[] {
  const parsed = (
    observePosting ? rawArbeitnowResponse : arbeitnowResponse
  ).parse(input)
  return parsed.data.flatMap((job) => {
    const parts = job.location
      .toLowerCase()
      .split(/[,;|]/)
      .map((p) => p.trim())
    const country = parts
      .map((p) => explicitCountry(p) ?? cityCountries[p])
      .find(Boolean)
    observePosting?.({
      title: job.title,
      company: job.company_name,
      url: job.url,
      description: plain(job.description),
      locations: job.location ? [job.location] : [],
      countries: parts
        .map(statedLocationCountry)
        .filter((value): value is string => Boolean(value)),
      postedAt: catalogDate(job.created_at),
    })
    if (!country) return []
    const row = catalogPosting(
      {
        source: "arbeitnow",
        company: job.company_name,
        title: job.title,
        url: job.url,
        country,
        city: job.location,
        description: plain(job.description),
        work_mode: job.remote === true ? "remote" : "unknown",
        posted_at: catalogDate(job.created_at),
      },
      undefined,
      jobCategories
    )
    return row ? [row] : []
  })
}
const greenhouseResponse = z.object({
  jobs: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      absolute_url: z.string(),
      location: z.object({ name: z.string() }),
      content: z.string(),
      first_published: z.string().nullish(),
      offices: z
        .array(
          z.object({
            name: z.string().nullish(),
            location: z.string().nullish(),
          })
        )
        .nullish(),
      metadata: z
        .array(z.object({ name: z.string(), value: z.unknown() }))
        .nullish(),
    })
  ),
})
const rawGreenhouseResponse = greenhouseResponse.extend({
  jobs: z.array(
    greenhouseResponse.shape.jobs.element.extend({
      content: emptySourceText,
      location: z
        .object({ name: emptySourceText })
        .nullish()
        .transform((value) => value ?? { name: "" }),
    })
  ),
})

export function parseGreenhouse(
  source: CatalogSource,
  input: unknown,
  observePosting?: FetchOptions["observePosting"],
  jobCategories?: readonly JobCategory[]
): CatalogPosting[] {
  const data = (
    observePosting ? rawGreenhouseResponse : greenhouseResponse
  ).parse(input)
  return data.jobs.flatMap((job) => {
    const fields = new Map(
      (job.metadata ?? []).map((field) => [
        field.name.toLowerCase(),
        field.value,
      ])
    )
    // Country fields may be single- or multi-select (for example InMobi's
    // "Base Country"). A mixed-country field cannot resolve a bare city.
    const countryFields = [fields.get("country"), fields.get("base country")]
    const metadataCountries = new Set(
      countryFields
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter((value): value is string => typeof value === "string")
        .map(explicitCountry)
        .filter((value): value is string => Boolean(value))
    )
    const metadataCountry =
      metadataCountries.size === 1 ? [...metadataCountries][0] : undefined
    const workField = fields.get("work arrangement")
    const mode =
      typeof workField === "string" ? workField.toLowerCase() : "unknown"
    // Greenhouse encodes the HTML in content. Decode before extracting text.
    const description = plain(job.content)
    const locations = job.location.name.split(";").flatMap((location) => {
      const label = location.trim()
      const parts = label
        .replace(/\.\s+(?=India$)/i, ", ")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
      const statedCountry = statedLocationCountry(parts.at(-1))
      const indiaPlace =
        label.match(
          /^(?:India|IND)(?:\s+[-–—]\s+|\s*,\s*|\s+(?=Remote$))(.+)$/i
        )?.[1] ??
        (/^Remote(?:\s+[-–—])?\s+(?:India|IND)$/i.test(label)
          ? "Remote"
          : undefined)
      // Associated office addresses are authoritative provider evidence. Match
      // the stated city to that office; an unrelated headquarters must not
      // turn "Remote" or an unknown city into an eligible country.
      const officeCountries = new Set(
        (job.offices ?? [])
          .filter((office) => {
            const city = office.location?.split(",")[0]?.trim()
            return (
              label.length > 0 &&
              [office.name, city].some(
                (value) => value?.trim().toLowerCase() === label.toLowerCase()
              )
            )
          })
          .map((office) =>
            statedLocationCountry(office.location?.split(",").at(-1))
          )
          .filter((value): value is string => Boolean(value))
      )
      const officeCountry =
        officeCountries.size === 1 ? [...officeCountries][0] : undefined
      const country =
        statedCountry ??
        (indiaPlace ? "India" : (metadataCountry ?? officeCountry))
      if (!country) return []
      const cityText = statedCountry
        ? parts.slice(0, -1).join(", ")
        : (indiaPlace ?? parts.join(", "))
      const remoteLocation = /^remote(?:$|\s+[-–—]\s+)/i.test(cityText)
      const city =
        !cityText || /^(remote|worldwide|anywhere)$/i.test(cityText)
          ? null
          : cityText
      return [{ country, city, remoteLocation }]
    })
    observePosting?.({
      title: job.title,
      company: source.company,
      url: job.absolute_url,
      description,
      locations: job.location.name ? [job.location.name] : [],
      countries: locations.length
        ? [...new Set(locations.map((location) => location.country))]
        : metadataCountry
          ? [metadataCountry]
          : [],
      postedAt: catalogDate(job.first_published ?? undefined),
    })
    return locations.flatMap(({ country, city, remoteLocation }) => {
      const row = catalogPosting(
        {
          source: source.id,
          company: source.company,
          title: job.title,
          url: job.absolute_url,
          country,
          city,
          description,
          work_mode:
            mode === "remote" || mode === "hybrid" || mode === "onsite"
              ? mode
              : remoteLocation
                ? "remote"
                : "unknown",
          stated: {
            employment: fields.get("employment type") ?? fields.get("job type"),
            experience:
              fields.get("experience level") ?? fields.get("seniority"),
          },
          // An update timestamp is not evidence of the original posting date.
          posted_at: catalogDate(job.first_published ?? undefined),
        },
        city ?? undefined,
        jobCategories
      )
      return row ? [row] : []
    })
  })
}

const leverResponse = z.array(
  z
    .object({
      text: z.string(),
      hostedUrl: z.string(),
      country: z.string().nullish(),
      categories: z
        .object({
          location: z.string().optional(),
          allLocations: z.array(z.string()).optional(),
          commitment: z.unknown().optional(),
        })
        .passthrough(),
      descriptionPlain: z.string().optional(),
      additionalPlain: z.string().optional(),
      workplaceType: z.string().optional(),
      salaryRange: z.unknown().optional(),
      createdAt: z.number().optional(),
      lists: z
        .array(z.object({ text: z.string(), content: z.string() }))
        .optional(),
    })
    .passthrough()
)
const rawLeverResponse = z.array(
  leverResponse.element.extend({
    categories: z
      .object({
        location: optionalSourceText,
        commitment: z.unknown().optional(),
        allLocations: z
          .array(z.string())
          .nullish()
          .transform((value) => value ?? undefined),
      })
      .passthrough()
      .nullish()
      .transform(
        (value) =>
          value ?? {
            location: undefined,
            allLocations: undefined,
            commitment: undefined,
          }
      ),
    descriptionPlain: optionalSourceText,
    additionalPlain: optionalSourceText,
    createdAt: z
      .number()
      .nullish()
      .transform((value) => value ?? undefined),
  })
)

export function parseLever(
  source: CatalogSource,
  input: unknown,
  observePosting?: FetchOptions["observePosting"],
  jobCategories?: readonly JobCategory[]
): CatalogPosting[] {
  return (observePosting ? rawLeverResponse : leverResponse)
    .parse(input)
    .flatMap((job) => {
      const location = job.categories.location ?? ""
      const country =
        explicitCountry(job.country ?? undefined) ??
        statedLocationCountry(location.split(",").at(-1)?.trim())
      const description = [
        job.descriptionPlain,
        ...(job.lists ?? []).map((l) => `${l.text}\n${plain(l.content)}`),
        job.additionalPlain,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 60000)
      observePosting?.({
        title: job.text,
        company: source.company,
        url: job.hostedUrl,
        description,
        locations: [location, ...(job.categories.allLocations ?? [])].filter(
          Boolean
        ),
        countries: country ? [country] : [],
        postedAt:
          job.createdAt === undefined
            ? null
            : catalogDate(job.createdAt / 1000),
      })
      if (!country) return []
      const row = catalogPosting(
        {
          source: source.id,
          company: source.company,
          title: job.text,
          url: job.hostedUrl,
          country,
          city: location || null,
          description,
          work_mode:
            job.workplaceType === "remote" ||
            job.workplaceType === "hybrid" ||
            job.workplaceType === "onsite"
              ? job.workplaceType
              : "unknown",
          stated: {
            employment: job.categories.commitment,
            salary: leverSalary(job.salaryRange),
          },
          posted_at:
            job.createdAt === undefined
              ? null
              : catalogDate(job.createdAt / 1000),
        },
        undefined,
        jobCategories
      )
      return row ? [row] : []
    })
}

/** Greenhouse, Ashby, Lever and Arbeitnow public JSON APIs. */
export async function fetchBoardApiPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  const region =
    source.kind === "greenhouse" || source.kind === "lever"
      ? z
          .object({ region: z.enum(["us", "eu"]).optional() })
          .parse(source.config ?? {}).region
      : undefined
  const url =
    source.kind === "greenhouse"
      ? `https://boards-api.${region === "eu" ? "eu." : ""}greenhouse.io/v1/boards/${source.board}/jobs?content=true`
      : source.kind === "ashby"
        ? `https://api.ashbyhq.com/posting-api/job-board/${source.board}?includeCompensation=true`
        : source.kind === "lever"
          ? `https://api.${region === "eu" ? "eu." : ""}lever.co/v0/postings/${source.board}?mode=json&skip=${(page - 1) * 100}&limit=100`
          : `https://www.arbeitnow.com/api/job-board-api?page=${page}`
  let requests = 0
  const data = await catalogJson(url, {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  })
  let records: unknown[],
    nextPage: number | null = null
  let parse: (input: unknown) => CatalogPosting[]
  if (source.kind === "greenhouse") {
    // Validate the full response before counting rejected individual postings.
    records = (
      options.observePosting ? rawGreenhouseResponse : greenhouseResponse
    ).parse(data).jobs
    parse = (record) =>
      parseGreenhouse(
        source,
        { jobs: [record] },
        options.observePosting,
        options.jobCategories
      )
  } else if (source.kind === "ashby") {
    records = (options.observePosting ? rawAshbyResponse : ashbyResponse).parse(
      data
    ).jobs
    parse = (record) =>
      parseAshby(
        source,
        { jobs: [record] },
        options.observePosting,
        options.jobCategories
      )
  } else if (source.kind === "lever") {
    records = (options.observePosting ? rawLeverResponse : leverResponse).parse(
      data
    )
    parse = (record) =>
      parseLever(
        source,
        [record],
        options.observePosting,
        options.jobCategories
      )
    nextPage = records.length >= 100 ? page + 1 : null
  } else {
    const result = (
      options.observePosting ? rawArbeitnowResponse : arbeitnowResponse
    )
      .extend({ links: z.object({ next: z.string().nullable() }) })
      .parse(data)
    records = result.data
    parse = (record) =>
      parseArbeitnow(
        { data: [record] },
        options.observePosting,
        options.jobCategories
      )
    if (result.links.next) {
      const next = new URL(result.links.next)
      const value = Number(next.searchParams.get("page"))
      if (
        next.origin !== "https://www.arbeitnow.com" ||
        next.pathname !== "/api/job-board-api" ||
        !Number.isSafeInteger(value) ||
        value !== page + 1 ||
        next.username ||
        next.password
      )
        throw new Error("Invalid source pagination")
      nextPage = value
    }
  }
  let rejected = 0
  const jobs = records.flatMap((record) => {
    const rows = parse(record)
    if (!rows.length) rejected++
    return rows
  })
  return { jobs, fetched: records.length, rejected, requests, nextPage }
}
