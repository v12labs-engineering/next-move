import { gunzipSync } from "node:zlib"
import { load } from "cheerio"
import { publicApplicationUrl } from "@/lib/applications/url"
import { publicRequestGuard } from "@/lib/server/applications/network"
import { readBounded } from "@/lib/server/catalog/discovery/seeds"
import { robotsAllowed } from "@/lib/server/catalog/discovery/validate"
import { boardFromUrl } from "@/lib/server/catalog/source-identity"

const careerPath =
  /\/(?:careers?|carrers?|jobs?|job-openings|current-openings|vacancies|recruitment|employment|join-us|join-our-team|work-with-us)(?=[/._-]|$)/i
const careerHost = /^(?:careers?|carrers?|jobs|recruitment)\./i
const careerLanding =
  /\/(?:careers?|carrers?|jobs|join-us|join-our-team|work-with-us|vacancies|recruitment|employment|job-openings|current[-_]openings?)(?:\.[a-z]+)?\/?$/i
const careerHeading =
  /(?:^jobs\b|\b(?:careers?|carrers?|(?:jobs?|employment) (?:openings?|opportunities|listings)|current (?:job )?openings?|vacancies|recruitment (?:openings|notices|notifications)|join (?:us|our team)|work with us|open (?:roles|positions))\b)/i
