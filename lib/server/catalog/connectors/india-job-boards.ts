import { setTimeout as delay } from "node:timers/promises"
import { load } from "cheerio"
import { z } from "zod"
import { indiaJobBoards, isIndiaJobBoard } from "@/lib/jobs/india-job-boards"
import { inspectRegistryJobPage, locationCountries } from "./job-page-facts"
import {
  CatalogSourceError,
  catalogJson,
  catalogPosting,
  catalogText,
  plain,
} from "../feeds"
import type { CatalogSource, FetchOptions, RawSourcePosting } from "../feeds"
import { robotsAllowed } from "../discovery/validate"
import type { CatalogPage } from "./index"
import {
  boardIndexLead,
  selectBoardDetails,
  type BoardIndexLead,
} from "./board-index"
import {
  parsePublicFeed,
  type PublicFeedKind,
  type PublicFeedPosting,
} from "./public-feeds"
import {
  readFourDayWeek,
  readHackerNewsHiring,
  readSitemapBoard,
  sitemapBoards,
  type BoardPosting,
  type SitemapBoard,
} from "./india-sitemap-boards"

const remoteRoleBoards = {
  "remote-java-jobs": "java",
  "remote-frontend-jobs": "frontend",
  "remote-backend-jobs": "backend",
} as const

type RemoteRoleBoard = keyof typeof remoteRoleBoards
const remoteRolePriority = Object.values(remoteRoleBoards)
const remoteRolePageSize = 50
const remoteRolePageLimit = 5
const remoteRoleJob = z.object({
  id: z.string().regex(/^[a-z0-9]{24,32}$/),
  title: z.string().min(1),
  author: z.string().min(1),
  isoDate: z.string(),
  location: z.string().nullish(),
  geoLabel: z.string().nullish(),
  sites: z.string(),
  contentSnippet: z.string().nullish(),
})

const feedSources = {
  himalayas: {
    kind: "himalayas",
    url: "https://himalayas.app/jobs/api/search?country=IN&sort=recent",
  },
  jobicy: { kind: "jobicy", url: "https://jobicy.com/api/jobs?count=100" },
  "remote-ok": { kind: "remote-ok", url: "https://remoteok.com/api" },
  "we-work-remotely": {
    kind: "xml",
    url: "https://weworkremotely.com/remote-jobs.rss",
  },
  hasjob: { kind: "xml", url: "https://hasjob.co/feed" },
  "foss-united": {
    kind: "xml",
    url: "https://fossunited.org/jobs/rss.xml",
  },
} satisfies Record<string, { kind: PublicFeedKind; url: string }>

const htmlSources = {
  shipmates: {
    detail: /^\/jobs\/[a-z0-9]+-[a-z0-9-]+\/?$/i,
    maxIndexPages: 6,
    cards: "a.ui-row[href]",
    renderIndex: false,
  },
  e2ehiring: {
    detail: /^\/jobs\/detail\/[a-z0-9._-]+-\d+\/?$/i,
    maxIndexPages: 1,
    cards: "article a[class*='cardSelect'][href]",
    renderIndex: false,
  },
  cyberpark: {
    detail: /^\/job\/[a-z0-9-]+\/$/i,
    maxIndexPages: 1,
    cards: "li.job_listing > a[href]",
    renderIndex: true,
  },
} as const

const firecrawlResponse = z.object({
  success: z.literal(true),
  data: z.object({
    rawHtml: z.string().min(1),
    links: z.array(z.string()).optional(),
    metadata: z.object({ sourceURL: z.string(), statusCode: z.number() }),
  }),
})

const technoparkDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const technoparkListing = z.object({
  id: z.number().int().positive(),
  job_title: z.string().min(1),
  posted_date: technoparkDate,
  closing_date: technoparkDate,
  updated_at: z.string().nullish(),
  company: z.object({ company: z.string().nullish() }).nullish(),
})
const technoparkInventory = z.object({
  current_page: z.number().int().positive(),
  last_page: z.number().int().positive(),
  per_page: z.literal(20),
  data: z.array(technoparkListing).max(20),
})
const technoparkDetail = z.object({
  component: z.literal("JobListing/JobDetailPage"),
  props: z.object({
    jobListing: technoparkListing.extend({
      status: z.string(),
      job_description: z.string(),
      preferred_skills: z.string().nullish(),
      company: z.object({ company: z.string(), address: z.string().nullish() }),
    }),
  }),
})

