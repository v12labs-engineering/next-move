import assert from "node:assert/strict"
import test from "node:test"
import { buildMatches } from "@/workflows/matching"
import { readAccountState } from "@/lib/server/account-store"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import {
  finalizeMatchBuild,
  type MatchCursor,
} from "@/lib/server/matching/build"
import type { Job } from "@/lib/jobs"

test("checkpointed matching matches the complete scorer and retries only unfinished batches", async (t) => {
  const originalFetch = globalThis.fetch
  const environment = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://matching-fixture.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-key"
  t.after(() => {
    globalThis.fetch = originalFetch
    process.env = environment
  })
  const userId = "00000000-0000-4000-8000-000000000001",
    token = "00000000-0000-4000-8000-000000000002"
  const now = new Date().toISOString()
  const candidate = {
    fullName: "Example Engineer",
    headline: "Backend Engineer",
    currentLocation: null,
    targetRoles: ["Backend Engineer"],
    skills: ["TypeScript"],
    experienceYears: 3,
    workModes: ["onsite"],
    sponsorshipRequired: false,
    excludedCompanies: [],
    resumeText:
      "Backend Engineer delivering TypeScript software in backend services. Maintained API integrations and coordinated software releases with colleagues.",
  }
  const listings = Array.from({ length: 401 }, (_, i) => ({
    id: `nurse-${String(i).padStart(4, "0")}`,
    title: "Backend Engineer",
    company: `Hospital ${i}`,
    country: "India",
    city: "Hyderabad",
    url: `https://example.com/nurse-${i}`,
    work_mode: "onsite",
    visa_signal: "possible",
    sponsorship_evidence: "",
    sponsor_verified: false,
    source: "fixture",
    posted_at: now,
    last_checked_at: now,
    discovered_at: now,
    is_active: true,
    description: "Deliver TypeScript software. Requires 4 years of experience.",
  }))
  const removed = "nurse-0200"
  let published = false,
    invalidProfile = true,
    profileFailures = 0,
    failCheckpoint = false,
    failDescription = false,
    scanned = 0
  let cursor: MatchCursor = {
    token,
    batch: 0,
    country: 0,
    after: null,
    phase: "catalog",
    measuredAt: now,
  }
  const batches: { batch: number; payload: { jobs: Job[] } }[] = [],
    staged: Job[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, "matching-fixture.example")
    const op = url.pathname.split("/").at(-1)!
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (op === "account_profiles")
      return Response.json({ data: candidate, version: 1 })
    if (op === "account_countries")
      return Response.json([{ country: "India", added_at: now }])
    if (op === "account_job_states") return Response.json([])
    if (op === "catalog_matching_overview")
      return Response.json({
        totalJobs: 401,
        sources: 1,
        failedSources: 0,
        lastUpdatedAt: now,
        health: [],
      })
    if (op === "catalog_matching_batch") {
      const remaining = listings.filter(
        (row) => !body.p_after || row.id > body.p_after
      )
      const items = remaining.slice(0, body.p_limit)
      scanned += items.length
      return Response.json({ items, hasMore: remaining.length > items.length })
    }
    if (op === "job_catalog")
      return Response.json(
        failDescription
          ? listings.filter((row) => row.id !== removed)
          : listings
      )
    if (op === "begin_account_match_build")
      return Response.json(
        published
          ? null
          : {
              cursor,
              profile: {
                data: invalidProfile
                  ? {
                      ...candidate,
                      experienceYears: undefined,
                      yearsExperience: 3,
                    }
                  : candidate,
                version: 1,
                countries: invalidProfile
                  ? []
                  : [{ country: "India", added_at: now }],
              },
            }
      )
    if (op === "fail_account_matching") {
      assert.equal(body.p_user, userId)
      assert.equal(body.p_token, token)
      profileFailures++
      return Response.json(null)
    }
    if (op === "checkpoint_account_match_batch") {
      if (failCheckpoint && body.p_batch === 1) {
        failCheckpoint = false
        return Response.json(
          { message: "injected checkpoint failure" },
          { status: 500 }
        )
      }
      assert.equal(body.p_batch, cursor.batch)
      for (const job of body.p_payload.jobs) {
        assert.equal(job.description, undefined)
        assert.equal(job.match.eligible, true)
      }
      batches.push({ batch: body.p_batch, payload: body.p_payload })
      cursor = body.p_next
      return Response.json(cursor)
    }
    if (op === "account_match_batches") {
      const after = Number(url.searchParams.get("batch")?.replace("gt.", ""))
      return Response.json(
        batches.filter((row) => row.batch > after).slice(0, 100)
      )
    }
    if (op === "reset_account_matches") {
      staged.length = 0
      return Response.json(null)
    }
    if (op === "stage_account_matches") {
      staged.push(...body.p_jobs)
      return Response.json(null)
    }
    if (op === "publish_account_matches") {
      assert.equal(body.p_count, failDescription ? 400 : 401)
      assert.equal(
        body.p_summary.catalog.coverage[0].relevantVacancies,
        body.p_count
      )
      published = true
      return Response.json(true)
    }
    throw new Error(`Unexpected operation: ${op}`)
  }
  assert.equal(await buildMatches(userId, token, 1), false)
  assert.equal(
    profileFailures,
    1,
    "An incomplete profile stops once without retries"
  )
  assert.equal(scanned, 0, "An incomplete profile must not scan the catalogue")
  assert.equal(
    published,
    false,
    "An incomplete profile must not publish matches"
  )
  invalidProfile = false
  const baseline = await readAccountState({
    db: supabaseServerClient(),
    user: { id: userId },
  })
  assert.equal(baseline.jobs.length, 401)
  scanned = 0
  failCheckpoint = true
  await assert.rejects(buildMatches(userId, token, 1), {
    message: "injected checkpoint failure",
  })
  assert.equal(cursor.batch, 1)
  assert.equal(published, false)
  await buildMatches(userId, token, 1)
  assert.deepEqual(staged, JSON.parse(JSON.stringify(baseline.jobs)))
  assert.equal(
    scanned,
    601,
    "the committed first 200 listings must not be rescanned or rescored"
  )
  const completedScans = scanned
  await buildMatches(userId, token, 1)
  assert.equal(
    scanned,
    completedScans,
    "publication replay does no computation"
  )
  console.log(
    JSON.stringify({
      benchmark: "batch_retry",
      jobs: 401,
      fullRestartRows: 802,
      checkpointedRows: scanned,
    })
  )
  published = false
  batches.length = 0
  cursor = { ...cursor, batch: 0, country: 0, after: null, phase: "catalog" }
  failDescription = true
  staged.length = 0
  await buildMatches(userId, token, 1)
  assert.equal(
    published,
    true,
    "a listing removed mid-scan does not block publication"
  )
  assert.equal(staged.length, 400)
  assert.equal(
    staged.some((job) => job.id === removed),
    false
  )
})

