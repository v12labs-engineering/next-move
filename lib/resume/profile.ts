import { z } from "zod"

const fact = z
  .object({
    value: z.string().trim().min(1).max(160),
    quote: z.string().trim().min(1).max(1200),
  })
  .strict()
const year = z.number().int().min(1900).max(2200).nullable()
export const resumeInsightsSchema = z
  .object({
    fullName: fact.nullable(),
    headline: fact.nullable(),
    currentLocation: fact.nullable(),
    skills: z.array(fact).max(30),
    experience: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(100),
            company: z.string().trim().min(1).max(160),
            startYear: year,
            endYear: year,
            current: z.boolean(),
            quote: z.string().trim().min(1).max(1600),
          })
          .strict()
      )
      .max(15),
    education: z
      .array(
        z
          .object({
            qualification: z.string().trim().min(1).max(160),
            institution: z.string().trim().min(1).max(160),
            quote: z.string().trim().min(1).max(1200),
          })
          .strict()
      )
      .max(8),
    projects: z.array(fact).max(8),
    achievements: z.array(z.string().trim().min(1).max(800)).max(8),
  })
  .strict()
export type ResumeInsights = z.infer<typeof resumeInsightsSchema>

const normalized = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en")
function contains(source: string, value: string) {
  return normalized(source).includes(normalized(value))
}

function containsTerm(quote: string, term: string) {
  const phrase = normalized(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}+#])${phrase}(?![\\p{L}\\p{N}\\p{M}+#])`,
    "u"
  ).test(normalized(quote))
}

function skillNames(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length > 0 && part.length <= 100 && part.split(/\s+/).length <= 6
    )
}

function listedSkills(lines: string[]) {
  const heading = lines.findIndex((line) =>
    /^(?:(?:technical|core|key)\s+)?(?:skills|tech stack|technical expertise|technologies)\s*:?$/i.test(
      line
    )
  )
  if (heading < 0) return []
  const groups: { value: string; quote: string }[][] = []
  for (const quote of lines.slice(heading + 1)) {
    if (!quote && !groups.length) continue
    const list = /^(?:[-*•]\s*)?[\p{L}][\p{L}\p{N} &/+-]{1,44}:\s*(.+)$/u.exec(
      quote
    )?.[1]
    if (!list || quote.length > 1200) break
    groups.push(skillNames(list).map((value) => ({ value, quote })))
  }
  // Keep terms from each listed discipline when the profile reaches its cap.
  return groups
    .flatMap((group) => group.map((item, index) => ({ ...item, index })))
    .sort((a, b) => a.index - b.index)
    .map(({ value, quote }) => ({ value, quote }))
}

function listedEmployment(lines: string[]): ResumeInsights["experience"] {
  const heading = lines.findIndex((line) =>
    /^(?:(?:professional|work)\s+)?(?:experience|employment(?: history)?)\s*:?$/i.test(
      line
    )
  )
  if (heading < 0) return []
  const history: ResumeInsights["experience"] = []
  for (const quote of lines.slice(heading + 1)) {
    if (
      /^(?:(?:selected\s+)?(?:projects|achievements)|education|certifications|(?:technical\s+)?skills|publications|open source)\s*:?$/i.test(
        quote
      )
    )
      break
    const parts = quote.split("|").map((part) => part.trim())
    if ((parts.length !== 3 && parts.length !== 4) || quote.length > 1600)
      continue
    const [title, company] = parts
    const dates =
      /^(?:[a-z]{3,9}\s+)?((?:19|20|21)\d{2})\s*[-–—]\s*(?:(?:[a-z]{3,9}\s+)?((?:19|20|21)\d{2})|present|current|now|ongoing)$/i.exec(
        parts.at(-1) ?? ""
      )
    if (
      !dates ||
      !title ||
      title.length > 100 ||
      !company ||
      company.length > 160
    )
      continue
    history.push({
      title,
      company,
      startYear: Number(dates[1]),
      endYear: dates[2] ? Number(dates[2]) : null,
      current: !dates[2],
      quote,
    })
  }
  return history
}

