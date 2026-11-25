import assert from "node:assert/strict"
import { test } from "node:test"
import {
  catalogRoleTitleScope,
  classifyJobCategory,
  isCatalogRole,
  jobCategoryIds,
  type JobCategory,
} from "@/lib/jobs/categories"
import { emptyCandidate } from "@/lib/candidate"
import { matchJob } from "@/lib/matching"
import type { Job } from "@/lib/jobs"

const cases: [string, JobCategory][] = [
  ["Backend Engineer", "software"],
  ["Salesforce Developer", "software"],
  ["Data Engineer", "software"],
  ["Data Scientist", "data"],
  ["Business Analyst", "data"],
  ["Senior Product Manager", "product"],
  ["UX Researcher", "design"],
  ["Product Designer", "design"],
  ["Product Marketing Manager", "marketing"],
  ["Digital Marketing Executive", "marketing"],
  ["Sales Engineer", "sales"],
  ["Account Executive", "sales"],
  ["Customer Success Manager", "customer_success"],
  ["Technical Support Engineer", "technical_support"],
]

test("job categories classify work independently of source and candidate skills", () => {
  for (const [title, category] of cases) {
    assert.equal(classifyJobCategory(title), category, title)
    assert.equal(isCatalogRole(title, "", [category]), true, title)
    assert.equal(
      isCatalogRole(
        title,
        "",
        jobCategoryIds.filter((id) => id !== category)
      ),
      false,
      title
    )
  }
  for (const title of [
    "Nurse",
    "Civil Engineer",
    "Recruiter",
    "Mechanical Engineer",
    "Accountant",
    "Open Position",
  ]) {
    assert.equal(
      classifyJobCategory(title, "Uses Python, React and Excel"),
      null,
      title
    )
  }
})

test("category title gate retains description requirements and legacy software default", () => {
  for (const title of [
    "UI Engineer",
    "UI Developer",
    "Product Design Engineer",
  ]) {
    assert.equal(catalogRoleTitleScope(title), "needs_description", title)
    assert.equal(
      isCatalogRole(
        title,
        "Build TypeScript services and production software."
      ),
      true,
      title
    )
  }
  assert.equal(
    catalogRoleTitleScope("CTO", jobCategoryIds),
    "needs_description"
  )
  assert.equal(
    isCatalogRole("CTO", "Lead software engineering teams", jobCategoryIds),
    true
  )
  assert.equal(
    isCatalogRole("CTO", "Lead civil construction teams", jobCategoryIds),
    false
  )
  assert.equal(catalogRoleTitleScope("CTO", ["marketing"]), "excluded")
  assert.equal(
    catalogRoleTitleScope("Product Marketing Manager", ["marketing"]),
    "included"
  )
  assert.equal(catalogRoleTitleScope("Product Marketing Manager"), "excluded")
  assert.equal(
    isCatalogRole("Account Executive", "Sell our software platform"),
    false
  )
})

const job: Job = {
  id: "marketing-india",
  title: "Marketing Manager",
  company: "Example",
  country: "India",
  remote: "hybrid",
  url: "https://example.com/jobs/marketing",
  description:
    "Lead marketing campaigns using analytics and CRM. Requires 3 years of experience.",
  visaSignal: "possible",
  visaSignalSource: "rules",
  sponsorVerified: false,
  freshness: "fresh",
  source: "test",
  status: "new",
  seenAt: new Date().toISOString(),
}
const profile = {
  ...emptyCandidate,
  targetCountries: ["India"],
  targetRoles: ["Marketing Manager"],
  skills: ["analytics", "CRM"],
  experienceYears: 3,
  sponsorshipRequired: false,
}

test("each user's categories are a hard matching gate, including relevant overrides", () => {
  const legacy = matchJob(job, { ...profile, jobCategories: undefined })
  assert.equal(legacy.inScope, false)
  assert.equal(legacy.reviewable, false)
  const selected = matchJob(job, { ...profile, jobCategories: ["marketing"] })
  assert.equal(selected.inScope, true)
  assert.equal(selected.category, "marketing")
  assert.equal(selected.softwareRole, false)
  assert.equal(selected.relevant, true)
  assert.equal(selected.reviewable, true)
  const excluded = matchJob(job, { ...profile, jobCategories: ["sales"] }, true)
  assert.equal(excluded.inScope, false)
  assert.equal(excluded.relevant, false)
  assert.equal(excluded.eligible, false)
  assert.ok(excluded.gaps.includes("Outside your selected job categories"))
})

test("choosing a category still respects country and target-role preferences", () => {
  const selected = { ...profile, jobCategories: ["marketing"] as JobCategory[] }
  assert.equal(
    matchJob({ ...job, country: "Germany" }, selected).reviewable,
    false
  )
  assert.equal(
    matchJob(job, { ...selected, targetRoles: ["SEO Specialist"], skills: [] })
      .relevant,
    false
  )
})
