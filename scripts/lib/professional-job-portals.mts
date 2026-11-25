import { readFileSync } from "node:fs"
import { load } from "cheerio"
import {
  parsePublicFeed,
  type PublicFeedKind,
} from "@/lib/server/catalog/connectors"
import { isEarlyCareerPosting, isSoftwareRole } from "@/lib/jobs/software-roles"
import {
  asPublicUrl,
  inspectRegistryJobPage,
  locationCountries,
  normalizedPosting,
  relatesToEmployer,
  type ScrapedPosting,
} from "./registry-job-postings.mjs"

type PortalFeed = { url: string; kind: PublicFeedKind }
export type ProfessionalPortal = {
  url: string
  company: string
  feed?: PortalFeed
  skip?: { outcome: "restricted" | "auth_required"; reason: string }
}

const feeds: Record<string, PortalFeed> = {
  Himalayas: {
    url: "https://himalayas.app/jobs/api/search?country=IN&exclude_worldwide=true&sort=recent&page=1",
    kind: "himalayas",
  },
  "Remote OK": { url: "https://remoteok.com/api", kind: "remote-ok" },
  Remotive: { url: "https://remotive.com/api/remote-jobs", kind: "remotive" },
  Jobicy: { url: "https://jobicy.com/api/jobs", kind: "jobicy" },
  "We Work Remotely": {
    url: "https://weworkremotely.com/remote-jobs.rss",
    kind: "xml",
  },
  Hasjob: { url: "https://hasjob.co/feed", kind: "xml" },
  FzlOps: { url: "https://www.fzlops.online/rss.xml", kind: "xml" },
  "Remote Gig": { url: "https://remotegig.in/feed.xml", kind: "xml" },
}

const terms: Record<string, string> = {
  "LinkedIn Jobs": "https://www.linkedin.com/legal/user-agreement",
  foundit: "https://www.foundit.in/info/terms-of-use",
  Cutshort: "https://cutshort.io/terms",
  hirist: "https://www.hirist.tech/terms",
  iimjobs: "https://www.iimjobs.com/terms",
  Wellfound: "https://wellfound.com/terms",
  "Y Combinator Startup Jobs": "https://www.ycombinator.com/legal",
  Chayan: "https://getchayan.com/terms",
  MyJobb: "https://myjobb.ai/terms-of-service",
  "Michael Page India": "https://www.michaelpage.co.in/terms-and-conditions",
  "Glassdoor India": "https://www.glassdoor.co.in/about/terms/",
  "GrabJobs India": "https://grabjobs.co/resources/about-us/terms-of-use/",
  "Jooble India": "https://in.jooble.org/info/terms",
  Impactpool: "https://www.impactpool.org/signup/terms",
  PharmaTutor: "https://www.pharmatutor.org/terms-of-use",
}
const candidateAccounts = new Set([
  "TopHire",
  "FlexiBees",
  "FlexJobs",
  "Uplers",
])
const excludedBoards = new Set([
  "QuikrJobs",
  "OLX Jobs",
  "ClickIndia Jobs",
  "TeacherOn",
  "Talentrack",
  "NIEPMD Disability Job Opportunities",
  "MediJobs",
])
const sections = new Set([
  "National job boards and classifieds",
  "Job search aggregators",
  "Technology, startups and professional roles",
  "Remote and flexible jobs",
  "Staffing agencies with multi-employer boards",
  "Regional technology parks",
  "Specialist job portals and vacancy indexes",
])
const searchUrls: Record<string, string> = {
  Shine: "https://www.shine.com/job-search/fullstack-software-developer-jobs",
  e2eHiring: "https://www.e2ehiring.com/jobs",
}

