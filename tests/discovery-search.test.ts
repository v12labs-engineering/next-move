import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import {
  discoverProfileSource,
  prioritizeDiscoveryObservations,
} from "@/lib/server/catalog/discovery-search"
import { newMatchingJobs } from "@/lib/jobs/search"
import type { Job } from "@/lib/jobs"

test("large employer discovery uses actual country/title evidence and prioritizes unseen jobs over refreshed listings", async () => {
  const jobs = Array.from({ length: 500 }, (_, i) => ({
    title: i % 5 === 0 ? "Civil Engineer" : "Senior Software Engineer",
    isListed: true,
    jobUrl: `https://jobs.ashbyhq.com/fixture/job-${i}`,
    descriptionPlain:
      "Develop TypeScript services and production systems. ".repeat(4),
    publishedAt: "2026-10-30T10:00:00Z",
    address: {
      postalAddress: {
        addressCountry: i % 7 === 0 ? "United States" : "India",
        addressLocality: "Hyderabad",
      },
    },
  }))
  const result = await discoverProfileSource(
    {
      id: "ashby:fixture",
      kind: "ashby",
      board: "fixture",
      company: "Fixture",
    },
    { roles: ["Lead Software Engineer"], countries: ["India"] },
    { fetch: async () => Response.json({ jobs }) }
  )
  assert.ok(
    result.jobs.length > 100,
    "The old whole-board size gate must not exclude this employer"
  )
  assert.ok(
    result.jobs.every(
      (job) =>
        job.country === "India" && job.title === "Senior Software Engineer"
    )
  )
  const old = new Set(result.jobs.slice(0, 200).map((job) => job.id))
  const db = createClient("https://fixture.example", "fixture", {
    global: {
      fetch: async (input) => {
        const ids = new URL(String(input)).searchParams
          .get("id")!
          .slice(4, -1)
          .split(",")
        return Response.json(
          ids.filter((id) => old.has(id)).map((id) => ({ id }))
        )
      },
    },
  })
  const selected = await prioritizeDiscoveryObservations(db, result.jobs)
  assert.equal(selected.length, 100)
  assert.ok(
    selected.every((job) => !old.has(job.id)),
    "Old observations cannot crowd unseen jobs out of the batch"
  )
  assert.equal(result.complete, true)
})

test("new-match counts use first discovery rather than a refreshed observation timestamp", () => {
  const make = (id: string, seenAt: string, reviewable = true): Job => ({
    id,
    title: "Software Engineer",
    company: id,
    country: "India",
    city: "Hyderabad",
    remote: "hybrid",
    url: `https://example.com/${id}`,
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    freshness: "stale",
    source: "fixture",
    status: "new",
    seenAt,
    lastCheckedAt: "2026-10-31T12:00:00Z",
    match: {
      score: 80,
      relevant: true,
      reviewable,
      eligible: false,
      reasons: [],
      gaps: [],
    },
  })
  const oldVariant = make("old-variant", "2026-10-01")
  const newVariant = {
    ...make("new-variant", "2026-10-31T11:00:00Z"),
    url: oldVariant.url,
    company: "Variant Employer",
  }
  const jobs = [
    oldVariant,
    newVariant,
    make("old-refreshed", "2026-10-01"),
    make("new-match", "2026-10-31T11:00:00Z"),
    make("unrelated-city", "2026-10-31T11:00:00Z", false),
  ]
  assert.deepEqual(
    newMatchingJobs(jobs, "2026-10-31T10:00:00Z").map((job) => job.id),
    ["new-match"]
  )
})

test("hosted completion stays partial when a planned board has no recorded result", async () => {
  const { finishSearch } = await import("@/workflows/job-search")
  const originalFetch = globalThis.fetch
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://workflow-fixture.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "operator-fixture"
  try {
    for (const [results, expected] of [
      [
        { "ashby:one": { status: "published", records: 1, complete: true } },
        "partial",
      ],
      [
        {
          "ashby:one": { status: "published", records: 1, complete: true },
          "lever:two": { status: "published", records: 0, complete: true },
        },
        "completed",
      ],
    ] as const) {
      let saved: { status?: string } = {}
      globalThis.fetch = async (input, init) => {
        assert.equal(
          new URL(String(input)).hostname,
          "workflow-fixture.example"
        )
        if (init?.method === "PATCH") {
          saved = JSON.parse(String(init.body))
          return new Response(null, { status: 204 })
        }
        return Response.json([{ sources: ["ashby:one", "lever:two"], results }])
      }
      await finishSearch("fixture-run", "fixture-token", "completed", null)
      assert.equal(saved.status, expected)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
  }
})
