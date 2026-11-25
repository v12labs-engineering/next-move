import { z } from "zod"
import { load } from "cheerio"
import { isEarlyCareerPosting } from "@/lib/jobs/software-roles"
import { catalogRoleTitleScope, isCatalogRole } from "@/lib/jobs/categories"
import {
  catalogDate,
  catalogJson,
  catalogPosting,
  explicitCountry,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { boardFromUrl, workdaySite } from "../source-identity"

// Detail hydration is bounded independently of an employer's total inventory.
export const ATS_PAGE_SIZE = 5
const SCOPED_SMART_PAGE_SIZE = 20
const smartScope = z.object({ country: z.literal("IN").optional() })
export class IncompleteAtsInventoryError extends Error {}
const smartCompany = z.object({
  identifier: z.string(),
  name: z.string().trim().min(1).max(300),
})
const smartSummary = z.object({
  id: z.string().regex(/^[0-9]+$/),
  company: smartCompany,
  name: z.string(),
})
const smartList = z.object({
  offset: z.number().int().nonnegative(),
  totalFound: z.number().int().nonnegative(),
  content: z.array(smartSummary).max(SCOPED_SMART_PAGE_SIZE),
})
const smartDetail = smartSummary.extend({
  active: z.boolean(),
  visibility: z.string(),
  releasedDate: z.string().optional(),
  typeOfEmployment: z
    .object({ label: z.unknown().optional() })
    .nullish()
    .catch(undefined),
  experienceLevel: z
    .object({ label: z.unknown().optional() })
    .nullish()
    .catch(undefined),
  location: z.object({
    country: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    remote: z.boolean().optional(),
    hybrid: z.boolean().optional(),
  }),
  jobAd: z.object({
    sections: z
      .record(z.string(), z.unknown())
      .transform((sections) => {
        // PostingDetails includes videos: { title, urls }, not a text section.
        // Keep strict validation for every remaining description section.
        const textSections = { ...sections }
        delete textSections.videos
        return textSections
      })
      .pipe(
        z.record(
          z.string(),
          z.object({ title: z.string().optional(), text: z.string() })
        )
      ),
  }),
})
const smartSourceDetail = smartDetail.extend({
  location: smartDetail.shape.location
    .extend({
      country: z.string().nullish(),
      city: z.string().nullish(),
      region: z.string().nullish(),
    })
    .nullish(),
  jobAd: z
    .object({
      sections: z
        .record(
          z.string(),
          z
            .object({
              title: z.string().optional(),
              text: z.string().nullish(),
            })
            .passthrough()
        )
        .nullish(),
    })
    .nullish(),
})
const workdayList = z.object({
  total: z.number().int().nonnegative(),
  jobPostings: z
    .array(z.object({ externalPath: z.string(), title: z.string() }))
    .max(ATS_PAGE_SIZE),
})
const workdayDetail = z.object({
  hiringOrganization: z
    .object({ name: z.string().trim().min(1).max(300) })
    .optional(),
  jobPostingInfo: z.object({
    title: z.string(),
    jobDescription: z.string(),
    jobPostingSiteId: z.string(),
    externalUrl: z.string(),
    startDate: z.string().optional(),
    timeType: z.unknown().optional(),
    location: z.string(),
    additionalLocations: z.array(z.string()).optional(),
    country: z.object({ descriptor: z.string() }).optional(),
    jobRequisitionLocation: z
      .object({
        country: z
          .object({
            alpha2Code: z.string().optional(),
            descriptor: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    canApply: z.boolean(),
    posted: z.boolean(),
  }),
})
const workdaySourceDetail = workdayDetail.extend({
  jobPostingInfo: workdayDetail.shape.jobPostingInfo.extend({
    jobDescription: z.string().nullish(),
    location: z.string().nullish(),
    country: z.object({ descriptor: z.string().nullish() }).nullish(),
  }),
})

function text(html: string) {
  const $ = load(html)
  $("script,style").remove()
  $("p,br,li,div,h1,h2,h3").before("\n")
  return $.root()
    .text()
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim()
    .slice(0, 60000)
}

export async function fetchAdditionalAtsPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  const scope =
    source.kind === "smartrecruiters"
      ? smartScope.parse(source.config ?? {}).country
      : undefined
  const pageSize = scope ? SCOPED_SMART_PAGE_SIZE : ATS_PAGE_SIZE
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid ATS page")
  let requests = 0
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(
      Math.max(1, Math.min(options.timeoutMs ?? 45000, 45000))
    ),
  ])
  const read = (url: string, init?: RequestInit) =>
    catalogJson(
      url,
      {
        ...options,
        signal,
        onRequest() {
          requests++
          options.onRequest?.()
        },
      },
      init
    )
  const jobs: CatalogPosting[] = []
  let employer: string | null = null
  let employerUrl: string | null = null
  let total: number, fetched: number, listingUrl: string
  if (source.kind === "smartrecruiters") {
    const base = `https://api.smartrecruiters.com/v1/companies/${source.board}/postings`
    const query = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    })
    if (scope) {
      const started = options.snapshotStartedAt ?? new Date().toISOString()
      const cutoff = new Date(Date.parse(started) - 30 * 86_400_000)
      query.set("country", scope.toLowerCase())
      query.set("destination", "PUBLIC")
      // A resumed scan must use the same inventory window on every page.
      if (!options.observePosting)
        query.set("releasedAfter", cutoff.toISOString())
    }
    listingUrl = `${base}?${query}`
    const list = smartList.parse(await read(listingUrl))
    if (list.offset !== offset)
      throw new Error("SmartRecruiters ignored pagination")
    total = list.totalFound
    fetched = list.content.length
    if (offset > total || fetched !== Math.min(pageSize, total - offset))
      throw new Error("ATS returned an incomplete inventory page")
    for (const item of list.content) {
      if (item.company.identifier.toLowerCase() !== source.board)
        throw new Error("SmartRecruiters board identity mismatch")
      if (
        scope &&
        !options.observePosting &&
        (catalogRoleTitleScope(
          item.name,
          options.jobCategories ?? ["software"]
        ) === "excluded" ||
          isEarlyCareerPosting(item.name))
      )
        continue
      const job = (
        options.observePosting ? smartSourceDetail : smartDetail
      ).parse(await read(`${base}/${item.id}`))
      if (
        job.id !== item.id ||
        job.company.identifier.toLowerCase() !== source.board
      )
        throw new Error("SmartRecruiters detail identity mismatch")
      if (!job.active || job.visibility !== "PUBLIC") continue
      employer ??= job.company.name
      employerUrl ??= `${base}/${item.id}`
      const country = explicitCountry(job.location?.country ?? undefined)
      if (scope && country && country !== explicitCountry(scope))
        throw new Error(
          "SmartRecruiters posting is outside the requested country"
        )
      const description = text(
        Object.entries(job.jobAd?.sections ?? {})
          .filter(([key]) => key !== "videos")
          .map(([, section]) => `${section.title ?? ""}\n${section.text ?? ""}`)
          .join("\n")
      )
      options.observePosting?.({
        title: job.name,
        company: job.company.name,
        url: `https://jobs.smartrecruiters.com/${source.board}/${job.id}`,
        description,
        locations: [
          [job.location?.city, job.location?.region, job.location?.country]
            .filter(Boolean)
            .join(", "),
        ].filter(Boolean),
        countries: country ? [country] : [],
        postedAt: catalogDate(job.releasedDate),
      })
      if (!country) {
        if (options.observePosting) continue
        throw new Error("SmartRecruiters posting country is unavailable")
      }
      if (scope && isEarlyCareerPosting(job.name)) continue
      if (
        !isCatalogRole(
          job.name,
          description,
          options.jobCategories ?? ["software"]
        )
      )
        continue
      const row = catalogPosting(
        {
          title: job.name,
          company: job.company.name,
          country,
          city: job.location?.city ?? null,
          url: `https://jobs.smartrecruiters.com/${source.board}/${job.id}`,
          description,
          source: source.id,
          posted_at: catalogDate(job.releasedDate),
          stated: {
            employment: job.typeOfEmployment?.label,
            experience: job.experienceLevel?.label,
          },
          work_mode: job.location?.hybrid
            ? "hybrid"
            : job.location?.remote
              ? "remote"
              : "unknown",
        },
        undefined,
        options.jobCategories
      )
      if (!row) {
        if (options.observePosting) continue
        throw new Error("SmartRecruiters posting is incomplete")
      }
      jobs.push(row)
    }
  } else if (source.kind === "workday") {
    const { origin, tenant, site } = workdaySite(source.board!)
    const base = `${origin}/wday/cxs/${tenant}/${site}`
    listingUrl = `${base}/jobs`
    const list = workdayList.parse(
      await read(listingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appliedFacets: {},
          limit: ATS_PAGE_SIZE,
          offset,
          searchText: "",
        }),
      })
    )
    // Live Workday CXS responses report the inventory total only at offset 0;
    // later pages can contain jobs with total=0. Re-read that bounded first-page
    // count instead of treating a continuation as an empty/complete inventory.
    total = list.total
    if (offset > 0 && total === 0) {
      const first = workdayList.parse(
        await read(listingUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appliedFacets: {},
            limit: ATS_PAGE_SIZE,
            offset: 0,
            searchText: "",
          }),
        })
      )
      total = first.total
    }
    // Workday can silently cap a large board. Never label a capped slice complete
    // or expire missing jobs. Facet-partitioned full scans need a persisted plan.
    if (total >= 2000)
      throw new IncompleteAtsInventoryError(
        "Workday result cap reached; complete collection requires a partitioned scan"
      )
    fetched = list.jobPostings.length
    if (offset > total || fetched !== Math.min(ATS_PAGE_SIZE, total - offset))
      throw new Error("ATS returned an incomplete inventory page")
    for (const item of list.jobPostings) {
      // Workday can omit the location slug: /job/<title-and-requisition>.
      // The fixed provider origin and detail's site identity still fence reads.
      if (
        !/^\/job\/(?:[A-Za-z0-9_/%.,()+-]+\/)?[A-Za-z0-9_%.,()+-]+$/.test(
          item.externalPath
        ) ||
        /%2f|%5c|%2e|\.\./i.test(item.externalPath)
      )
        throw new Error("Invalid Workday detail path")
      // An excluded summary title cannot become an eligible role from its
      // description. Count it in the complete inventory without hydrating
      // irrelevant details, which can contain missing employer metadata.
      if (
        !options.observePosting &&
        catalogRoleTitleScope(
          item.title,
          options.jobCategories ?? ["software"]
        ) === "excluded"
      )
        continue
      const detail = (
        options.observePosting ? workdaySourceDetail : workdayDetail
      ).parse(await read(`${base}${item.externalPath}`))
      const job = detail.jobPostingInfo
      if (
        job.jobPostingSiteId !== site ||
        boardFromUrl(job.externalUrl)?.id !== source.id ||
        !new URL(job.externalUrl).pathname.endsWith(item.externalPath)
      )
        throw new Error("Workday site identity mismatch")
      if (!job.posted || !job.canApply) continue
      employer ??= detail.hiringOrganization?.name ?? null
      employerUrl ??= `${base}${item.externalPath}`
      const primary = explicitCountry(
        job.jobRequisitionLocation?.country?.alpha2Code ??
          job.jobRequisitionLocation?.country?.descriptor ??
          job.country?.descriptor ??
          undefined
      )
      const locations = [
        job.location,
        ...(job.additionalLocations ?? []),
      ].filter((location): location is string => Boolean(location))
      const description = text(job.jobDescription ?? "")
      options.observePosting?.({
        title: job.title,
        company: detail.hiringOrganization?.name ?? source.company,
        url: `${origin}/${site}${item.externalPath}`,
        description,
        locations,
        countries: primary ? [primary] : [],
        postedAt: catalogDate(job.startDate),
      })
      if (
        !isCatalogRole(
          job.title,
          description,
          options.jobCategories ?? ["software"]
        )
      )
        continue
      if (!primary) {
        if (options.observePosting) continue
        throw new Error("Workday posting country is unavailable")
      }
      for (const [index, location] of [...new Set(locations)].entries()) {
        const parts = location.split(",").map((part) => part.trim())
        const country =
          index === 0
            ? primary
            : parts
                .map((part) =>
                  part.length > 2 ? explicitCountry(part) : undefined
                )
                .find(Boolean)
        if (!country) continue
        const city =
          parts
            .filter((part) => explicitCountry(part) !== country)
            .join(", ") || null
        const row = catalogPosting(
          {
            title: job.title,
            company: detail.hiringOrganization?.name ?? source.company,
            country,
            city,
            url: `${origin}/${site}${item.externalPath}`,
            description,
            source: source.id,
            posted_at: catalogDate(job.startDate),
            stated: { employment: job.timeType },
            work_mode: "unknown",
          },
          location,
          options.jobCategories
        )
        if (!row) {
          if (options.observePosting) continue
          throw new Error("Workday posting is incomplete")
        }
        jobs.push(row)
      }
    }
  } else throw new Error("Unsupported ATS reader")
  if (offset > total || fetched !== Math.min(pageSize, total - offset))
    throw new Error("ATS returned an incomplete inventory page")
  return {
    employer,
    employerUrl,
    listingUrl,
    jobs,
    fetched,
    rejected: Math.max(0, fetched - new Set(jobs.map((job) => job.url)).size),
    requests,
    nextPage: offset + fetched < total ? page + 1 : null,
  }
}
