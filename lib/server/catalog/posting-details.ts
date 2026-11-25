import type {
  EmploymentType,
  ExperienceLevel,
  JobPostingDetails,
  PostedSalary,
} from "@/lib/jobs/posting-details"

const employmentAliases = new Map<string, EmploymentType>([
  ["fulltime", "full_time"],
  ["parttime", "part_time"],
  ["contract", "contract"],
  ["contractor", "contract"],
  ["contractual", "contract"],
  ["temporary", "temporary"],
  ["permanent", "permanent"],
  ["fixedterm", "temporary"],
  ["intern", "internship"],
  ["internship", "internship"],
  ["volunteer", "volunteer"],
  ["perdiem", "per_diem"],
  ["other", "other"],
])
const experienceAliases = new Map<string, ExperienceLevel>([
  ["internship", "internship"],
  ["entrylevel", "entry"],
  ["entry", "entry"],
  ["junior", "entry"],
  ["fresher", "entry"],
  ["associate", "associate"],
  ["professional", "professional"],
  ["midlevel", "mid"],
  ["mid", "mid"],
  ["midseniorlevel", "mid_senior"],
  ["midsenior", "mid_senior"],
  ["seniorlevel", "senior"],
  ["senior", "senior"],
  ["lead", "lead"],
  ["manager", "manager"],
  ["director", "director"],
  ["executive", "executive"],
])
const salaryPeriods = new Map<string, PostedSalary["period"]>(
  [
    ["hour", "hourly"],
    ["day", "daily"],
    ["week", "weekly"],
    ["month", "monthly"],
    ["year", "yearly", "annual", "annually", "annum"],
  ].flatMap(([period, ...aliases]) =>
    [period, ...aliases].map((alias) => [
      alias,
      period as PostedSalary["period"],
    ])
  )
)
function label(value: unknown) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[\s_-]+/g, "")
    : ""
}

export function postedSalary(
  currency: unknown,
  interval: unknown,
  low: unknown,
  high: unknown
): PostedSalary | undefined {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : ""
  const period = salaryPeriods.get(
    label(interval).replace(/^1|^per|salary$/g, "")
  )
  if (!/^[A-Z]{3}$/.test(code) || !period) return undefined
  const amount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : null
  const min = amount(low)
  const max = amount(high)
  if (
    (min === null && max === null) ||
    (low != null && min === null) ||
    (high != null && max === null) ||
    (min !== null && max !== null && min > max)
  )
    return undefined
  return { currency: code, period, min, max }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function structuredPostingDetails(
  job:
    | {
        employmentType?: unknown
        experienceLevel?: unknown
        experienceRequirements?: unknown
        baseSalary?: unknown
      }
    | null
    | undefined
) {
  const salary = record(job?.baseSalary)
  const quantity = record(salary?.value)
  const isRange = quantity?.minValue != null || quantity?.maxValue != null
  return {
    employment: job?.employmentType,
    experience: job?.experienceLevel ?? job?.experienceRequirements,
    salary: postedSalary(
      salary?.currency,
      quantity?.unitText,
      isRange ? quantity?.minValue : quantity?.value,
      isRange ? quantity?.maxValue : quantity?.value
    ),
  }
}

export function ashbySalary(compensation: unknown) {
  const data = record(compensation)
  const tiers = data?.compensationTiers
  // Separate location or grade tiers don't uniquely describe one salary.
  if (Array.isArray(tiers) && tiers.length > 1) return undefined
  const components = data?.summaryComponents
  if (!Array.isArray(components)) return undefined
  const salaries = components
    .map(record)
    .filter((item) => item?.compensationType === "Salary")
  if (salaries.length !== 1) return undefined
  const salary = salaries[0]
  return postedSalary(
    salary?.currencyCode,
    salary?.interval,
    salary?.minValue,
    salary?.maxValue
  )
}

export function leverSalary(range: unknown) {
  const salary = record(range)
  return postedSalary(
    salary?.currency,
    salary?.interval,
    salary?.min,
    salary?.max
  )
}

// Accept explicit INR amounts with a stated pay period. Bare LPA is accepted for India.
const inrPay =
  /^(?:(₹|INR)\s*)?([\d,]+(?:\.\d+)?)\s*(?:(?:[-–—]|to)\s*(?:₹|INR)?\s*([\d,]+(?:\.\d+)?))?\s*(LPA|(?:(?:per\s+|\/\s*)(year|annum|month|week|day|hour)))$/i
function labeledSalary(value: string, country: string) {
  const match = inrPay.exec(value.trim())
  if (!match) return undefined
  const [, currency, low, high, interval, unit] = match
  const lpa = interval.toLowerCase() === "lpa"
  if (!currency && !(lpa && country === "India")) return undefined
  const parse = (number: string) =>
    Number(number.replaceAll(",", "")) * (lpa ? 100_000 : 1)
  return postedSalary(
    "INR",
    lpa ? "year" : unit,
    parse(low),
    parse(high ?? low)
  )
}

export interface PostedFields {
  employment?: unknown
  experience?: unknown
  salary?: PostedSalary
}

export function postingDetails(
  description: string,
  country: string,
  stated?: PostedFields
): JobPostingDetails | undefined {
  const employmentValues = Array.isArray(stated?.employment)
    ? stated.employment
    : [stated?.employment]
  const types = new Set(
    employmentValues.flatMap((value) => {
      const type = employmentAliases.get(label(value))
      return type ? [type] : []
    })
  )
  const experience = experienceAliases.get(label(stated?.experience))
  const labeledTypes = new Set<EmploymentType>()
  const labeledLevels = new Set<ExperienceLevel>()
  const salaries = new Map<string, PostedSalary>()
  for (const line of description.split("\n")) {
    const field =
      /^\s*(employment type|job type|experience level|seniority(?: level)?|(?:base )?salary(?: range)?)\s*:\s*(.{1,120})\s*$/i.exec(
        line
      )
    if (!field) continue
    const [, name, value] = field
    if (/^(?:employment|job)/i.test(name)) {
      const type = employmentAliases.get(label(value))
      if (type) labeledTypes.add(type)
    } else if (/^(?:experience|seniority)/i.test(name)) {
      const level = experienceAliases.get(label(value))
      if (level) labeledLevels.add(level)
    } else {
      const salary = labeledSalary(value, country)
      if (salary) salaries.set(JSON.stringify(salary), salary)
    }
  }
  const employmentTypes = [...(types.size ? types : labeledTypes)].sort()
  const experienceLevel =
    experience ?? (labeledLevels.size === 1 ? [...labeledLevels][0] : undefined)
  const salary =
    stated?.salary ??
    (salaries.size === 1 ? [...salaries.values()][0] : undefined)
  if (!employmentTypes.length && !experienceLevel && !salary) return undefined
  return {
    ...(employmentTypes.length ? { employmentTypes } : {}),
    ...(experienceLevel ? { experienceLevel } : {}),
    ...(salary ? { salary } : {}),
  }
}