export function loadProfessionalPortals(): ProfessionalPortal[] {
  const directory = readFileSync(
    new URL(
      "../../docs/research/2026-11-17-india-job-portal-directory.md",
      import.meta.url
    ),
    "utf8"
  )
  const portals: ProfessionalPortal[] = []
  let section = ""
  for (const line of directory.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3)
    if (!line.startsWith("| ")) continue
    const [, company, , link] = line.split("|").map((field) => field.trim())
    if (!sections.has(section) && company !== "National Career Service (NCS)")
      continue
    if (excludedBoards.has(company)) continue
    const url = asPublicUrl(
      searchUrls[company] ?? link.match(/\((https:\/\/[^)]+)\)/)?.[1] ?? ""
    )
    if (!url) continue
    const skip = terms[company]
      ? {
          outcome: "restricted" as const,
          reason: `Collection terms require permission: ${terms[company]}`,
        }
      : candidateAccounts.has(company)
        ? {
            outcome: "auth_required" as const,
            reason: "Candidate account required to browse matches",
          }
        : undefined
    portals.push({
      url: url.href,
      company,
      feed: feeds[company],
      skip,
    })
  }
  portals.push({
    url: "https://jobicy.com/jobs",
    company: "Jobicy",
    feed: feeds.Jobicy,
  })
  portals.push({
    url: "https://www.adzuna.in/",
    company: "Adzuna India",
  })
  return portals
}

const indiaPlace =
  /\b(?:andhra pradesh|arunachal pradesh|bengaluru|bangalore|bhubanes[hw]ar|chandigarh|chennai|coimbatore|delhi|ghaziabad|gujarat|gurga?on|gurugram|haryana|indore|jaipur|karnataka|kerala|kochi|cochin|kolkata|lucknow|ludhiana|madurai|maharashtra|mumbai|mysor[eu]|nagpur|navi mumbai|noida|odisha|pune|rajasthan|surat|tamil nadu|telangana|thiruvananthapuram|trivandrum|uttar pradesh|uttarakhand|vadodara|visakhapatnam|west bengal|ahmedabad)\b/i
const worldwide =
  /^(?:remote[\s,:-]+)?(?:worldwide|anywhere in the world|anywhere|global)$/i
const fixedRegion =
  /\b(?:(?:must|need to) (?:be (?:based|located)|reside|live) (?:in|within)|(?:candidates?|applicants?) (?:based|located) (?:in|within))\s+([^.!?\n]{2,100})/gi
const foreignPlace =
  /\b(?:united states|u\.?s\.?a?\.?|united kingdom|u\.?k\.?|canada|europe|australia|philippines|singapore|germany|france|new zealand)\b/i

function professionalTitle(title: string, description: string) {
  if (
    isEarlyCareerPosting(title) ||
    /\b(?:driver|delivery boy|helper|security guard|housekeeping|data entry|telecaller|forklift|maid|room attendant|job alert)\b/i.test(
      title
    )
  )
    return false
  return (
    isSoftwareRole(title, description) ||
    /\b(?:engineer|developer|architect|programmer|analyst|scientist|researcher|research fellow|professor|lecturer|teacher|academic|accountant|actuar|auditor|controller|finance|banking|legal|counsel|lawyer|attorney|consultant|manager|director|design(?:er)?|physician|doctor|surgeon|nurse|pharmacist|specialist|recruiter|writer|editor|marketing|strategist|technologist|cybersecurity|devops|operations|administrator|officer|vice president|chief|sales executive)\w*\b/i.test(
      title
    )
  )
}

export function indiaProfessionalPosting(job: ScrapedPosting, board: string) {
  if (
    job.company.toLowerCase() === board.toLowerCase() ||
    /^(?:confidential|unknown|undisclosed|private employer|various companies)$/i.test(
      job.company
    ) ||
    !professionalTitle(job.title, job.description)
  )
    return null
  if (job.countries.includes("India")) return job
  if (job.countries.length) return null
  const place = job.location ?? ""
  if (locationCountries(place).includes("India"))
    return { ...job, countries: [...new Set([...job.countries, "India"])] }
  if (foreignPlace.test(place)) return null
  if (indiaPlace.test(place)) return { ...job, countries: ["India"] }
  if (!worldwide.test(place.trim())) return null
  if (
    /\b(?:u\.?s\.?|u\.?k\.?|canada|europe|australia)[ -]+(?:based|only)\b/i.test(
      job.title
    )
  )
    return null
  for (const [, region] of job.description.matchAll(fixedRegion))
    if (foreignPlace.test(region) && !/\bindia\b/i.test(region)) return null
  return { ...job, location: "Remote (worldwide)", countries: ["India"] }
}

