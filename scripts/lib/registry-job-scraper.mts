import { publicRequestGuard } from "@/lib/server/applications/network"
import { readBounded } from "@/lib/server/catalog/discovery/seeds"
import { robotsAllowed } from "@/lib/server/catalog/discovery/validate"
import { fetchSourcePage } from "@/lib/server/catalog/connectors"
import { registryBoardKey, scrapeRegistryBoard } from "./registry-job-ats.mjs"
import {
  indiaProfessionalPosting,
  inspectProfessionalFeed,
  inspectProfessionalPage,
  type ProfessionalPortal,
} from "./professional-job-portals.mjs"
import {
  asPublicUrl,
  inspectRegistryJobPage,
  isRegistryJobDetailUrl,
  normalizedPosting,
  readSuccessFactorsJobDetail,
  relatesToEmployer,
  type ScrapedPosting,
} from "./registry-job-postings.mjs"

export type RegistryJobSource = {
  url: string
  company: string
  careerJobLinks?: readonly string[]
  portal?: ProfessionalPortal
}
export type SourceOutcome =
  | "collected"
  | "partial"
  | "checked_empty"
  | "no_verified_jobs"
  | "render_pending"
  | "auth_required"
  | "captcha"
  | "restricted"
  | "retry_due"
  | "unavailable"
export type SourceScrape = {
  outcome: SourceOutcome
  jobs: ScrapedPosting[]
  pages: number
  reason: string | null
}
type PageContent = { url: URL; html: string; incomplete?: boolean }
export type RenderJobs = (
  url: URL,
  permitted: (url: URL) => boolean,
  beforeNavigate: (url: URL) => Promise<void>
) => Promise<PageContent[]>

export class JobPageError extends Error {
  constructor(
    readonly outcome: SourceOutcome,
    message: string
  ) {
    super(message)
  }
}

