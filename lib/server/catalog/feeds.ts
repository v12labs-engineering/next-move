import { createHash } from "node:crypto"
import { load } from "cheerio"
import { countryName } from "@/lib/location/countries"
import { sanitizeJobTitle } from "@/lib/jobs/title"
import { isCatalogRole, type JobCategory } from "@/lib/jobs/categories"
import { postingSponsorship } from "@/lib/jobs/sponsorship"
import type { JobPostingDetails } from "@/lib/jobs/posting-details"
import { postingDetails, type PostedFields } from "./posting-details"
import type { DescriptionRef } from "./content"
import type { ConnectorKind } from "./connectors/index"
import type { BoardIndexRefresh } from "./connectors/board-index"

export const catalogSources = [
  { id: "ashby:n8n", kind: "ashby", company: "n8n", board: "n8n" },
  { id: "ashby:deepl", kind: "ashby", company: "DeepL", board: "deepl" },
  {
    id: "ashby:mistral.ai",
    kind: "ashby",
    company: "Mistral AI",
    board: "mistral.ai",
  },
  {
    id: "ashby:elevenlabs",
    kind: "ashby",
    company: "ElevenLabs",
    board: "elevenlabs",
  },
  { id: "ashby:linear", kind: "ashby", company: "Linear", board: "linear" },
  { id: "arbeitnow", kind: "arbeitnow", company: "Arbeitnow", board: null },
  {
    id: "greenhouse:newrelic",
    kind: "greenhouse",
    company: "New Relic",
    board: "newrelic",
  },
  {
    id: "greenhouse:deliveroo",
    kind: "greenhouse",
    company: "Deliveroo",
    board: "deliveroo",
  },
] as const
export interface CatalogSource {
  id: string
  kind: ConnectorKind | "alexandria"
  company: string
  board: string | null
  config?: unknown
}
export interface CatalogPosting {
  id: string
  title: string
  company: string
  country: string
  city: string | null
  url: string
  description: string
  description_ref?: DescriptionRef | null
  posting_details?: JobPostingDetails | null
  work_mode: "remote" | "hybrid" | "onsite" | "unknown"
  visa_signal: "confirmed" | "possible" | "no"
  sponsorship_evidence: string
  sponsor_verified: boolean
  source: string
  posted_at: string | null
}
/** Source facts for research consumers, before catalog eligibility filtering. */
export interface RawSourcePosting {
  title: string
  company: string
  url: string
  description: string
  locations: string[]
  countries: string[]
  postedAt: string | null
}
const countryAliases: Record<string, string> = {
  de: "Germany",
  deu: "Germany",
  germany: "Germany",
  deutschland: "Germany",
  nl: "Netherlands",
  nld: "Netherlands",
  netherlands: "Netherlands",
  ie: "Ireland",
  irl: "Ireland",
  ireland: "Ireland",
  dk: "Denmark",
  dnk: "Denmark",
  denmark: "Denmark",
  se: "Sweden",
  swe: "Sweden",
  sweden: "Sweden",
  au: "Australia",
  aus: "Australia",
  australia: "Australia",
  jp: "Japan",
  jpn: "Japan",
  japan: "Japan",
  ind: "India",
  ae: "UAE",
  are: "UAE",
  uae: "UAE",
  "united arab emirates": "UAE",
}
export function explicitCountry(value: string | undefined) {
  return value
    ? (countryName(value) ?? countryAliases[value.trim().toLowerCase()])
    : undefined
}

