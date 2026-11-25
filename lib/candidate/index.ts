import { z } from "zod"
import { countryName } from "@/lib/location/countries"
import { roleTitleCore } from "@/lib/matching"
import { classifyJobCategory, jobCategoryIds } from "@/lib/jobs/categories"
import { applicationProfileSchema } from "../applications/profile"
import {
  resumeInsightsSchema,
  groundResumeInsights,
  estimateExperienceYears,
} from "@/lib/resume/profile"

export const destinationCountrySchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .transform((value, ctx) => {
    const country = countryName(value)
    if (country) return country
    ctx.addIssue({
      code: "custom",
      message: "Choose a country from the suggestions.",
    })
    return z.NEVER
  })
const terms = z
  .array(z.string().trim().min(1).max(100))
  .max(30)
  .transform((values) => [...new Set(values)])
export const targetLocationSchema = z
  .object({
    id: z.number().int().positive().safe(),
    country: destinationCountrySchema,
    name: z.string().trim().min(1).max(120),
    region: z.string().trim().min(1).max(120).nullable(),
  })
  .strict()
export type TargetLocation = z.infer<typeof targetLocationSchema>
export const candidateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    headline: z.string().trim().min(3).max(160),
    currentLocation: z.string().trim().min(2).max(120).nullable(),
    targetRoles: terms.pipe(z.array(z.string()).min(1)),
    jobCategories: z
      .array(z.enum(jobCategoryIds))
      .min(1)
      .max(8)
      .transform((values) => [...new Set(values)])
      .optional(),
    skills: terms.pipe(z.array(z.string()).min(1)),
    experienceYears: z.number().int().min(0).max(60).nullable(),
    targetCountries: z
      .array(destinationCountrySchema)
      .min(1)
      .max(8)
      .transform((values) => [...new Set(values)]),
    targetLocations: z
      .array(targetLocationSchema)
      .max(40)
      .transform((values) => [
        ...new Map(values.map((value) => [value.id, value])).values(),
      ])
      .optional(),
    workModes: z
      .array(z.enum(["remote", "hybrid", "onsite"]))
      .min(1)
      .max(3),
    sponsorshipRequired: z.boolean().nullable(),
    remoteFromHome: z.boolean().optional(),
    applicationProfile: applicationProfileSchema.optional(),
    autoApply: z
      .object({
        enabled: z.boolean(),
        minScore: z.number().int().min(50).max(100),
        // Accept the retired field in stored profiles and old client payloads.
        dailyLimit: z.unknown().optional(),
      })
      .strict()
      .transform(({ enabled, minScore }) => ({ enabled, minScore }))
      .optional(),
    excludedCompanies: terms,
    resumeInsights: resumeInsightsSchema.optional(),
    resumeText: z
      .string()
      .trim()
      .min(100, "Add at least 100 characters of resume content.")
      .max(30_000),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    const counts = new Map<string, number>()
    for (const [index, location] of (
      candidate.targetLocations ?? []
    ).entries()) {
      const count = (counts.get(location.country) ?? 0) + 1
      counts.set(location.country, count)
      if (count > 5)
        ctx.addIssue({
          code: "custom",
          path: ["targetLocations", index],
          message: "Select up to 5 locations per country.",
        })
      if (!candidate.targetCountries.includes(location.country)) {
        ctx.addIssue({
          code: "custom",
          path: ["targetLocations", index, "country"],
          message: "Select the location's country first.",
        })
      }
    }
  })

export type Candidate = z.infer<typeof candidateSchema>

const roleWord =
  /\b(engineer|engineering|developer|architect|programmer|manager|lead|consultant|analyst|scientist|cto|head|director|sre|devops|administrator|specialist|technical staff)\b/i