const hiring =
  /\b(?:job (?:openings?|positions?|vacancies|opportunities|listings)|current (?:job )?openings?|open (?:positions|roles)|vacancies|we(?: are|'re) hiring|join our (?:team|company)|work with us|work for us|(?:submit|send|upload|share|attach) (?:us )?(?:your )?(?:cv|r[eé]sum[eé])|apply for (?:a |the )?(?:job|role|position)|no (?:current )?openings)\b/i
const companyPath =
  /\/(?:about(?:-us|-company)?|contact(?:-us)?|company|who-we-are|legal)(?:[/._-]|$)/i
const blockedPath =
  /(?:^|\/)(?:login|log-in|sign-?in|sso|authenticate|candidate-login)(?:[/._-]|$)/i
const blockedHeading =
  /^(?:please )?(?:log ?in|sign in|authentication required|access denied|just a moment|request rejected|forbidden|page not found|404\b|domain parking|website for sale)\b/i
const commonPaths = [
  "/career",
  "/careers",
  "/carrer",
  "/jobs",
  "/join-us",
  "/work-with-us",
  "/carrers",
  "/career.html",
  "/careers.html",
  "/carrer.html",
  "/career.php",
  "/careers.php",
  "/career.aspx",
]
const subdomains = ["career", "careers", "carrer", "jobs"]
const hostKey = (url: URL) => url.hostname.replace(/^www\./, "")

function publicUrl(value: string, base?: URL) {
  const url = URL.parse(value, base)
  if (!url || !publicApplicationUrl(url.href)) return null
  url.hash = ""
  return url
}

function companyKey(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bpvt\b/g, "private")
    .replace(/\bltd\b/g, "limited")
    .replace(/[^\p{L}\p{N}]/gu, "")
}

function belongsToCompany(url: URL, domain: string) {
  return hostKey(url) === domain || url.hostname.endsWith("." + domain)
}

type CareerLink = { url: string; evidence: string; method: string }
type Check = {
  links: CareerLink[]
  result: string
  websiteEvidence: string | null
}
type Page = { body: string; url: URL }

function hiringContent(body: string, url: URL) {
  const $ = load(body)
  const title = $("title").text().trim()
  $("header,footer,nav,[role='navigation'],script,style").remove()
  const region = $("main").length ? $("main") : $("body")
  const headings = region
    .find("h1,h2")
    .toArray()
    .map((el) => $(el).text().trim())
  const blocked =
    [title, headings[0] ?? ""].some((value) => blockedHeading.test(value)) ||
    region.find("form input[type='password']").length > 0
  const blocks = region
    .find("p,h3,h4,h5,h6,button")
    .toArray()
    .map((el) => $(el).text())
  const text = [region.text(), ...headings, ...blocks]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  const dedicated =
    careerLanding.test(url.pathname) ||
    (url.pathname === "/" && careerHost.test(url.hostname))
  // Job detail titles often append the employer's careers section to the role.
  const relevantHeading =
    [dedicated ? title : title.split(/[|–—]/, 1)[0], ...headings].some(
      (heading) => careerHeading.test(heading)
    ) ||
    (dedicated && /\brecruitment\b/i.test([title, ...headings].join(" ")))
  const application =
    dedicated &&
    /\b(?:apply (?:now|here|online)|submit your application|r[eé]sum[eé]|current vacancies|available positions)\b/i.test(
      text
    )
  return {
    text,
    verified:
      !blocked &&
      text.length >= 40 &&
      relevantHeading &&
      (hiring.test(text) || application),
  }
}

export function showsPublicCareers(body: string, url: URL) {
  return hiringContent(body, url).verified
}

export async function probeEmployerCareers(
  site: {
    url: string
    legalName: string
    registrationId: string
    verified: boolean
  },
  options: { fetch?: typeof fetch; guard?: (url: string) => Promise<void> } = {}
): Promise<Check> {
  const start = publicUrl(site.url)
  const links = new Map<string, CareerLink>()
  let websiteEvidence: string | null = null
  const finish = (result: string): Check => ({
    links: [...links.values()],
    result,
    websiteEvidence,
  })
  if (!start) return finish("website_unavailable")
  const deadline = Date.now() + 24_000
  const transport = options.fetch ?? fetch
  const guard = options.guard ?? publicRequestGuard()
  const robotsCache = new Map<string, Promise<string | null>>()
  const rateLimited = new Set<string>()

  async function read(
    url: URL,
    kind: "page" | "robots" | "sitemap",
    allowed: (destination: URL) => boolean,
    redirects = 0
  ): Promise<Page | null> {
    if (
      !allowed(url) ||
      redirects > 3 ||
      rateLimited.has(url.origin) ||
      Date.now() >= deadline
    )
      return null
    if (kind === "page" && blockedPath.test(url.pathname)) return null
    try {
      await guard(url.href)
      if (kind !== "robots") {
        const rules = await rulesFor(url)
        if (rules === null || !robotsAllowed(rules, url.pathname + url.search))
          return null
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      const response = await transport(url.href, {
        redirect: "manual",
        headers: { "User-Agent": "JobSearchCatalog/1.0" },
        signal: AbortSignal.timeout(Math.min(remaining, 3_500)),
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const next = publicUrl(response.headers.get("location") ?? "", url)
        return next && next.href !== url.href
          ? read(next, kind, allowed, redirects + 1)
          : null
      }
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 429) rateLimited.add(url.origin)
        if (
          kind === "robots" &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        )
          return { body: "", url }
        return null
      }
      if (
        kind === "page" &&
        !/text\/html|application\/xhtml\+xml/i.test(
          response.headers.get("content-type") ?? ""
        )
      ) {
        await response.body?.cancel()
        return null
      }
      const bytes = await readBounded(
        response,
        kind === "robots" ? 512_000 : 2_000_000
      )
      const body =
        kind === "sitemap" && bytes[0] === 0x1f && bytes[1] === 0x8b
          ? gunzipSync(bytes, { maxOutputLength: 2_000_000 })
          : bytes
      return { body: body.toString("utf8"), url }
    } catch {
      return null
    }
  }

  async function rulesFor(url: URL) {
    if (!robotsCache.has(url.origin)) {
      const result = read(
        new URL("/robots.txt", url),
        "robots",
        (next) => hostKey(next) === hostKey(url)
      ).then((page) => page?.body ?? null)
      robotsCache.set(url.origin, result)
    }
    return robotsCache.get(url.origin)!
  }

  const legalName = companyKey(site.legalName)
  const companyId = companyKey(site.registrationId)
  function showsIdentity(page: Page, detailed: boolean) {
    const $ = load(page.body)
    if (blockedHeading.test($("title").text().trim())) return false
    const values = $(
      "title,h1,address,footer,[id*='footer'],[class*='footer'],[itemprop='legalName']"
    )
      .toArray()
      .map((element) => $(element).text())
    if (detailed) values.push($("main,article").text() || $("body").text())
    return values.some((value) => {
      const key = companyKey(value)
      return (
        (companyId.length > 10 && key.includes(companyId)) ||
        (legalName.length > 5 && key.includes(legalName))
      )
    })
  }

  const homepage = await read(start, "page", () => true)
  const home = homepage?.url ?? start
  const domain = hostKey(home)
  const sameSite = (url: URL) => belongsToCompany(url, domain)
  const sources: Page[] = homepage ? [homepage] : []
  const previouslyVerified =
    site.verified && belongsToCompany(home, hostKey(start))
  if (!previouslyVerified) {
    if (!homepage) return finish("website_unavailable")
    if (showsIdentity(homepage, companyPath.test(home.pathname))) {
      websiteEvidence = homepage.url.href
    } else {
      const $ = load(homepage.body)
      const about = new Map<string, URL>()
      for (const el of $("a[href]")) {
        const url = publicUrl($(el).attr("href") ?? "", home)
        if (
          url &&
          sameSite(url) &&
          companyPath.test(url.pathname) &&
          url.href !== home.href
        )
          about.set(url.href, url)
      }
      for (const url of [...about.values()].slice(0, 2)) {
        const page = await read(url, "page", sameSite)
        if (!page) continue
        sources.push(page)
        if (showsIdentity(page, true)) {
          websiteEvidence = page.url.href
          break
        }
      }
    }
    if (!websiteEvidence) return finish("website_identity_unconfirmed")
  }

  const attempted = new Set<string>()
  const homeContent = homepage ? hiringContent(homepage.body, home) : null
  if (
    homepage &&
    homeContent &&
    (careerPath.test(home.pathname) || careerHost.test(home.hostname)) &&
    homeContent.verified
  ) {
    links.set(home.href, {
      url: home.href,
      evidence: start.href,
      method: "Public careers page verified at employer URL",
    })
  }
  async function confirm(url: URL, evidence: string, method: string) {
    if (attempted.has(url.href)) return
    attempted.add(url.href)
    const permitted = (target: URL) =>
      sameSite(target) || Boolean(boardFromUrl(target.href))
    const page = await read(url, "page", permitted)
    if (!page || page.url.href === home.href) return
    const content = hiringContent(page.body, page.url)
    if (content.text === homeContent?.text || !content.verified) return
    links.set(page.url.href, { url: page.url.href, evidence, method })
  }

  const published = new Map<string, { url: URL; evidence: string }>()
  for (const source of sources) {
    const $ = load(source.body)
    for (const el of $("a[href],iframe[src]")) {
      const url = publicUrl(
        $(el).attr("href") ?? $(el).attr("src") ?? "",
        source.url
      )
      if (!url || url.href === source.url.href) continue
      const label = ($(el).attr("aria-label") ?? $(el).text()).trim()
      if (
        (sameSite(url) &&
          (careerPath.test(url.pathname) ||
            careerHost.test(url.hostname) ||
            careerHeading.test(label))) ||
        (boardFromUrl(url.href) &&
          (careerHeading.test(label) || el.name === "iframe"))
      )
        published.set(url.href, { url, evidence: source.url.href })
    }
  }
  for (const { url, evidence } of [...published.values()].slice(0, 8))
    await confirm(url, evidence, "Link published by employer")

  if (!links.size && homepage) {
    const rules = await rulesFor(home)
    const sitemapURLs = [...(rules ?? "").matchAll(/^sitemap:\s*(\S+)/gim)]
      .map((match) => publicUrl(match[1], home))
      .filter((url): url is URL => !!url && sameSite(url))
    if (!sitemapURLs.length) sitemapURLs.push(new URL("/sitemap.xml", home))
    const seen = new Set<string>()
    for (const url of sitemapURLs) {
      if (seen.size >= 3 || links.size) break
      if (seen.has(url.href)) continue
      seen.add(url.href)
      const map = await read(url, "sitemap", sameSite)
      if (!map || !/<(?:urlset|sitemapindex)\b/i.test(map.body)) continue
      const $ = load(map.body, { xml: true })
      const pages = $("urlset url > loc")
        .toArray()
        .map((el) => publicUrl($(el).text().trim(), map.url))
      for (const page of pages
        .filter(
          (value): value is URL =>
            !!value && sameSite(value) && careerPath.test(value.pathname)
        )
        .slice(0, 6))
        await confirm(page, map.url.href, "URL published in employer sitemap")
      const children = $("sitemapindex sitemap > loc")
        .toArray()
        .map((el) => publicUrl($(el).text().trim(), map.url))
      sitemapURLs.push(
        ...children
          .filter(
            (value): value is URL =>
              !!value &&
              sameSite(value) &&
              /(?:career|job|page|sitemap[_.-])/.test(value.pathname)
          )
          .slice(0, 4)
      )
    }
  }

  if (!links.size) {
    // Subdomains are independent origins. Stop probing fallbacks once an employer
    // site has yielded a public careers page.
    const seeds = [
      ...commonPaths.slice(0, 4).map((path) => new URL(path, home)),
      ...subdomains.map((label) => new URL("https://" + label + "." + domain)),
      ...commonPaths.slice(4).map((path) => new URL(path, home)),
    ]
    for (const url of seeds) {
      await confirm(
        url,
        url.href,
        "Public careers page verified at employer URL"
      )
      if (links.size || Date.now() >= deadline) break
    }
  }
  if (links.size) return finish("public_careers_found")
  if (!homepage || rateLimited.size || Date.now() >= deadline)
    return finish("check_incomplete")
  return finish("no_public_careers_found")
}
