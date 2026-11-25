import type { Job } from "@/lib/jobs"

// A generic title is not a vacancy identifier. Large employers can publish
// many distinct requisitions with the same title, city and even description.
function providerPostingIdentity(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null
    if (
      /^(?:www\.)?accenture\.com$/.test(url.hostname) &&
      /^\/[a-z]{2}-[a-z]{2}\/careers\/jobdetails\/?$/.test(url.pathname)
    ) {
      const id = url.searchParams.get("id")
      return id && /^[\w-]+$/.test(id)
        ? `accenture:${id.replace(/_en$/, "")}`
        : null
    }
    const greenhouse = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/)
    if (
      greenhouse &&
      /^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname)
    )
      return `greenhouse:${url.hostname.includes(".eu.") ? "eu" : "us"}:${greenhouse[1]}:${greenhouse[2]}`
    const smartRecruiters = url.pathname.match(
      /^\/([^/]+)\/(\d+)(?:-[^/]*)?\/?$/
    )
    if (url.hostname === "jobs.smartrecruiters.com" && smartRecruiters)
      return `smartrecruiters:${smartRecruiters[1].toLowerCase()}:${smartRecruiters[2]}`
    const uuidPosting = url.pathname.match(
      /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i
    )
    if (uuidPosting) {
      const identity = `${uuidPosting[1].toLowerCase()}:${uuidPosting[2].toLowerCase()}`
      if (url.hostname === "jobs.ashbyhq.com") return `ashby:${identity}`
      if (["jobs.lever.co", "jobs.eu.lever.co"].includes(url.hostname))
        return `lever:${url.hostname}:${identity}`
    }
    const workable = url.pathname.match(/^\/(?:[^/]+\/)?j\/([a-f0-9]{10})\/?$/i)
    if (url.hostname === "apply.workable.com" && workable)
      return `workable:${workable[1].toLowerCase()}`
    const amazon = url.pathname.match(
      /^\/en\/jobs\/(\d+|SF\d+)(?:\/[^/]+)?\/?$/
    )
    if (["www.amazon.jobs", "amazon.jobs"].includes(url.hostname) && amazon)
      return `amazon:${amazon[1]}`
    // Oracle's employer site and this verified tenant expose the same IDs.
    const oracle =
      url.hostname === "careers.oracle.com"
        ? url.pathname.match(/^\/en\/sites\/jobsearch\/job\/(\d+)\/?$/)
        : url.hostname === "eeho.fa.us2.oraclecloud.com"
          ? url.pathname.match(
              /^\/hcmUI\/CandidateExperience\/en\/sites\/CX_45001\/job\/(\d+)\/?$/
            )
          : null
    if (oracle) return `oracle:eeho.fa.us2.oraclecloud.com:${oracle[1]}`
    const verifiedOracleSites: Record<string, string> = {
      "jpmc.fa.oraclecloud.com": "CX_1001",
      "hdjq.fa.us2.oraclecloud.com": "CX_1",
      "fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com": "CX_1",
    }
    const oracleTenant = url.pathname.match(
      /^\/hcmUI\/CandidateExperience\/en\/sites\/([^/]+)\/job\/(\d+)\/?$/
    )
    if (oracleTenant && verifiedOracleSites[url.hostname] === oracleTenant[1])
      return `oracle:${url.hostname}:${oracleTenant[2]}`
    const nokia = url.pathname.match(/^\/en\/sites\/CX_1\/job\/(\d+)\/?$/)
    if (url.hostname === "jobs.nokia.com" && nokia)
      return `oracle:fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com:${nokia[1]}`
    const deloitte = url.pathname.match(/^\/job\/[^/]+\/(\d+)\/?$/)
    if (url.hostname === "southasiacareers.deloitte.com" && deloitte)
      return `successfactors:deloitte-india:${deloitte[1]}`
    const qualcomm = url.pathname.match(/^\/careers\/job\/(\d+)\/?$/)
    if (url.hostname === "careers.qualcomm.com" && qualcomm)
      return `eightfold:qualcomm:${qualcomm[1]}`
    const barclays = url.pathname.match(
      /^\/job\/[^/]+\/[^/]+\/13015\/(\d+)\/?$/
    )
    if (url.hostname === "search.jobs.barclays" && barclays)
      return `talentbrew:barclays:${barclays[1]}`
    if (
      url.hostname === "careers.ibm.com" &&
      /^\/(?:en_US\/)?careers\/JobDetail\/?$/.test(url.pathname)
    ) {
      const ids = url.searchParams.getAll("jobId")
      if (ids.length === 1 && /^\d+$/.test(ids[0])) return `ibm:${ids[0]}`
    }
    return null
  } catch {
    return null
  }
}

// The same vacancy can be listed in several countries. Preserve a saved
// location variant; otherwise prefer the variant that best fits this account.
export function deduplicateLocations(jobs: Job[]): Job[] {
  const ranked = [...jobs].sort(
    (a, b) =>
      Number(b.status !== "new") - Number(a.status !== "new") ||
      Number(b.match?.eligible ?? false) - Number(a.match?.eligible ?? false) ||
      Number(b.match?.reviewable ?? false) -
        Number(a.match?.reviewable ?? false) ||
      (b.match?.score ?? 0) - (a.match?.score ?? 0)
  )
  const seenUrls = new Set<string>(),
    seenRequisitions = new Set<string>(),
    seenCopies = new Set<string>()
  return ranked.filter((job) => {
    const requisition = providerPostingIdentity(job.url)
    // Compact match rows intentionally omit descriptions. Without one there
    // is no evidence that different unknown-provider URLs are identical copies.
    const description = job.description?.trim()
    const copy =
      !requisition && description
        ? [job.company, job.title, job.country, job.city ?? "", description]
            .map((value) => value.trim().toLowerCase().replace(/\s+/g, " "))
            .join("\n")
        : null
    if (
      seenUrls.has(job.url) ||
      (requisition
        ? seenRequisitions.has(requisition)
        : copy !== null && seenCopies.has(copy))
    )
      return false
    seenUrls.add(job.url)
    if (requisition) seenRequisitions.add(requisition)
    else if (copy !== null) seenCopies.add(copy)
    return true
  })
}

// Keep destination variants until the viewer has applied its country filter.
export function deduplicateCountryLocations(jobs: Job[]): Job[] {
  const byCountry = new Map<string, Job[]>()
  for (const job of jobs) {
    const group = byCountry.get(job.country) ?? []
    group.push(job)
    byCountry.set(job.country, group)
  }
  return [...byCountry.values()].flatMap(deduplicateLocations)
}

export function catalogListingsInSearch(
  jobs: Job[],
  countries: string[],
  country = "all"
) {
  return jobs.filter(
    (job) =>
      job.isActive !== false &&
      countries.includes(job.country) &&
      (country === "all" || job.country === country)
  )
}
export function visibleRecommendations(
  jobs: Job[],
  strict: boolean,
  showHidden: boolean
) {
  return jobs
    .filter(
      (job) =>
        job.match?.relevant !== false &&
        (showHidden ||
          (job.status !== "applied" && job.status !== "dismissed")) &&
        (job.status !== "new" ||
          (job.isActive !== false &&
            (strict ? job.match?.eligible : job.match?.reviewable)))
    )
    .sort(
      (a, b) =>
        Number(b.match?.eligible ?? false) -
          Number(a.match?.eligible ?? false) ||
        (b.match?.score ?? 0) - (a.match?.score ?? 0)
    )
}
