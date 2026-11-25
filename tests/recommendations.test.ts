import assert from "node:assert/strict"
import test from "node:test"
import { matchJob, relevantJobTitle } from "@/lib/matching"
import { candidateSchema } from "@/lib/candidate"
import type { Job } from "@/lib/jobs"
const candidate = candidateSchema.parse({
  fullName: "Alex Example",
  headline: "Lead engineer",
  currentLocation: null,
  targetRoles: ["Lead Software Engineer"],
  skills: ["Node.js", "React", "PostgreSQL"],
  experienceYears: 12,
  targetCountries: ["Germany"],
  workModes: ["onsite"],
  sponsorshipRequired: true,
  excludedCompanies: [],
  resumeText:
    "Built Node.js and React applications backed by PostgreSQL databases. Led software delivery and engineering teams.",
})
const job: Job = {
  id: "real",
  title: "Senior Full-Stack Developer",
  company: "Example",
  country: "Germany",
  remote: "onsite",
  url: "https://example.com/careers/real",
  description:
    "Build NodeJS and React applications using Postgres. Requires 10 years of experience.",
  visaSignal: "possible",
  visaSignalSource: "rules",
  sponsorVerified: false,
  freshness: "fresh",
  source: "test",
  status: "new",
  seenAt: "2026-10-29",
}
for (const title of [
  "Jr. Software Engineer",
  "Entry-level Software Engineer",
  "Software Engineer Apprentice",
  "Software Engineer - Working Student",
  "Software Engineer - New Grad",
  "Software Engineer Trainee",
  "Software Engineer - Fresher",
]) {
  test(`junior listing ${title} is excluded for senior targets and experienced candidates`, async () => {
    const { visibleRecommendations } = await import("@/lib/jobs/recommendations")
    const listing = {
      ...job,
      title,
      description: "Build NodeJS and React applications using Postgres.",
    }
    for (const profile of [
      { ...candidate, experienceYears: null },
      {
        ...candidate,
        targetRoles: ["Sr. Software Engineer"],
        experienceYears: null,
      },
      { ...candidate, targetRoles: ["Software Engineer"] },
    ]) {
      const match = matchJob(listing, profile)
      assert.equal(match.reviewable, false, JSON.stringify(profile.targetRoles))
      assert.equal(match.eligible, false)
      assert.equal(
        visibleRecommendations([{ ...listing, match }], false, false).length,
        0
      )
    }
    assert.equal(
      matchJob(listing, {
        ...candidate,
        targetRoles: ["Software Engineer"],
        experienceYears: 1,
      }).reviewable,
      true
    )
    assert.equal(
      relevantJobTitle(title, ["Sr. Software Engineer"], candidate.skills),
      false
    )
  })
}
test("related software titles and skill aliases are relevant even while sponsorship is unconfirmed", () => {
  const match = matchJob(job, candidate)
  assert.equal(match.relevant, true)
  assert.equal(match.reviewable, true)
  assert.equal(match.eligible, false)
  assert.ok(match.reasons.some((r) => r.includes("Related role")))
  assert.ok(match.reasons.some((r) => r.includes("PostgreSQL")))
})
test("unrelated jobs are never promoted as preference matches merely for location and sponsorship", () => {
  const match = matchJob(
    {
      ...job,
      title: "Accountant",
      description: "Accounting and payroll. We provide visa sponsorship.",
      visaSignal: "confirmed",
    },
    candidate
  )
  assert.equal(match.relevant, false)
  assert.equal(match.eligible, false)
  assert.equal(match.reviewable, false)
})
test("explicit sponsorship refusal and excluded companies cannot be fallback recommendations", () => {
  assert.equal(
    matchJob({ ...job, visaSignal: "no" }, candidate).reviewable,
    false
  )
  assert.equal(
    matchJob(job, { ...candidate, excludedCompanies: ["Example"] }).reviewable,
    false
  )
})

test("default recommendations include uncertain relevant roles; strict view does not", async () => {
  const { visibleRecommendations, deduplicateLocations } =
    await import("@/lib/jobs/recommendations")
  const ranked = { ...job, match: matchJob(job, candidate) }
  assert.equal(visibleRecommendations([ranked], false, false).length, 1)
  assert.equal(visibleRecommendations([ranked], true, false).length, 0)
  assert.equal(
    visibleRecommendations([{ ...ranked, isActive: false }], false, false)
      .length,
    0
  )
  const saved = {
    ...ranked,
    id: "saved-location",
    country: "Netherlands" as const,
    status: "interested" as const,
  }
  assert.equal(deduplicateLocations([ranked, saved]).length, 1)
  assert.equal(deduplicateLocations([ranked, saved])[0].id, saved.id)
})

