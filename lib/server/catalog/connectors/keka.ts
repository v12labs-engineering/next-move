import { load } from "cheerio"
import { z } from "zod"
import {
  catalogDate,
  catalogJson,
  catalogPosting,
  catalogText,
  explicitCountry,
  plain,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { publicBoardUrl } from "../source-identity"

const location = z.object({
  city: z.string().nullish(),
  countryCode: z.string().nullish(),
  countryName: z.string().nullish(),
})
const job = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  description: z.string().nullish(),
  jobLocations: z.array(location).nullish(),
  experience: z.string().nullish(),
  publishedOn: z.string().nullish(),
})
const portal = z.object({
  name: z.string().trim().min(1).max(300),
  careersPortalDomain: z.string().nullish(),
})

/** Keka custom portals expose a GUID for the embed API. Default portals use
 * the same-origin active-jobs API observed in Keka's public frontend. Both
 * return a complete array with descriptions; the browser filters it locally. */
export async function fetchKekaPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  if (source.kind !== "keka" || !source.board || page !== 1)
    throw new Error("Invalid Keka source or page")
  let requests = 0
  const request = {
    ...options,
    onRequest() {
      requests++
      options.onRequest?.()
    },
  }
  const careers = `${publicBoardUrl("keka", source.board)}/`
  const html = await catalogText(careers, request)
  const guid = html.match(
    /\/ats\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/careerportal\//
  )?.[1]
  if (!guid) {
    const $ = load(html)
    const defaultPortal =
      $("base#baseHref").attr("href") === "/careers/" &&
      $('meta[name="portalName"]').length === 1 &&
      !($('meta[name="portalName"]').attr("content") ?? "").trim() &&
      $("#kh-jobs-section").length === 1 &&
      $("script[src]")
        .toArray()
        .some((element) =>
          /^https:\/\/cdn\.keka\.com\/careers\/v\/\d+\/scripts\/app\/app\.min\.js$/.test(
            $(element).attr("src") ?? ""
          )
        )
    if (!defaultPortal)
      throw new Error("Keka careers portal identifier not found")
  }
  const employerUrl = `${careers}api/organization/default/careerportalinfo`
  const listingUrl = guid
    ? `${careers}api/embedjobs/default/active/${guid}`
    : `${careers}api/jobs/default/active`
  const identity = portal.parse(await catalogJson(employerUrl, request))
  if (
    !guid &&
    identity.careersPortalDomain?.toLowerCase() !== new URL(careers).hostname
  )
    throw new Error("Keka default portal employer domain does not match source")
  const employer = identity.name
  const list = z
    .array(job)
    .max(5000)
    .parse(await catalogJson(listingUrl, request))
  if (new Set(list.map((item) => item.id)).size !== list.length)
    throw new Error("Keka active inventory contains duplicate job identifiers")
  const jobs: CatalogPosting[] = []
  let accepted = 0
  for (const item of list) {
    const description = plain(item.description ?? "")
    const countries = new Map<string, Set<string>>()
    for (const loc of item.jobLocations ?? []) {
      const country = explicitCountry(
        loc.countryCode ?? loc.countryName ?? undefined
      )
      if (!country) continue
      const cities = countries.get(country) ?? new Set<string>()
      if (loc.city?.trim()) cities.add(loc.city.trim())
      countries.set(country, cities)
    }
    const company = source.company || employer
    const url = `${careers}jobdetails/${encodeURIComponent(item.id)}`
    const postedAt = catalogDate(item.publishedOn ?? undefined)
    options.observePosting?.({
      title: item.title,
      company,
      url,
      description,
      locations: (item.jobLocations ?? [])
        .map((loc) =>
          [loc.city, loc.countryName || loc.countryCode]
            .filter(Boolean)
            .join(", ")
        )
        .filter(Boolean),
      countries: [...countries.keys()],
      postedAt,
    })
    let kept = false
    for (const [country, cities] of countries) {
      const posting = catalogPosting(
        {
          title: item.title,
          company,
          country,
          city: [...cities].join("; ") || null,
          url,
          description,
          work_mode: "unknown",
          stated: { experience: item.experience },
          source: source.id,
          posted_at: postedAt,
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
    fetched: list.length,
    rejected: list.length - accepted,
    total: list.length,
    nextPage: null,
    requests,
    employer,
    employerUrl,
    listingUrl,
  }
}
