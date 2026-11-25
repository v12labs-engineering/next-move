import { createHash } from "node:crypto"
import { load } from "cheerio"
import { publicRequestGuard } from "../../applications/network"
import { boardFromUrl } from "../source-identity"
import { readBounded, type SourceCandidate } from "./seeds"
import { robotsAllowed } from "./validate"

export function candidatesFromLinks(page: string, links: string[]) {
  const found = new Map<string, SourceCandidate>()
  for (const value of links) {
    const identity = boardFromUrl(value)
    if (identity)
      found.set(identity.id, {
        ...identity,
        expected_company: null,
        historical_checked_at: null,
        evidence_url: page,
      })
  }
  return [...found.values()]
}

export function linkDiscoveryOrigin(
  inputs: string[],
  candidates: SourceCandidate[]
) {
  const body = JSON.stringify({
    inputs: [...inputs].sort(),
    candidates: [...candidates].sort((a, b) => a.id.localeCompare(b.id)),
  })
  const revision = createHash("sha1").update(body).digest("hex")
  return {
    id: `career-links:${revision}`,
    format: "career-links",
    revision,
    sha256: createHash("sha256").update(body).digest("hex"),
    license: "not-established",
    attribution: "Observed public employer career links",
    inputs: [...inputs].sort(),
    note: "Observed link metadata only; no content reuse permission inferred. Revision hashes the discovery result, not a Git commit.",
  }
}

/** Read only bounded, public employer pages. Discovered ATS links are candidates,
 * never automatically followed, activated or treated as current vacancies. */
export async function discoverEmployerLinks(
  inputs: string[],
  options: {
    fetch?: typeof fetch
    guard?: (url: string) => Promise<void>
    maxMs?: number
    maxPages?: number
    inspectPage?: (page: URL, html: string, links: string[]) => void
    inspectKnownBoards?: boolean
    sameSiteRedirects?: boolean
  } = {}
) {
  if (!inputs.length || inputs.length > 20)
    throw new Error("Use 1–20 employer career URLs")
  const maxPages = options.maxPages ?? 3
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 3)
    throw new Error("Use 1–3 pages per career URL")
  const transport = options.fetch ?? fetch
  const guard = options.guard ?? publicRequestGuard()
  const deadline = Date.now() + Math.min(options.maxMs ?? 60000, 60000)
  const candidates = new Map<string, SourceCandidate>()
  const errors: { url: string; reason: string }[] = []
  const checked: string[] = []
  const robots = new Map<string, string>()
  async function read(
    value: string,
    robot = false,
    redirects = 0
  ): Promise<{ body: string; url: URL }> {
    const url = new URL(value)
    await guard(url.href)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Discovery time budget reached")
    const response = await transport(url.href, {
      redirect: options.sameSiteRedirects ? "manual" : "error",
      cache: "no-store",
      headers: {
        "User-Agent": "JobSearchCatalog/1.0",
        Accept: robot ? "text/plain" : "text/html",
      },
      signal: AbortSignal.timeout(Math.min(remaining, 15000)),
    })
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      options.sameSiteRedirects
    ) {
      await response.body?.cancel()
      const location = response.headers.get("location")
      if (!location || redirects >= 2)
        throw new Error("Career page redirect limit reached")
      const next = new URL(location, url)
      if (
        next.hostname.replace(/^www\./, "") !==
        url.hostname.replace(/^www\./, "")
      )
        throw new Error("Career page redirects to a different site")
      if (
        !robot &&
        !robotsAllowed(await rulesFor(next), next.pathname + next.search)
      )
        throw new Error("Employer robots rules exclude redirect destination")
      return read(next.href, robot, redirects + 1)
    }
    if (
      robot &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    ) {
      await response.body?.cancel()
      return { body: "", url }
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Discovery HTTP ${response.status}`)
    }
    if (
      !robot &&
      !/text\/html|application\/xhtml\+xml/i.test(
        response.headers.get("content-type") ?? ""
      )
    ) {
      await response.body?.cancel()
      throw new Error("Employer page is not HTML")
    }
    return {
      body: (await readBounded(response, robot ? 512000 : 2000000)).toString(
        "utf8"
      ),
      url,
    }
  }
  async function rulesFor(page: URL) {
    const cached = robots.get(page.origin)
    if (cached !== undefined) return cached
    const { body } = await read(`${page.origin}/robots.txt`, true)
    robots.set(page.origin, body)
    return body
  }
  for (const input of [...new Set(inputs)]) {
    try {
      const url = new URL(input)
      if (url.protocol !== "https:" || url.port || url.username || url.password)
        throw new Error("A public HTTPS career URL is required")
      const direct = candidatesFromLinks(input, [input])
      if (direct.length) {
        for (const candidate of direct) candidates.set(candidate.id, candidate)
        if (!options.inspectKnownBoards) continue
      }
      const queue = [url.href]
      for (let index = 0; index < Math.min(queue.length, maxPages); index++) {
        const target = new URL(queue[index])
        if (checked.includes(target.href)) continue
        if (
          !robotsAllowed(
            await rulesFor(target),
            target.pathname + target.search
          )
        )
          throw new Error("Employer robots rules exclude this path")
        const { body: html, url: page } = await read(target.href)
        checked.push(page.href)
        const $ = load(html)
        const links: string[] = []
        $("a[href],iframe[src]").each((_, element) => {
          const raw = $(element).attr("href") ?? $(element).attr("src")
          try {
            if (raw) links.push(new URL(raw, page).href)
          } catch {
            /* Ignore malformed links. */
          }
        })
        // Embedded ATS URLs are evidence only; no JavaScript is evaluated.
        links.push(
          ...(html.replaceAll("\\/", "/").match(/https:\/\/[^\s"'<>\\]+/g) ??
            [])
        )
        options.inspectPage?.(page, html, links)
        for (const candidate of candidatesFromLinks(page.href, links))
          candidates.set(candidate.id, candidate)
        for (const link of links) {
          const next = new URL(link)
          next.hash = ""
          if (
            next.origin === url.origin &&
            /\/(?:careers?|jobs?|join-us|work-with-us)(?:[/?-]|$)/i.test(
              next.pathname
            ) &&
            !queue.includes(next.href) &&
            queue.length < maxPages
          )
            queue.push(next.href)
        }
      }
    } catch (error) {
      errors.push({
        url: input,
        reason:
          error instanceof Error ? error.message : "Employer discovery failed",
      })
    }
  }
  return {
    candidates: [...candidates.values()],
    checked,
    errors,
    complete: errors.length === 0,
  }
}
