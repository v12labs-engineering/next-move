import { setTimeout as delay } from "node:timers/promises"
import { gunzipSync } from "node:zlib"
import { z } from "zod"
import { CatalogSourceError, catalogJson, catalogText, plain } from "../feeds"
import type { CatalogPosting, FetchOptions, RawSourcePosting } from "../feeds"
import { robotsAllowed } from "../discovery/validate"
import { inspectRegistryJobPage } from "./job-page-facts"
import { boardIndexLead, selectBoardDetails } from "./board-index"

type WorkMode = CatalogPosting["work_mode"]
export type BoardPosting = RawSourcePosting & {
  workMode?: WorkMode
  expiresAt?: string
}

// Indian aggregators that publish every live job in a sitemap and embed
// schema.org JobPosting data on the detail page.
export const sitemapBoards = {
  shine: {
    sitemap: "https://www.shine.com/sitemaps/all_jd_sitemap.xml",
    detail: /^\/jobs\/[a-z0-9-]+\/[a-z0-9-]+\/\d+\/?$/i,
  },
  freshersworld: {
    sitemap: "https://www.freshersworld.com/sitemap-activejobs-1.xml",
    detail: /^\/jobs\/[a-z0-9-]+-\d+\/?$/i,
  },
  // Cutshort rate-limits quick detail reads.
  cutshort: {
    sitemap: "https://cutshort.io/sitemap_jobs.xml",
    detail: /^\/job\/[A-Za-z0-9-]+\/?$/,
    pause: 3000,
  },
  apna: {
    sitemap:
      "https://apna.co/api/job-listing-sitemap/active-job-listings-1.xml",
    detail: /^\/job\/[a-z0-9-]+\/[a-z0-9-]+-\d+\/?$/i,
  },
  // Hirist and iimjobs build job pages client-side, so details need the
  // Firecrawl Local browser. Their sitemap lastmod is a regeneration stamp;
  // the trailing job id is the reliable recency order.
  hirist: {
    sitemap: "https://www.hirist.tech/new_sitemap-j-1.xml.gz",
    detail: /^\/j\/[a-z0-9-]+-\d+\/?$/i,
    order: "id",
    render: true,
  },
  iimjobs: {
    sitemap: "https://www.iimjobs.com/revamp_sitemap-j-1.xml.gz",
    detail: /^\/j\/[a-z0-9-]+-\d+\/?$/i,
    order: "id",
    render: true,
  },
  placementindia: {
    sitemap: "https://www.placementindia.com/sitemap/latest_job_details.xml",
    detail: /^\/job-detail\/[a-z0-9-]+-\d+\.htm$/i,
  },
  internshala: {
    sitemap: "https://internshala.com/sitemap-jobs.xml",
    detail: /^\/job\/detail\/[a-z0-9-]+\d+\/?$/i,
  },
  // Sitemap indexes: the first child files hold the most recently updated jobs.
  talent: {
    sitemap: "https://in.talent.com/sitemaps/view-en/sitemap.xml",
    detail: /^\/view\?id=\d+$/,
    index: 3,
  },
  unstop: {
    sitemap: "https://unstop.com/sitemap",
    detail: /^\/(?:jobs|internships)\/[a-z0-9-]+-\d+\/?$/i,
    index: 2,
    render: true,
  },
  remoterocketship: {
    sitemap: "https://www.remoterocketship.com/sitemap_job_openings_in.xml",
    detail: /^\/company\/[^/]+\/jobs\/[^/]+\/?$/,
  },
  // Global feeds: only remote roles whose slug opens them to India/Asia.
  "remoterocketship-global": {
    sitemap:
      "https://www.remoterocketship.com/sitemap_job_openings_worldwide.xml",
    extra: [
      "https://www.remoterocketship.com/sitemap_job_openings_rest_of_world.xml",
      "https://www.remoterocketship.com/sitemap_job_openings_rest_of_world_2.xml",
    ],
    detail:
      /^\/(?:[a-z]{2}\/)?company\/[^/]+\/jobs\/[^/]+-(?:worldwide|apac|asia|asia-pacific|india)-remote(?:-\d+)?\/?$/,
  },
  bebee: {
    sitemap: "https://bebee.com/sitemaps/jobs/in",
    detail: /^\/in\/jobs\/[a-z0-9-]+--[a-z0-9]+-\d+$/,
    order: "id",
  },
  indgovtjobs: {
    sitemap: "https://www.indgovtjobs.in/sitemap.xml?page=1",
    detail: /^\/20\d\d\/\d\d\/[a-z0-9-]+\.html$/,
  },
  herkey: {
    sitemap: "https://www.herkey.com/sitemaps/jobs-1.xml",
    detail: /^\/jobs\/[^/]+\/\d+\/?$/,
  },
  nodesk: {
    sitemap: "https://nodesk.co/sitemap-jobs.xml",
    detail: /^\/remote-jobs\/[^/]+\/$/,
  },
  findwork: {
    sitemap: "https://findwork.dev/sitemap-jobs_details.xml",
    detail: /^\/[A-Za-z0-9]{7}\/[^/]+$/,
  },
  jobspresso: {
    sitemap: "https://jobspresso.co/job_listing-sitemap1.xml",
    detail: /^\/job\/[^/]+\/$/,
  },
} as const satisfies Record<string, BoardConfig>
type BoardConfig = {
  sitemap: string
  detail: RegExp
  order?: "id"
  render?: true
  index?: number
  extra?: readonly string[]
  pause?: number
}
export type SitemapBoard = keyof typeof sitemapBoards