// Evidence must be an actual source passage, and each extracted fact must occur
// in that passage. Unsupported model output is discarded, never filled in.
export function groundResumeInsights(
  source: string,
  input: unknown
): ResumeInsights {
  const parsed = resumeInsightsSchema.parse(input)
  const groundedFact = (item: z.infer<typeof fact> | null) =>
    item && contains(source, item.quote) && contains(item.quote, item.value)
      ? item
      : null
  const lines = source.split(/\r?\n/).map((line) => line.trim())
  const skills = new Map(
    listedSkills(lines).map((item) => [normalized(item.value), item])
  )
  for (const item of parsed.skills) {
    if (!groundedFact(item)) continue
    for (const value of skillNames(item.value)) {
      if (containsTerm(item.quote, value))
        skills.set(normalized(value), { value, quote: item.quote })
    }
  }
  const employmentKey = (item: ResumeInsights["experience"][number]) =>
    JSON.stringify([normalized(item.title), normalized(item.company)])
  const listedRoles = listedEmployment(lines)
  const rolesWithDates = new Set(listedRoles.map(employmentKey))
  const extractedRoles = parsed.experience.flatMap((item) => {
    const [role, extra] = item.title.split(/\s*\|\s*/, 2)
    const title =
      extra && normalized(extra) === normalized(item.company)
        ? role
        : item.title
    if (rolesWithDates.has(employmentKey({ ...item, title }))) return []
    const identifiesRole = (line: string) =>
      containsTerm(line, title) && containsTerm(line, item.company)
    // An extractor may quote a responsibility instead of the job header.
    // Recover the header only when one source line identifies both facts.
    let quote = item.quote
    if (!contains(source, quote) || !identifiesRole(quote)) {
      const headers = lines.filter(identifiesRole)
      if (headers.length !== 1 || headers[0].length > 1600) return []
      quote = headers[0]
    }
    return [
      {
        ...item,
        title,
        quote,
        startYear:
          item.startYear !== null && containsTerm(quote, String(item.startYear))
            ? item.startYear
            : null,
        endYear:
          item.endYear !== null && containsTerm(quote, String(item.endYear))
            ? item.endYear
            : null,
        current:
          item.current && /\b(present|current|now|ongoing)\b/i.test(quote),
      },
    ]
  })
  const experience = new Map(
    [...listedRoles, ...extractedRoles].map((item) => [
      JSON.stringify([
        employmentKey(item),
        item.startYear,
        item.endYear,
        item.current,
      ]),
      item,
    ])
  )
  return {
    fullName: groundedFact(parsed.fullName),
    headline: groundedFact(parsed.headline),
    currentLocation: groundedFact(parsed.currentLocation),
    skills: [...skills.values()].slice(0, 30),
    experience: [...experience.values()].slice(0, 15),
    education: parsed.education.filter(
      (item) =>
        contains(source, item.quote) &&
        contains(item.quote, item.qualification) &&
        contains(item.quote, item.institution)
    ),
    projects: parsed.projects.filter((item) => groundedFact(item)),
    achievements: parsed.achievements.filter((item) => contains(source, item)),
  }
}

// Year-only dates give an estimate, not a claim of exact tenure. Overlapping
// jobs count once. Undated history stays unknown rather than implying zero.
export function estimateExperienceYears(
  insights: ResumeInsights,
  currentYear: number
): number | null {
  if (!insights.experience.length) return null
  const ranges: [number, number][] = []
  for (const job of insights.experience) {
    const end = job.current ? currentYear : job.endYear
    if (
      job.startYear === null ||
      end === null ||
      end < job.startYear ||
      end > currentYear ||
      job.startYear > currentYear
    )
      return null
    ranges.push([job.startYear, end])
  }
  ranges.sort((a, b) => a[0] - b[0])
  let total = 0,
    start = ranges[0][0],
    end = ranges[0][1]
  for (const range of ranges.slice(1)) {
    if (range[0] <= end) end = Math.max(end, range[1])
    else {
      total += end - start
      ;[start, end] = range
    }
  }
  total += end - start
  return total <= 60 ? total : null
}
