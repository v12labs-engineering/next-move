import { isSoftwareRole, softwareRoleTitleScope } from "./software-roles"

/** Collection scope and user preferences share this vocabulary. Categories
 * describe the job, never an inferred employer industry or candidate skill. */
export const jobCategoryIds = [
  "software",
  "data",
  "product",
  "design",
  "marketing",
  "sales",
  "customer_success",
  "technical_support",
] as const
export type JobCategory = (typeof jobCategoryIds)[number]
export const jobCategoryLabels: Record<JobCategory, string> = {
  software: "Software engineering",
  data: "Data science & analytics",
  product: "Product management",
  design: "Design & user research",
  marketing: "Marketing",
  sales: "Sales & business development",
  customer_success: "Customer success",
  technical_support: "Technical support",
}

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

// Specific families precede broad titles: product marketing belongs to
// marketing; sales engineers belong to sales, not software engineering.
const categoryTitles: [Exclude<JobCategory, "software">, RegExp][] = [
  [
    "marketing",
    /\b(marketing|growth marketer|seo|sem|social media|content (writer|strategist|manager)|copywriter|brand (manager|strategist))\b/,
  ],
  [
    "customer_success",
    /\b(customer success|client success|customer onboarding|customer experience (manager|specialist|lead))\b/,
  ],
  [
    "sales",
    /\b(sales|pre sales|presales|account executive|account manager|business development|sdr|bdr|revenue operations)\b/,
  ],
  [
    "product",
    /\b(product (manager|owner|management|lead|director|operations)|head of product|director of product|vp of product|chief product officer)\b/,
  ],
  [
    "design",
    /\b(ux|ui|user experience|user interface|user research|product design(?:er)?|interaction design(?:er)?|visual design(?:er)?|graphic design(?:er)?|design researcher)\b/,
  ],
  [
    "data",
    /\b(data (analyst|scientist|science)|analytics (analyst|manager|lead|consultant)|business analyst|business intelligence analyst|bi analyst|decision scientist)\b/,
  ],
  [
    "technical_support",
    /\b(technical support|application support|software support|support engineer|support developer|support analyst|it support|help desk|service desk)\b/,
  ],
]

export function classifyJobCategory(
  title: string,
  description = ""
): JobCategory | null {
  if (isSoftwareRole(title, description)) return "software"
  const value = normalized(title)
  return categoryTitles.find(([, pattern]) => pattern.test(value))?.[0] ?? null
}

export function isCatalogRole(
  title: string,
  description = "",
  categories: readonly JobCategory[] = ["software"]
) {
  const category = classifyJobCategory(title, description)
  return category !== null && categories.includes(category)
}

/** Safe before a detail request: ambiguous software titles still need the
 * description, and an unselected category must not widen the fetch scope. */
export function catalogRoleTitleScope(
  title: string,
  categories: readonly JobCategory[] = ["software"]
): "included" | "excluded" | "needs_description" {
  // "UI Engineer" can be design or software depending on the work. Do not
  // discard it before reading evidence when software is an allowed category.
  if (
    categories.includes("software") &&
    softwareRoleTitleScope(title) === "needs_description"
  )
    return "needs_description"
  const category = classifyJobCategory(title)
  if (category) return categories.includes(category) ? "included" : "excluded"
  return categories.includes("software")
    ? softwareRoleTitleScope(title)
    : "excluded"
}
