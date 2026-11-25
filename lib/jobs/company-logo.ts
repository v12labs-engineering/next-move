// Hiring platforms and job boards: their favicon is not the employer's logo.
const PLATFORM_HOSTS =
  /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|workday\.com|recruitee\.com|personio\.(?:de|com)|teamtailor\.com|bamboohr\.com|jobvite\.com|icims\.com|breezy\.hr|join\.com|arbeitnow\.com|linkedin\.com|indeed\.[a-z.]+|adzuna\.[a-z.]+|glassdoor\.[a-z.]+|remotive\.com|weworkremotely\.com|wellfound\.com|successfactors\.[a-z.]+|taleo\.net|oraclecloud\.com|jobs\.ch|stepstone\.[a-z.]+|naukri\.com|google\.com)$/i

// Platforms that name the employer in the first path segment, not a subdomain.
const PATH_SLUG_HOSTS =
  /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|apply\.workable\.com|smartrecruiters\.com|join\.com)$/i

const LEGAL_SUFFIX =
  /\b(?:llc|l\.l\.c|inc|incorporated|ltd|limited|gmbh|ag|bv|b\.v|nv|sa|s\.a|sas|srl|s\.r\.l|sl|s\.l|plc|corp|corporation|co|company|pvt|private|pte|oy|ab|as|aps|kk|pty|group|holdings?)\.?$/i

/** Employer domain from a job URL on the company's own site, else null. */
export function companyDomain(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (PLATFORM_HOSTS.test(host)) return null
    return host.replace(/^(?:www|careers?|jobs|apply|boards?)\./, "")
  } catch {
    return null
  }
}

/** Employer slug from a hiring-platform URL (boards.greenhouse.io/acme → acme). */
export function platformSlug(url: string) {
  try {
    const { hostname, pathname } = new URL(url)
    const host = hostname.toLowerCase()
    if (!PLATFORM_HOSTS.test(host)) return null
    const slug = PATH_SLUG_HOSTS.test(host)
      ? pathname.split("/").filter(Boolean)[0]
      : host.split(".")[0]
    return slug &&
      /^[a-z0-9-]{2,}$/i.test(slug) &&
      !/^(?:www|jobs|boards|apply|careers)$/i.test(slug)
      ? slug.toLowerCase()
      : null
  } catch {
    return null
  }
}

/** Company name reduced to a domain label: "Crunchyroll, LLC" → "crunchyroll". */
export function nameSlug(name: string) {
  let base = name.toLowerCase().replace(/[,()]/g, " ").trim()
  for (let previous = ""; previous !== base; ) {
    previous = base
    base = base.replace(LEGAL_SUFFIX, "").trim()
  }
  return base.normalize("NFKD").replace(/[^a-z0-9]/g, "")
}

/** Domains to try for a logo, best guess first. */
export function logoCandidates(name: string, hint?: string | null) {
  const domains: string[] = []
  if (hint?.includes(".")) domains.push(hint)
  for (const slug of new Set([nameSlug(name), hint?.includes(".") ? "" : hint]))
    if (slug && slug.length >= 2)
      for (const tld of ["com", "io", "co", "ai"])
        domains.push(`${slug}.${tld}`)
  return [...new Set(domains)].slice(0, 9)
}