test("company stack keywords do not turn a GTM or account role into an engineering recommendation", () => {
  const match = matchJob(
    {
      ...job,
      title: "Senior Manager - Product and GTM Enablement",
      description:
        "Our team uses NodeJS, React and Postgres. Lead our sales enablement and commercial training.",
    },
    candidate
  )
  assert.equal(match.relevant, false)
  assert.equal(match.reviewable, false)
})
test("reposted copies with different URLs collapse while preserving the saved posting", async () => {
  const { deduplicateLocations } = await import("@/lib/jobs/recommendations")
  const first = { ...job, city: "Berlin", match: matchJob(job, candidate) }
  const repost = {
    ...first,
    id: "repost",
    url: "https://example.com/careers/repost",
    status: "interested" as const,
  }
  const rows = deduplicateLocations([first, repost])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, "repost")
})

test("distinct employer requisitions survive identical title, location and description", async () => {
  const { deduplicateLocations } = await import("@/lib/jobs/recommendations")
  for (const urls of [
    [
      "https://www.accenture.com/in-en/careers/jobdetails?id=ATCI-123_en",
      "https://www.accenture.com/in-en/careers/jobdetails?id=ATCI-456_en",
    ],
    [
      "https://job-boards.greenhouse.io/example/jobs/123",
      "https://job-boards.greenhouse.io/example/jobs/456",
    ],
    [
      "https://jobs.smartrecruiters.com/Example/123",
      "https://jobs.smartrecruiters.com/Example/456",
    ],
    [
      "https://jobs.ashbyhq.com/opengov/8f8cebbe-54ee-424c-8569-230172720392",
      "https://jobs.ashbyhq.com/opengov/8cb345ba-b10c-4e2b-9d86-1e93159d2703",
    ],
    [
      "https://jobs.lever.co/paytmpayments/0eae2510-facb-4721-b5ac-74bee3c49f63",
      "https://jobs.lever.co/paytmpayments/2042b5fc-3b7a-4f67-bf02-ebb65a3f9ab2",
    ],
    [
      "https://apply.workable.com/j/0FEA1362AD",
      "https://apply.workable.com/j/F259AF4464",
    ],
    [
      "https://www.amazon.jobs/en/jobs/10604005",
      "https://www.amazon.jobs/en/jobs/SF260123206",
    ],
    [
      "https://careers.oracle.com/en/sites/jobsearch/job/347859",
      "https://careers.oracle.com/en/sites/jobsearch/job/347860",
    ],
    [
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210667152",
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210773272",
    ],
    [
      "https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012464",
      "https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012703",
    ],
    [
      "https://jobs.nokia.com/en/sites/CX_1/job/38359",
      "https://jobs.nokia.com/en/sites/CX_1/job/40015",
    ],
    [
      "https://careers.ibm.com/careers/JobDetail?jobId=142862",
      "https://careers.ibm.com/careers/JobDetail?jobId=142863",
    ],
    [
      "https://southasiacareers.deloitte.com/job/Software-Engineer/59120444/",
      "https://southasiacareers.deloitte.com/job/Software-Engineer/61599344/",
    ],
    [
      "https://careers.qualcomm.com/careers/job/446721896079",
      "https://careers.qualcomm.com/careers/job/446721896080",
    ],
    [
      "https://search.jobs.barclays/job/pune/devops-engineer/13015/98454849344",
      "https://search.jobs.barclays/job/pune/devops-engineer/13015/98454849345",
    ],
  ]) {
    const rows = urls.map((url, index) => ({
      ...job,
      id: String(index),
      title: "Custom Software Engineer",
      country: "India",
      city: "Bengaluru",
      url,
    }))
    assert.equal(deduplicateLocations(rows).length, 2)
  }
})