const dayMs = 86_400_000
const detailsPerPage = 10
// A rendered detail takes ~11s (up to 30s under load); keep a page inside the
// worker's 90s fetch window.
const renderedDetailsPerPage = 3
const maxSitemapPages = 30
const sitemapCache = new Map<
  string,
  { key: string; entries: { url: URL; lastmod: number }[] }
>()

function asOf(options: FetchOptions) {
  return Date.parse(options.snapshotStartedAt ?? new Date().toISOString())
}

async function robots(origin: URL, options: FetchOptions) {
  const rules = await catalogText(new URL("/robots.txt", origin).href, {
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

async function sitemapText(sitemap: string, options: FetchOptions) {
  if (!sitemap.endsWith(".gz")) return catalogText(sitemap, options)
  options.signal?.throwIfAborted()
  options.onRequest?.()
  const response = await (options.fetch ?? fetch)(sitemap, {
    redirect: "error",
    headers: { "User-Agent": "JobSearchCatalog/1.0" },
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(30_000),
    ]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new CatalogSourceError(
      `Source HTTP ${response.status}`,
      new Date(Date.now() + 15 * 60_000).toISOString()
    )
  }
  // Some hosts serve the .gz file with Content-Encoding: gzip, which fetch
  // has already decoded.
  const bytes = Buffer.from(await response.arrayBuffer())
  return (
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
      : bytes
  ).toString("utf8")
}

const jobId = (url: URL) => Number(url.pathname.match(/-(\d+)\/?$/)?.[1] ?? 0)

async function recentDetails(
  board: SitemapBoard,
  options: FetchOptions,
  allowed: (url: URL) => boolean
) {
  const config: BoardConfig = sitemapBoards[board]
  const { sitemap, detail } = config
  const key = options.snapshotStartedAt ?? ""
  const cached = sitemapCache.get(board)
  if (cached && key && cached.key === key) return cached.entries
  const origin = new URL(sitemap)
  const cutoff = asOf(options) - 30 * dayMs
  let xml = await sitemapText(sitemap, options)
  if (config.index) {
    const children = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/g)]
      .map(([, loc]) => URL.parse(loc.replaceAll("&amp;", "&")))
      .filter((child): child is URL => child?.origin === origin.origin)
      .slice(0, config.index)
    if (children.length === 0) throw new Error("Job board sitemap index was empty")
    const parts: string[] = []
    for (const child of children) parts.push(await sitemapText(child.href, options))
    xml = parts.join("")
  }
  for (const more of config.extra ?? []) xml += await sitemapText(more, options)
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].flatMap(
    ([, entry]) => {
      const loc = entry.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1]
      const url = loc ? URL.parse(loc.replaceAll("&amp;", "&")) : null
      if (
        !url ||
        url.origin !== origin.origin ||
        !detail.test(url.pathname + url.search) ||
        !allowed(url)
      )
        return []
      const lastmod = Date.parse(
        entry.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] ?? ""
      )
      if (Number.isFinite(lastmod) && lastmod < cutoff) return []
      url.hash = ""
      return [{ url, lastmod: Number.isFinite(lastmod) ? lastmod : 0 }]
    }
  )
  if (entries.length === 0 && /<urlset\b/.test(xml) === false)
    throw new Error("Job board sitemap was not a URL set")
  const recent = entries
    .sort((a, b) =>
      config.order === "id"
        ? jobId(b.url) - jobId(a.url)
        : b.lastmod - a.lastmod
    )
    .slice(0, maxSitemapPages * detailsPerPage)
  sitemapCache.set(board, { key, entries: recent })
  return recent
}