const egigSearch = z.object({
  jobs: z
    .array(
      z.object({
        title: z.string(),
        company: z.string(),
        listed_by: z.string(),
        location: z.string(),
        posted: z.string(),
        url: z.url(),
        remote: z.boolean(),
        pay: z.string().nullish(),
        type: z.string().nullish(),
      })
    )
    .max(20),
})

const dayMs = 86_400_000
const detailsPerPage = 10
const chunksPerIndex = 6
const indiaCity =
  /(?:^|[,;])\s*(?:ahmedabad|bangalore|bengaluru|bhubanes[hw]ar|chandigarh|chennai|cochin|coimbatore|delhi|ghaziabad|gurga?on|gurugram|hyderabad|indore|jaipur|kochi|kolkata|lucknow|mumbai|mysore|nagpur|noida|pune|surat|thiruvananthapuram|trivandrum|vadodara|visakhapatnam)(?=\s*[,;]|\s*$)/i
const worldwide =
  /^(?:remote\s*[-,:]\s*)?(?:anywhere(?: in the world)?|worldwide|global)(?:\s+remote)?$/i
const foreignRegion =
  "(?:united states|united kingdom|u\\.?s\\.?a?\\.?|u\\.?k\\.?|canada|europe|australia|philippines|latam)"
const foreignTitle = new RegExp(
  `\\b${foreignRegion}[ -]+(?:based|only)\\b|\\b(?:only in|remote in|based in) ${foreignRegion}(?![a-z])`,
  "i"
)
const foreignRequirement = new RegExp(
  `\\b(?:only candidates|must be based|must reside|must live|applicants? (?:located|based))\\b[^\\n!?]{0,65}\\b${foreignRegion}(?![a-z])[^\\n!?]{0,30}`,
  "gi"
)

function excludedGeography(job: RawSourcePosting) {
  if (foreignTitle.test(job.title) && !/\bindia\b/i.test(job.title)) return true
  return [...job.description.matchAll(foreignRequirement)].some(
    ([requirement]) => !/\bindia\b/i.test(requirement)
  )
}

function indianLocation(job: RawSourcePosting & Partial<PublicFeedPosting>) {
  const places = job.locations.join("; ")
  const countries = job.locationRestrictions ?? []
  const zones = job.timezoneRestrictions ?? []
  if (excludedGeography(job)) return null
  if (countries.length && !countries.some((c) => /^(in|ind|india)$/i.test(c)))
    return null
  if (
    zones.length &&
    !zones.some((z) => /^(?:utc\s*)?\+?0?5(?::30|\.50*)$/i.test(z))
  )
    return null
  if (job.countries.includes("India") || countries.length || zones.length)
    return {
      city: /^remote|^worldwide$/i.test(places) ? null : places || null,
      remote:
        countries.length > 0 || zones.length > 0 || /\bremote\b/i.test(places),
    }
  if (job.countries.length) return null
  if (locationCountries(places).includes("India") || indiaCity.test(places))
    return { city: places, remote: /\bremote\b/i.test(places) }
  if (worldwide.test(places)) return { city: null, remote: true }
  return null
}

async function readRemoteRoleBoard(
  board: RemoteRoleBoard,
  page: number,
  options: FetchOptions
) {
  if (page < 1 || page > remoteRolePageLimit)
    throw new Error("Invalid remote role board page")
  const role = remoteRoleBoards[board]
  const url = new URL("/api/jobs", indiaJobBoards["remote-backend-jobs"].url)
  url.searchParams.set("board", role)
  url.searchParams.set("regions", "asia")
  url.searchParams.set("limit", String(remoteRolePageSize))
  url.searchParams.set("offset", String((page - 1) * remoteRolePageSize))
  const batch = z
    .array(z.unknown())
    .max(remoteRolePageSize)
    .parse(await catalogJson(url.href, options))
  const postings: BoardPosting[] = []
  let recognized = 0
  for (const item of batch) {
    const parsed = remoteRoleJob.safeParse(item)
    if (!parsed.success) continue
    const job = parsed.data
    const sites = job.sites.split(",")
    if (!sites.includes(role)) continue
    recognized++
    // The API lists some posts on several boards. Use the same precedence on
    // all three so a publisher job ID is admitted once.
    if (remoteRolePriority.find((site) => sites.includes(site)) !== role)
      continue
    const location = job.location?.trim() || job.geoLabel?.trim() || ""
    if (!/\bIndia\b/i.test(job.geoLabel ?? "") && !/\bIndia\b/i.test(location))
      continue
    postings.push({
      title: job.title,
      company: job.author,
      url: new URL(`/${job.id}`, indiaJobBoards[board].url).href,
      description: plain(job.contentSnippet ?? ""),
      locations: [location],
      countries: ["India"],
      postedAt: job.isoDate,
      workMode: "remote",
    })
  }
  if (batch.length && !recognized)
    throw new Error("Remote role board returned no recognizable listings")
  return {
    postings,
    fetched: batch.length,
    nextPage:
      batch.length === remoteRolePageSize && page < remoteRolePageLimit
        ? page + 1
        : null,
  }
}

