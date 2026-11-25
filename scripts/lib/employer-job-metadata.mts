import { load } from "cheerio"
import { publicApplicationUrl } from "@/lib/applications/url"
import { isEarlyCareerPosting, isSoftwareRole } from "@/lib/jobs/software-roles"

export type JobObservation = {
  url: string
  title: string
  city: string | null
  postedAt: string | null
  method: "ats" | "structured_data" | "firecrawl_map"
  sourceId?: string
  evidenceUrl?: string
  countries?: string[]
}

function entries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(entries)
  if (!value || typeof value !== "object") return []
  return [value as Record<string, unknown>]
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function india(value: unknown) {
  return /^(in|ind|india)$/i.test(text(value))
}

export function readEmployerJobMetadata(
  page: URL,
  html: string,
  employerId: (name: string) => string,
  expectedId: string,
  now: Date
): JobObservation[] {
  const $ = load(html)
  const jobs: JobObservation[] = []
  for (const script of $('script[type="application/ld+json"]')) {
    let roots: Record<string, unknown>[]
    try {
      roots = entries(JSON.parse($(script).text()))
    } catch {
      continue
    }
    for (const node of roots.flatMap((root) => [
      root,
      ...entries(root["@graph"]),
    ])) {
      const type = node["@type"]
      if (
        !(Array.isArray(type) ? type : [type]).some(
          (value) =>
            value === "JobPosting" || value === "https://schema.org/JobPosting"
        )
      )
        continue
      if (
        !entries(node.hiringOrganization).some(
          (org) => employerId(text(org.name)) === expectedId
        )
      )
        continue
      const title = text(node.title)
      if (
        !title ||
        isEarlyCareerPosting(title) ||
        !isSoftwareRole(title, load(text(node.description)).text())
      )
        continue
      const addresses = entries(node.jobLocation)
        .flatMap((location) => entries(location.address))
        .filter(
          (address) =>
            india(address.addressCountry) ||
            entries(address.addressCountry).some((country) =>
              india(country.name)
            )
        )
      const indiaRemote =
        text(node.jobLocationType).toUpperCase() === "TELECOMMUTE" &&
        entries(node.applicantLocationRequirements).some((location) =>
          india(location.name)
        )
      if (!addresses.length && !indiaRemote) continue
      const closingDate = text(node.validThrough)
      const expires = Date.parse(
        /^\d{4}-\d{2}-\d{2}$/.test(closingDate)
          ? `${closingDate}T23:59:59+05:30`
          : closingDate
      )
      if (Number.isFinite(expires) && expires < now.getTime()) continue
      const posted = Date.parse(text(node.datePosted))
      if (Number.isFinite(posted) && posted > now.getTime()) continue
      const target = URL.parse(text(node.url) || page.href, page)
      const link = target && publicApplicationUrl(target.href)
      if (!link || new URL(link).origin !== page.origin) continue
      jobs.push({
        url: link,
        title,
        city:
          [
            ...new Set(
              addresses
                .map((address) => text(address.addressLocality))
                .filter(Boolean)
            ),
          ].join("; ") || null,
        postedAt: Number.isFinite(posted)
          ? new Date(posted).toISOString()
          : null,
        method: "structured_data",
      })
    }
  }
  return jobs
}
