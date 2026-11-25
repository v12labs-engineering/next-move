import { load } from "cheerio"
import { z } from "zod"
import {
  catalogDate,
  catalogPosting,
  catalogText,
  explicitCountry,
  plain,
  type CatalogPosting,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { publicBoardUrl } from "../source-identity"

const job = z.object({
  id: z.string().regex(/^\d{1,30}$/),
  Posting_Title: z.string().nullish(),
  Job_Opening_Name: z.string().nullish(),
  Job_Description: z.string().nullish(),
  City: z.string().nullish(),
  Country: z.string().nullish(),
  Remote_Job: z.boolean().nullish(),
  Publish: z.boolean().nullish(),
  Date_Opened: z.string().nullish(),
})

const slug = (title: string) =>
  title
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "job"

/** Zoho Recruit career site: the page embeds every published opening as JSON
 * in a hidden `#jobs` input, so one request covers the full inventory. */
export async function fetchZohoRecruitPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions = {}
) {
  if (source.kind !== "zohorecruit" || !source.board || page !== 1)
    throw new Error("Invalid Zoho Recruit source or page")
  let requests = 0
  const listingUrl = publicBoardUrl("zohorecruit", source.board)
  const $ = load(
    await catalogText(listingUrl, {
      ...options,
      onRequest() {
        requests++
        options.onRequest?.()
      },
    })
  )
  const raw = $("input#jobs").attr("value")
  if (raw === undefined) throw new Error("Zoho Recruit job inventory not found")
  const list = z.array(job).max(5000).parse(JSON.parse(raw))
  const employer =
    $('meta[property="og:site_name"]').attr("content")?.trim() || null
  const origin = new URL(listingUrl).origin
  const jobs: CatalogPosting[] = []
  let accepted = 0
  for (const item of list) {
    const title = item.Posting_Title ?? item.Job_Opening_Name ?? ""
    const country = explicitCountry(item.Country ?? undefined)
    const company = source.company || employer
    if (item.Publish === false) continue
    const url = `${origin}/jobs/Careers/${item.id}/${slug(title)}`
    const description = plain(item.Job_Description ?? "")
    const postedAt = catalogDate(item.Date_Opened ?? undefined)
    options.observePosting?.({
      title,
      company: company ?? "",
      url,
      description,
      locations: [[item.City, item.Country].filter(Boolean).join(", ")].filter(
        Boolean
      ),
      countries: country ? [country] : [],
      postedAt,
    })
    if (!country || !company) continue
    const posting = catalogPosting(
      {
        title,
        company,
        country,
        city: item.City?.trim() || null,
        url,
        description,
        work_mode: item.Remote_Job ? "remote" : "unknown",
        source: source.id,
        posted_at: postedAt,
      },
      undefined,
      options.jobCategories
    )
    if (posting) {
      jobs.push(posting)
      accepted++
    }
  }
  return {
    jobs,
    fetched: list.length,
    rejected: list.length - accepted,
    total: list.length,
    nextPage: null,
    requests,
    employer,
    employerUrl: listingUrl,
    listingUrl,
  }
}