async function readFeed(
  source: (typeof feedSources)[keyof typeof feedSources],
  publisher: string,
  page: number,
  options: FetchOptions
) {
  let current = new URL(source.url)
  if (source.kind === "himalayas" && page > 1)
    current.searchParams.set("page", String(page))
  if (source.kind !== "himalayas" && page !== 1)
    throw new Error("Invalid job feed page")
  const postings: PublicFeedPosting[] = []
  let nextPage: number | null = null
  const maxPages = source.kind === "jobicy" ? 4 : 1
  const visited = new Set<string>()
  for (let index = 0; index < maxPages; index++) {
    if (visited.has(current.href)) throw new Error("Job feed repeated its page")
    visited.add(current.href)
    const body = await catalogText(current.href, options)
    const batch = parsePublicFeed(body, current, {
      kind: source.kind,
      publisher,
    })
    postings.push(...batch.postings)
    if (!batch.next) break
    if (source.kind === "himalayas") {
      if (
        page < 25 &&
        batch.postings.some(
          (job) =>
            Date.parse(job.postedAt ?? "") >=
            Date.parse(options.snapshotStartedAt ?? new Date().toISOString()) -
              30 * dayMs
        )
      )
        nextPage = page + 1
      break
    }
    current = batch.next
    if (index + 1 < maxPages)
      await delay(1000, undefined, { signal: options.signal })
  }
  return { postings, nextPage }
}

export function localScrapeEndpoint() {
  const url = URL.parse(process.env.CATALOG_FIRECRAWL_LOCAL_URL ?? "")
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Catalog scraping requires Firecrawl Local on loopback")
  return new URL("/v2/scrape", url)
}

// Each Firecrawl render starts a Chromium; cap how many run at once. Plain
// fetches get their own, wider lane so they never queue behind renders.
const lanes = {
  render: { active: 0, max: 2, queue: [] as (() => void)[] },
  plain: { active: 0, max: 6, queue: [] as (() => void)[] },
}

export async function scrapeHtml(
  endpoint: URL,
  target: URL,
  options: FetchOptions,
  withLinks: boolean,
  render = false
) {
  const lane = render ? lanes.render : lanes.plain
  // A finishing scrape hands its slot straight to the next waiter.
  if (lane.active >= lane.max)
    await new Promise<void>((resolve) => lane.queue.push(resolve))
  else lane.active++
  try {
    return await scrapeOnce(endpoint, target, options, withLinks, render)
  } finally {
    const next = lane.queue.shift()
    if (next) next()
    else lane.active--
  }
}

async function scrapeOnce(
  endpoint: URL,
  target: URL,
  options: FetchOptions,
  withLinks: boolean,
  render: boolean
) {
  const result = firecrawlResponse.parse(
    await catalogJson(
      endpoint.href,
      // Outlast Firecrawl's own timeout so it, not us, ends the render and
      // closes the tab; an abandoned request leaves its tab running.
      { ...options, retries: 0, timeoutMs: render ? 30_000 : 25_000 },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: target.href,
          formats: withLinks ? ["rawHtml", "links"] : ["rawHtml"],
          onlyMainContent: false,
          // waitFor makes Firecrawl Local use Chromium instead of guessing;
          // a cold browser start needs more than the plain-fetch budget.
          ...(render ? { waitFor: 1000, timeout: 15000 } : { timeout: 12000 }),
        }),
      }
    )
  ).data
  const actual = URL.parse(result.metadata.sourceURL)
  if (result.metadata.statusCode !== 200 || actual?.href !== target.href)
    throw new Error(
      "Firecrawl Local returned a different or unavailable job page"
    )
  return result
}

