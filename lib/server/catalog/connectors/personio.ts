import { load } from "cheerio"
import { SaxesParser } from "saxes"
import { z } from "zod"
import { structuredPostingDetails } from "../posting-details"
import { catalogRoleTitleScope, isCatalogRole } from "../../../jobs/categories"
import {
  catalogDate,
  catalogPosting,
  catalogText,
  explicitCountry,
  plain,
  statedLocationCountry,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { boardIdentity, publicBoardUrl } from "../source-identity"

const pageSize = 10
const addressCountry = z.union([z.string(), z.object({ name: z.string() })])
const place = z.object({
  address: z
    .object({
      addressCountry: addressCountry.nullish(),
      addressLocality: z.string().nullish(),
    })
    .nullish(),
})
const structuredJob = z.object({
  title: z.string(),
  identifier: z
    .object({ value: z.union([z.string(), z.number()]).transform(String) })
    .optional(),
  hiringOrganization: z.object({ name: z.string().trim().min(1) }).optional(),
  employmentType: z.unknown().optional(),
  experienceLevel: z.unknown().optional(),
  experienceRequirements: z.unknown().optional(),
  baseSalary: z.unknown().optional(),
  datePosted: z.string().nullish(),
  validThrough: z.string().nullish(),
  jobLocation: z.union([place, z.array(place)]).nullish(),
  jobLocationType: z.string().nullish(),
  applicantLocationRequirements: z
    .union([
      z.object({ "@type": z.literal("Country"), name: z.string() }),
      z.array(z.object({ "@type": z.literal("Country"), name: z.string() })),
    ])
    .nullish(),
})

function inventory(text: string) {
  const parser = new SaxesParser()
  parser.on("doctype", () => {
    throw new Error("Personio XML must not contain a DTD")
  })
  parser.write(text).close()
  const $ = load(text, { xml: true })
  const root = $.root().children()
  if (root.length !== 1 || root[0]?.tagName !== "workzag-jobs")
    throw new Error("Invalid Personio feed root")
  const nodes = root.children()
  if (
    nodes.length > 5000 ||
    nodes.toArray().some((node) => node.tagName !== "position")
  )
    throw new Error("Invalid Personio feed inventory")
  const seen = new Set<string>()
  return nodes
    .toArray()
    .map((node) => {
      function field(key: string) {
        const values = $(node).children(key)
        if (values.length > 1) throw new Error("Duplicate Personio XML field")
        return values.text().trim()
      }
      const id = field("id")
      const title = field("name")
      if (!/^[1-9][0-9]{0,19}$/.test(id) || !title || seen.has(id))
        throw new Error("Invalid or duplicate Personio posting identity")
      seen.add(id)
      const descriptions = $(node).children("jobDescriptions")
      if (descriptions.length > 1)
        throw new Error("Duplicate Personio XML description")
      const description = plain(
        descriptions
          .children("jobDescription")
          .toArray()
          .map((part) => {
            const names = $(part).children("name")
            const values = $(part).children("value")
            if (names.length > 1 || values.length > 1)
              throw new Error("Duplicate Personio XML description field")
            return `${names.text()}\n${values.text()}`
          })
          .join("\n")
      )
      const additional = $(node).children("additionalOffices")
      if (
        additional.length > 1 ||
        additional
          .children()
          .toArray()
          .some((office) => office.tagName !== "office")
      )
        throw new Error("Invalid Personio additional offices")
      const offices = [
        field("office"),
        ...additional
          .children("office")
          .toArray()
          .map((office) => $(office).text().trim()),
      ].filter(Boolean)
      return {
        id,
        title,
        description,
        company: field("subcompany"),
        offices,
      }
    })
    .sort(
      (left, right) =>
        left.id.length - right.id.length || left.id.localeCompare(right.id)
    )
}

function samePage(value: string | undefined, expected: string) {
  const actual = value ? URL.parse(value) : null
  const target = new URL(expected)
  return (
    actual &&
    !actual.username &&
    !actual.password &&
    !actual.port &&
    actual.origin === target.origin &&
    actual.pathname === target.pathname
  )
}

function detailFacts(html: string, url: string, id: string, title: string) {
  const $ = load(html)
  if (!samePage($('link[rel="canonical"]').attr("href"), url))
    throw new Error("Personio detail canonical identity differs")
  const postings: unknown[] = []
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") return
    const node = value as Record<string, unknown>
    if (node["@type"] === "JobPosting") postings.push(node)
    if (node["@graph"]) visit(node["@graph"])
  }
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      visit(JSON.parse($(element).text()))
    } catch {
      throw new Error("Invalid Personio structured job data")
    }
  })
  if (!postings.length) return null
  if (postings.length !== 1)
    throw new Error("Ambiguous Personio structured job data")
  const job = structuredJob.parse(postings[0])
  if (
    job.title !== title ||
    (job.identifier &&
      !new RegExp(`^${id}(?:-[0-9]+)?$`).test(job.identifier.value))
  )
    throw new Error("Personio structured posting identity differs")
  return job
}

