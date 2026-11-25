import { crawlPage } from "./crawl-page"

/** Common careers-page paths to probe when a homepage has no obvious link. */
const CAREERS_PATH_HINTS = [
  "/careers",
  "/career",
  "/jobs",
  "/join-us",
  "/join",
  "/work-with-us",
  "/vacancies",
  "/en/careers",
  "/about/careers",
  "/company/careers",
]

const CAREERS_LINK_RE = /(career|jobs?|join|vacanc|werken-bij|stellenangebote|hiring)/i

/** Legal-form suffixes to strip before guessing a domain from a company name. */
const LEGAL_SUFFIX_RE =
  /\b(b\.?v\.?|n\.?v\.?|a\/s|gmbh|ltd|limited|inc|llc|llp|co\.?|kg|holding|holdings|group|nederland|netherlands|ireland|japan|europe|eu)\b/gi

/**
 * Resolve a company website by guessing likely domains from the name and
 * verifying each with a real fetch. Avoids search-engine scraping (rate-limited
 * and brittle). Returns "" if no candidate responds.
 */
export async function resolveWebsite(
  name: string,
  tlds: string[] = [".com", ".io", ".ai", ".net", ".nl", ".dk", ".ie", ".co", ".de", ".se"]
): Promise<string> {
  const words = name
    .replace(LEGAL_SUFFIX_RE, " ")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return ""

  // Try the full slug first, then the first significant word — many companies
  // use a short brand domain (e.g. "Juniper Networks" -> juniper.net).
  const slugs = [words.join("").toLowerCase()]
  if (words.length > 1 && words[0].length >= 4) slugs.push(words[0].toLowerCase())

  for (const slug of slugs) {
    if (slug.length < 2) continue
    for (const tld of tlds) {
      const candidate = `https://${slug}${tld}`
      const page = await crawlPage(candidate).catch(() => null)
      if (page && (page.status == null || page.status < 400) && (page.html?.length ?? 0) > 500) {
        return page.finalUrl || candidate
      }
    }
  }
  return ""
}

/**
 * Find a company's careers page from its website.
 *
 * Strategy (no search-engine scraping — that gets rate-limited):
 *  1. crawl the homepage and look for an in-page careers link
 *  2. probe well-known careers paths
 * Returns "" if nothing is found (caller decides what to do).
 */
export async function resolveCareersUrl(website: string): Promise<string> {
  if (!website) return ""

  const home = await crawlPage(website).catch(() => null)
  if (home) {
    const fromLinks = pickCareersLink(home.finalUrl || website, home.links ?? [])
    if (fromLinks) return fromLinks
  }

  const origin = safeOrigin(website)
  if (origin) {
    for (const hint of CAREERS_PATH_HINTS) {
      const candidate = `${origin}${hint}`
      const probe = await crawlPage(candidate).catch(() => null)
      if (probe && (probe.status == null || probe.status < 400)) {
        // A real careers page tends to have job-ish links or relevant title.
        if (
          CAREERS_LINK_RE.test(probe.title ?? "") ||
          (probe.links ?? []).some((l) => CAREERS_LINK_RE.test(l))
        ) {
          return probe.finalUrl || candidate
        }
      }
    }
  }

  return ""
}

export function pickCareersLink(base: string, links: string[]): string {
  for (const raw of links) {
    const url = absolute(base, raw)
    if (!url) continue
    if (CAREERS_LINK_RE.test(url)) return url
  }
  return ""
}

/** Normalize a possibly-bare website string into an https origin. */
export function normalizeWebsite(value: string): string {
  if (!value) return ""
  const withScheme = value.startsWith("http") ? value : `https://${value}`
  try {
    const u = new URL(withScheme)
    return u.toString().replace(/\/$/, "")
  } catch {
    return ""
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).origin
  } catch {
    return null
  }
}

function absolute(base: string, href: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return ""
  }
}