function resumeHeaderName(source: string, location: string | undefined) {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
  const section = lines.findIndex((line) =>
    /^(?:(?:professional |career |work )?summary|(?:professional |work )?experience|employment|education|skills|projects|references?)\b\s*[:–—-]?\s*$/i.test(
      line
    )
  )
  const header = (section === -1 ? lines : lines.slice(0, section))
    .filter((line) => !/^(?:r[eé]sum[eé]|cv|curriculum vitae)$/i.test(line))
    .flatMap((line) => line.split(/\s*[|•·]\s*/))
    .filter(Boolean)

  const isName = (value: string) => {
    const words = value.split(/\s+/)
    return (
      value.length >= 2 &&
      value.length <= 120 &&
      words.length >= 1 &&
      words.length <= 7 &&
      !roleWord.test(value) &&
      !/\b(?:inc|ltd|llc|corp|company|corporation|systems|solutions|university|contact|profile|references?)\b/i.test(
        value
      ) &&
      value.toLowerCase() !== location?.toLowerCase() &&
      words.every((word) =>
        /^\p{L}[\p{L}\p{M}]*(?:[.'’\-]\p{L}[\p{L}\p{M}]*)*\.?$/u.test(word)
      )
    )
  }

  const labelled = header.flatMap((quote) => {
    const value = /^(?:full\s+)?name\s*:\s*(.+)$/i.exec(quote)?.[1].trim()
    return value ? [{ value, quote }] : []
  })
  // A nearby role or contact does not establish that a heading is a person's
  // name. Without an explicit label, leave missing extracted identity for review.
  return labelled.length === 1 && isName(labelled[0].value) ? labelled[0] : null
}

function presentable(title: string) {
  const core = roleTitleCore(title).replace(/\s+/g, " ").trim()
  if (core !== core.toUpperCase()) return core
  return core
    .toLowerCase()
    .replace(
      /(^|[\s/&(-])(\p{L})/gu,
      (_, lead, c) => `${lead}${c.toUpperCase()}`
    )
}
/**
 * Target roles are the candidate's own roles stripped of team, tool and
 * employer qualifiers: the headline's role first, then recent job titles.
 */
export function targetRolesFrom(
  headline: string | undefined,
  titles: readonly string[]
) {
  const headlineRole = headline
    ?.split(/\s*[|•·]\s*|\s+[–—-]\s+/)
    .map((part) => part.trim())
    .find(
      (part) =>
        part &&
        part.length <= 60 &&
        (roleWord.test(part) || classifyJobCategory(part) !== null)
    )
  const roles = new Set<string>()
  for (const title of [headlineRole, ...titles]) {
    if (!title) continue
    const role = presentable(title)
    if (role && role.length <= 100) roles.add(role)
    if (roles.size === 4) break
  }
  return [...roles]
}

export function candidateFromResume(
  resumeText: string,
  input: unknown,
  currentYear: number
): Candidate {
  const insights = groundResumeInsights(resumeText, input)
  const fullName =
    insights.fullName ??
    resumeHeaderName(resumeText, insights.currentLocation?.value)
  const titles = [...insights.experience]
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (b.endYear ?? b.startYear ?? 0) - (a.endYear ?? a.startYear ?? 0) ||
        (b.startYear ?? 0) - (a.startYear ?? 0)
    )
    .map((job) => job.title)
  const headline = insights.headline?.value
  const supportedTitles = titles.filter((title) => classifyJobCategory(title))
  const supportedHeadline = targetRolesFrom(headline, []).find((title) =>
    classifyJobCategory(title)
  )
  const targetRoles =
    supportedHeadline || supportedTitles.length
      ? targetRolesFrom(supportedHeadline, supportedTitles)
      : targetRolesFrom(headline, titles)
  const jobCategories = [
    ...new Set(
      targetRoles
        .map((role) => classifyJobCategory(role))
        .filter((category) => category !== null)
    ),
  ]
  return {
    ...emptyCandidate,
    fullName: fullName?.value.slice(0, 120) ?? "",
    headline: headline ?? titles[0] ?? "",
    currentLocation: insights.currentLocation?.value.slice(0, 120) ?? null,
    experienceYears: estimateExperienceYears(insights, currentYear),
    targetRoles,
    jobCategories: jobCategories.length ? jobCategories : undefined,
    skills: [...new Set(insights.skills.map((skill) => skill.value))],
    resumeText,
    resumeInsights: { ...insights, fullName },
  }
}

export const emptyCandidate: Candidate = {
  fullName: "",
  headline: "",
  currentLocation: null,
  targetRoles: [],
  jobCategories: ["software"],
  skills: [],
  experienceYears: null,
  targetCountries: [],
  targetLocations: [],
  workModes: ["remote", "hybrid", "onsite"],
  sponsorshipRequired: null,
  excludedCompanies: [],
  resumeText: "",
}
