import assert from "node:assert/strict"
import test from "node:test"
import { candidateSchema } from "@/lib/candidate"
import { matchJob } from "@/lib/matching"
import type { Job } from "@/lib/jobs"

const profile = candidateSchema.parse({
  fullName: "Example Candidate",
  headline: "Registered Nurse",
  currentLocation: null,
  targetRoles: ["Registered Nurse"],
  skills: ["Patient care", "Excel"],
  experienceYears: 3,
  targetCountries: ["India"],
  workModes: ["onsite"],
  sponsorshipRequired: false,
  excludedCompanies: [],
  resumeText:
    "Registered Nurse providing patient care in hospital wards. Prepared patient records and coordinated clinical handovers.",
})
const listing: Job = {
  id: "nurse",
  title: "Staff Registered Nurse",
  company: "Example Hospital",
  country: "India",
  remote: "onsite",
  url: "https://example.com/jobs/nurse",
  description: "Provide patient care and maintain records using Excel.",
  visaSignal: "possible",
  visaSignalSource: "rules",
  sponsorVerified: false,
  freshness: "fresh",
  source: "test",
  status: "new",
  seenAt: "2026-10-29",
}

test("non-software vacancies are excluded even when the candidate targets that profession", () => {
  assert.equal(matchJob(listing, profile).reviewable, false)
  const accountant = {
    ...profile,
    targetRoles: ["Accountant"],
    skills: ["Excel", "Reconciliation"],
    experienceYears: 6,
  }
  assert.equal(matchJob(listing, accountant).reviewable, false)
  assert.equal(
    matchJob({ ...listing, title: "Senior Accountant" }, accountant).reviewable,
    false
  )
})

test("overlapping engineering keywords never substitute for the candidate's profession", () => {
  const software = {
    ...profile,
    targetRoles: ["Backend Engineer"],
    skills: ["Python", "SQL"],
  }
  assert.equal(
    matchJob(
      {
        ...listing,
        title: "Civil Engineer",
        description: "Use Python and SQL for structural analysis.",
      },
      software
    ).reviewable,
    false
  )
})

test("local-language title matching respects Unicode word boundaries", () => {
  const french = {
    ...profile,
    targetRoles: ["Ingénieur DevOps"],
    skills: ["Excel"],
  }
  assert.equal(
    matchJob({ ...listing, title: "Ingénieur DevOps confirmé" }, french)
      .reviewable,
    true
  )
  assert.equal(
    matchJob({ ...listing, title: "Ingénieur DevOpsse" }, french).reviewable,
    false
  )
  assert.equal(
    matchJob({ ...listing, title: "Ingénieur DevOpsé" }, french).reviewable,
    false
  )
})

test("software company sales titles are not software engineering occupations", () => {
  const engineer = {
    ...profile,
    targetRoles: ["Backend Engineer"],
    skills: ["Python", "SQL"],
  }
  const result = matchJob(
    {
      ...listing,
      title: "Software Sales Manager",
      description: "Sell software to Python and SQL teams.",
    },
    engineer
  )
  assert.equal(result.relevant, false)
  assert.equal(result.reviewable, false)
})