export async function readSitemapBoard(
  board: SitemapBoard,
  page: number,
  options: FetchOptions,
  readDetail: (target: URL) => Promise<string>
) {
  if (page < 1 || page > maxSitemapPages)
    throw new Error("Invalid job board page")
  const origin = new URL(sitemapBoards[board].sitemap)
  const allowed = await robots(origin, options)
  if (!allowed(origin))
    throw new Error("Job board sitemap is excluded by robots rules")
  const entries = await recentDetails(board, options, allowed)
  const perPage =
    "render" in sitemapBoards[board] ? renderedDetailsPerPage : detailsPerPage
  const start = (page - 1) * perPage
  const batch = entries
    .slice(start, start + perPage)
    .filter(({ url }) => allowed(url))
    .map(({ url, lastmod }) => ({
      ...boardIndexLead(url, [url.href, lastmod]),
      target: url,
    }))
  const selected = await selectBoardDetails(batch, options.boardIndexRefresh)
  const postings: BoardPosting[] = []
  for (const [index, lead] of selected.entries()) {
    const url = lead.target
    if (index > 0)
      await delay((sitemapBoards[board] as BoardConfig).pause ?? 300, undefined, {
        signal: options.signal,
      })
    let body: string
    try {
      body = await readDetail(url)
    } catch (error) {
      // A closed job redirects or disappears; Firecrawl reports that as a
      // different or unavailable page.
      if (
        (error instanceof CatalogSourceError &&
          /^Source HTTP (?:30\d|404|410)$/.test(error.message)) ||
        (error instanceof Error &&
          error.message ===
            "Firecrawl Local returned a different or unavailable job page")
      ) {
        options.boardIndexRefresh?.checked(lead)
        continue
      }
      throw error
    }
    const parsed = inspectRegistryJobPage(body, url, origin, "", true)
    if (parsed.gate)
      throw new Error("Job board detail requires interactive access")
    options.boardIndexRefresh?.checked(lead)
    const job = parsed.jobs.find((found) => {
      const canonical = new URL(found.url)
      return (
        found.method === "structured_data" &&
        canonical.origin === url.origin &&
        canonical.pathname.replace(/\/$/, "") ===
          url.pathname.replace(/\/$/, "")
      )
    })
    if (!job) continue
    const dayFirst = body.match(/"datePosted"\s*:\s*"(\d{2})-(\d{2})-(\d{4})"/)
    postings.push({
      title: plain(job.title),
      company: plain(job.company),
      url: url.href,
      description: job.description,
      locations: job.location ? [job.location] : [],
      countries: job.countries,
      postedAt:
        job.postedAt ??
        (dayFirst
          ? `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}T00:00:00+05:30`
          : null),
    })
  }
  const nextPage =
    entries.length > start + perPage && page < maxSitemapPages ? page + 1 : null
  return { postings, nextPage, fetched: batch.length, checked: selected.length }
}

const fourDayWeekJob = z.object({
  title: z.string().min(1),
  description: z.string(),
  url: z.url(),
  posted_at: z.string(),
  expires_at: z.string().nullish(),
  work_arrangement: z.string().nullish(),
  locations: z
    .array(
      z.object({
        city: z.string().nullish(),
        country: z.string().nullish(),
        work_arrangement: z.string().nullish(),
      })
    )
    .nullish(),
  company: z.object({ name: z.string().min(1) }),
})
const fourDayWeekPage = z.object({
  page: z.number().int().positive(),
  has_more: z.boolean(),
  data: z.array(z.unknown()).max(100),
})

const workModes: Record<string, WorkMode> = {
  remote: "remote",
  hybrid: "hybrid",
  onsite: "onsite",
}