export function inspectProfessionalFeed(
  body: string,
  page: URL,
  portal: ProfessionalPortal
) {
  if (!portal.feed) throw new Error("Portal has no public feed")
  const parsed = parsePublicFeed(body, page, {
    kind: portal.feed.kind,
    publisher: portal.company,
  })
  const jobs: ScrapedPosting[] = []
  for (const posting of parsed.postings) {
    const expiry = Date.parse(posting.expiresAt ?? "")
    if (Number.isFinite(expiry) && expiry < Date.now()) continue
    let location = posting.locations.join("; ")
    if (portal.feed.kind === "himalayas") {
      const countries = posting.locationRestrictions ?? []
      const timezones = posting.timezoneRestrictions ?? []
      if (
        countries.length &&
        !countries.some((country) => /^(?:IN|IND|India)$/i.test(country))
      )
        continue
      if (
        timezones.length &&
        !timezones.some((zone) =>
          /^(?:UTC\s*)?\+?0?5(?::30|\.50*)$/i.test(zone)
        )
      )
        continue
      location =
        countries.length || timezones.length ? "Remote (India)" : "Worldwide"
    }
    const row = normalizedPosting({
      title: posting.title,
      company: posting.company,
      url: posting.url,
      location: location || null,
      countries: posting.countries.length
        ? posting.countries
        : locationCountries(location),
      postedAt: posting.postedAt,
      description: posting.description,
      evidence: posting.evidence,
      method: "structured_data",
    })
    const eligible = row && indiaProfessionalPosting(row, portal.company)
    if (eligible) jobs.push({ ...eligible, url: posting.url })
  }
  return {
    jobs,
    details: parsed.details,
    next: parsed.next,
    window: parsed.window,
  }
}

const jobLink =
  /\/(?:jobs?|jobdetails|jobdetail|job[-_]listing|job-details|vacanc(?:y|ies)|position|opportunities|recruitment|viewjob)\/(?:[^/]+\/)*[^/]*[a-z0-9][-a-z0-9_%+.]{3,}\/?$|\/(?:job-listings-|jobdescription\/|j\/|showjob\/)|[?&](?:job[_-]?id|joblistingid|jk)=/i
const resultsLink =
  /\/jobs?\/(?:location|category|locations|by-location|search|country|categories|india)(?:\/|$)|\/search\/|\/job-search\//i

export function inspectProfessionalPage(
  html: string,
  page: URL,
  start: URL,
  portal: ProfessionalPortal,
  isDetail: boolean
) {
  const data = inspectRegistryJobPage(html, page, start, "", isDetail)
  if (data.gate) return data
  const $ = load(html)
  const details = new Map<string, URL>()
  const next = new Map(
    data.next
      .filter((url) => relatesToEmployer(url, start))
      .map((url) => [url.href, url])
  )
  if (!isDetail)
    for (const element of $("a[href]").toArray()) {
      const anchor = $(element)
      const url = asPublicUrl(anchor.attr("href") ?? "", page)
      if (!url || url.href === page.href || !relatesToEmployer(url, start))
        continue
      const label = (anchor.attr("aria-label") ?? anchor.text())
        .replace(/\s+/g, " ")
        .trim()
      if (
        /^(?:go to (?:the )?)?next(?: page)?$|^[›»→]$/i.test(label) &&
        /[?&](?:page|p|start|offset)=\d|\/page\/\d/i.test(url.href)
      ) {
        next.set(url.href, url)
      } else if (
        jobLink.test(url.pathname + url.search) &&
        !resultsLink.test(url.pathname) &&
        /[\p{L}]{3}/u.test(label)
      ) {
        if (
          !/^(?:privacy|terms|log in|sign in|apply now|post a job|browse jobs|salary guide|find jobs|view all jobs|jobs in .+)$/i.test(
            label
          )
        )
          details.set(url.href, url)
      }
    }
  const jobs = data.jobs.flatMap((job) => {
    const eligible = indiaProfessionalPosting(job, portal.company)
    return eligible ? [eligible] : []
  })
  return {
    ...data,
    jobs,
    details: [...details.values()],
    next: [...next.values()],
    boards: [],
    listings: [],
  }
}
