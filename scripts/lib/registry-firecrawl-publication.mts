import { jobCategoryIds } from "@/lib/jobs/categories"
import { catalogPosting } from "@/lib/server/catalog/feeds"
import {
  normalizedPosting,
  type ScrapedPosting,
} from "./registry-job-postings.mjs"

export function registryFirecrawlPosting(
  job: ScrapedPosting,
  now = Date.now()
) {
  const posted = Date.parse(job.postedAt ?? "")
  if (
    job.method !== "structured_data" ||
    job.countries.length !== 1 ||
    job.countries[0] !== "India" ||
    !Number.isFinite(posted) ||
    posted > now ||
    posted < now - 30 * 86_400_000 ||
    normalizedPosting({ ...job, url: job.evidence })?.url !== job.url
  )
    return null

  return catalogPosting(
    {
      country: "India",
      city: job.location?.split(",")[0]?.trim() || null,
      title: job.title,
      company: job.company,
      url: job.url,
      description: job.description,
      source: "firecrawl:registry",
      posted_at: job.postedAt,
      work_mode: "unknown",
    },
    undefined,
    jobCategoryIds
  )
}