/** The public XML feed is complete, but its createdAt and office labels do not
 * establish publication date or country. Read bounded detail pages for those
 * facts; never turn an old creation date or a city name into hiring evidence. */
export async function fetchPersonioPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  if (
    source.kind !== "personio" ||
    !source.board ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    boardIdentity("personio", source.board).id !== source.id
  )
    throw new Error("Invalid Personio source or page")
  const origin = publicBoardUrl("personio", source.board)
  const listingUrl = `${origin}/xml?language=en`
  const employerUrl = `${origin}/?language=en`
  let requests = 0
  const request = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const all = inventory(await catalogText(listingUrl, request))
  const offset = (page - 1) * pageSize
  if (page > 1 && offset >= all.length)
    throw new Error("Personio page exceeds current inventory")
  const board = load(await catalogText(employerUrl, request))
  const employer = board("title")
    .text()
    .trim()
    .match(/^Jobs at (.+)$/)?.[1]
    ?.trim()
  if (
    !employer ||
    employer.length > 300 ||
    !samePage(board('link[rel="canonical"]').attr("href"), employerUrl)
  )
    throw new Error("Personio employer identity unavailable")
  if (source.company && source.company !== employer)
    throw new Error("Personio employer changed; revalidation required")
  const jobs: CatalogPosting[] = []
  const records = all.slice(offset, offset + pageSize)
  let accepted = 0
  for (const item of records) {
    const url = `${origin}/job/${item.id}`
    const data = detailFacts(
      await catalogText(`${url}?language=en`, request),
      url,
      item.id,
      item.title
    )
    const expiry = catalogDate(data?.validThrough ?? undefined)
    if (expiry && Date.parse(expiry) <= Date.now()) continue
    const postedAt = catalogDate(data?.datePosted ?? undefined)
    const company = item.company || data?.hiringOrganization?.name || employer
    const places = data?.jobLocation
      ? Array.isArray(data.jobLocation)
        ? data.jobLocation
        : [data.jobLocation]
      : []
    const countries = new Map<string, Set<string>>()
    const locations = new Set(item.offices)
    for (const location of places) {
      const value = location.address?.addressCountry
      const rawCountry = typeof value === "string" ? value : value?.name
      const city = location.address?.addressLocality?.trim()
      const label = [city, rawCountry].filter(Boolean).join(", ")
      if (label) locations.add(label)
      const country = explicitCountry(rawCountry)
      if (!country) continue
      const cities = countries.get(country) ?? new Set<string>()
      if (city) cities.add(city)
      countries.set(country, cities)
    }
    for (const part of item.offices.flatMap((office) =>
      office.split(/[,;|]|\s+[-–—]\s+/)
    )) {
      const country = statedLocationCountry(part.trim())
      if (country && !countries.has(country)) countries.set(country, new Set())
    }
    const remote = data?.jobLocationType === "TELECOMMUTE"
    if (remote && data?.applicantLocationRequirements) {
      const requirements = Array.isArray(data.applicantLocationRequirements)
        ? data.applicantLocationRequirements
        : [data.applicantLocationRequirements]
      const allowed = new Map<string, Set<string>>()
      for (const requirement of requirements) {
        locations.add(requirement.name)
        const country = explicitCountry(requirement.name)
        if (country) allowed.set(country, countries.get(country) ?? new Set())
      }
      countries.clear()
      for (const [country, cities] of allowed) countries.set(country, cities)
    }
    options.observePosting?.({
      title: item.title,
      company,
      url,
      description: item.description,
      locations: [...locations],
      countries: [...countries.keys()],
      postedAt,
    })
    if (!options.observePosting) {
      const categories = options.jobCategories ?? ["software"]
      if (
        catalogRoleTitleScope(item.title, categories) !== "excluded" &&
        item.description.length < 100
      )
        throw new Error("Personio description is incomplete")
      if (
        isCatalogRole(item.title, item.description, categories) &&
        !countries.size
      )
        throw new Error("Personio eligible posting lacks country evidence")
    }
    let kept = false
    for (const [country, cities] of countries) {
      const posting = catalogPosting(
        {
          title: item.title,
          company,
          url,
          description: item.description,
          country,
          city: [...cities].join("; ") || null,
          posted_at: postedAt,
          work_mode: remote ? "remote" : "unknown",
          stated: structuredPostingDetails(data),
          source: source.id,
        },
        undefined,
        options.jobCategories
      )
      if (posting) {
        jobs.push(posting)
        kept = true
      }
    }
    if (kept) accepted++
  }
  return {
    jobs,
    fetched: records.length,
    rejected: records.length - accepted,
    requests,
    nextPage: offset + records.length < all.length ? page + 1 : null,
    employer,
    employerUrl,
    listingUrl,
  }
}
