import { z } from "zod"
import { publicApplicationUrl } from "@/lib/applications/url"
import { boardFromUrl } from "../source-identity"
import {
  candidatesFromLinks,
  discoverEmployerLinks,
  linkDiscoveryOrigin,
} from "./links"
import { readBounded, type SourceCandidate } from "./seeds"

export const browserbaseSearchResponse = z.object({
  requestId: z.string().min(1).max(200),
  results: z.array(z.object({ url: z.string().max(4000) })).max(25),
})
const queriesSchema = z.array(z.string().trim().min(1).max(200)).min(1).max(30)

// Conservative reservations, not invoice measurements. Fixed Parallel fast
// requests cost no more than the higher generic Search meter in current docs.
const searchReservationUsd = 0.007
const browserReservationUsd = (2 / 60) * 0.12
export type RenderCareerLinks = (
  url: string,
  signal: AbortSignal
) => Promise<{ links: string[]; sessionId: string; releaseRequested: boolean }>

export class DiscoveryBrowserError extends Error {
  constructor(
    readonly phase: string,
    readonly sessionId: string,
    readonly releaseRequested: boolean,
    readonly status?: number
  ) {
    super(`Browserbase career-page rendering failed during ${phase}`)
  }
}

export async function discoverWithBrowserbase(
  input: string[],
  options: {
    apiKey: string
    knownSourceIds?: ReadonlySet<string>
    maxUrls?: number
    maxUrlsPerQuery?: number
    maxBrowsers?: number
    maxCostUsd?: number
    maxMs?: number
    fetch?: typeof fetch
    discover?: typeof discoverEmployerLinks
    render?: RenderCareerLinks
  }
) {
  const queries = [...new Set(queriesSchema.parse(input))]
  const maxUrls = options.maxUrls ?? 50,
    maxUrlsPerQuery = options.maxUrlsPerQuery ?? 25,
    maxBrowsers = options.maxBrowsers ?? 0,
    maxMs = options.maxMs ?? 600_000,
    maxCostUsd = options.maxCostUsd ?? 1
  if (
    !options.apiKey ||
    !Number.isSafeInteger(maxUrls) ||
    maxUrls < 1 ||
    maxUrls > 50 ||
    !Number.isSafeInteger(maxUrlsPerQuery) ||
    maxUrlsPerQuery < 1 ||
    maxUrlsPerQuery > 25 ||
    !Number.isSafeInteger(maxBrowsers) ||
    maxBrowsers < 0 ||
    maxBrowsers > 10 ||
    !Number.isSafeInteger(maxMs) ||
    maxMs < 1000 ||
    maxMs > 900_000 ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd <= 0 ||
    maxCostUsd > 1 ||
    (maxBrowsers > 0 && !options.render)
  )
    throw new Error("Invalid Browserbase discovery configuration")

  const transport = options.fetch ?? fetch,
    discover = options.discover ?? discoverEmployerLinks,
    signal = AbortSignal.timeout(maxMs),
    deadline = Date.now() + maxMs,
    known = options.knownSourceIds ?? new Set<string>(),
    urls = new Set<string>(),
    boards = new Set<string>(),
    candidates = new Map<string, SourceCandidate>(),
    searches: {
      query: string
      requestId: string
      results: number
      selectedUrls: number
    }[] = [],
    errors: { url?: string; reason: string }[] = [],
    stops = new Set<string>(),
    sessions: { sessionId: string; releaseRequested: boolean }[] = []
  let searchAttempts = 0,
    browserAttempts = 0,
    reservedCostUsd = 0,
    skippedKnown = 0,
    rejectedUrls = 0,
    checkedUrls = 0
  function reserve(usd: number) {
    if (signal.aborted) {
      stops.add("time_budget")
      return false
    }
    if (reservedCostUsd + usd > maxCostUsd + 1e-9) {
      stops.add("cost_budget")
      return false
    }
    reservedCostUsd += usd
    return true
  }
  function add(rows: SourceCandidate[]) {
    for (const row of rows) {
      if (known.has(row.id)) skippedKnown++
      else if (!candidates.has(row.id)) candidates.set(row.id, row)
    }
  }

  for (const query of queries) {
    if (!reserve(searchReservationUsd)) break
    searchAttempts++ // Failed/ambiguous requests consume their reservation too.
    try {
      const response = await transport(
        "https://api.browserbase.com/v1/search",
        {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "x-bb-api-key": options.apiKey,
          },
          body: JSON.stringify({
            query,
            provider: "parallel",
            mode: "fast",
            numResults: 25,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        }
      )
      if (!response.ok) {
        await response.body?.cancel()
        errors.push({
          reason: `Browserbase Search HTTP ${response.status}; no automatic retry`,
        })
        stops.add("search_error")
        break
      }
      const data = browserbaseSearchResponse.parse(
        JSON.parse((await readBounded(response, 256_000)).toString("utf8"))
      )
      const before = urls.size
      for (const result of data.results) {
        if (urls.size - before >= maxUrlsPerQuery) break
        const safe = publicApplicationUrl(result.url)
        if (!safe) {
          rejectedUrls++
          continue
        }
        const url = new URL(safe)
        url.hash = ""
        const board = boardFromUrl(url.href)
        if (board && known.has(board.id)) {
          skippedKnown++
          continue
        }
        if (board && boards.has(board.id)) continue
        if (urls.has(url.href)) continue
        if (urls.size >= maxUrls) {
          stops.add("url_budget")
          break
        }
        urls.add(url.href)
        if (board) boards.add(board.id)
      }
      searches.push({
        query,
        requestId: data.requestId,
        results: data.results.length,
        selectedUrls: urls.size - before,
      })
      if (stops.has("url_budget")) break
    } catch {
      errors.push({
        reason: signal.aborted
          ? "Discovery time budget reached"
          : "Browserbase Search unavailable or invalid response; no automatic retry",
      })
      stops.add(signal.aborted ? "time_budget" : "search_error")
      break
    }
  }

  // Preserve already observed ATS URLs even after a search failure. An access
  // refusal stops further paid calls; search hits never become published jobs.
  for (const url of urls) {
    const direct = candidatesFromLinks(url, [url])
    if (direct.length) {
      add(direct)
      checkedUrls++
    }
  }
  for (const url of urls) {
    if (boardFromUrl(url)) continue
    if (signal.aborted) {
      stops.add("time_budget")
      break
    }
    const result = await discover([url], {
      maxPages: 1,
      maxMs: Math.min(15_000, deadline - Date.now()),
    })
    checkedUrls++
    add(result.candidates)
    if (result.errors.length) {
      // HTTP refusal, robots exclusion and private destinations cannot trigger
      // a browser fallback. Keep safe fixed error text out of provider bodies.
      errors.push({
        url,
        reason: "Static career-page discovery failed; browser fallback skipped",
      })
      continue
    }
    if (
      result.candidates.length ||
      !options.render ||
      stops.has("search_error") ||
      stops.has("browser_error")
    )
      continue
    if (browserAttempts >= maxBrowsers) {
      stops.add("browser_budget")
      continue
    }
    if (!reserve(browserReservationUsd)) continue
    browserAttempts++
    try {
      const rendered = await options.render(url, signal)
      sessions.push({
        sessionId: rendered.sessionId,
        releaseRequested: rendered.releaseRequested,
      })
      add(candidatesFromLinks(url, rendered.links))
      if (!rendered.releaseRequested) {
        errors.push({
          url,
          reason:
            "Browser release unconfirmed; session timeout bounds remaining usage",
        })
        stops.add("browser_error")
      }
    } catch (error) {
      if (error instanceof DiscoveryBrowserError && error.sessionId)
        sessions.push({
          sessionId: error.sessionId,
          releaseRequested: error.releaseRequested,
        })
      errors.push({
        url,
        reason:
          error instanceof DiscoveryBrowserError
            ? `${error.message}${error.status ? ` (HTTP ${error.status})` : ""}; no automatic retry`
            : "Browserbase career-page rendering failed; no automatic retry",
      })
      stops.add("browser_error")
    }
  }
  const rows = [...candidates.values()]
  const base = linkDiscoveryOrigin([...urls], rows)
  return {
    candidates: rows,
    origin: {
      ...base,
      id: `browserbase:${base.revision}`,
      format: "browserbase-search",
      queries,
      searches,
    },
    complete:
      stops.size === 0 &&
      errors.length === 0 &&
      searches.length === queries.length,
    stopReasons: [...stops],
    errors,
    usage: {
      searchAttempts,
      browserAttempts,
      checkedUrls,
      skippedKnown,
      rejectedUrls,
      reservedCostUsd: Number(reservedCostUsd.toFixed(6)),
      maxCostUsd,
      maxUrlsPerQuery,
      note: "Conservative usage reservation, not measured billing. No proxy, Extract or model inference is used.",
    },
    sessions,
  }
}