async function boardRobots(listing: URL, options: FetchOptions) {
  const rules = await catalogText(new URL("/robots.txt", listing).href, {
    ...options,
    retries: 0,
  }).catch((error: unknown) => {
    if (
      error instanceof CatalogSourceError &&
      error.message === "Source HTTP 404"
    )
      return ""
    throw error
  })
  if (/<(?:!doctype|html)\b/i.test(rules))
    throw new Error("Job board robots resource returned HTML")
  return (target: URL) => robotsAllowed(rules, target.pathname + target.search)
}

async function readTechnopark(page: number, options: FetchOptions) {
  const index = Math.ceil(page / 2)
  if (index > 25) throw new Error("Invalid Technopark inventory page")
  const listing = new URL(
    `/api/paginated-jobs?page=${index}&search=&type=`,
    indiaJobBoards.technopark.url
  )
  const allowed = await boardRobots(listing, options)
  if (!allowed(listing))
    throw new Error("Technopark listing is excluded by robots rules")
  const inventory = technoparkInventory.parse(
    await catalogJson(listing.href, options)
  )
  if (
    inventory.current_page !== index ||
    new Set(inventory.data.map((job) => job.id)).size !== inventory.data.length
  )
    throw new Error("Technopark returned an unexpected inventory page")
  const start = ((page - 1) % 2) * detailsPerPage
  const batch = inventory.data.slice(start, start + detailsPerPage)
  const nextPage =
    inventory.data.length > start + detailsPerPage
      ? page + 1
      : index < Math.min(25, inventory.last_page)
        ? index * 2 + 1
        : null
  const endpoint = localScrapeEndpoint()
  const postings: (RawSourcePosting & { expiresAt: string })[] = []
  const observed = Date.parse(
    options.snapshotStartedAt ?? new Date().toISOString()
  )
  const leads = batch.flatMap((entry) => {
    const target = new URL(`/job-details/${entry.id}`, listing)
    const expiresAt = `${entry.closing_date}T23:59:59+05:30`
    if (Date.parse(expiresAt) < observed || !allowed(target)) return []
    return [{ ...boardIndexLead(target, entry), target, entry, expiresAt }]
  })
  const selected = await selectBoardDetails(leads, options.boardIndexRefresh)
  for (const lead of selected) {
    const { target, entry, expiresAt } = lead
    const raw = (await scrapeHtml(endpoint, target, options, false)).rawHtml
    const data = load(raw)("[data-page]").first().attr("data-page")
    if (!data) throw new Error("Technopark did not return a public job detail")
    const job = technoparkDetail.parse(JSON.parse(data)).props.jobListing
    if (
      job.id !== entry.id ||
      job.posted_date !== entry.posted_date ||
      job.closing_date !== entry.closing_date
    )
      throw new Error("Technopark job details and index disagree")
    options.boardIndexRefresh?.checked(lead)
    if (job.status !== "APPROVED") continue
    const address = job.company.address ?? ""
    const location = address.match(
      /\b(?:thiruvananthapuram|trivandrum|kollam)\b/i
    )?.[0]
    postings.push({
      title: job.job_title,
      company: job.company.company,
      url: target.href,
      description: plain(
        [job.job_description, job.preferred_skills].filter(Boolean).join("\n")
      ),
      locations: location ? [location] : [],
      countries: ["India"],
      postedAt: `${job.posted_date}T00:00:00+05:30`,
      expiresAt,
    })
  }
  return { postings, nextPage, fetched: batch.length, checked: selected.length }
}

function boardCardEvidence(
  board: keyof typeof htmlSources,
  html: string,
  listing: URL
) {
  const $ = load(html)
  const evidence = new Map<string, string>()
  for (const element of $(htmlSources[board].cards)) {
    const anchor = $(element)
    const url = URL.parse(anchor.attr("href") ?? "", listing)
    if (
      !url ||
      url.origin !== listing.origin ||
      !htmlSources[board].detail.test(url.pathname)
    )
      continue
    url.hash = ""
    url.search = ""
    const card = anchor.clone()
    card.find("time").each((_, time) => {
      $(time).text($(time).attr("datetime") ?? "")
    })
    evidence.set(url.href, card.text().replace(/\s+/g, " ").trim())
  }
  return evidence
}

