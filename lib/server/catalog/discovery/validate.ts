import { load } from "cheerio"
import { connectors, fetchCatalogPage } from "../connectors"
import { IncompleteAtsInventoryError } from "../connectors/additional-ats"
import { providerHost } from "../source-identity"
import { isIP } from "node:net"
import { z } from "zod"
import { publicApplicationUrl } from "@/lib/applications/url"
import {
  explicitCountry,
  statedLocationCountry,
  type CatalogPosting,
  type CatalogSource,
  type RawSourcePosting,
} from "../feeds"
import {
  boardIdentity,
  publicBoardUrl,
  readBounded,
  type SourceCandidate,
} from "./seeds"

export type ValidationStatus =
  | "verified"
  | "empty"
  | "needs_review"
  | "deferred"
  | "missing"
  | "invalid"
export interface ValidationResult {
  status: ValidationStatus
  company: string | null
  countries: string[]
  fetched_count: number
  accepted_count: number
  fresh_count?: number
  complete: boolean
  next_attempt_at: string
  reason: string
  evidence: { url: string; kind: string }[]
}
class ProbeFailure extends Error {
  constructor(
    readonly status: ValidationStatus,
    message: string,
    readonly retryAt?: string
  ) {
    super(message)
  }
}
const trustedHosts = new Set([
  "api.ashbyhq.com",
  "jobs.ashbyhq.com",
  "boards-api.greenhouse.io",
  "job-boards.greenhouse.io",
  "boards.greenhouse.io",
  "api.lever.co",
  "jobs.lever.co",
])
const agent = "JobSearchCatalog"

export function robotsAllowed(text: string, pathname: string) {
  const groups: {
    agents: string[]
    rules: { allow: boolean; path: string }[]
  }[] = []
  let group = {
    agents: [] as string[],
    rules: [] as { allow: boolean; path: string }[],
  }
  let hasDirective = false
  for (const line of text.split(/\r?\n/)) {
    const match = line
      .replace(/#.*/, "")
      .trim()
      .match(/^([^:]+):\s*(.*)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase(),
      value = match[2].trim()
    if (key === "user-agent") {
      if (hasDirective) {
        groups.push(group)
        group = { agents: [], rules: [] }
        hasDirective = false
      }
      group.agents.push(value.toLowerCase())
    } else if ((key === "allow" || key === "disallow") && group.agents.length) {
      hasDirective = true
      if (value) group.rules.push({ allow: key === "allow", path: value })
    }
  }
  groups.push(group)
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a))
  )
  const relevant = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"))
  let best = -1,
    allowed = true
  for (const rule of relevant.flatMap((g) => g.rules)) {
    const end = rule.path.endsWith("$")
    const path = end ? rule.path.slice(0, -1) : rule.path
    const pattern = path
      .split("*")
      .map((part) => part.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&"))
      .join(".*")
    if (new RegExp(`^${pattern}${end ? "$" : ""}`).test(pathname)) {
      const length = path.replaceAll("*", "").length
      if (length > best || (length === best && rule.allow)) {
        best = length
        allowed = rule.allow
      }
    }
  }
  return allowed
}

