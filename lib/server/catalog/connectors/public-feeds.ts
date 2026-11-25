import { load } from "cheerio"
import { publicApplicationUrl } from "@/lib/applications/url"
import { explicitCountry, plain, type RawSourcePosting } from "../feeds"

export type PublicFeedKind =
  | "himalayas"
  | "remote-ok"
  | "remotive"
  | "jobicy"
  | "xml"
export interface PublicFeedPosting extends RawSourcePosting {
  evidence: string
  expiresAt: string | null
  locationRestrictions?: string[]
  timezoneRestrictions?: string[]
}
export interface PublicFeedPage {
  postings: PublicFeedPosting[]
  details: URL[]
  next: URL | null
  window: string | null
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "")
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value == null ? [] : [value]

function feedDate(value: unknown) {
  if (typeof value !== "number") return str(value) || null
  const date = new Date(value * 1000)
  return Number.isFinite(+date) ? date.toISOString() : null
}

function publicUrl(value: string, base: URL) {
  if (!value || /^\s*#/.test(value)) return null
  const url = URL.parse(value, base)
  if (!url || !publicApplicationUrl(url.href)) return null
  url.hash = ""
  return url
}

function samePublisher(url: URL, page: URL) {
  const host = (value: URL) =>
    value.hostname.replace(
      /^(?:www\.|careers?\.|carrers?\.|jobs\.|recruitment\.)/i,
      ""
    )
  return host(url) === host(page) || url.hostname.endsWith("." + host(page))
}

/** Parse publisher facts only. Country, profession, freshness and eligibility
 * policies belong to consumers; a published feed window is never a full census. */
export function parsePublicFeed(
  body: string,
  page: URL,
  config: { kind: PublicFeedKind; publisher: string }
): PublicFeedPage {
  const postings: PublicFeedPosting[] = []
  const details: URL[] = []
  let next: URL | null = null
  function add(input: {
    title: string
    company: string
    url: string
    location: string
    postedAt?: unknown
    description: string
    expiresAt?: unknown
    evidence?: string
    countries?: string[]
    locationRestrictions?: string[]
    timezoneRestrictions?: string[]
  }) {
    const url = publicUrl(input.url, page)
    const evidence = publicUrl(input.evidence ?? input.url, page)
    if (!url || !evidence || !samePublisher(url, page)) return
    postings.push({
      title: input.title,
      company: input.company,
      url: url.href,
      description: plain(input.description),
      locations: input.location ? [input.location] : [],
      countries: input.countries ?? [],
      postedAt: feedDate(input.postedAt),
      expiresAt: feedDate(input.expiresAt),
      evidence: evidence.href,
      ...(input.locationRestrictions
        ? { locationRestrictions: input.locationRestrictions }
        : {}),
      ...(input.timezoneRestrictions
        ? { timezoneRestrictions: input.timezoneRestrictions }
        : {}),
    })
  }
  if (config.kind === "xml") {
    const $ = load(body, { xml: true })
    if (!$("rss channel, feed").length)
      throw new Error("Expected a public job feed")
    for (const element of $("rss channel > item, feed > entry")) {
      const entry = $(element)
      const value = (key: string) => entry.children(key).first().text().trim()
      const url = publicUrl(
        entry.children("link").first().attr("href") ?? value("link"),
        page
      )
      if (!url || !samePublisher(url, page)) continue
      const rawTitle = value("title")
      const content = value("content") || value("description")
      if (config.publisher === "FOSS United") {
        if (
          url.origin !== page.origin ||
          !/^\/jobs\/[a-z0-9]{10}$/.test(url.pathname)
        )
          continue
        const company = value("dc\\:creator")
        const suffix = ` at ${company}`
        const description = load(content)
        const place = description("p")
          .filter((_, paragraph) =>
            /^Location:$/i.test(
              description(paragraph).find("strong").first().text().trim()
            )
          )
          .first()
          .text()
          .replace(/^Location:\s*/i, "")
        if (company && rawTitle.endsWith(suffix) && place)
          add({
            title: rawTitle.slice(0, -suffix.length),
            company,
            url: url.href,
            location: place,
            postedAt: value("pubDate"),
            description: content,
          })
        continue
      }
      const hasjobEmployer =
        config.publisher === "Hasjob"
          ? load(content)("p").first().find("strong > a").first().text().trim()
          : ""
      const delimiter =
        config.publisher === "Hasjob"
          ? rawTitle.lastIndexOf(" - ")
          : rawTitle.indexOf(": ")
      if (
        (delimiter > 0 || hasjobEmployer) &&
        ["Hasjob", "We Work Remotely"].includes(config.publisher)
      ) {
        const country = value("country")
        const namedCountry = explicitCountry(country)
        const trailing = delimiter > 0 ? rawTitle.slice(delimiter + 3) : ""
        add({
          title:
            config.publisher === "Hasjob"
              ? !hasjobEmployer ||
                trailing.toLowerCase() === hasjobEmployer.toLowerCase()
                ? rawTitle.slice(0, delimiter)
                : rawTitle
              : rawTitle.slice(delimiter + 2),
          company:
            config.publisher === "Hasjob"
              ? hasjobEmployer || trailing
              : rawTitle.slice(0, delimiter),
          url: url.href,
          location:
            value("location") ||
            (/^IN$/i.test(country) ? "India" : country) ||
            value("region"),
          countries: namedCountry ? [namedCountry] : [],
          postedAt: value("published") || value("pubDate"),
          description: content,
          expiresAt: value("expires_at"),
        })
      } else details.push(url)
    }
    return { postings, details, next, window: "Latest published feed window" }
  }
  const payload: unknown = JSON.parse(body)
  const envelope = obj(payload)
  const entries = Array.isArray(payload) ? payload.slice(1) : envelope.jobs
  if (!Array.isArray(entries)) throw new Error("Expected a public job list")
  for (const item of entries.map(obj)) {
    switch (config.kind) {
      case "himalayas": {
        const restrictions = array(item.locationRestrictions).map(
          (entry) =>
            str(obj(entry).alpha2) ||
            str(obj(entry).name) ||
            str(entry) ||
            JSON.stringify(entry)
        )
        const timezones = array(item.timezoneRestrictions).map((entry) =>
          typeof entry === "string" || typeof entry === "number"
            ? String(entry).trim()
            : JSON.stringify(entry)
        )
        add({
          title: str(item.title),
          company: str(item.companyName),
          url: str(item.applicationLink),
          location:
            restrictions.length || timezones.length ? "Remote" : "Worldwide",
          countries: restrictions
            .map(explicitCountry)
            .filter((country): country is string => Boolean(country)),
          postedAt: item.pubDate,
          description: str(item.description),
          expiresAt: item.expiryDate,
          evidence: str(item.guid),
          locationRestrictions: restrictions,
          timezoneRestrictions: timezones,
        })
        break
      }
      case "remote-ok":
        add({
          title: str(item.position),
          company: str(item.company),
          url: str(item.url),
          location: str(item.location),
          postedAt: item.date,
          description: str(item.description),
        })
        break
      case "remotive":
        add({
          title: str(item.title),
          company: str(item.company_name),
          url: str(item.url),
          location: str(item.candidate_required_location),
          postedAt: item.publication_date,
          description: str(item.description),
        })
        break
      case "jobicy":
        add({
          title: str(item.jobTitle),
          company: str(item.companyName),
          url: str(item.url),
          location: array(item.jobGeo).map(str).join(", "),
          postedAt: item.pubDate,
          description: str(item.jobDescription),
        })
        break
    }
  }
  if (
    config.kind === "himalayas" &&
    Number(envelope.offset) + entries.length < Number(envelope.totalCount) &&
    entries.length
  ) {
    const current = Number(page.searchParams.get("page") ?? 1)
    if (!Number.isSafeInteger(current) || current < 1)
      throw new Error("Invalid feed page")
    next = new URL(page)
    next.searchParams.set("page", String(current + 1))
  }
  if (config.kind === "jobicy" && str(envelope.nextCursor)) {
    const cursor = str(envelope.nextCursor)
    if (cursor === page.searchParams.get("cursor"))
      throw new Error("Feed repeated its cursor")
    next = new URL(page)
    next.searchParams.set("cursor", cursor)
  }
  return {
    postings,
    details,
    next,
    window:
      config.kind === "himalayas" ? null : "Publisher's recent feed window",
  }
}