async function readBoardPages(
  board: keyof typeof htmlSources,
  page: number,
  options: FetchOptions
) {
  const config = htmlSources[board]
  const index = Math.floor((page - 1) / chunksPerIndex) + 1
  const start = ((page - 1) % chunksPerIndex) * detailsPerPage
  if (index > config.maxIndexPages) throw new Error("Invalid job board page")
  const listing = new URL(indiaJobBoards[board].url)
  if (index > 1) listing.searchParams.set("page", String(index))
  const endpoint = localScrapeEndpoint()
  const allowed = await boardRobots(listing, options)
  if (!allowed(listing))
    throw new Error("Job board listing is excluded by robots rules")
  const result = await scrapeHtml(
    endpoint,
    listing,
    options,
    true,
    config.renderIndex
  )
  const links = (result.links ?? []).flatMap((link) => {
    const url = URL.parse(link, listing)
    if (!url || url.origin !== listing.origin || url.username || url.password)
      return []
    url.hash = ""
    return [url]
  })
  const details = [
    ...new Set(
      links
        .filter(({ pathname }) => config.detail.test(pathname))
        .map((url) => {
          url.search = ""
          return url.href
        })
    ),
  ]
  if (details.length === 0)
    throw new Error("Job board index returned no recognizable detail links")
  if (details.length > chunksPerIndex * detailsPerPage)
    throw new Error("Job board page size changed")
  const nextIndex =
    index < config.maxIndexPages &&
    links.some(
      (url) =>
        url.pathname === listing.pathname &&
        url.searchParams.get("page") === String(index + 1) &&
        url.searchParams.get("country") === listing.searchParams.get("country")
    )
  const nextPage =
    details.length > start + detailsPerPage
      ? page + 1
      : nextIndex
        ? index * chunksPerIndex + 1
        : null
  const batch = details
    .slice(start, start + detailsPerPage)
    .map((url) => new URL(url))
    .filter(allowed)
  const evidence = options.boardIndexRefresh
    ? boardCardEvidence(board, result.rawHtml, listing)
    : new Map<string, string>()
  const leads = batch.map((target) => ({
    ...boardIndexLead(target, evidence.get(target.href) ?? target.href),
    target,
  }))
  return {
    ...(await readIndexedDetails(board, listing, endpoint, leads, options)),
    nextPage,
  }
}

async function readEgig(page: number, options: FetchOptions) {
  if (page !== 1) throw new Error("Invalid eGig search page")
  const endpoint = localScrapeEndpoint()
  const listing = new URL("/api/open/jobs?limit=20", indiaJobBoards.egig.url)
  const allowed = await boardRobots(listing, options)
  if (!allowed(listing))
    throw new Error("eGig public API is excluded by robots rules")
  const { jobs } = egigSearch.parse(await catalogJson(listing.href, options))
  const asOf = Date.parse(options.snapshotStartedAt ?? new Date().toISOString())
  const leads = jobs.flatMap((job) => {
    const target = new URL(job.url)
    const posted = Date.parse(job.posted)
    if (
      job.listed_by !== "eGig" ||
      !job.company.trim() ||
      /^not named$/i.test(job.company) ||
      !Number.isFinite(posted) ||
      posted > asOf ||
      posted < asOf - 30 * dayMs ||
      target.origin !== listing.origin ||
      target.username ||
      target.password ||
      !/^\/jobs\/[a-z0-9-]+-\d+$/.test(target.pathname) ||
      !allowed(target)
    )
      return []
    target.hash = ""
    return [{ ...boardIndexLead(target, job), target }]
  })
  return {
    ...(await readIndexedDetails("egig", listing, endpoint, leads, options)),
    nextPage: null,
  }
}