export function makeRegistryJobScraper({
  mapEndpoint,
  preferCareerLinks = false,
  fetcher = fetch,
  guard = publicRequestGuard(),
}: {
  mapEndpoint?: URL
  preferCareerLinks?: boolean
  fetcher?: typeof fetch
  guard?: ReturnType<typeof publicRequestGuard>
} = {}) {
  if (
    mapEndpoint &&
    (mapEndpoint.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(mapEndpoint.hostname) ||
      mapEndpoint.username ||
      mapEndpoint.password)
  )
    throw new Error("Firecrawl Map requires a loopback HTTP service")
  const mapUrl = mapEndpoint && new URL("/v2/map", mapEndpoint)
  const robots = new Map<string, Promise<string>>()
  const boards = new Map<string, ReturnType<typeof scrapeRegistryBoard>>()
  const deferredHosts = new Map<string, number>()

  async function read(
    url: URL,
    signal: AbortSignal,
    permit: (url: URL) => boolean,
    rules = false,
    redirects = 0,
    feed = false
  ): Promise<PageContent> {
    if (!permit(url) || redirects > 4)
      throw new JobPageError(
        "unavailable",
        "Redirect left the evidenced employer or ATS"
      )
    if ((deferredHosts.get(url.origin) ?? 0) > Date.now())
      throw new JobPageError("retry_due", "Host asked us to retry later")
    if (
      /\/(?:candidate-)?(?:login|log-in|sign-?in|auth|sso)(?:\/|$)/i.test(
        url.pathname
      )
    )
      throw new JobPageError("auth_required", "Listing redirected to sign-in")
    signal.throwIfAborted()
    await guard(url.href)
    if (!rules && !feed) await beforeNavigate(url)
    const response = await fetcher(url.href, {
      redirect: "manual",
      headers: {
        "User-Agent": "JobSearchCatalog/1.0",
        Accept: rules
          ? "text/plain"
          : feed
            ? "application/json,application/xml,text/xml,*/*"
            : "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_500)]),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const next = asPublicUrl(response.headers.get("location") ?? "", url)
      if (!next || next.href === url.href)
        throw new JobPageError("unavailable", "Invalid redirect")
      return read(next, signal, permit, rules, redirects + 1, feed)
    }
    if (response.headers.get("cf-mitigated") === "challenge") {
      await response.body?.cancel()
      if (
        rules &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        return { url, html: "" }
      throw new JobPageError("captcha", "Cloudflare challenge")
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429 || response.status === 503) {
        const hint = response.headers.get("retry-after")
        const at =
          hint && /^\d+$/.test(hint)
            ? Date.now() + Number(hint) * 1000
            : Date.parse(hint ?? "")
        deferredHosts.set(
          url.origin,
          Number.isFinite(at) ? at : Date.now() + 60_000
        )
        throw new JobPageError("retry_due", "HTTP " + response.status)
      }
      if (rules && response.status >= 400 && response.status < 500)
        return { url, html: "" }
      if (response.status === 401)
        throw new JobPageError("auth_required", "HTTP 401")
      if (response.status === 403)
        throw new JobPageError("restricted", "HTTP 403")
      throw new JobPageError("unavailable", "HTTP " + response.status)
    }
    if (
      !rules &&
      !feed &&
      !/text\/html|application\/xhtml\+xml/i.test(
        response.headers.get("content-type") ?? ""
      )
    ) {
      await response.body?.cancel()
      throw new JobPageError("unavailable", "Listing did not return HTML")
    }
    return {
      url,
      html: (
        await readBounded(
          response,
          rules ? 256_000 : feed ? 10_000_000 : 2_500_000
        )
      ).toString("utf8"),
    }
  }

  async function beforeNavigate(url: URL) {
    if (!robots.has(url.origin)) {
      if (robots.size >= 1500) robots.delete(robots.keys().next().value!)
      robots.set(
        url.origin,
        read(
          new URL("/robots.txt", url),
          AbortSignal.timeout(6500),
          (target) =>
            target.hostname.replace(/^www\./, "") ===
            url.hostname.replace(/^www\./, ""),
          true
        ).then((content) => content.html)
      )
    }
    const rules = await robots.get(url.origin)!
    if (!robotsAllowed(rules, url.pathname + url.search))
      throw new JobPageError(
        "restricted",
        "Employer robots rules exclude this path"
      )
  }

  function readBoard(url: URL, company: string) {
    const key = registryBoardKey(url)!
    if (!boards.has(key)) {
      if (boards.size >= 100) boards.delete(boards.keys().next().value!)
      const result = scrapeRegistryBoard(url, company).catch((error) => {
        boards.delete(key)
        throw error
      })
      boards.set(key, result)
    }
    return boards.get(key)!
  }

  async function scrapeMap(
    source: RegistryJobSource,
    start: URL,
    endpoint: URL
  ): Promise<SourceScrape> {
    const jobs = new Map<string, ScrapedPosting>()
    const finish = (outcome: SourceOutcome, pages: number, reason: string) => ({
      outcome,
      pages,
      reason,
      jobs: [...jobs.values()],
    })
    try {
      await guard(start.href)
      await beforeNavigate(start)
    } catch (error) {
      if (
        error instanceof JobPageError &&
        ["restricted", "auth_required", "captcha"].includes(error.outcome)
      )
        return finish(error.outcome, 0, error.message)
      throw new Error(
        `Could not check access to ${start.href} before mapping`,
        {
          cause: error,
        }
      )
    }
    const permitted = (url: URL) => relatesToEmployer(url, start)
    const key = (url: URL) =>
      url.origin + url.pathname.replace(/\/+$/, "") + url.search
    const publishedLinks = new Map<string, URL>()
    for (const value of source.careerJobLinks ?? []) {
      const url = asPublicUrl(value, start)
      if (url && url.origin === start.origin && isRegistryJobDetailUrl(url))
        publishedLinks.set(key(url), url)
    }
    async function mapCandidates(sitemap: "only" | "skip") {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: start.href,
          sitemap,
          includeSubdomains: false,
          limit: 1000,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Firecrawl Map failed with HTTP ${response.status}`)
      }
      const mapped: { success?: boolean; links?: { url?: string }[] } =
        JSON.parse((await readBounded(response, 2_500_000)).toString("utf8"))
      if (mapped?.success !== true || !Array.isArray(mapped.links))
        throw new Error("Firecrawl Map returned an invalid response")

      const candidates = new Map<string, URL>()
      for (const link of mapped.links) {
        if (typeof link?.url !== "string") continue
        const mappedUrl = asPublicUrl(link.url)
        const url =
          mappedUrl && (publishedLinks.get(key(mappedUrl)) ?? mappedUrl)
        if (
          !url ||
          !permitted(url) ||
          !isRegistryJobDetailUrl(url) ||
          key(url) === key(start)
        )
          continue
        candidates.set(url.href, url)
      }
      return [...candidates.values()]
    }
    const linked = preferCareerLinks ? await mapCandidates("skip") : []
    const candidates = linked.length ? linked : await mapCandidates("only")

    const signal = AbortSignal.timeout(40_000)
    let pages = 0
    let checked = 0
    let failures = 0
    let stopped: JobPageError | undefined
    for (const candidate of candidates.slice(0, 12)) {
      if (signal.aborted) break
      checked++
      try {
        const page = await read(candidate, signal, permitted)
        pages++
        const parsed = inspectRegistryJobPage(
          page.html,
          page.url,
          start,
          source.company,
          true
        )
        if (parsed.gate)
          throw new JobPageError(parsed.gate, "Employer access gate")
        const detailed = readSuccessFactorsJobDetail(
          page.html,
          page.url,
          source.company
        )
        for (const job of detailed ? [detailed, ...parsed.jobs] : parsed.jobs) {
          const url = asPublicUrl(job.url)
          if (
            job.method === "listing" ||
            !job.description ||
            !url ||
            !permitted(url)
          )
            continue
          const existing = jobs.get(job.key)
          if (!existing || (!existing.postedAt && job.postedAt))
            jobs.set(job.key, job)
        }
      } catch (error) {
        failures++
        if (
          error instanceof JobPageError &&
          (["retry_due", "captcha", "auth_required"].includes(error.outcome) ||
            (error.outcome === "restricted" &&
              error.message !== "Employer robots rules exclude this path"))
        ) {
          stopped = error
          break
        }
      }
    }
    const reason =
      `Firecrawl Map checked ${checked}/${candidates.length} candidate URLs` +
      (failures ? `, ${failures} could not be verified` : "") +
      (stopped ? `; ${stopped.message}` : "")
    return finish(
      jobs.size ? "partial" : (stopped?.outcome ?? "no_verified_jobs"),
      pages,
      reason
    )
  }

  return async function scrape(
    source: RegistryJobSource,
    render?: RenderJobs
  ): Promise<SourceScrape> {
    if (source.portal?.skip)
      return { ...source.portal.skip, jobs: [], pages: 0 }
    const url = asPublicUrl(source.url)
    if (!url)
      return {
        outcome: "unavailable",
        jobs: [],
        pages: 0,
        reason: "Invalid public URL",
      }
    const start = url
    if (mapUrl) return scrapeMap(source, start, mapUrl)
    const portal = source.portal
    const jobs = new Map<string, ScrapedPosting>()
    let pages = 0
    let empty = false
    let dynamic = false
    let partial: string | null = null
    const finish = (
      outcome: SourceOutcome,
      reason: string | null = null
    ): SourceScrape => ({ outcome, jobs: [...jobs.values()], pages, reason })
    function store(posting: ScrapedPosting) {
      const prior = jobs.get(posting.key)
      if (
        !prior ||
        posting.description.length > prior.description.length ||
        (prior.method === "listing" && posting.method !== "listing")
      )
        jobs.set(posting.key, posting)
    }
    const message = (error: unknown) =>
      error instanceof Error ? error.message : "Page request failed"
    const outcomeOf = (error: unknown) =>
      error instanceof JobPageError ? error.outcome : "unavailable"
    const permitted = (url: URL) =>
      relatesToEmployer(url, start) ||
      (!portal && Boolean(registryBoardKey(url)))
    const signal = AbortSignal.timeout(
      portal ? 75_000 : render ? 50_000 : 30_000
    )
    const visited = new Set<string>()
    const candidates = new Map<string, URL>()
    const jobsPages = new Map<string, URL>()
    const listingPages = [start]
    function inspect(content: PageContent, isDetail = false) {
      pages++
      if (content.incomplete)
        partial = "Browser pagination still has more results"
      const data = portal
        ? inspectProfessionalPage(
            content.html,
            content.url,
            start,
            portal,
            isDetail
          )
        : inspectRegistryJobPage(
            content.html,
            content.url,
            start,
            source.company,
            isDetail
          )
      if (data.gate)
        throw new JobPageError(
          data.gate,
          data.gate === "captcha"
            ? "Employer challenge page"
            : "Employer requires sign-in"
        )
      for (const posting of data.jobs) store(posting)
      for (const board of data.boards) {
        const key = registryBoardKey(board)
        if (key) candidates.set(key, board)
      }
      if (!isDetail)
        for (const url of data.details) jobsPages.set(url.href, url)
      if (!isDetail)
        listingPages.push(...data.next, ...data.frames, ...data.listings)
      if (data.empty) empty = true
      if (data.dynamic) dynamic = true
    }
    try {
      if (portal && start.href === "https://infopark.in/companies-job") {
        const snapshotStartedAt = new Date().toISOString()
        for (let page: number | null = 1; page && page <= 12; ) {
          const result = await fetchSourcePage(
            {
              id: "infopark:kerala",
              kind: "infopark",
              board: "kerala",
              company: portal.company,
            },
            page,
            {
              signal,
              snapshotStartedAt,
              timeoutMs: 5_500,
              maxResponseBytes: 2_500_000,
              onRequest: () => {
                pages++
              },
              fetch: async (url, init) => {
                await guard(String(url))
                return fetch(url, init)
              },
            }
          )
          for (const job of result.postings) {
            const row = normalizedPosting({
              title: job.title,
              company: job.company,
              url: job.url,
              location: job.locations.join("; ") || null,
              countries: job.countries,
              postedAt: job.postedAt,
              description: job.description,
              evidence: job.url,
              method: "job_detail",
            })
            const eligible =
              row && indiaProfessionalPosting(row, portal.company)
            if (eligible) store(eligible)
          }
          page = result.nextPage
        }
        return finish(
          "partial",
          "Infopark collection is bounded by the source page budget"
        )
      }
      if (portal?.feed && !render) {
        try {
          let current = asPublicUrl(portal.feed.url)
          const feedUrls = new Set<string>()
          let window: string | null = null
          while (current && pages < 12 && !feedUrls.has(current.href)) {
            feedUrls.add(current.href)
            const page = await read(current, signal, permitted, false, 0, true)
            const result = inspectProfessionalFeed(page.html, page.url, portal)
            pages++
            for (const job of result.jobs) store(job)
            for (const detail of result.details)
              jobsPages.set(detail.href, detail)
            window = result.window
            current = result.next
          }
          partial = current
            ? "Public feed has more pages after the first pass"
            : window
          if (!jobsPages.size)
            return finish(
              jobs.size ? (partial ? "partial" : "collected") : "checked_empty",
              partial
            )
          listingPages.length = 0
        } catch (error) {
          if (jobs.size || outcomeOf(error) !== "unavailable") throw error
          partial = message(error)
        }
      }
      if (!portal && registryBoardKey(start)) {
        try {
          const feed = await readBoard(start, source.company)
          for (const posting of feed.jobs) store(posting)
          pages++
          if (feed.complete)
            return finish(jobs.size ? "collected" : "checked_empty")
          partial = feed.reason
          if (jobs.size) return finish("partial", partial)
        } catch (error) {
          partial = message(error)
        }
      }
      if (render) {
        for (const content of await render(start, permitted, beforeNavigate)) {
          inspect(content)
          visited.add(content.url.href)
        }
        visited.add(start.href)
      }
      for (let i = 0; i < listingPages.length; i++) {
        const url = listingPages[i]
        if (visited.has(url.href)) continue
        if (visited.size >= (portal ? 12 : 25) || signal.aborted) {
          partial = "Listing pagination was incomplete"
          break
        }
        visited.add(url.href)
        try {
          const page = await read(url, signal, permitted)
          visited.add(page.url.href)
          if (!portal && registryBoardKey(page.url))
            candidates.set(registryBoardKey(page.url)!, page.url)
          inspect(page)
        } catch (error) {
          if (pages === 0) throw error
          partial = message(error)
        }
      }
      if (candidates.size > 6)
        partial = "Some external boards still need collection"
      const inventories = await Promise.allSettled(
        [...candidates.values()]
          .slice(0, 6)
          .map((url) => readBoard(url, source.company))
      )
      for (const inventory of inventories) {
        if (inventory.status === "rejected") {
          partial = message(inventory.reason)
          continue
        }
        const feed = inventory.value
        pages++
        for (const posting of feed.jobs) store(posting)
        if (feed.complete && feed.jobs.length === 0) empty = true
        if (!feed.complete) partial = feed.reason ?? "ATS coverage incomplete"
      }
      const known = new Set(
        [...jobs.values()]
          .filter((job) => job.method !== "listing")
          .map((job) => job.url)
      )
      const details = [...jobsPages.values()].filter(
        (url) =>
          !visited.has(url.href) &&
          !known.has(url.href) &&
          !registryBoardKey(url)
      )
      if (details.length > 80)
        partial = "Some individual postings still need verification"
      for (let i = 0; i < Math.min(details.length, 80); i += 3) {
        if (signal.aborted) {
          partial = "Job detail reads ran out of time"
          break
        }
        await Promise.all(
          details.slice(i, Math.min(i + 3, 80)).map(async (url) => {
            try {
              const page = await read(url, signal, permitted)
              inspect(page, true)
            } catch (error) {
              partial = message(error)
            }
          })
        )
      }
      if (jobs.size) return finish(partial ? "partial" : "collected", partial)
      if (empty && !partial && !dynamic) return finish("checked_empty")
      if (!render && (dynamic || candidates.size > 0))
        return finish("render_pending", partial)
      if (partial) return finish("partial", partial)
      return finish("no_verified_jobs")
    } catch (error) {
      const outcome = outcomeOf(error)
      if (jobs.size) return finish("partial", message(error))
      return finish(outcome, message(error))
    }
  }
}