// Fixed provider origins and validated board tokens are the only destinations.
// CSV URLs, employer websites and links in descriptions are never fetched.
export function probeClient(
  transport: typeof fetch = fetch,
  now = () => new Date()
) {
  const robots = new Map<string, Promise<string>>()
  async function request(
    url: string,
    limit: number,
    robotsRequest = false,
    signal?: AbortSignal,
    init: RequestInit = {}
  ) {
    const target = new URL(url)
    if (
      target.protocol !== "https:" ||
      target.port ||
      target.username ||
      target.password ||
      (!trustedHosts.has(target.hostname) && !providerHost(target.hostname))
    )
      throw new ProbeFailure("invalid", "Untrusted provider endpoint")
    let response: Response
    try {
      response = await transport(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        headers: {
          ...init.headers,
          "User-Agent": `${agent}/1.0`,
          Accept: "application/json,text/html,text/plain",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      })
    } catch {
      throw new ProbeFailure("deferred", "Provider request unavailable")
    }
    // RFC 9309 §2.3.1.3: a 4xx robots resource is unavailable. Still honor
    // throttling, and never apply this rule to the actual identity/job request.
    if (
      robotsRequest &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    ) {
      await response.body?.cancel()
      return ""
    }
    if (!response.ok) {
      await response.body?.cancel()
      const retry = response.headers.get("retry-after")
      const milliseconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : retry
            ? Date.parse(retry) - now().getTime()
            : 900_000
      const retryAt = new Date(
        now().getTime() +
          Math.max(
            60_000,
            Number.isFinite(milliseconds) ? milliseconds : 900_000
          )
      ).toISOString()
      const status = robotsRequest
        ? "deferred"
        : [404, 410].includes(response.status)
          ? "missing"
          : [401, 403].includes(response.status)
            ? "needs_review"
            : "deferred"
      throw new ProbeFailure(
        status,
        `Provider HTTP ${response.status}`,
        retryAt
      )
    }
    try {
      return (await readBounded(response, limit)).toString("utf8")
    } catch {
      throw new ProbeFailure(
        "deferred",
        "Provider body unreadable or too large"
      )
    }
  }
  return async (
    url: string,
    format: "json" | "html",
    signal?: AbortSignal,
    init: RequestInit = {}
  ) => {
    const target = new URL(url)
    const publicPostingApi =
      ((target.hostname === "api.smartrecruiters.com" &&
        /^\/v1\/companies\/[a-z0-9][a-z0-9._-]{0,99}\/postings(?:\/[0-9]+)?$/.test(
          target.pathname
        )) ||
        (/^[a-z0-9][a-z0-9-]{0,62}\.recruitee\.com$/.test(target.hostname) &&
          target.pathname === "/api/feeds/offers.xml") ||
        (target.hostname === "apply.workable.com" &&
          /^\/api\/v1\/widget\/accounts\/[a-z0-9][a-z0-9-]{0,62}$/.test(
            target.pathname
          ))) &&
      (!init.method || init.method === "GET")
    // These providers document public GET feeds. The API host's
    // blanket crawler rule is not used as the contract for this API client.
    // No credentials/internal-posting access; 401/403/429 are still enforced.
    if (publicPostingApi) {
      const body = await request(url, 15_000_000, false, signal, init)
      if (format === "html") return body
      try {
        return JSON.parse(body) as unknown
      } catch {
        throw new ProbeFailure("invalid", "Provider returned invalid JSON")
      }
    }
    if (!robots.has(target.origin)) {
      const pending = request(
        `${target.origin}/robots.txt`,
        512_000,
        true,
        signal
      )
      robots.set(target.origin, pending)
      pending.catch(() => {
        if (robots.get(target.origin) === pending) robots.delete(target.origin)
      })
    }
    const rules = await robots.get(target.origin)!
    if (!robotsAllowed(rules, target.pathname + target.search))
      throw new ProbeFailure(
        "needs_review",
        "Provider robots rules exclude this path"
      )
    const body = await request(
      url,
      format === "json" ? 15_000_000 : 4_000_000,
      false,
      signal,
      init
    )
    if (format === "html") return body
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new ProbeFailure("invalid", "Provider returned invalid JSON")
    }
  }
}

// Extract just the JSON assignment; never evaluate employer-provided JavaScript.
export function ashbyOrganization(html: string) {
  const assignment = /window\.__appData\s*=\s*/.exec(html)
  if (!assignment) throw new Error("Ashby identity metadata unavailable")
  const start = assignment.index + assignment[0].length
  if (html[start] !== "{") throw new Error("Unexpected Ashby metadata")
  let depth = 0,
    quoted = false,
    escaped = false
  for (let i = start; i < html.length; i++) {
    const char = html[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) {
      return z
        .object({
          organization: z.object({
            name: z.string().trim().min(1).max(300),
            hostedJobsPageSlug: z.string(),
          }),
        })
        .parse(JSON.parse(html.slice(start, i + 1))).organization
    }
  }
  throw new Error("Incomplete Ashby metadata")
}

export function observedCompany(
  candidate: SourceCandidate,
  input: unknown,
  boardUrl = publicBoardUrl(candidate.kind, candidate.board)
) {
  if (candidate.kind === "greenhouse")
    return z.object({ name: z.string().trim().min(1).max(300) }).parse(input)
      .name
  if (typeof input !== "string")
    throw new Error("Board identity page unavailable")
  if (candidate.kind === "ashby") {
    const organization = ashbyOrganization(input)
    if (organization.hostedJobsPageSlug.toLowerCase() !== candidate.board)
      throw new Error("Board identity mismatch")
    return organization.name
  }
  const $ = load(input)
  const canonical = $("meta[property='og:url']").attr("content")
  const title = $("title").text().trim()
  if (
    !canonical ||
    new URL(canonical).origin +
      new URL(canonical).pathname.replace(/\/$/, "").toLowerCase() !==
      boardUrl
  )
    throw new Error("Lever canonical board mismatch")
  const ogTitle = $("meta[property='og:title']").attr("content")?.trim()
  if (
    !title ||
    title.length > 300 ||
    !ogTitle ||
    ![title.toLowerCase(), `${title} jobs`.toLowerCase()].includes(
      ogTitle.toLowerCase()
    ) ||
    /^(just a moment|access denied|error|jobs|careers)$/i.test(title)
  )
    throw new Error("Lever identity metadata unavailable")
  return title
}