async function readIndexedDetails(
  board: keyof typeof htmlSources | "egig",
  listing: URL,
  endpoint: URL,
  leads: (BoardIndexLead & { target: URL })[],
  options: FetchOptions
) {
  const postings: RawSourcePosting[] = []
  const selected = await selectBoardDetails(leads, options.boardIndexRefresh)
  const bodies: (string | null)[] = []
  // Slow boards (~5s per page) cannot fit ten sequential details in a step.
  for (let i = 0; i < selected.length; i += 4)
    bodies.push(
      ...(await Promise.all(
        selected.slice(i, i + 4).map(async (lead) => {
          try {
            return (await scrapeHtml(endpoint, lead.target, options, false))
              .rawHtml
          } catch (error) {
            if (
              error instanceof CatalogSourceError &&
              ["Source HTTP 404", "Source HTTP 410"].includes(error.message)
            ) {
              options.boardIndexRefresh?.checked(lead)
              return null
            }
            throw error
          }
        })
      ))
    )
  for (const [i, lead] of selected.entries()) {
    const url = lead.target
    const body = bodies[i]
    if (body === null) continue
    const parsed = inspectRegistryJobPage(body, url, listing, "", true)
    if (parsed.gate)
      throw new Error("Job board detail requires interactive access")
    options.boardIndexRefresh?.checked(lead)
    for (const job of parsed.jobs) {
      const canonical = new URL(job.url)
      if (
        job.method !== "structured_data" ||
        canonical.hostname.replace(/^www\./, "") !==
          url.hostname.replace(/^www\./, "") ||
        canonical.pathname.replace(/\/$/, "") !==
          url.pathname.replace(/\/$/, "") ||
        (board === "egig" && /^hr(?:\s|$)/i.test(job.company))
      )
        continue
      const countries =
        board === "cyberpark" &&
        !job.countries.length &&
        /\b(?:kozhikode|calicut|kerala)\b/i.test(job.location ?? "")
          ? ["India"]
          : job.countries
      postings.push({
        title: job.title,
        company: job.company,
        url: url.href,
        description: job.description,
        locations: job.location ? [job.location] : [],
        countries,
        postedAt: job.postedAt,
      })
    }
  }
  return { postings, fetched: leads.length, checked: selected.length }
}

export async function fetchIndiaJobBoardPage(
  source: CatalogSource,
  page: number,
  options: FetchOptions
): Promise<CatalogPage> {
  const board = source.board
  if (
    !isIndiaJobBoard(board) ||
    source.id !== `indiaboard:${board}` ||
    source.company !== indiaJobBoards[board].name ||
    (source.config !== undefined && JSON.stringify(source.config) !== "{}")
  )
    throw new Error("Unknown India job board identity")
  let requests = 0
  const counted = {
    ...options,
    onRequest() {
      options.onRequest?.()
      requests++
    },
  }
  const result = Object.hasOwn(remoteRoleBoards, board)
    ? await readRemoteRoleBoard(board as RemoteRoleBoard, page, counted)
    : board in feedSources
      ? await readFeed(
          feedSources[board as keyof typeof feedSources],
          source.company,
          page,
          counted
        )
      : board in sitemapBoards
        ? await readSitemapBoard(
            board as SitemapBoard,
            page,
            counted,
            async (target) =>
              (
                await scrapeHtml(
                  localScrapeEndpoint(),
                  target,
                  counted,
                  false,
                  "render" in sitemapBoards[board as SitemapBoard]
                )
              ).rawHtml
          )
        : board === "4dayweek"
          ? await readFourDayWeek(page, counted)
          : board === "hn-hiring"
            ? await readHackerNewsHiring(page, counted)
            : board === "technopark"
              ? await readTechnopark(page, counted)
              : board === "egig"
                ? await readEgig(page, counted)
                : await readBoardPages(
                    board as keyof typeof htmlSources,
                    page,
                    counted
                  )
  const asOf = Date.parse(options.snapshotStartedAt ?? new Date().toISOString())
  const jobs = []
  for (const posting of result.postings) {
    options.observePosting?.(posting)
    const posted = Date.parse(posting.postedAt ?? "")
    const expiry = Date.parse(
      "expiresAt" in posting && typeof posting.expiresAt === "string"
        ? posting.expiresAt
        : ""
    )
    const place = indianLocation(posting)
    if (
      !place ||
      !Number.isFinite(posted) ||
      posted > asOf ||
      posted < asOf - 30 * dayMs ||
      expiry <= asOf ||
      posting.company.trim().toLowerCase() === source.company.toLowerCase()
    )
      continue
    const job = catalogPosting(
      {
        source: source.id,
        company: posting.company,
        title: posting.title,
        description: posting.description,
        url: posting.url,
        country: "India",
        city: place.city,
        work_mode:
          (posting as BoardPosting).workMode ??
          ((board in feedSources &&
            board !== "hasjob" &&
            board !== "foss-united") ||
          place.remote
            ? "remote"
            : "unknown"),
        posted_at: new Date(posted).toISOString(),
      },
      undefined,
      options.jobCategories
    )
    if (job) jobs.push(job)
  }
  const fetched = "fetched" in result ? result.fetched : result.postings.length
  return {
    jobs,
    fetched,
    rejected: Math.max(
      0,
      ("checked" in result ? result.checked : fetched) - jobs.length
    ),
    requests,
    nextPage: result.nextPage,
  }
}
