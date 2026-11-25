import { load } from "cheerio"
import { isEarlyCareerPosting } from "@/lib/jobs/software-roles"
import { catalogRoleTitleScope } from "@/lib/jobs/categories"
import {
  catalogPosting,
  catalogText,
  plain,
  type CatalogSource,
  type FetchOptions,
} from "../feeds"
import { robotsAllowed } from "../discovery/validate"

const origin = "https://infopark.in"
const listing = "/companies-job"
const day = 86_400_000

function postedDate(value: string) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value)
  if (!match) throw new Error("Invalid Infopark posting date")
  const iso = `${match[3]}-${match[2]}-${match[1]}`
  const date = new Date(`${iso}T00:00:00Z`)
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso
  )
    throw new Error("Invalid Infopark posting date")
  return date
}

const label = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")

export async function fetchInfoparkPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions
) {
  if (source.id !== "infopark:kerala" || source.board !== "kerala")
    throw new Error("Invalid Infopark source")
  const started = Date.parse(
    options.snapshotStartedAt ?? new Date().toISOString()
  )
  const localToday = Math.floor((started + 330 * 60_000) / day) * day
  const cutoff = localToday - 29 * day
  let requests = 0
  const onRequest = () => {
    requests++
    options.onRequest?.()
  }
  const rules = await catalogText(`${origin}/robots.txt`, {
    ...options,
    onRequest,
  })
  function allowed(url: URL) {
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !robotsAllowed(rules, url.pathname + url.search)
    )
      throw new Error("Infopark path is outside the public feed")
  }
  const transport = options.fetch ?? fetch
  const read = async (url: URL, detail = false) => {
    allowed(url)
    return catalogText(url.href, {
      ...options,
      onRequest,
      ...(detail
        ? {
            fetch: async (input, init) => {
              const response = await transport(input, {
                ...init,
                redirect: "manual",
              })
              if (![301, 302, 303, 307, 308].includes(response.status))
                return response
              await response.body?.cancel()
              const location = response.headers.get("location")
              if (!location)
                throw new Error("Infopark detail redirect has no destination")
              const target = new URL(location, url)
              allowed(target)
              if (!/^\/jobs\/[a-z0-9-]+\/[a-z0-9-]+\/?$/i.test(target.pathname))
                throw new Error("Invalid Infopark job detail destination")
              onRequest()
              return transport(target, { ...init, redirect: "error" })
            },
          }
        : {}),
    })
  }
  const url = new URL(listing, origin)
  if (page > 1) url.searchParams.set("page", String(page))
  const $ = load(await read(url))
  const table = $("table").filter(
    (_, table) =>
      $(table).find("th").first().text().trim() === "Date of Posting"
  )
  if (
    table.length !== 1 ||
    !table
      .find("th")
      .toArray()
      .some((el) => $(el).text().trim() === "Last Date to Apply")
  )
    throw new Error("Infopark listing table was not returned")
  const next = $(".pagination a[rel='next']").attr("href")
  const active = $(".pagination li.active").text().trim()
  if ((active && Number(active) !== page) || (page > 1 && !active))
    throw new Error("Infopark ignored pagination")
  if (next) {
    const nextUrl = new URL(next, url)
    if (
      nextUrl.origin !== origin ||
      nextUrl.pathname !== listing ||
      nextUrl.searchParams.get("page") !== String(page + 1)
    )
      throw new Error("Invalid Infopark continuation")
  }
  const records = table
    .find("tr")
    .filter((_, el) => $(el).children("td").length > 0)
    .toArray()
    .map((el) => {
      const cells = $(el).children("td")
      const href = cells.eq(4).find("a[href]").attr("href")
      const jobUrl = href && new URL(href, origin)
      if (
        !jobUrl ||
        jobUrl.origin !== origin ||
        jobUrl.username ||
        jobUrl.password ||
        !/^\/company-jobs\/details\/\d+\/\d+$/.test(jobUrl.pathname) ||
        jobUrl.search ||
        jobUrl.hash
      )
        throw new Error("Infopark row has no stable posting identity")
      const posted = postedDate(cells.eq(0).text().trim())
      const expiry = cells.eq(3).text().trim()
      const deadline = /^\d{1,2} [a-z]{3} \d{4}$/i.test(expiry)
        ? Date.parse(`${expiry} 23:59:59 GMT+0530`)
        : NaN
      const title = cells.eq(1).text().trim(),
        company = cells.eq(2).text().trim()
      if (!title || !company || !Number.isFinite(deadline))
        throw new Error("Incomplete Infopark row")
      return { jobUrl, title, company, posted, deadline }
    })
  if (
    !records.length ||
    records.length > 20 ||
    (next && records.length !== 20) ||
    new Set(records.map((row) => row.jobUrl.href)).size !== records.length ||
    records.some(
      (row, index) => index > 0 && row.posted > records[index - 1].posted
    )
  )
    throw new Error(
      "Infopark returned an incomplete or unordered inventory page"
    )

  const jobs = []
  for (const { jobUrl, title, company, posted, deadline } of records) {
    const excludedFromCatalog =
      posted.getTime() < cutoff ||
      posted.getTime() > localToday ||
      deadline < started ||
      isEarlyCareerPosting(title) ||
      catalogRoleTitleScope(title, options.jobCategories ?? ["software"]) ===
        "excluded"
    if (excludedFromCatalog && !options.observePosting) continue
    let html: string
    try {
      html = await read(jobUrl, true)
    } catch (error) {
      if (
        error instanceof Error &&
        /^Source HTTP (404|410)$/.test(error.message)
      )
        continue
      throw error
    }
    const detail = load(html)
    if (
      label(detail(".logo-con h4").first().text()) !== label(company) ||
      label(detail(".deatil-box h4").first().text()) !== label(title)
    )
      throw new Error("Infopark job detail identity mismatch")
    const description = plain(detail(".deatil-box").first().html() ?? "")
    const explicitCity =
      /\b(?:job |work )?location\s*:\s*(koch[iy]|cochin|thrissur|cherthala|ernakulam)\b/i.exec(
        description
      )?.[1]
    const city =
      explicitCity && /^(kochi|cochin)$/i.test(explicitCity)
        ? "Kochi"
        : explicitCity &&
          explicitCity[0].toUpperCase() + explicitCity.slice(1).toLowerCase()
    options.observePosting?.({
      title,
      company,
      url: jobUrl.href,
      description,
      locations: city ? [city] : [],
      countries: ["India"],
      postedAt: posted.toISOString(),
    })
    if (
      excludedFromCatalog ||
      /\b(?:our|a) sister company\b/i.test(description)
    )
      continue
    const row = catalogPosting(
      {
        title,
        company,
        country: "India",
        city: city || null,
        url: jobUrl.href,
        description,
        source: source.id,
        posted_at: posted.toISOString(),
        work_mode: "unknown",
      },
      undefined,
      options.jobCategories
    )
    if (row) jobs.push(row)
  }
  return {
    jobs,
    requests,
    fetched: records.length,
    rejected: records.length - jobs.length,
    nextPage:
      next &&
      (options.observePosting || records.at(-1)!.posted.getTime() >= cutoff)
        ? page + 1
        : null,
  }
}
