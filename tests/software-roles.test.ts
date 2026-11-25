import assert from "node:assert/strict"
import test from "node:test"
import { isSoftwareRole } from "@/lib/jobs/software-roles"
import { catalogSources } from "@/lib/server/catalog/feeds"
import { parseAshby } from "@/lib/server/catalog/connectors/board-apis"
import { matchJob } from "@/lib/matching"
import { candidateSchema } from "@/lib/candidate"
import type { Job } from "@/lib/jobs"

const softwareWork =
  "Lead software development and build software applications and APIs using TypeScript. ".repeat(
    3
  )

test("software scope spans leadership, individual contributors and entry-level roles", () => {
  for (const title of [
    "CTO",
    "Chief Technology Officer",
    "Chief Technical Officer",
    "VP of Engineering",
    "Vice President, Engineering",
    "Head of Engineering",
    "Director of Software Engineering",
    "Engineering Manager",
    "Technical Lead",
    "Distinguished Software Engineer",
    "Principal Engineer",
    "Staff Engineer",
    "Senior Software Engineer",
    "Software Engineer II",
    "Junior Software Engineer",
    "Assistant Software Engineer",
    "Python Developer",
    "C++ Developer",
    "C# Developer",
    ".NET Developer",
    "Node.js Engineer",
    "Head of Technology",
    "Member of Technical Staff",
    "Graduate Software Developer",
    "Software Engineering Intern",
    "Junior Developer",
    "Frontend Engineer",
    "Front-end Developer",
    "Backend Developer",
    "Full-Stack Engineer",
    "iOS Engineer",
    "Android Developer",
    "Mobile Engineer",
    "Embedded Software Engineer",
    "Firmware Engineer",
    "Game Developer",
    "Software Architect",
    "DevOps Engineer",
    "SRE",
    "Site Reliability Engineer",
    "Cloud Engineer",
    "Platform Engineer",
    "Data Engineer",
    "Machine Learning Engineer",
    "AI Engineer",
    "SDET",
    "Test Automation Engineer",
    "QA Automation Engineer",
    "QA Engineer",
    "Application Security Engineer",
    "Product Security Engineer",
    "SWE Intern",
  ])
    assert.equal(isSoftwareRole(title, softwareWork), true, title)
})

test("explicit software titles do not require a particular stack, employer or seniority", () => {
  for (const title of [
    "Junior Software Engineer",
    "Backend Developer",
    "SDET",
    "SRE",
  ])
    assert.equal(isSoftwareRole(title), true, title)
})

test("unrelated titles cannot qualify through the employer's software description", () => {
  for (const title of [
    "Registered Nurse",
    "Accountant",
    "Software Sales Engineer",
    "Software Sales Manager",
    "Solutions Engineer, Pre-Sales",
    "Software Engineering Recruiter",
    "Technical Recruiter",
    "Product Manager",
    "Technical Program Manager",
    "Project Manager",
    "Scrum Master",
    "Product Designer",
    "UX Engineer",
    "Software Support Engineer",
    "Customer Success Manager",
    "IT Support",
    "Network Engineer",
    "Systems Administrator",
    "Civil Engineer",
    "Mechanical Engineer",
    "Electrical Engineer",
    "Hardware Engineer",
    "Industrial Engineer",
    "Data Center Engineer",
    "Facilities Engineer",
    "Web Content Developer",
    "Manufacturing Engineering Manager",
    "Data Analyst",
    "Data Scientist",
    "Business Analyst",
    "Marketing Director",
    "HR Director",
    "Executive Assistant to CTO",
    "Chief of Staff to CTO",
    "CTO Office Manager",
    "Office Manager",
    "CEO",
    "Open role",
    "",
  ])
    assert.equal(isSoftwareRole(title, softwareWork), false, title)
})

test("ambiguous engineering and QA titles require evidence of software work", () => {
  for (const title of [
    "CTO",
    "Chief Technology Officer",
    "Engineering Manager",
    "Platform Engineer",
    "Infrastructure Engineer",
    "Application Engineer",
    "VP Engineering",
    "Staff Engineer",
    "QA Engineer",
    "Developer",
  ]) {
    assert.equal(isSoftwareRole(title), false, title)
    assert.equal(
      isSoftwareRole(
        title,
        "Manage bridge inspections and prepare records in Excel."
      ),
      false,
      title
    )
    assert.equal(isSoftwareRole(title, softwareWork), true, title)
    assert.equal(
      isSoftwareRole(
        title,
        "Manage production shifts and react to customer requests."
      ),
      false,
      title
    )
  }
})

test("mixed employer snapshots retain CTO and junior roles but drop unrelated professions", () => {
  const titles = [
    "CTO",
    "Junior Software Engineer",
    "Registered Nurse",
    "Accountant",
    "Software Sales Engineer",
  ]
  const rows = parseAshby(catalogSources[0], {
    jobs: titles.map((title, index) => ({
      title,
      isListed: true,
      jobUrl: `https://jobs.ashbyhq.com/n8n/${index}`,
      descriptionPlain: softwareWork,
      address: { addressCountry: "IN" },
    })),
  })
  assert.deepEqual(
    rows.map((row) => row.title),
    ["CTO", "Junior Software Engineer"]
  )
})

test("old non-software listings cannot be recommended through target roles or relevance overrides", () => {
  const profile = candidateSchema.parse({
    fullName: "Example Candidate",
    headline: "Engineer",
    currentLocation: null,
    targetRoles: ["Civil Engineer"],
    skills: ["TypeScript"],
    experienceYears: 3,
    targetCountries: ["India"],
    workModes: ["onsite"],
    sponsorshipRequired: false,
    excludedCompanies: [],
    resumeText: softwareWork,
  })
  const job: Job = {
    id: "legacy",
    title: "Civil Engineer",
    company: "Software Employer",
    country: "India",
    remote: "onsite",
    url: "https://example.com/job",
    description: softwareWork,
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    freshness: "fresh",
    source: "fixture",
    status: "new",
    seenAt: "2026-11-02",
  }
  for (const override of [undefined, true]) {
    const match = matchJob(job, profile, override)
    assert.equal(match.softwareRole, false)
    assert.equal(match.relevant, false)
    assert.equal(match.reviewable, false)
    assert.equal(match.eligible, false)
  }
  for (const title of ["CTO", "Junior Software Engineer"]) {
    const match = matchJob(
      { ...job, title },
      { ...profile, targetRoles: [title], experienceYears: null }
    )
    assert.equal(match.softwareRole, true)
    assert.equal(match.reviewable, true)
  }
})