for (const duringPublication of [false, true]) {
  test(`missing destinations stop ${duringPublication ? "publication" : "scoring"} without replacing existing matches`, async (t) => {
    const environment = { ...process.env }
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: "https://matching-fixture.example",
      SUPABASE_SERVICE_ROLE_KEY: "fixture-key",
    })
    t.after(() => {
      process.env = environment
    })
    const operations: string[] = []
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        const operation = url.pathname.split("/").at(-1)!
        operations.push(operation)
        if (operation === "begin_account_match_build")
          return Response.json({
            cursor: {
              token: "owned-token",
              batch: 0,
              phase: duringPublication ? "done" : "catalog",
            },
            profile: {
              version: 1,
              countries: [],
              data: {
                fullName: "Generated QA candidate",
                headline: "Backend Engineer",
                currentLocation: null,
                targetRoles: ["Backend Engineer"],
                skills: ["TypeScript"],
                experienceYears: null,
                workModes: ["remote", "hybrid", "onsite"],
                sponsorshipRequired: null,
                excludedCompanies: [],
                resumeText:
                  "Fictional QA candidate. Built TypeScript APIs, request validation and automated tests for a generated project. No real applicant.",
              },
            },
          })
        assert.equal(
          operation,
          "fail_account_matching",
          "No listing reads or publication writes are permitted"
        )
        assert.deepEqual(JSON.parse(String(init?.body)), {
          p_user: "generated-user",
          p_token: "owned-token",
        })
        return Response.json(null)
      }
    )
    const result = duringPublication
      ? await finalizeMatchBuild("generated-user", "owned-token", 1)
      : await buildMatches("generated-user", "owned-token", 1)
    assert.equal(result, false)
    assert.deepEqual(operations, [
      "begin_account_match_build",
      "fail_account_matching",
    ])
  })
}