// Official public API: https://4dayweek.io/developers (credit 4dayweek.io).
export async function readFourDayWeek(page: number, options: FetchOptions) {
  if (page < 1 || page > 20) throw new Error("Invalid 4 Day Week page")
  const url = new URL("https://4dayweek.io/api/v2/jobs")
  url.searchParams.set("country", "India")
  url.searchParams.set("limit", "100")
  url.searchParams.set("posted_after", "30")
  url.searchParams.set("page", String(page))
  const result = fourDayWeekPage.parse(await catalogJson(url.href, options))
  if (result.page !== page) throw new Error("4 Day Week returned another page")
  const cutoff = asOf(options) - 30 * dayMs
  const jobs = result.data.flatMap((item) => {
    const parsed = fourDayWeekJob.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  if (result.data.length > 0 && jobs.length === 0)
    throw new Error("4 Day Week returned no recognizable job records")
  const postings: BoardPosting[] = jobs.flatMap((job) => {
    const listing = new URL(job.url)
    if (
      listing.origin !== url.origin ||
      !/^\/job\/[a-z0-9-]+\/?$/i.test(listing.pathname)
    )
      return []
    const india = (job.locations ?? []).filter((place) =>
      /^india$/i.test(place.country ?? "")
    )
    if (india.length === 0) return []
    const mode = india[0]?.work_arrangement ?? job.work_arrangement ?? ""
    return [
      {
        title: job.title,
        company: job.company.name,
        url: job.url,
        description: plain(job.description),
        locations: india.flatMap((place) => (place.city ? [place.city] : [])),
        countries: ["India"],
        postedAt: job.posted_at,
        workMode: Object.hasOwn(workModes, mode) ? workModes[mode] : "unknown",
        ...(job.expires_at ? { expiresAt: job.expires_at } : {}),
      },
    ]
  })
  const nextPage =
    result.has_more &&
    page < 20 &&
    jobs.some((job) => Date.parse(job.posted_at) >= cutoff)
      ? page + 1
      : null
  return { postings, nextPage, fetched: result.data.length }
}

const hnHit = z.object({
  objectID: z.string().regex(/^\d+$/),
  created_at: z.string(),
  parent_id: z.number().nullish(),
  comment_text: z.string().nullish(),
})
const hnSearch = z.object({ hits: z.array(z.unknown()) })

// Monthly Hacker News "Who is hiring?" thread via the official Algolia API.
// Top-level comments open with "Company | Role | Location | ...".
export async function readHackerNewsHiring(page: number, options: FetchOptions) {
  if (page !== 1) throw new Error("Invalid Hacker News page")
  const stories = new URL("https://hn.algolia.com/api/v1/search_by_date")
  stories.searchParams.set("tags", "story,author_whoishiring")
  stories.searchParams.set("hitsPerPage", "10")
  const story = z
    .array(z.object({ objectID: z.string().regex(/^\d+$/), title: z.string() }))
    .parse(hnSearch.parse(await catalogJson(stories.href, options)).hits)
    .find(({ title }) => /who is hiring\?/i.test(title))
  if (!story) return { postings: [], nextPage: null, fetched: 0 }
  const comments = new URL("https://hn.algolia.com/api/v1/search")
  comments.searchParams.set("tags", `comment,story_${story.objectID}`)
  comments.searchParams.set("hitsPerPage", "1000")
  const hits = hnSearch
    .parse(await catalogJson(comments.href, options))
    .hits.flatMap((hit) => {
      const parsed = hnHit.safeParse(hit)
      return parsed.success &&
        parsed.data.parent_id === Number(story.objectID) &&
        parsed.data.comment_text
        ? [{ ...parsed.data, text: parsed.data.comment_text }]
        : []
    })
  const postings: BoardPosting[] = hits.flatMap((hit) => {
    const head = plain(hit.text.split(/<p>/i)[0] ?? "")
    const parts = head.split("|").map((part) => part.trim()).filter(Boolean)
    const [company, title, ...rest] = parts
    if (!company || !title || company.length > 80 || title.length > 160)
      return []
    return [
      {
        title,
        company,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        description: plain(hit.text),
        locations: rest.length ? [rest.join(" | ")] : [],
        countries: [],
        postedAt: hit.created_at,
      },
    ]
  })
  return { postings, nextPage: null, fetched: hits.length }
}
