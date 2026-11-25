import assert from "node:assert/strict"
import test from "node:test"
import { selectAutoApplicationCandidates } from "@/lib/server/applications/auto-apply"
import { candidateSchema } from "@/lib/candidate"
import { autoApplyEligible } from "@/lib/applications/auto-apply"
import type { Job } from "@/lib/jobs"

test("paged auto-apply retains the same top 50 eligible jobs with bounded memory", () => {
  const candidate = candidateSchema.parse({
    fullName: "Fixture Candidate",
    headline: "Engineer",
    currentLocation: null,
    targetRoles: ["Engineer"],
    skills: ["Python"],
    experienceYears: 5,
    targetCountries: ["Germany"],
    workModes: ["onsite"],
    sponsorshipRequired: false,
    excludedCompanies: [],
    resumeText:
      "Synthetic engineer building software and maintaining Python services for several years. Designed reliable databases and automated regression testing.",
    autoApply: { enabled: true, minScore: 80 },
  })
  const jobs: Job[] = Array.from({ length: 5000 }, (_, i) => ({
    id: String(i),
    title: "Engineer",
    company: "Fixture",
    country: i % 7 ? "Germany" : "Canada",
    url: `https://example.com/${i}`,
    remote: "onsite",
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    source: "fixture",
    status: i % 11 ? "new" : "applied",
    isActive: true,
    freshness: "fresh",
    seenAt: new Date().toISOString(),
    match: {
      score: i % 101,
      relevant: true,
      eligible: true,
      reviewable: true,
      reasons: [],
      gaps: [],
    },
  }))
  const expected = jobs
    .filter(
      (j) =>
        candidate.targetCountries.includes(j.country) &&
        autoApplyEligible(candidate, j)
    )
    .sort((a, b) => b.match!.score - a.match!.score)
    .slice(0, 50)
  let retained: Job[] = []
  for (let offset = 0; offset < jobs.length; offset += 200) {
    retained = selectAutoApplicationCandidates(candidate, [
      ...retained,
      ...jobs.slice(offset, offset + 200),
    ])
    assert.ok(retained.length <= 50)
  }
  assert.deepEqual(retained, expected)
  console.log(
    JSON.stringify({
      benchmark: "auto_apply_retained_rows",
      before: jobs.length,
      after: retained.length,
    })
  )
})
