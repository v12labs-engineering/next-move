export const employmentTypeLabels = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  temporary: "Temporary",
  permanent: "Permanent",
  internship: "Internship",
  volunteer: "Volunteer",
  per_diem: "Per diem",
  other: "Other",
} as const

export const experienceLevelLabels = {
  internship: "Internship level",
  entry: "Entry level",
  associate: "Associate",
  professional: "Professional",
  mid: "Mid-level",
  mid_senior: "Mid–senior level",
  senior: "Senior",
  lead: "Lead",
  manager: "Manager",
  director: "Director",
  executive: "Executive",
} as const

export type EmploymentType = keyof typeof employmentTypeLabels
export type ExperienceLevel = keyof typeof experienceLevelLabels
export const employmentTypes = Object.keys(
  employmentTypeLabels
) as EmploymentType[]
export const experienceLevels = Object.keys(
  experienceLevelLabels
) as ExperienceLevel[]

export interface PostedSalary {
  currency: string
  period: "hour" | "day" | "week" | "month" | "year"
  min: number | null
  max: number | null
}

export interface JobPostingDetails {
  employmentTypes?: EmploymentType[]
  experienceLevel?: ExperienceLevel
  salary?: PostedSalary
}

export const salaryFilterLabels = {
  disclosed: "Disclosed salary",
  unknown: "Unknown",
  "500000": "Minimum ₹5L/year",
  "1000000": "Minimum ₹10L/year",
  "1500000": "Minimum ₹15L/year",
  "2000000": "Minimum ₹20L/year",
  "3000000": "Minimum ₹30L/year",
  "5000000": "Minimum ₹50L/year",
} as const
export type SalaryFilter = keyof typeof salaryFilterLabels
export const salaryFilters = Object.keys(salaryFilterLabels) as SalaryFilter[]

export function formatPostedSalary(salary: PostedSalary) {
  const formatter = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: salary.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
  const { min, max, period } = salary
  const amount =
    min === null
      ? `Up to ${formatter.format(max!)}`
      : max === null
        ? `From ${formatter.format(min)}`
        : min === max
          ? formatter.format(min)
          : `${formatter.format(min)}–${formatter.format(max)}`
  return `${amount}/${period}`
}