test("provider URL aliases collapse by requisition and preserve saved state", async () => {
  const { deduplicateLocations } = await import("@/lib/jobs/recommendations")
  for (const [url, alias] of [
    [
      "https://www.accenture.com/in-en/careers/jobdetails?id=ATCI-123_en&title=Engineer",
      "https://www.accenture.com/us-en/careers/jobdetails?id=ATCI-123_en&utm_source=jobs",
    ],
    [
      "https://jobs.ashbyhq.com/opengov/8f8cebbe-54ee-424c-8569-230172720392",
      "https://jobs.ashbyhq.com/opengov/8f8cebbe-54ee-424c-8569-230172720392/?utm_source=jobs",
    ],
    [
      "https://jobs.eu.lever.co/example/0eae2510-facb-4721-b5ac-74bee3c49f63",
      "https://jobs.eu.lever.co/example/0eae2510-facb-4721-b5ac-74bee3c49f63?lever-source=jobs",
    ],
    [
      "https://apply.workable.com/j/0FEA1362AD",
      "https://apply.workable.com/innovaccer-analytics/j/0FEA1362AD/",
    ],
    [
      "https://www.amazon.jobs/en/jobs/10604005",
      "https://www.amazon.jobs/en/jobs/10604005/software-development-engineer?source=jobs",
    ],
    [
      "https://careers.oracle.com/en/sites/jobsearch/job/347859",
      "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/347859",
    ],
    [
      "https://jobs.nokia.com/en/sites/CX_1/job/38359",
      "https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/38359",
    ],
    [
      "https://careers.ibm.com/careers/JobDetail?jobId=142862",
      "https://careers.ibm.com/en_US/careers/JobDetail?jobId=142862&utm_source=search",
    ],
    [
      "https://southasiacareers.deloitte.com/job/Software-Engineer/59120444/",
      "https://southasiacareers.deloitte.com/job/Renamed-Software-Engineer/59120444/?utm_source=jobs",
    ],
    [
      "https://careers.qualcomm.com/careers/job/446721896079",
      "https://careers.qualcomm.com/careers/job/446721896079/?source=jobs",
    ],
    [
      "https://search.jobs.barclays/job/pune/devops-engineer/13015/98454849344",
      "https://search.jobs.barclays/job/pune/renamed-role/13015/98454849344?utm_source=jobs",
    ],
  ]) {
    const first = { ...job, url, description: undefined }
    const saved = {
      ...first,
      id: "saved",
      status: "interested" as const,
      url: alias,
    }
    assert.deepEqual(
      deduplicateLocations([first, saved]).map((row) => row.id),
      ["saved"],
      url
    )
  }
})

test("compact match rows need no description and retain unknown distinct URLs", async () => {
  const { deduplicateLocations } = await import("@/lib/jobs/recommendations")
  const first = { ...job, description: undefined }
  const second = {
    ...first,
    id: "other",
    url: "https://example.com/jobs/other",
  }
  const saved = { ...first, id: "saved", status: "interested" as const }
  assert.deepEqual(
    deduplicateLocations([first, second, saved]).map((row) => row.id),
    ["saved", "other"]
  )
})

test("unverified paths do not create provider requisition identities", async () => {
  const { deduplicateLocations } = await import("@/lib/jobs/recommendations")
  for (const urls of [
    [
      "https://jobs.ashbyhq.com/example/a",
      "https://jobs.ashbyhq.com/example/b",
    ],
    ["https://jobs.lever.co/example/a", "https://jobs.lever.co/example/b"],
    ["https://apply.workable.com/j/a", "https://apply.workable.com/j/b"],
    ["https://www.amazon.jobs/en/jobs/a", "https://www.amazon.jobs/en/jobs/b"],
    [
      "https://unverified.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/123",
      "https://unverified.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/456",
    ],
    [
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/other/job/123",
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/other/job/456",
    ],
    [
      "https://careers.ibm.com/careers/JobDetail?jobId=invalid",
      "https://careers.ibm.com/careers/JobDetail?jobId=other",
    ],
    [
      "https://search.jobs.barclays/job/pune/engineer/other/123",
      "https://search.jobs.barclays/job/pune/engineer/other/456",
    ],
  ]) {
    const rows = urls.map((url, index) => ({ ...job, id: String(index), url }))
    assert.equal(deduplicateLocations(rows).length, 1, urls.join(", "))
  }
})

test("matching labels do not suppress jobs with different work descriptions", async () => {
  const { deduplicateLocations } = await import("@/lib/jobs/recommendations")
  const other = {
    ...job,
    id: "other",
    url: "https://example.com/careers/other",
    description:
      "Build Python data pipelines and maintain warehouse infrastructure.",
  }
  assert.equal(deduplicateLocations([job, other]).length, 2)
})

test("destination variants survive until a country is selected", async () => {
  const { deduplicateCountryLocations, deduplicateLocations } =
    await import("@/lib/jobs/recommendations")
  const variants = deduplicateCountryLocations([
    { ...job, country: "India" },
    { ...job, id: "germany", country: "Germany" },
  ])
  assert.equal(variants.length, 2)
  assert.equal(deduplicateLocations(variants).length, 1)
  assert.equal(
    deduplicateLocations(variants.filter((row) => row.country === "Germany"))[0]
      .id,
    "germany"
  )
})
