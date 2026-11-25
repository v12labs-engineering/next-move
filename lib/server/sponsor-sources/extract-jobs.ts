import * as cheerio from "cheerio"

import { crawlPage } from "./crawl-page"
import type { SourceType } from "@/lib/location/relocation-data"

export interface ExtractedJob {
  title: string
  url: string
  /** Which ATS / page type the job link came from. */
  ats: SourceType
}

/** Known ATS hosts and the URL shape of an individual job posting. */
const ATS_JOB_PATTERNS: Array<{ host: string; ats: SourceType; jobPath: RegExp }> = [
  { host: "greenhouse.io", ats: "greenhouse", jobPath: /\/jobs\/\d+/ },
  { host: "boards.greenhouse.io", ats: "greenhouse", jobPath: /\/[^/]+\/jobs\/\d+/ },
  { host: "lever.co", ats: "lever", jobPath: /\/[0-9a-f-]{8,}/i },
  { host: "ashbyhq.com", ats: "ashby", jobPath: /\/[0-9a-f-]{8,}/i },
  { host: "workable.com", ats: "workable", jobPath: /\/(?:j|view)\/[A-Z0-9]+/i },
  { host: "smartrecruiters.com", ats: "career_page", jobPath: /\/\d{6,}/ },
  { host: "teamtailor.com", ats: "career_page", jobPath: /\/jobs\/\d+/ },
  { host: "recruitee.com", ats: "career_page", jobPath: /\/o\/[^/]+/ },
]

/** Generic job-link signals when the host isn't a known ATS. */
const GENERIC_JOB_PATH =
  /(\/jobs?\/.+|\/vacanc(?:y|ies)\/.+|\/positions?\/.+|\/openings?\/.+|\/opportunit(?:y|ies)\/.+|gh_jid=|jobId=|job_id=|requisitionId=|reqId=)/i

const NON_JOB_PATH_SEGMENTS = new Set([
  "about",
  "benefits",
  "blog",
  "candidate",
  "career-and-development",
  "culture",
  "culture-inclusion-and-belonging",
  "early-career",
  "early-careers",
  "edge-early-career",
  "getting-hired",
  "how-we-hire",
  "internship",
  "internships",
  "life",
  "locations",
  "people",
  "students",
  "teams",
  "values",
  "working-at-falck",
])

/**
 * Pure link classifier — given the careers URL and the links discovered on it,
 * return likely individual job postings. Kept side-effect free so it can be
 * unit-tested against saved fixtures.
 */
export function selectJobLinks(
  careersUrl: string,
  links: string[],
  linkText: Record<string, string> = {}
): ExtractedJob[] {
  const seen = new Set<string>()
  const jobs: ExtractedJob[] = []

  for (const raw of links) {
    const url = absolute(careersUrl, raw)
    if (!url) continue
    const host = safeHost(url)
    if (!host) continue

    let ats: SourceType | null = null
    const atsMatch = ATS_JOB_PATTERNS.find(
      (p) => host.includes(p.host) && p.jobPath.test(url)
    )
    if (atsMatch) {
      ats = atsMatch.ats
    } else if (looksLikeGenericJobPosting(url)) {
      ats = "career_page"
    }
    if (!ats) continue

    if (seen.has(url)) continue
    seen.add(url)

    const derived = deriveTitle(url)
    const title = (linkText[raw] ?? linkText[url] ?? derived ?? "").trim()
    // Numeric-id ATS postings (e.g. greenhouse /jobs/4012345) derive to an
    // empty slug title; keep them with a placeholder rather than dropping a
    // real posting. The title gets enriched later by the pipeline if needed.
    jobs.push({ title: title.length >= 3 ? title : "Open role", url, ats })
  }

  return jobs
}

/** Live: crawl a careers page and extract job postings from its links. */
export async function extractJobsFromCareers(
  careersUrl: string,
  limit = 25
): Promise<ExtractedJob[]> {
  if (!careersUrl || careersUrl === "#") return []
  const page = await crawlPage(careersUrl)
  const base = page.finalUrl || careersUrl
  // Pull anchor text from the HTML so postings get real titles instead of
  // opaque ATS slugs/ids. Falls back to crawler links if HTML is unavailable.
  const linkText = anchorTextMap(base, page.html ?? "")
  const links = page.html ? Object.keys(linkText) : page.links ?? []
  const jobs = selectJobLinks(base, links, linkText)
  return jobs.slice(0, limit)
}

/** Map absolute href -> visible anchor text from a page's HTML. */
function anchorTextMap(base: string, html: string): Record<string, string> {
  if (!html) return {}
  const $ = cheerio.load(html)
  const map: Record<string, string> = {}
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? ""
    const abs = absolute(base, href)
    if (!abs) return
    const text = $(a).text().replace(/\s+/g, " ").trim()
    if (text && (!map[abs] || map[abs].length < text.length)) map[abs] = text
  })
  return map
}

function isListingIndex(url: string): boolean {
  // The careers index itself (/careers, /jobs) is not a single posting.
  if (/\/(careers?|jobs|vacancies|openings)\/?($|\?)/i.test(url)) return true
  // Filtered/search result pages are still listings. They often look like
  // careers URLs but only encode faceted navigation state.
  if (/[?&][^=]*(jobs-index|refinementList|query|location|department)[^=]*=/i.test(url)) {
    return true
  }
  if (/#careers?-?all/i.test(url)) return true
  // Job-board navigation/aggregation paths (e.g. arbeitnow /jobs/locations/*,
  // /jobs/companies, /jobs/tags/*) are listings, not individual postings.
  if (/\/jobs\/(locations|companies|countries|tags|categories)(\/|$|\?)/i.test(url)) {
    return true
  }
  return false
}

function looksLikeGenericJobPosting(url: string): boolean {
  if (!GENERIC_JOB_PATH.test(url) || isListingIndex(url) || hasNonJobPath(url)) {
    return false
  }

  try {
    const parsed = new URL(url)
    const segments = parsed.pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean)
    const last = segments.at(-1) ?? ""

    if (/\d{4,}/.test(last)) return true
    return /(engineer|developer|architect|manager|designer|analyst|scientist|consultant|specialist|director|lead|principal|staff|senior|software|data|product|devops|platform|security)/i.test(
      last
    )
  } catch {
    return false
  }
}

function hasNonJobPath(url: string): boolean {
  try {
    const segments = new URL(url).pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase().replace(/\.html?$/, ""))
      .filter(Boolean)
    return segments.some((segment) => NON_JOB_PATH_SEGMENTS.has(segment))
  } catch {
    return true
  }
}

function deriveTitle(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "")
    const slug = path.split("/").filter(Boolean).pop() ?? ""
    return slug
      .replace(/[-_]+/g, " ")
      .replace(/\d{4,}/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
  } catch {
    return ""
  }
}

function absolute(base: string, href: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return ""
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}
