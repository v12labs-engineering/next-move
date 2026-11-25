import assert from "node:assert/strict"
import test from "node:test"
import { scanCatalog } from "@/lib/server/catalog/read"
import { createCoverageAssessment } from "@/lib/jobs/coverage"
import { countryOptions } from "@/lib/location/countries"
import type { Job } from "@/lib/jobs"

test("a relevant vacancy after 3,000 unrelated listings is still assessed", async () => {
  const rows = Array.from({ length: 3201 }, (_, i) => ({
    id: String(i).padStart(5, "0"),
    title: i === 3200 ? "Registered Nurse" : "Accountant",
  }))
  const found: string[] = []
  await scanCatalog(
    async (after) => rows.filter((r) => !after || r.id > after).slice(0, 1000),
    (page) => {
      found.push(
        ...page.filter((r) => r.title === "Registered Nurse").map((r) => r.id)
      )
    }
  )
  assert.deepEqual(found, ["03200"])
})

test("coverage distinguishes unconfigured, unmeasured, failed, partial, stale and checked-empty sources", () => {
  const now = new Date("2026-10-29T12:00:00Z")
  const report = createCoverageAssessment(
    ["India", "Canada", "Germany", "Japan", "France", "UAE", "Ireland"],
    now
  ).report([
    {
      id: "unmeasured",
      countries: ["India"],
      enabled: true,
      last_success_at: null,
      failed: false,
      complete: null,
      pending: false,
    },
    {
      id: "failed",
      countries: ["Canada"],
      enabled: true,
      last_success_at: null,
      failed: true,
      complete: null,
      pending: true,
    },
    {
      id: "partial",
      countries: ["Germany"],
      enabled: true,
      last_success_at: null,
      failed: false,
      complete: null,
      pending: true,
    },
    {
      id: "stale",
      countries: ["Japan"],
      enabled: true,
      last_success_at: "2026-10-28T12:00:00Z",
      failed: false,
      complete: true,
      pending: false,
    },
    {
      id: "empty",
      countries: ["France"],
      enabled: true,
      last_success_at: now.toISOString(),
      failed: false,
      complete: true,
      pending: false,
    },
    {
      id: "disabled",
      countries: ["UAE"],
      enabled: false,
      last_success_at: null,
      failed: false,
      complete: null,
      pending: false,
    },
  ])
  assert.deepEqual(
    report.countries.map((r) => r.state),
    [
      "unmeasured",
      "failed",
      "partial",
      "stale",
      "checked_empty",
      "no_configured_source",
      "no_configured_source",
    ]
  )
})

test("coverage includes all destinations and counts location variants once per country", () => {
  const assessment = createCoverageAssessment(
    countryOptions,
    new Date("2026-10-29T12:00:00Z")
  )
  const job: Job = {
    id: "1",
    title: "Nurse",
    country: "India",
    city: "Hyderabad",
    company: "Hospital",
    url: "https://example.com/jobs/1",
    description: "Care",
    remote: "onsite",
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    freshness: "fresh",
    source: "test",
    status: "new",
    seenAt: "2026-10-29",
    isActive: true,
    lastCheckedAt: "2026-10-29T11:00:00Z",
  }
  assessment.add([
    job,
    { ...job, id: "2", city: "Bengaluru" },
    { ...job, id: "3", url: "https://example.com/jobs/3", isActive: false },
  ])
  const report = assessment.report()
  assert.equal(report.countries.length, 249)
  assert.equal(
    report.countries.find((r) => r.country === "India")?.activeVacancies,
    1
  )
  assert.equal(
    report.countries.find((r) => r.country === "India")?.unknownSponsorship,
    1
  )
  assert.equal(
    report.countries.find((r) => r.country === "Canada")?.state,
    "no_observed_supply"
  )
  assert.equal(
    report.countries.find((r) => r.country === "India")?.confirmedSponsorship,
    0
  )
})
