import { z } from "zod"
import { companyDomain } from "@/lib/jobs/company-logo"
import { relevantJobTitle } from "@/lib/matching"

const linkedinProfile = z
  .string()
  .max(500)
  .regex(/^https:\/\/(?:[a-z]{2}\.|www\.)?linkedin\.com\/in\/[a-z0-9%_-]+\/?$/i)

export const followupContactsSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(150),
      title: z.string().trim().min(1).max(200),
      profileUrl: linkedinProfile,
      reason: z.enum([
        "Recruiting",
        "Related role",
        "Company leadership",
        "Company employee",
      ]),
    })
  )
  .max(3)

export type FollowupContact = z.infer<typeof followupContactsSchema>[number]

const resultSchema = z.object({
  success: z.literal(true),
  data: z.object({
    alexandria: z
      .array(z.object({ data: z.unknown(), error: z.unknown().optional() }))
      .length(1),
  }),
})
const peopleSchema = z.union([
  z.array(z.unknown()),
  z
    .object({
      success: z.literal(true).optional(),
      results: z.array(z.unknown()),
    })
    .transform((data) => data.results),
])
const personSchema = z.object({
  full_name: z.string().trim().min(1).max(150),
  linkedin_url: linkedinProfile,
  experiences: z.array(
    z.object({
      company_name: z.string(),
      company_domain: z.string().nullish(),
      company_linkedin_url: z.string().nullish(),
      job_title: z.string().trim().min(1).max(200),
      job_is_current: z.boolean(),
    })
  ),
})

function normalized(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
}

function contactReason(title: string, role: string): FollowupContact["reason"] {
  if (/\b(recruiter|recruiting|recruitment|talent acquisition)\b/i.test(title))
    return "Recruiting"
  if (
    relevantJobTitle(title, [role]) ||
    (/\b(engineer|developer)\b/i.test(role) &&
      /\bengineering manager\b/i.test(title))
  )
    return "Related role"
  if (/\b(founder|chief|ceo|cto)\b/i.test(title)) return "Company leadership"
  return "Company employee"
}

export async function findFollowupContacts(
  employer: { company: string; title: string; targetUrl: string },
  apiKey: string,
  fetcher = fetch
): Promise<FollowupContact[]> {
  const relatedTitle = employer.title
    .replace(/\b(?:senior|junior|principal|staff|associate)\b/gi, "")
    .replace(/[^\p{L}\p{N}+# ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
  const titles = [
    "recruiter",
    "talent acquisition",
    "people operations",
    "founder",
  ]
  if (relatedTitle) titles.push(relatedTitle)
  if (/\b(engineer|developer)\b/i.test(employer.title))
    titles.push("engineering manager")

  const response = await fetcher("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      alexandria: {
        provider: "blitzapi",
        capability: "people/search",
        options: {
          company: { name: { include: [employer.company] } },
          people: { job_title: { include: titles } },
          max_results: 3,
        },
      },
    }),
  })
  if (!response.ok)
    throw new Error(`Firecrawl people search failed (${response.status})`)
  const body = resultSchema.parse(await response.json())
  const result = body.data.alexandria[0]
  if (result.error) throw new Error("Firecrawl people search provider failed")
  const people = peopleSchema.parse(result.data)
  const matches = people.flatMap((row) => {
    const person = personSchema.safeParse(row)
    if (!person.success) return []
    const experience = person.data.experiences.find(
      (job) =>
        job.job_is_current &&
        normalized(job.company_name) === normalized(employer.company)
    )
    if (!experience) return []
    return [{ person: person.data, experience }]
  })

  // Prefer records whose employer domain is corroborated by the job URL.
  const domain = companyDomain(employer.targetUrl)
  const onDomain = matches.filter(
    ({ experience }) =>
      domain && normalized(experience.company_domain ?? "") === domain
  )
  const candidates = onDomain.length ? onDomain : matches
  const companyPages = new Set(
    candidates.flatMap(({ experience }) =>
      experience.company_linkedin_url
        ? [experience.company_linkedin_url.toLowerCase().replace(/\/$/, "")]
        : []
    )
  )
  if (companyPages.size > 1) return []

  const ranked = candidates.map(({ person, experience }) => ({
    name: person.full_name,
    title: experience.job_title,
    profileUrl: person.linkedin_url.toLowerCase().replace(/\/$/, ""),
    reason: contactReason(experience.job_title, employer.title),
  }))
  const priorities: FollowupContact["reason"][] = [
    "Recruiting",
    "Related role",
    "Company leadership",
    "Company employee",
  ]
  ranked.sort(
    (a, b) => priorities.indexOf(a.reason) - priorities.indexOf(b.reason)
  )
  return ranked
    .filter(
      (person, index) =>
        ranked.findIndex(
          ({ profileUrl }) => profileUrl === person.profileUrl
        ) === index
    )
    .slice(0, 3)
}
