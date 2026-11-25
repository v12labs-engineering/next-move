import { createHash } from "node:crypto"
import { load } from "cheerio"
import { publicApplicationUrl } from "@/lib/applications/url"
import {
  explicitCountry,
  plain,
  statedLocationCountry,
} from "@/lib/server/catalog/feeds"
import { boardFromUrl } from "@/lib/server/catalog/source-identity"

export type ScrapedPosting = {
  key: string
  url: string
  title: string
  company: string
  location: string | null
  countries: string[]
  postedAt: string | null
  description: string
  evidence: string
  method: "ats" | "structured_data" | "job_detail" | "listing"
}

export const str = (value: unknown) =>
  typeof value === "string" ? value.trim() : ""
export const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value == null ? [] : [value]

export function asPublicUrl(value: string, base?: URL) {
  if (!value || /^\s*#/.test(value)) return null
  const url = URL.parse(value, base)
  if (!url || !publicApplicationUrl(url.href)) return null
  url.hash = ""
  return url
}

export const employerHost = (url: URL) =>
  url.hostname.replace(
    /^(?:www\.|careers?\.|carrers?\.|jobs\.|recruitment\.)/i,
    ""
  )

export function relatesToEmployer(url: URL, source: URL) {
  const host = employerHost(source)
  return employerHost(url) === host || url.hostname.endsWith("." + host)
}

export function locationCountries(location: string | null) {
  // Short region labels in a free-text address are ambiguous. Country codes
  // from structured fields are handled separately.
  if (!location) return []
  const words = location.split(/[,;|]/).map((part) => part.trim())
  const countries = words
    .map(statedLocationCountry)
    .filter((name): name is string => Boolean(name))
  if (/\b(?:india|ind)(?:$|[\s,;|/)])/i.test(location)) countries.push("India")
  return [...new Set(countries)]
}

function namedCountry(value: unknown) {
  return explicitCountry(str(value) || str(obj(value).name))
}

const genericTitle =
  /^(?:apply(?: now| here| for (?:this|the) (?:job|role|position))?|read more|details?|learn more|careers?|carrers?|jobs?|job (?:openings?|description|details?|requirements)|current openings?|open positions?|vacancies|our team|contact us|join (?:with )?(?:us|our team)\b.*|submit|all jobs|share (?:this|the) (?:job|posting)|view (?:openings|jobs|details)|send (?:us )?your (?:cv|resume))[\s.!:]*$/i
const inactive =
  /\b(?:no longer (?:available|accepting applications)|position (?:has been|is now) filled|job (?:posting |listing )?(?:has )?expired|applications? (?:for this (?:job|position) )?(?:are|is) closed|this (?:job|vacancy|posting) (?:is|has been) (?:closed|removed))\b/i
const noOpenings =
  /\b(?:no (?:current |open |available )?(?:jobs|openings|vacancies|positions)(?:\s+(?:at (?:this|the) time|available|right now|currently))?|(?:currently|at present)[,\s]+(?:we )?(?:have|there are) no (?:openings|vacancies|positions))\b/i
const siteGate =
  /^(?:sign ?in|log ?in|sso|authentication required|access denied|request rejected|attention required|just a moment|verify (?:that )?you are human)\b/i
const applyLabel =
  /^(?:apply(?: now| here| online| for (?:this|the) (?:job|role|position))?|submit (?:your )?(?:application|resume|cv))[\s!:.›»→]*$/i
