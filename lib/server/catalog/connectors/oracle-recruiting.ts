import { z } from "zod"
import { isEarlyCareerPosting } from "@/lib/jobs/software-roles"
import { catalogRoleTitleScope, isCatalogRole } from "@/lib/jobs/categories"
import {
  catalogDate,
  catalogJson,
  catalogPosting,
  CatalogSourceError,
  catalogText,
  explicitCountry,
  plain,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { robotsAllowed } from "../discovery/validate"

const tenants = {
  bny: { host: "eofe.fa.us2.oraclecloud.com", site: "BNY-Careers" },
  "ibs-software": {
    host: "fa-etbm-saasfaprod1.fa.ocs.oraclecloud.com",
    site: "CX_1",
  },
  "oracle-india": {
    host: "eeho.fa.us2.oraclecloud.com",
    site: "CX_45001",
  },
  "jpmorgan-chase": {
    host: "jpmc.fa.oraclecloud.com",
    site: "CX_1001",
  },
  honeywell: {
    host: "ibqbjb.fa.ocs.oraclecloud.com",
    site: "Honeywell",
  },
  nokia: {
    host: "fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com",
    site: "CX_1",
  },
  emerson: { host: "hdjq.fa.us2.oraclecloud.com", site: "CX_1" },
} as const
const apiPath = "/hcmRestApi/resources/latest/"
const listPath = `${apiPath}recruitingCEJobRequisitions`
const detailPath = `${apiPath}recruitingCEJobRequisitionDetails`
const rawConfig = z
  .object({
    scope: z.enum(["global", "india"]),
    detail: z.literal("summary"),
  })
  .strict()
const rawSummary = z.object({
  Id: z.string().regex(/^\d+$/),
  Title: z.string().trim().min(1),
  PostedDate: z.string().nullish(),
  PostingEndDate: z.string().nullish(),
  PrimaryLocation: z.string().nullish(),
  PrimaryLocationCountry: z.string().nullish(),
  ShortDescriptionStr: z.string().nullish(),
  ExternalResponsibilitiesStr: z.string().nullish(),
  ExternalQualificationsStr: z.string().nullish(),
})
const summary = rawSummary.extend({
  PostedDate: z.iso.date(),
})
const detail = z.object({
  items: z
    .array(
      summary.omit({ PostedDate: true }).extend({
        ExternalPostedStartDate: z.string().nullish(),
        ExternalPostedEndDate: z.string().nullish(),
        ExternalDescriptionStr: z.string().nullish(),
        ExternalQualificationsStr: z.string().nullish(),
        ExternalResponsibilitiesStr: z.string().nullish(),
        WorkplaceType: z.string().nullish(),
      })
    )
    .max(1),
})

function cityName(location: string | null | undefined) {
  const first = location?.split(",")[0].trim()
  return first && !/^(?:india|[A-Z]{2})$/i.test(first) ? first : null
}

export async function fetchOracleRecruitingPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions
) {
  const board = source.board
  if (
    !board ||
    !Object.hasOwn(tenants, board) ||
    source.id !== `oracle:${board}` ||
    source.kind !== "oracle"
  )
    throw new Error("Unsupported Oracle Recruiting source")
  const tenant = tenants[board as keyof typeof tenants]
  const config =
    source.config === undefined ||
    source.config === null ||
    (typeof source.config === "object" &&
      Object.keys(source.config).length === 0)
      ? null
      : rawConfig.parse(source.config)
  if (
    (config && !options.observePosting) ||
    (board === "oracle-india" && config && config.scope !== "india") ||
    (config?.scope === "global" && board !== "ibs-software")
  )
    throw new Error("Unsupported Oracle Recruiting scope")
  const indiaOnly = !config || config.scope === "india"
  const pageSize = config ? 20 : 10
  const origin = `https://${tenant.host}`
  const publicOrigin =
    board === "oracle-india"
      ? "https://careers.oracle.com"
      : board === "nokia"
        ? "https://jobs.nokia.com"
        : origin
  const jobRoot =
    board === "oracle-india"
      ? "/en/sites/jobsearch"
      : board === "nokia"
        ? "/en/sites/CX_1"
        : `/hcmUI/CandidateExperience/en/sites/${tenant.site}`
  const started = Date.parse(
    options.snapshotStartedAt ?? new Date().toISOString()
  )
  const cutoff = started - 30 * 86_400_000
  // Pin the supported catalog window on every page. Oracle's summary dates
  // have day precision, so preserve the existing one-day detail-check grace.
  const postingStartDate =
    [
      "oracle-india",
      "jpmorgan-chase",
      "honeywell",
      "nokia",
      "emerson",
    ].includes(board) && !config
      ? new Date(cutoff - 86_400_000).toISOString()
      : null
  let requests = 0
  const requestOptions = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  let rules = ""
  try {
    rules = await catalogText(`${origin}/robots.txt`, requestOptions)
  } catch (error) {
    // Match discovery's RFC 9309 policy: a 4xx robots resource is
    // unavailable, except throttling. This never relaxes job API errors.
    const status =
      error instanceof CatalogSourceError
        ? Number(error.message.match(/^Source HTTP (\d{3})$/)?.[1])
        : NaN
    if (!(status >= 400 && status < 500 && status !== 429)) throw error
  }
  const read = (path: string, finder: string) => {
    const url = new URL(path, origin)
    url.searchParams.set("finder", finder)
    url.searchParams.set("onlyData", "true")
    if (path === listPath) url.searchParams.set("expand", "requisitionList")
    if (!robotsAllowed(rules, url.pathname + url.search))
      throw new Error("Oracle Recruiting path excluded by robots rules")
    return catalogJson(url.href, requestOptions)
  }
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid Oracle Recruiting page")
  const {
    items: [snapshot],
  } = z
    .object({
      items: z.tuple([
        z.object({
          Location: indiaOnly ? z.literal("India") : z.string().nullish(),
          SiteNumber: z.string(),
          Offset: z.number().int().nonnegative(),
          Limit: z.literal(pageSize),
          TotalJobsCount: z.number().int().nonnegative(),
          PostingStartDate: z.string().nullish(),
          requisitionList: z.array(config ? rawSummary : summary).max(pageSize),
        }),
      ]),
    })
    .parse(
      await read(
        listPath,
        `findReqs;siteNumber=${tenant.site},limit=${pageSize},offset=${offset},sortBy=POSTING_DATES_DESC` +
          (indiaOnly ? ",location=India" : "") +
          (postingStartDate ? `,postingStartDate=${postingStartDate}` : "")
      )
    )
  const fetched = snapshot.requisitionList.length
  if (
    snapshot.SiteNumber !== tenant.site ||
    (postingStartDate !== null &&
      snapshot.PostingStartDate !== postingStartDate) ||
    snapshot.Offset !== offset ||
    offset > snapshot.TotalJobsCount ||
    fetched !== Math.min(pageSize, snapshot.TotalJobsCount - offset) ||
    new Set(snapshot.requisitionList.map((job) => job.Id)).size !== fetched
  )
    throw new Error(
      "Oracle Recruiting returned an incomplete or mismatched inventory page"
    )

  const jobs = []
  for (const item of snapshot.requisitionList) {
    if (config) {
      const country = explicitCountry(item.PrimaryLocationCountry ?? undefined)
      const ends = item.PostingEndDate ?? ""
      const expiry = Date.parse(
        /^\d{4}-\d{2}-\d{2}$/.test(ends) ? `${ends}T23:59:59Z` : ends
      )
      // Closed postings are not active inventory, regardless of occupation.
      if (Number.isFinite(expiry) && expiry < started) continue
      options.observePosting?.({
        title: item.Title,
        company: source.company,
        url: `${publicOrigin}${jobRoot}/job/${item.Id}`,
        locations: item.PrimaryLocation ? [item.PrimaryLocation] : [],
        countries: country ? [country] : [],
        description: plain(
          [
            item.ShortDescriptionStr,
            item.ExternalResponsibilitiesStr,
            item.ExternalQualificationsStr,
          ]
            .filter(Boolean)
            .join("<br>")
        ),
        postedAt: catalogDate(item.PostedDate ?? undefined),
      })
      continue
    }
    const excludedFromCatalog =
      item.PrimaryLocationCountry !== "IN" ||
      Date.parse(item.PostedDate!) < cutoff - 86_400_000 ||
      isEarlyCareerPosting(item.Title) ||
      catalogRoleTitleScope(
        item.Title,
        options.jobCategories ?? ["software"]
      ) === "excluded"
    if (excludedFromCatalog && !options.observePosting) continue
    const {
      items: [job],
    } = detail.parse(await read(detailPath, `ById;Id=${item.Id}`))
    if (!job) continue
    if (job.Id !== item.Id || job.PrimaryLocationCountry !== "IN")
      throw new Error("Oracle Recruiting detail identity mismatch")
    const endsAt = Date.parse(job.ExternalPostedEndDate ?? "")
    const postedAt = catalogDate(
      job.ExternalPostedStartDate ?? item.PostedDate ?? undefined
    )
    const description = plain(
      [
        job.ExternalDescriptionStr,
        job.ExternalResponsibilitiesStr &&
          `<h3>Responsibilities</h3>${job.ExternalResponsibilitiesStr}`,
        job.ExternalQualificationsStr &&
          `<h3>Qualifications</h3>${job.ExternalQualificationsStr}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    const url = `${publicOrigin}${jobRoot}/job/${job.Id}`
    options.observePosting?.({
      title: job.Title,
      company: source.company,
      url,
      description,
      locations: [
        ...new Set([item.PrimaryLocation, job.PrimaryLocation]),
      ].filter((location): location is string => Boolean(location)),
      countries: ["India"],
      postedAt,
    })
    if (
      excludedFromCatalog ||
      (Number.isFinite(endsAt) && endsAt < started) ||
      isEarlyCareerPosting(job.Title) ||
      !postedAt ||
      Date.parse(postedAt) < cutoff ||
      Date.parse(postedAt) > started
    )
      continue
    const mode = job.WorkplaceType?.toLowerCase()
    const row = catalogPosting(
      {
        title: job.Title,
        company: source.company,
        country: "India",
        city: cityName(item.PrimaryLocation) ?? cityName(job.PrimaryLocation),
        url,
        description,
        source: source.id,
        posted_at: postedAt,
        work_mode:
          mode === "hybrid" || mode === "remote" || mode === "onsite"
            ? mode
            : "unknown",
      },
      undefined,
      options.jobCategories
    )
    if (row) jobs.push(row)
    else if (
      isCatalogRole(
        job.Title,
        description,
        options.jobCategories ?? ["software"]
      )
    )
      throw new Error("Oracle Recruiting posting is incomplete")
  }
  return {
    jobs,
    requests,
    fetched,
    rejected: fetched - jobs.length,
    nextPage: offset + fetched < snapshot.TotalJobsCount ? page + 1 : null,
  }
}
