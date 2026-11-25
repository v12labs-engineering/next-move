import { test } from "node:test"
import assert from "node:assert/strict"
import {
  freshnessOf,
  verifyAgainstRegister,
  normalizePayload,
  mergeJobs,
} from "../lib/jobs"
import { sanitizeJobTitle } from "../lib/jobs/title"
import { parseVisaSignal } from "../lib/server/visa-signal"
import { rowsToAppState } from "../lib/server/app-state-store"
import type { Job } from "../lib/jobs"
import type { ImportPayload } from "../lib/location/relocation-data"

const NOW = new Date("2026-06-28T00:00:00Z")

test("freshnessOf: <=3 days is fresh", () => {
  assert.equal(freshnessOf("2026-06-26T00:00:00Z", NOW), "fresh")
})

test("freshnessOf: 4..30 days is ok", () => {
  assert.equal(freshnessOf("2026-06-10T00:00:00Z", NOW), "ok")
})

test("freshnessOf: >30 days is stale", () => {
  assert.equal(freshnessOf("2026-04-01T00:00:00Z", NOW), "stale")
})

test("freshnessOf: missing date is stale", () => {
  assert.equal(freshnessOf(undefined, NOW), "stale")
})

test("verifyAgainstRegister: case-insensitive trimmed match", () => {
  const names = new Set(["acme bv", "globex"])
  assert.equal(verifyAgainstRegister("  ACME BV ", names), true)
  assert.equal(verifyAgainstRegister("Unknown Co", names), false)
})

test("sanitizeJobTitle strips embedded html and decodes common entities", () => {
  assert.equal(
    sanitizeJobTitle(
      'Senior Engineer &amp; Lead <img loading="lazy" src="/flag.svg" alt="SG"> APAC'
    ),
    "Senior Engineer & Lead APAC"
  )
})

test("normalizePayload: flattens leads, verifies sponsor, sets freshness", () => {
  const payload: ImportPayload = {
    companies: [
      {
        id: "c1",
        name: "Acme BV",
        country: "Netherlands",
        city: "Amsterdam",
      } as never,
    ],
    jobs: [
      {
        id: "j1",
        title: "Staff Engineer",
        companyId: "c1",
        country: "Netherlands",
        city: "Amsterdam",
        workMode: "hybrid",
        sourceUrl: "https://x/job",
        sourceType: "greenhouse",
        visaConfidence: "strong",
        refreshedAt: "2026-06-27T00:00:00Z",
        createdAt: "2026-06-27T00:00:00Z",
      } as never,
    ],
    people: [],
    drafts: [],
  } as never

  const jobs = normalizePayload(payload, {
    tier: "official_register",
    registerNames: new Set(["acme bv"]),
    now: new Date("2026-06-28T00:00:00Z"),
  })

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].company, "Acme BV")
  assert.equal(jobs[0].remote, "hybrid")
  assert.equal(jobs[0].visaSignal, "strong")
  assert.equal(jobs[0].visaSignalSource, "rules")
  assert.equal(jobs[0].sponsorVerified, true)
  assert.equal(jobs[0].freshness, "fresh")
  assert.equal(jobs[0].status, "new")
})

test("normalizePayload: discovery tier never verifies", () => {
  const payload = {
    companies: [{ id: "c1", name: "Acme BV", country: "Germany" } as never],
    jobs: [
      {
        id: "j1",
        title: "Eng",
        companyId: "c1",
        country: "Germany",
        workMode: "remote",
        sourceUrl: "u",
        sourceType: "arbeitnow",
        visaConfidence: "possible",
        createdAt: "2026-06-27T00:00:00Z",
      } as never,
    ],
    people: [],
    drafts: [],
  } as never
  const jobs = normalizePayload(payload, {
    tier: "discovery_proxy",
    registerNames: new Set(["acme bv"]),
    now: new Date("2026-06-28T00:00:00Z"),
  })
  assert.equal(jobs[0].sponsorVerified, false)
})