const detailsContent =
  /\b(?:job description|responsibilit(?:ies|y)|qualifications|requirements|required skills|minimum experience|experience required|role overview|what you(?:'ll| will) do)\b/gi
const detailPath =
  /\/(?:jobs?|(?:current[-_])?job[-_]?(?:details?|openings?)|positions?|vacanc(?:y|ies)|requisitions?|viewjob|careers?|career[-_]?details?|carrers?)\/[^/]+|[?&](?:job[-_]?id|jobid|req(?:uisition)?[-_]?id|vacancy[-_]?id|position[-_]?id)=/i

export function isRegistryJobDetailUrl(url: URL) {
  return detailPath.test(url.pathname + url.search)
}

const listingLabel =
  /^(?:(?:browse|explore|find|search|see|view)\s+(?:(?:all|our|for|the|available|current|open)\s+)*(?:openings?|positions?|vacancies|jobs?|opportunities|roles)|(?:all|current|available|open)\s+(?:(?:career|job)\s+)?(?:openings?|positions?|jobs?|vacancies|opportunities|roles)|job (?:search|openings?)|search careers)\b/i
const listingPath =
  /(?:^|\/)(?:careers?|carrers?|jobs?|job-?search|search-?jobs|find-?jobs|job-?openings?|current-?openings?|vacancies|open-?positions|opportunities|search)(?:\/|[.-][a-z]|$)/i

function postingTitle(value: string) {
  const title = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^job description\s*[-–—:]\s*/i, "")
  if (
    genericTitle.test(title) ||
    /^apply for (?:a |the |this )?(?:job|position|role)[\s.!:]*$/i.test(
      title
    ) ||
    /^(?:students and graduates|early careers|life at \S+|career opportunities|career with us|career growth|why join us|why work (?:here|at|with))\b/i.test(
      title
    )
  )
    return ""
  return title.replace(/^apply for\s+/i, "")
}

function titleInJobPath(title: string, url: URL) {
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (words.length < 2) return false
  const slug = url.pathname.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return (
    slug.includes("-" + words.join("-") + "-") ||
    slug.endsWith("-" + words.join("-"))
  )
}

export function normalizedPosting(
  input: Omit<ScrapedPosting, "key">,
  inlineIdentifier?: string
): ScrapedPosting | null {
  const url = asPublicUrl(input.url)
  const title = postingTitle(input.title)
  const company = input.company.replace(/\s+/g, " ").trim()
  if (
    !url ||
    title.length < 3 ||
    title.length > 300 ||
    genericTitle.test(title) ||
    !company
  )
    return null
  for (const key of [...url.searchParams.keys()])
    if (/^(?:utm_|fbclid$|gclid$|gh_src$|trackingId$)/i.test(key))
      url.searchParams.delete(key)
  url.searchParams.sort()
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  const ghId =
    url.searchParams.get("gh_jid") ??
    (/(?:^|\.)greenhouse\.io$/.test(url.hostname)
      ? (url.pathname.match(/\/jobs\/([0-9]+)$/)?.[1] ?? null)
      : null)
  const identity = inlineIdentifier
    ? [
        employerHost(url),
        company,
        inlineIdentifier,
        title,
        input.location ?? "",
      ]
        .join("\n")
        .toLowerCase()
    : ghId && /^\d+$/.test(ghId)
      ? "greenhouse:" + ghId
      : url.href
  const posted = Date.parse(input.postedAt ?? "")
  return {
    ...input,
    key: createHash("sha256").update(identity).digest("hex"),
    title,
    company: company.slice(0, 300),
    url: url.href,
    countries: [...new Set(input.countries)],
    postedAt:
      Number.isFinite(posted) && posted <= Date.now() + 86_400_000
        ? new Date(posted).toISOString()
        : null,
    description: input.description.slice(0, 24_000),
  }
}

export function readSuccessFactorsJobDetail(
  html: string,
  page: URL,
  company: string
) {
  const id = page.pathname.match(/^\/job\/[^/]+\/([1-9][0-9]*)\/$/)?.[1]
  if (!id) return null
  const $ = load(html)
  const job = $(".jobDisplayShell[itemtype$='/JobPosting']").first()
  const canonical = asPublicUrl(
    $("link[rel='canonical']").attr("href") ?? "",
    page
  )
  const hasApply = job
    .find("a.apply[href]")
    .toArray()
    .some((element) => {
      const url = URL.parse($(element).attr("href") ?? "", page)
      return (
        url?.origin === page.origin &&
        url.pathname === `/talentcommunity/apply/${id}/`
      )
    })
  const metadata = (property: string) =>
    job.find(`meta[itemprop='${property}']`).first().attr("content")?.trim() ??
    ""
  const employer = metadata("hiringOrganization").replace(/\s+/g, " ")
  const expected = company.toLowerCase().replace(/\s+/g, " ").trim()
  const identity = employer.toLowerCase()
  const location = metadata("streetAddress")
  const country = explicitCountry(location.split(",").at(-1)?.trim())
  const postedAt = metadata("datePosted")
  const expires = Date.parse(metadata("validThrough"))
  const description = plain(job.find(".jobdescription").first().html() ?? "")
  if (
    canonical?.href !== page.href ||
    !hasApply ||
    identity.length < 4 ||
    (expected !== identity && !expected.startsWith(identity + " ")) ||
    !location.includes(",") ||
    !country ||
    !Number.isFinite(Date.parse(postedAt)) ||
    (Number.isFinite(expires) && expires < Date.now()) ||
    !description ||
    inactive.test(description)
  )
    return null
  return normalizedPosting({
    url: page.href,
    title: job.find("[itemprop='title']").first().text().trim(),
    company: employer,
    location,
    countries: [country],
    postedAt,
    description,
    evidence: page.href,
    method: "structured_data",
  })
}

function permitted(url: URL, source: URL) {
  return relatesToEmployer(url, source) || Boolean(boardFromUrl(url.href))
}

function jobNodes(value: unknown): Record<string, unknown>[] {
  return array(value).flatMap((item) => {
    const node = obj(item)
    return [
      ...(array(node["@type"]).some(
        (type) =>
          typeof type === "string" &&
          /^(?:https?:\/\/schema\.org\/)?JobPosting$/i.test(type)
      )
        ? [node]
        : []),
      ...array(node["@graph"]).flatMap(jobNodes),
      ...array(node.mainEntity).flatMap(jobNodes),
      ...array(node.itemListElement).flatMap((item) =>
        jobNodes(obj(item).item ?? item)
      ),
    ]
  })
}

export function inspectRegistryJobPage(
  html: string,
  page: URL,
  source: URL,
  company: string,
  isDetail = false
) {
  const $ = load(html)
  const title = $("title").text().trim()
  const body = $("main").length ? $("main").first() : $("body")
  const heading = body.find("h1").first().text().trim()
  const challenge =
    /\b(?:just a moment|verify (?:that )?you are human|attention required|captcha|request rejected)\b/i.test(
      title
    )
  const auth =
    !challenge &&
    ([title, heading].some((value) => siteGate.test(value)) ||
      /\/(?:candidate-)?(?:login|log-in|sign-?in|auth|sso)(?:\/|$)/i.test(
        page.pathname
      ))
  const jobs = new Map<string, ScrapedPosting>()
  const boards = new Map<string, URL>()
  const details = new Map<string, URL>()
  const listings = new Map<string, URL>()
  const next = new Map<string, URL>()
  const frames = new Map<string, URL>()
  function add(posting: ScrapedPosting | null) {
    if (!posting || jobs.has(posting.key)) return
    if (
      posting.method === "listing" &&
      [...jobs.values()].some(
        (known) =>
          known.method === "structured_data" &&
          known.url === posting.url &&
          (isDetail ||
            known.title.toLowerCase() === posting.title.toLowerCase())
      )
    )
      return
    jobs.set(posting.key, posting)
  }
  if (auth || challenge)
    return {
      jobs: [],
      boards: [],
      details: [],
      listings: [],
      next: [],
      frames: [],
      empty: false,
      dynamic: false,
      gate: challenge ? ("captcha" as const) : ("auth_required" as const),
    }

  for (const script of $('script[type="application/ld+json"]')) {
    let entries: Record<string, unknown>[]
    try {
      entries = jobNodes(JSON.parse($(script).text()))
    } catch {
      continue
    }
    for (const node of entries) {
      const expires = str(node.validThrough)
      const expiration = Date.parse(
        /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires + "T23:59:59Z" : expires
      )
      if (Number.isFinite(expiration) && expiration < Date.now()) continue
      const description = plain(str(node.description))
      if (inactive.test(description)) continue
      const addresses = array(node.jobLocation).flatMap((location) =>
        array(obj(location).address)
      )
      const location =
        addresses
          .map((address) => {
            if (typeof address === "string") return address.trim()
            const fields = obj(address)
            return [
              str(fields.addressLocality),
              str(fields.addressRegion),
              str(fields.addressCountry) ||
                str(obj(fields.addressCountry).name),
            ]
              .filter(Boolean)
              .join(", ")
          })
          .filter(Boolean)
          .join("; ") || null
      const countries = addresses
        .map((address) => namedCountry(obj(address).addressCountry))
        .filter((value): value is string => Boolean(value))
      for (const requirement of array(node.applicantLocationRequirements))
        if (str(node.jobLocationType).toUpperCase() === "TELECOMMUTE") {
          const allowed = namedCountry(obj(requirement).name)
          if (allowed) countries.push(allowed)
        }
      const target = asPublicUrl(
        str(node.url) || str(obj(node.mainEntityOfPage)["@id"]) || page.href,
        page
      )
      if (!target || !permitted(target, source)) continue
      const externalId = str(obj(node.identifier).value)
      const inline =
        target.href === page.href && !isDetail && entries.length > 1
      add(
        normalizedPosting(
          {
            url: target.href,
            title: str(node.title),
            company: str(obj(node.hiringOrganization).name) || company,
            location,
            countries,
            description,
            postedAt: str(node.datePosted) || null,
            evidence: page.href,
            method: "structured_data",
          },
          inline ? externalId || "structured listing" : undefined
        )
      )
    }
  }

  const candidateElements = $("a[href], iframe[src], link[rel='next']")
  for (const el of candidateElements) {
    const node = $(el)
    const url = asPublicUrl(node.attr("href") ?? node.attr("src") ?? "", page)
    if (!url || url.href === page.href || !permitted(url, source)) continue
    const label = (node.attr("aria-label") ?? node.text())
      .replace(/\s+/g, " ")
      .trim()
    const board = boardFromUrl(url.href)
    if (
      board &&
      board.board !== "embed" &&
      (el.name === "iframe" ||
        /\b(?:careers?|jobs?|openings?|positions?|vacancies|apply)\b/i.test(
          label
        ) ||
        detailPath.test(url.href))
    )
      boards.set(url.href, url)
    if (
      el.name === "iframe" &&
      !board &&
      relatesToEmployer(url, source) &&
      /job|career|opening|vacanc/i.test(url.pathname + url.hostname)
    )
      frames.set(url.href, url)
    if (
      relatesToEmployer(url, source) &&
      (node.attr("rel")?.split(/\s+/).includes("next") ||
        (node.closest(
          ".pagination,[class*='paginat'],[aria-label*='Pagination']"
        ).length > 0 &&
          /^(?:(?:go to (?:the )?)?next(?: page)?|[›»→])$/i.test(label)))
    ) {
      next.set(url.href, url)
      continue
    }
    if (
      el.name === "a" &&
      !isDetail &&
      relatesToEmployer(url, source) &&
      listingLabel.test(label) &&
      (listingPath.test(url.pathname) ||
        /^(?:jobs?|careers?)\./i.test(url.hostname))
    ) {
      listings.set(url.href, url)
      continue
    }
    if (
      el.name !== "a" ||
      !relatesToEmployer(url, source) ||
      !detailPath.test(url.pathname + url.search)
    )
      continue
    if (
      /\b(?:privacy|benefits|events|culture|students|graduates|contact|login|sign-in|job alert|talent community|submit (?:resume|cv))\b/i.test(
        label
      )
    )
      continue
    if (
      !label ||
      (genericTitle.test(label) &&
        !applyLabel.test(label) &&
        !/^(?:details?|read more|view job)$/i.test(label))
    )
      continue
    details.set(url.href, url)
  }

  // A documented position card can represent a specific job even when a site
  // puts its details and application controls on the same URL.
  const cards = $(
    "[itemtype$='JobPosting'],[data-job-id],[data-requisition-id],.job-card,.job-opening,.job-listing,.job_listing,.job-item,.career-opening"
  )
  for (const el of cards) {
    const card = $(el)
    const role = (
      card.attr("data-job-title") ||
      card
        .find("[itemprop='title'],.job-title,.position-title,h2,h3,h4")
        .first()
        .text()
    ).trim()
    const text = card.text().replace(/\s+/g, " ").trim()
    const controls = card.find("a,button,input[type='submit']").toArray()
    if (
      !postingTitle(role) ||
      inactive.test(text) ||
      !controls.some((control) =>
        applyLabel.test($(control).attr("value") ?? $(control).text().trim())
      )
    )
      continue
    const detail = controls
      .map((control) => asPublicUrl($(control).attr("href") ?? "", page))
      .find(
        (link) =>
          link &&
          relatesToEmployer(link, source) &&
          detailPath.test(link.href) &&
          link.href !== page.href
      )
    const location =
      card
        .find("[itemprop='jobLocation'],.job-location,[data-job-location]")
        .first()
        .text()
        .trim() || null
    const id = card.attr("data-job-id") ?? card.attr("data-requisition-id")
    const describedRole =
      new Set(
        (text.match(detailsContent) ?? []).map((term) => term.toLowerCase())
      ).size > 0
    if (!detail && !id && !describedRole && !location) continue
    if (detail) details.set(detail.href, detail)
    add(
      normalizedPosting(
        {
          url: detail?.href ?? page.href,
          title: role,
          company,
          location,
          countries: locationCountries(location),
          postedAt:
            card.find("time[datetime]").first().attr("datetime") ?? null,
          description: text,
          evidence: page.href,
          method: "listing",
        },
        detail ? undefined : id || "public listing"
      )
    )
  }

  const headings = body
    .find("h1,h2,h3,h4,h5,h6")
    .toArray()
    .map((el) => $(el).text().trim())
    .join(" ")
  if (
    /\b(?:current (?:job )?openings?|open positions|available (?:positions|jobs)|current vacancies)\b/i.test(
      headings
    )
  ) {
    const roleHeading = (value: string) =>
      value.length >= 3 &&
      value.length <= 140 &&
      Boolean(postingTitle(value)) &&
      !/\b(?:step away|welcome to|start your career|start to your career|work with us|why (?:work|join)|explore your|build your future)\b/i.test(
        value
      ) &&
      !/^(?:experience|education|no\.? of positions|open positions|current (?:job )?openings?|description|responsibilities|qualifications|requirements|skills|location)\b/i.test(
        value
      )
    const markers =
      /\b(?:experience\s*[:\u2013-]|open positions?|no\.?\s+of positions|qualification|responsibilit(?:ies|y)|job description|location\s*:)\b/i
    const controls = body
      .find("a,button,input[type='submit']")
      .toArray()
      .filter((el) =>
        applyLabel.test($(el).attr("value") ?? $(el).text().trim())
      )
    for (const control of controls) {
      const link = asPublicUrl($(control).attr("href") ?? "", page)
      if (link && permitted(link, source) && detailPath.test(link.href))
        continue
      for (const ancestor of $(control).parents().slice(0, 7)) {
        const card = $(ancestor)
        if (card.is("body,main") || card.closest("nav,header,footer").length)
          break
        const titles = [
          ...new Set(
            card
              .find("h2,h3,h4,h5,h6")
              .toArray()
              .map((el) => $(el).text().replace(/\s+/g, " ").trim())
              .filter(roleHeading)
          ),
        ]
        if (titles.length > 1) break
        if (!titles.length) continue
        const text = [
          card.text(),
          ...card
            .find("h2,h3,h4,h5,h6,p")
            .toArray()
            .map((el) => $(el).text()),
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
        if (!markers.test(text) || inactive.test(text)) continue
        const role = titles[0]
        if (
          ![...jobs.values()].some(
            (posting) => posting.title.toLowerCase() === role.toLowerCase()
          )
        ) {
          const location =
            card
              .find(
                "[itemprop='jobLocation'],.job-location,[data-job-location]"
              )
              .first()
              .text()
              .trim() || null
          add(
            normalizedPosting(
              {
                url: page.href,
                title: role,
                company,
                location,
                countries: locationCountries(location),
                postedAt: null,
                description: text,
                evidence: page.href,
                method: "listing",
              },
              "public listing"
            )
          )
        }
        break
      }
    }
  }
  $("script,style,nav,header,footer,[role='navigation']").remove()
  const blocks = body
    .find("h1,h2,h3,h4,h5,h6,p,dt,dd,li")
    .toArray()
    .map((element) => $(element).text())
  const text = [body.text(), ...blocks].join(" ").replace(/\s+/g, " ").trim()
  const visibleApply = body
    .find("a,button,input[type='submit']")
    .toArray()
    .some((el) => applyLabel.test($(el).attr("value") ?? $(el).text().trim()))
  const slugTitle = body
    .find("h1,h2,h3,h4,[itemprop='title'],.job-title")
    .toArray()
    .map((el) => postingTitle($(el).text()))
    .find((candidate) => candidate && titleInJobPath(candidate, page))
  const detailTitle = slugTitle || postingTitle(heading)
  const detailFields = new Set(
    (text.match(detailsContent) ?? []).map((term) => term.toLowerCase())
  )
  const labeledFields = new Set(
    [
      ...text.matchAll(
        /\b(location|experience|qualifications?|skills|job type|employment type|salary|vacancies)\s*:/gi
      ),
    ].map((field) => field[1].toLowerCase())
  )
  if (
    (isDetail || detailPath.test(page.pathname + page.search)) &&
    detailTitle &&
    !inactive.test(text) &&
    ((visibleApply && detailFields.size >= 2) ||
      (slugTitle && labeledFields.size >= 3))
  ) {
    const location =
      body
        .find("[itemprop='jobLocation'],.job-location,[data-job-location]")
        .first()
        .text()
        .trim() ||
      (slugTitle
        ? (blocks
            .find((block) => /^\s*location\s*:/i.test(block))
            ?.split(":")[1]
            ?.trim()
            .slice(0, 200) ?? null)
        : null)
    add(
      normalizedPosting({
        url: page.href,
        title: detailTitle,
        company,
        location,
        countries: locationCountries(location),
        postedAt: null,
        description: text,
        evidence: page.href,
        method: "job_detail",
      })
    )
  }
  const dynamic =
    /\b(?:loading (?:jobs|openings|positions|vacancies)|enable javascript|please wait while .*jobs)\b/i.test(
      text
    ) ||
    /\b(?:data-automation-id=["']jobResults|data-(?:job-board|careers-widget)|job-widget|job-board-widget|job-results|data-testid=["']job-list|acsbJobWidget)\b/i.test(
      html
    ) ||
    (text.length < 700 &&
      /(?:id=["'](?:root|app|__next|careers|jobs)["']|<app-root\b)/i.test(html))
  return {
    jobs: [...jobs.values()],
    boards: [...boards.values()],
    details: [...details.values()],
    listings: [...listings.values()],
    next: [...next.values()],
    frames: [...frames.values()],
    empty: noOpenings.test(text),
    dynamic,
    gate: null,
  }
}