function companyKey(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /\b(incorporated|inc|limited|ltd|llc|gmbh|corp|corporation)\b/g,
      ""
    )
    .replace(/[^\p{L}\p{N}]/gu, "")
}

// Source admission uses public posting evidence independently of the current
// catalog's profession policy. A raw location may name a country, but a city
// alone or an ambiguous state abbreviation is never country evidence.
function usableSourcePostings(postings: RawSourcePosting[]) {
  return postings.flatMap((posting) => {
    if (
      !posting.title.trim() ||
      !posting.company.trim() ||
      posting.description.trim().length < 100 ||
      !publicApplicationUrl(posting.url)
    )
      return []
    const countries = [
      ...new Set(
        [
          ...posting.countries.map((country) => explicitCountry(country)),
          ...posting.locations.flatMap((location) =>
            location
              .split(/[,;|]|\s+[-–—]\s+/)
              .map((part) => statedLocationCountry(part.trim()))
          ),
        ].filter((country): country is string => Boolean(country))
      ),
    ]
    return countries.length ? [{ ...posting, countries }] : []
  })
}

export async function validateCandidate(
  candidate: SourceCandidate,
  read = probeClient(),
  now = new Date(),
  signal?: AbortSignal,
  options: {
    config?: CatalogSource["config"]
    observeJobs?: (jobs: CatalogPosting[]) => void
  } = {}
): Promise<ValidationResult> {
  const base: ValidationResult = {
    status: "needs_review",
    company: null,
    countries: [],
    fetched_count: 0,
    accepted_count: 0,
    complete: false,
    next_attempt_at: new Date(now.getTime() + 86400000).toISOString(),
    reason: "",
    evidence: [],
  }
  try {
    const identity = boardIdentity(candidate.kind, candidate.board)
    if (identity.id !== candidate.id || identity.board !== candidate.board)
      throw new ProbeFailure("invalid", "Candidate identity is not canonical")
    const verification = connectors[candidate.kind].verification
    if (verification) {
      const observations: RawSourcePosting[] = []
      const snapshot = await fetchCatalogPage(
        { ...candidate, company: "", config: options.config },
        1,
        {
          signal,
          observePosting: (posting) => observations.push(posting),
          fetch: async (url, init) =>
            verification.responseFormat(new URL(String(url))) === "html"
              ? new Response(
                  String(await read(String(url), "html", signal, init))
                )
              : Response.json(await read(String(url), "json", signal, init)),
        }
      )
      base.company = snapshot.employer ?? null
      if (!snapshot.fetched)
        return {
          ...base,
          status: "empty",
          reason:
            "Recognized endpoint has no public postings; employer identity remains unverified",
        }
      if (!base.company || !snapshot.employerUrl || !snapshot.listingUrl)
        throw new Error("Employer identity unavailable")
      if (
        candidate.expected_company &&
        companyKey(candidate.expected_company) !==
          companyKey(candidate.board) &&
        companyKey(base.company) !== companyKey(candidate.expected_company)
      )
        throw new ProbeFailure(
          "needs_review",
          "Historical employer label differs from current board"
        )
      base.fetched_count = snapshot.fetched
      const usable = usableSourcePostings(observations)
      base.accepted_count = usable.length
      base.fresh_count = usable.filter(
        (job) =>
          job.postedAt &&
          Date.parse(job.postedAt) >= now.getTime() - 30 * 86400000 &&
          Date.parse(job.postedAt) <= now.getTime()
      ).length
      base.complete = snapshot.nextPage === null
      base.countries = [
        ...new Set(usable.flatMap((job) => job.countries)),
      ].sort()
      base.evidence = [
        { url: snapshot.employerUrl, kind: "provider_employer_identity" },
        {
          url: snapshot.listingUrl,
          kind: base.complete ? "complete_board_response" : "first_page_sample",
        },
      ]
      options.observeJobs?.(snapshot.jobs)
      return {
        ...base,
        status: usable.length ? "verified" : "needs_review",
        reason: usable.length
          ? "Provider identity and public postings verified"
          : "Public postings lack usable country and description evidence",
      }
    }
    const region =
      candidate.kind === "greenhouse" || candidate.kind === "lever"
        ? z
            .object({ region: z.enum(["us", "eu"]).optional() })
            .parse(options.config ?? {}).region
        : undefined
    const boardUrl = publicBoardUrl(candidate.kind, candidate.board).replace(
      region === "eu" ? /\.(greenhouse\.io|lever\.co)/ : /$^/,
      ".eu.$1"
    )
    const identityUrl =
      candidate.kind === "greenhouse"
        ? `https://boards-api.${region === "eu" ? "eu." : ""}greenhouse.io/v1/boards/${candidate.board}`
        : boardUrl
    const identityData = await read(
      identityUrl,
      candidate.kind === "greenhouse" ? "json" : "html",
      signal
    )
    base.company = observedCompany(candidate, identityData, boardUrl)
    base.evidence.push({ url: identityUrl, kind: "provider_employer_identity" })
    // A slug-as-label in a historical directory is not an independent company claim.
    if (
      base.company &&
      candidate.expected_company &&
      companyKey(candidate.expected_company) !== companyKey(candidate.board) &&
      companyKey(base.company) !== companyKey(candidate.expected_company)
    )
      throw new ProbeFailure(
        "needs_review",
        "Historical employer label differs from current board"
      )
    let url = ""
    let data: unknown
    const observations: RawSourcePosting[] = []
    const source: CatalogSource = {
      ...candidate,
      company: base.company,
      config: options.config,
    }
    const { jobs } = await fetchCatalogPage(source, 1, {
      signal,
      observePosting: (posting) => observations.push(posting),
      fetch: async (endpoint, init) => {
        url = String(endpoint)
        data = await read(url, "json", signal, init)
        return Response.json(data)
      },
    })
    const records =
      candidate.kind === "lever"
        ? (data as { hostedUrl: string }[])
        : (
            data as {
              jobs: {
                isListed?: boolean
                jobUrl?: string
                absolute_url?: string
              }[]
            }
          ).jobs
    const publicRecords =
      candidate.kind === "ashby"
        ? records.filter((r) => (r as { isListed?: boolean }).isListed === true)
        : records
    for (const record of publicRecords) {
      const row = record as {
        id?: number
        hostedUrl?: string
        jobUrl?: string
        absolute_url?: string
      }
      const posting = new URL(
        row.hostedUrl ?? row.jobUrl ?? row.absolute_url ?? ""
      )
      const hosts =
        candidate.kind === "greenhouse"
          ? region === "eu"
            ? ["boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io"]
            : ["boards.greenhouse.io", "job-boards.greenhouse.io"]
          : [new URL(boardUrl).hostname]
      const embeddedGreenhouseJob =
        candidate.kind === "greenhouse" &&
        posting.searchParams.get("gh_jid") === String(row.id) &&
        posting.hostname.includes(".") &&
        !isIP(posting.hostname.replace(/^\[|\]$/g, "")) &&
        !/\.(localhost|local|internal|invalid|test)$/.test(posting.hostname)
      if (
        posting.protocol !== "https:" ||
        posting.port ||
        posting.username ||
        posting.password ||
        (!embeddedGreenhouseJob &&
          (!hosts.includes(posting.hostname) ||
            posting.pathname.split("/")[1]?.toLowerCase() !== candidate.board))
      )
        throw new ProbeFailure(
          "needs_review",
          "Posting URLs need board identity review"
        )
    }
    base.fetched_count = publicRecords.length
    const usable = usableSourcePostings(observations)
    base.accepted_count = usable.length
    base.fresh_count = usable.filter(
      (job) =>
        job.postedAt &&
        Date.parse(job.postedAt) >= now.getTime() - 30 * 86400000 &&
        Date.parse(job.postedAt) <= now.getTime()
    ).length
    base.complete = candidate.kind !== "lever" || records.length < 100
    base.countries = [...new Set(usable.flatMap((job) => job.countries))].sort()
    base.evidence.push({
      url,
      kind: base.complete ? "complete_board_response" : "first_page_sample",
    })
    if (!publicRecords.length)
      return {
        ...base,
        status: "empty",
        reason: "Recognized board has no public postings",
      }
    if (!usable.length)
      return {
        ...base,
        status: "needs_review",
        reason:
          "Public postings could not produce usable country and description evidence",
      }
    options.observeJobs?.(jobs)
    return {
      ...base,
      status: "verified",
      reason: "Provider identity and public postings verified",
    }
  } catch (error) {
    if (error instanceof IncompleteAtsInventoryError)
      return { ...base, status: "needs_review", reason: error.message }
    if (error instanceof ProbeFailure)
      return {
        ...base,
        status: error.status,
        reason: error.message,
        next_attempt_at: error.retryAt ?? base.next_attempt_at,
      }
    return {
      ...base,
      status: "needs_review",
      reason: "Provider identity or response schema needs review",
    }
  }
}