test("rowsToAppState: reads normalized rows as simple UI state", () => {
  const state = rowsToAppState({
    jobs: [
      {
        id: "j1",
        company_id: "c1",
        title: "Senior Applied AI Engineer",
        country: "Netherlands",
        city: "Amsterdam",
        work_mode: "hybrid",
        source_url: "https://example.com/job",
        source_type: "career_page",
        visa_confidence: "possible",
        relocation_signal: "Relocation may be possible.",
        status: "shortlisted",
        created_at: "2026-06-26T00:00:00Z",
        refreshed_at: "2026-06-27T00:00:00Z",
      },
    ],
    companies: [{ id: "c1", name: "Acme BV" }],
    countryScores: [
      {
        country: "Netherlands",
        city: "Amsterdam / Eindhoven",
        score: 94,
        safety: 9,
        healthcare: 9,
        childcare: 8,
        spouse_rights: 9,
        english_friendly: 9,
        residence_path: 9,
        cost_pressure: "high",
        notes: "Strong family fit.",
      },
    ],
    trackedCountries: [
      {
        country: "Netherlands",
        source_tier: "official_register",
        added_at: "2026-06-25T00:00:00Z",
      },
    ],
    now: NOW,
  })

  assert.equal(state.jobs.length, 1)
  assert.equal(state.jobs[0].company, "Acme BV")
  assert.equal(state.jobs[0].url, "https://example.com/job")
  assert.equal(state.jobs[0].status, "interested")
  assert.equal(state.jobs[0].freshness, "fresh")
  assert.equal(state.trackedCountries.length, 1)
  assert.equal(state.trackedCountries[0].country, "Netherlands")
  assert.equal(state.trackedCountries[0].sourceTier, "official_register")
  assert.equal(state.trackedCountries[0].addedAt, "2026-06-25T00:00:00Z")
  assert.equal(state.trackedCountries[0].score?.spouseRights, 9)
})

function job(over: Partial<Job>): Job {
  return {
    id: "j",
    title: "Eng",
    company: "Acme",
    country: "Netherlands",
    remote: "remote",
    url: "https://x/1",
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    freshness: "ok",
    source: "greenhouse",
    status: "new",
    seenAt: "2026-06-01T00:00:00Z",
    ...over,
  }
}

test("mergeJobs: appends genuinely new jobs as new", () => {
  const out = mergeJobs(
    [job({ url: "https://x/1" })],
    [job({ id: "j2", url: "https://x/2" })]
  )
  assert.equal(out.length, 2)
  assert.equal(out.find((j) => j.url === "https://x/2")?.status, "new")
})

test("mergeJobs: existing job keeps its status and seenAt across refresh", () => {
  const existing = [
    job({
      url: "https://x/1",
      status: "applied",
      seenAt: "2026-06-01T00:00:00Z",
      freshness: "stale",
    }),
  ]
  const incoming = [
    job({
      url: "https://x/1",
      status: "new",
      seenAt: "2026-06-28T00:00:00Z",
      freshness: "fresh",
      visaSignal: "confirmed",
    }),
  ]
  const out = mergeJobs(existing, incoming)
  assert.equal(out.length, 1)
  assert.equal(out[0].status, "applied")
  assert.equal(out[0].seenAt, "2026-06-01T00:00:00Z")
  assert.equal(out[0].freshness, "fresh")
  assert.equal(out[0].visaSignal, "confirmed")
})

test("parseVisaSignal: extracts signal + reason from JSON", () => {
  const out = parseVisaSignal(
    '{"signal":"confirmed","reason":"Post says we sponsor visas"}'
  )
  assert.deepEqual(out, {
    signal: "confirmed",
    reason: "Post says we sponsor visas",
  })
})

test("parseVisaSignal: returns null on garbage", () => {
  assert.equal(parseVisaSignal("not json"), null)
})

test("parseVisaSignal: returns null on invalid signal value", () => {
  assert.equal(parseVisaSignal('{"signal":"maybe","reason":"x"}'), null)
})