// A free-text location's trailing region is not a structured country field:
// Atlanta, GA must not become Gabon; Georgia may mean the US state.
export function statedLocationCountry(value: string | undefined) {
  const text = value?.trim()
  if (
    !text ||
    (/^[a-z]{2}$/i.test(text) && !/^(us|uk)$/i.test(text)) ||
    /^georgia$/i.test(text)
  )
    return undefined
  return explicitCountry(text)
}
export function plain(html: string) {
  // Greenhouse sometimes entity-encodes the entire HTML document. Decode that
  // wrapper before walking blocks; text() first would erase section boundaries.
  let input = html
  for (
    let depth = 0;
    depth < 2 &&
    /&(?:amp;)?lt;\s*\/?(?:p|div|h[1-6]|ul|ol|li|br|section)\b/i.test(input);
    depth++
  )
    input = load(input).text()
  const $ = load(input)
  $("script,style").remove()
  $("br").replaceWith("\n")
  $(
    "p,div,h1,h2,h3,h4,h5,h6,li,ul,ol,section,article,blockquote,tr,dt,dd"
  ).each((_, element) => {
    $(element).before("\n").after("\n")
  })
  return $.root()
    .text()
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 60000)
}
export function catalogPosting(
  {
    stated,
    ...args
  }: Omit<
    CatalogPosting,
    | "id"
    | "visa_signal"
    | "sponsorship_evidence"
    | "sponsor_verified"
    | "posting_details"
  > & { stated?: PostedFields },
  locationKey?: string,
  jobCategories: readonly JobCategory[] = ["software"]
): CatalogPosting | null {
  let url: URL
  try {
    url = new URL(args.url)
  } catch {
    return null
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    args.description.length < 100 ||
    !args.title.trim() ||
    !args.company.trim()
  )
    return null
  if (!isCatalogRole(args.title, args.description, jobCategories)) return null
  const visa = postingSponsorship(args.description, args.country)
  const details = postingDetails(args.description, args.country, stated)
  return {
    ...args,
    ...(details ? { posting_details: details } : {}),
    title: sanitizeJobTitle(args.title).slice(0, 300),
    id: createHash("sha256")
      .update(
        `${args.source}\n${args.url}\n${args.country}${locationKey ? `\n${locationKey}` : ""}`
      )
      .digest("hex"),
    visa_signal: visa.signal,
    sponsorship_evidence: visa.evidence,
    sponsor_verified: false,
  }
}
export function catalogDate(value: string | number | undefined) {
  if (value === undefined) return null
  const d = new Date(typeof value === "number" ? value * 1000 : value)
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86400000
    ? null
    : d.toISOString()
}
export interface FetchOptions {
  /** Catalog policy only; source observations always retain every profession. */
  jobCategories?: readonly JobCategory[]
  maxResponseBytes?: number
  /** Retries for network errors, 429 and 5xx. Defaults to 2. */
  retries?: number
  fetch?: typeof fetch
  timeoutMs?: number
  onRequest?: () => void
  signal?: AbortSignal
  snapshotStartedAt?: string
  boardIndexRefresh?: BoardIndexRefresh
  /** Research observer only; returned catalog rows still use normal eligibility. */
  observePosting?: (posting: RawSourcePosting) => void
}

export class CatalogSourceError extends Error {
  constructor(
    message: string,
    readonly retryAt: string
  ) {
    super(message)
  }
}

export async function catalogJson(
  url: string,
  options: FetchOptions,
  init: RequestInit = {}
) {
  return JSON.parse(await catalogText(url, options, init)) as unknown
}

function catalogHeaders(overrides: HeadersInit | undefined) {
  const headers = new Headers({
    Accept:
      "application/json, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
  })
  new Headers(overrides).forEach((value, key) => headers.set(key, value))
  headers.set("User-Agent", "JobSearchCatalog/1.0")
  return headers
}

export async function catalogText(
  url: string,
  options: FetchOptions,
  init: RequestInit = {}
) {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted()
    options.onRequest?.()
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        headers: catalogHeaders(init.headers),
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(
            Math.max(1, Math.min(options.timeoutMs ?? 20000, 30000))
          ),
        ]),
        cache: "no-store",
      })
    } catch (error) {
      if (options.signal?.aborted || attempt >= (options.retries ?? 2))
        throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      const retry = response.headers.get("retry-after")
      const delay =
        retry === null
          ? 500 * 2 ** attempt
          : /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now()
      if (
        attempt < (options.retries ?? 2) &&
        (response.status === 429 || response.status >= 500) &&
        Number.isFinite(delay) &&
        delay <= 10000
      ) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)))
        continue
      }
      const retryTime = new Date(
        Date.now() +
          (retry !== null && Number.isFinite(delay)
            ? Math.max(60000, delay)
            : 15 * 60000)
      )
      throw new CatalogSourceError(
        `Source HTTP ${response.status}`,
        Number.isNaN(retryTime.getTime())
          ? new Date(Date.now() + 15 * 60000).toISOString()
          : retryTime.toISOString()
      )
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Source returned no body")
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > (options.maxResponseBytes ?? 15000000)) {
        await reader.cancel()
        throw new Error("Source exceeded size limit")
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  }
}

export { fetchCatalogPage } from "./connectors/index"
