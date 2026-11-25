import assert from "node:assert/strict"
import test from "node:test"
import { catalogSources } from "@/lib/server/catalog/feeds"
import { parseGreenhouse } from "@/lib/server/catalog/connectors/board-apis"
import {
  catalogListingsInSearch,
  deduplicateLocations,
} from "@/lib/jobs/recommendations"
import { matchJob } from "@/lib/matching"
import { emptyCandidate, type Candidate } from "@/lib/candidate"
import type { Job } from "@/lib/jobs"

test("catalogue includes verified employer feeds with India and Hyderabad coverage", () => {
  const sources = catalogSources.map((source) => String(source.id))
  assert.ok(sources.includes("greenhouse:newrelic"))
  assert.ok(sources.includes("greenhouse:deliveroo"))
})

test("a multi-city vacancy keeps the requested Hyderabad variant when its region needs confirmation", () => {
  const profile: Candidate = {
    ...emptyCandidate,
    fullName: "Test Applicant",
    headline: "Software Engineer",
    targetRoles: ["Software Engineer"],
    skills: ["TypeScript"],
    targetCountries: ["India"],
    targetLocations: [
      { id: 1269843, name: "Hyderabad", region: "Telangana", country: "India" },
    ],
  }
  const base: Job = {
    id: "bangalore",
    title: "Software Engineer",
    company: "Example",
    country: "India",
    city: "Bangalore, India",
    remote: "unknown",
    url: "https://example.com/jobs/shared",
    description: "Build software using TypeScript.",
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    freshness: "fresh",
    source: "test",
    status: "new",
    seenAt: "2026-10-29",
  }
  const jobs = [
    base,
    { ...base, id: "hyderabad", city: "Hyderabad, India" },
  ].map((job) => ({ ...job, match: matchJob(job, profile) }))
  assert.equal(jobs[0].match.reviewable, false)
  assert.equal(jobs[1].match.reviewable, true)
  assert.equal(deduplicateLocations(jobs)[0].id, "hyderabad")
  assert.equal(catalogListingsInSearch([base], ["Germany"]).length, 0)
  assert.equal(
    catalogListingsInSearch([{ ...base, isActive: false }], ["India"]).length,
    0
  )
  assert.equal(catalogListingsInSearch([base], ["India"]).length, 1)
})

test("Greenhouse retains distinct same-country locations and explicit evidence without guessing geography or dates", () => {
  const source = catalogSources.find(
    (source) => String(source.id) === "greenhouse:newrelic"
  )!
  const raw = {
    id: 1,
    title: "Software Engineer",
    absolute_url: "https://example.com/jobs/1",
    location: { name: "Bangalore, India; Hyderabad, India" },
    content:
      "&lt;p&gt;Build TypeScript APIs, test reliable distributed systems and collaborate with software engineers. Visa sponsorship is not available for this position.&lt;/p&gt;",
    updated_at: "2026-10-29T08:00:00Z",
    metadata: [{ name: "Work Arrangement", value: "Hybrid" }],
  }
  const rows = parseGreenhouse(source, { jobs: [raw] })
  assert.deepEqual(
    rows.map((row) => [row.country, row.city]),
    [
      ["India", "Bangalore"],
      ["India", "Hyderabad"],
    ]
  )
  assert.notEqual(rows[0].id, rows[1].id)
  assert.equal(rows[1].id, parseGreenhouse(source, { jobs: [raw] })[1].id)
  assert.equal(rows[1].work_mode, "hybrid")
  assert.equal(rows[1].visa_signal, "no")
  assert.equal(rows[1].sponsor_verified, false)
  assert.equal(rows[1].posted_at, null)
  assert.ok(!rows[1].description.includes("<p>"))
  assert.equal(
    parseGreenhouse(source, {
      jobs: [{ ...raw, first_published: "2026-10-20T00:00:00Z" }],
    })[0].posted_at,
    "2026-10-20T00:00:00.000Z"
  )
  assert.deepEqual(
    parseGreenhouse(source, {
      jobs: [{ ...raw, location: { name: "Worldwide" } }],
    }),
    []
  )
  assert.deepEqual(
    parseGreenhouse(source, {
      jobs: [{ ...raw, absolute_url: "javascript:bad" }],
    }),
    []
  )
  const metadata = [{ name: "Country", value: "India" }]
  const fromMetadata = parseGreenhouse(source, {
    jobs: [{ ...raw, location: { name: "Hyderabad" }, metadata }],
  })[0]
  assert.equal(fromMetadata.country, "India")
  assert.equal(fromMetadata.work_mode, "unknown")
})
