import { z } from "zod"
import { load } from "cheerio"
import { SaxesParser } from "saxes"
import { publicApplicationUrl } from "@/lib/applications/url"
import { isCatalogRole } from "@/lib/jobs/categories"
import { boardIdentity, publicBoardUrl } from "../source-identity"
import {
  catalogDate,
  catalogJson,
  catalogText,
  catalogPosting,
  explicitCountry,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"

const location = z.object({
  country: z.string().nullish(),
  country_code: z.string().nullish(),
  countryCode: z.string().nullish(),
  city: z.string().nullish(),
})
const offer = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  title: z.string(),
  status: z.string(),
  company_name: z.string().trim().min(1).max(300),
  careers_url: z.string(),
  description: z.string(),
  requirements: z.string().nullish(),
  country: z.string().nullish(),
  country_code: z.string().nullish(),
  city: z.string().nullish(),
  locations: z.array(location).optional(),
  published_at: z.string().nullish(),
  close_at: z.string().nullish(),
  remote: z.boolean().optional(),
  hybrid: z.boolean().optional(),
  on_site: z.boolean().optional(),
})
const workableJob = z.object({
  shortcode: z.string().regex(/^[A-Fa-f0-9]{10}$/),
  title: z.string(),
  url: z.string(),
  description: z.string(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  locations: z.array(location).optional(),
  published_on: z.string().nullish(),
  telecommuting: z.boolean().optional(),
})

function plain(html: string) {
  const $ = load(html)
  $("script,style").remove()
  $("p,br,li,div,h1,h2,h3").before("\n")
  return $.root()
    .text()
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim()
    .slice(0, 60_000)
}
function recruiteeDate(value: string | null | undefined) {
  if (!value) return null
  return catalogDate(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/.test(value)
      ? value.replace(" ", "T").replace(" UTC", "Z")
      : value
  )
}

function recruiteeXml(text: string) {
  // Cheerio alone repairs truncated XML. Validate syntax first, and never
  // process DTDs/entities or fetch anything named inside the document.
  const parser = new SaxesParser()
  parser.on("doctype", () => {
    throw new Error("Recruitee XML must not contain a DTD")
  })
  parser.write(text).close()
  const $ = load(text, { xml: true })
  if (
    $.root().children().length !== 1 ||
    $("offers").length !== 1 ||
    $.root().children()[0]?.tagName !== "offers"
  )
    throw new Error("Invalid Recruitee feed root")
  const nodes = $("offers").children()
  if (
    nodes.length > 5000 ||
    nodes.toArray().some((node) => node.tagName !== "offer")
  )
    throw new Error("Invalid Recruitee feed inventory")
  return {
    offers: nodes.toArray().map((node) => {
      const get = (key: string) => {
        const values = $(node).children(key)
        if (values.length > 1) throw new Error("Duplicate Recruitee XML field")
        return values.text().trim()
      }
      const flag = (key: string) => {
        const value = get(key)
        if (value && value !== "true" && value !== "false")
          throw new Error("Invalid Recruitee boolean")
        return value === "true"
      }
      return {
        id: Number(get("id")),
        slug: get("slug"),
        title: get("title"),
        status: get("status") || "published",
        company_name: get("company_name"),
        careers_url: get("careers_url"),
        description: get("description"),
        requirements: get("requirements"),
        country: get("country") || null,
        country_code: get("country_code") || null,
        city: get("city") || null,
        published_at: get("published_at") || null,
        close_at: get("close_at") || null,
        remote: flag("remote"),
        hybrid: flag("hybrid"),
        on_site: flag("on_site"),
        locations: $(node)
          .children("locations")
          .children("location")
          .toArray()
          .map((loc) => ({
            country: $(loc).children("country").text() || null,
            country_code: $(loc).children("country_code").text() || null,
            city: $(loc).children("city").text() || null,
          })),
      }
    }),
  }
}

/** Documented complete public inventories. Never apply a local row cap then
 * claim completeness; oversized/invalid feeds fail without publishing. */
export async function fetchPublicAtsPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  if (
    !["recruitee", "workable"].includes(source.kind) ||
    !source.board ||
    boardIdentity(source.kind as "recruitee" | "workable", source.board).id !==
      source.id ||
    page !== 1
  )
    throw new Error("Invalid public ATS source or page")
  const boardUrl = publicBoardUrl(
    source.kind as "recruitee" | "workable",
    source.board
  )
  const listingUrl =
    source.kind === "recruitee"
      ? `${boardUrl}/api/feeds/offers.xml`
      : `https://apply.workable.com/api/v1/widget/accounts/${source.board}?details=true`
  let requests = 0
  const requestOptions = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const data =
    source.kind === "recruitee"
      ? recruiteeXml(await catalogText(listingUrl, requestOptions))
      : await catalogJson(listingUrl, requestOptions)
  const jobs: CatalogPosting[] = []
  let employer: string | null = null
  let fetched: number
  let acceptedRows = 0
  const seen = new Set<string>()
  const accepted = new Set<string>()
  function add(
    row: {
      title: string
      url: string
      description: string
      posted_at: string | null
      work_mode: CatalogPosting["work_mode"]
    },
    locations: z.infer<typeof location>[]
  ) {
    const rawCountries = locations.flatMap((loc) => {
      const country = explicitCountry(
        loc.country_code ?? loc.countryCode ?? loc.country ?? undefined
      )
      return country ? [country] : []
    })
    options.observePosting?.({
      title: row.title,
      company: employer!,
      url: row.url,
      description: row.description,
      locations: locations
        .map((loc) =>
          [loc.city, loc.country ?? loc.country_code ?? loc.countryCode]
            .filter(Boolean)
            .join(", ")
        )
        .filter(Boolean),
      countries: [...new Set(rawCountries)],
      postedAt: row.posted_at,
    })
    if (
      !isCatalogRole(
        row.title,
        row.description,
        options.jobCategories ?? ["software"]
      )
    )
      return
    if (row.description.length < 100) {
      if (options.observePosting) return
      throw new Error("Public ATS description is incomplete")
    }
    const countries = new Set<string>()
    for (const loc of locations) {
      const country = explicitCountry(
        loc.country_code ?? loc.countryCode ?? loc.country ?? undefined
      )
      if (!country || countries.has(country)) continue
      countries.add(country)
      const identity = `${row.url}\n${country}`
      if (accepted.has(identity)) continue
      const posting = catalogPosting(
        {
          ...row,
          country,
          city: loc.city ?? null,
          company: employer!,
          source: source.id,
        },
        undefined,
        options.jobCategories
      )
      if (posting) {
        jobs.push(posting)
        accepted.add(identity)
      }
    }
    if (!countries.size && !options.observePosting)
      throw new Error("Public ATS eligible posting lacks country evidence")
    acceptedRows++
  }
  if (source.kind === "recruitee") {
    const list = z.object({ offers: z.array(offer).max(5000) }).parse(data)
    fetched = list.offers.length
    for (const job of list.offers) {
      if (seen.has(String(job.id)))
        throw new Error("Duplicate public ATS posting")
      seen.add(String(job.id))
      if (job.status !== "published") continue
      const closed = recruiteeDate(job.close_at)
      if (closed && Date.parse(closed) <= Date.now()) continue
      if (employer && employer !== job.company_name)
        throw new Error("Recruitee employer identity differs across feed")
      employer = job.company_name
      const url = new URL(job.careers_url)
      if (
        !publicApplicationUrl(job.careers_url) ||
        (url.hostname.endsWith(".recruitee.com") && url.origin !== boardUrl) ||
        url.username ||
        url.password ||
        url.pathname !== `/o/${job.slug}` ||
        url.search ||
        url.hash
      )
        throw new Error("Recruitee posting URL needs employer identity review")
      add(
        {
          title: job.title,
          url: url.href,
          description: plain(`${job.description}\n${job.requirements ?? ""}`),
          posted_at: recruiteeDate(job.published_at),
          work_mode: job.hybrid
            ? "hybrid"
            : job.remote
              ? "remote"
              : job.on_site
                ? "onsite"
                : "unknown",
        },
        job.locations?.length ? job.locations : [job]
      )
    }
  } else {
    const list = z
      .object({
        name: z.string().trim().min(1).max(300),
        jobs: z
          .array(
            options.observePosting
              ? workableJob.extend({ description: z.string().nullish() })
              : workableJob
          )
          .max(5000),
      })
      .parse(data)
    fetched = list.jobs.length
    employer = list.name
    const content = new Map<string, string>()
    for (const job of list.jobs) {
      // The public widget repeats one shortcode for different locations.
      // Merge those locations, but fail conflicting content for the same job.
      const fingerprint = JSON.stringify([
        job.title,
        job.url,
        job.description,
        job.published_on,
        job.telecommuting,
      ])
      if (
        content.has(job.shortcode) &&
        content.get(job.shortcode) !== fingerprint
      )
        throw new Error("Conflicting public ATS posting")
      content.set(job.shortcode, fingerprint)
      const url = new URL(job.url)
      if (
        url.origin !== "https://apply.workable.com" ||
        url.username ||
        url.password ||
        ![
          `/j/${job.shortcode}`,
          `/${source.board}/j/${job.shortcode}`,
        ].includes(url.pathname.replace(/\/$/, "")) ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Workable posting URL differs from public feed identity"
        )
      add(
        {
          title: job.title,
          url: url.href,
          description: plain(job.description ?? ""),
          posted_at: catalogDate(job.published_on ?? undefined),
          work_mode: job.telecommuting ? "remote" : "unknown",
        },
        job.locations?.length ? job.locations : [job]
      )
    }
  }
  if (source.company && employer && source.company !== employer)
    throw new Error("Public ATS employer changed; revalidation required")
  return {
    jobs,
    fetched,
    rejected: fetched - acceptedRows,
    total: fetched,
    nextPage: null,
    requests,
    employer,
    employerUrl: listingUrl,
    listingUrl,
  }
}
