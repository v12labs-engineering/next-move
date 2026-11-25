import assert from "node:assert/strict"
import test from "node:test"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import {
  requestAutoApplications,
  recoverPendingApplicationDispatches,
  autoApplyForAccount,
} from "@/lib/server/applications/auto-apply"
import { candidateSchema } from "@/lib/candidate"
import type { Job } from "@/lib/jobs"

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
    "Synthetic engineer building Python services, reliable SQL databases and automated regression tests. Coordinated releases and monitoring for synthetic applications.",
  autoApply: { enabled: true, minScore: 80 },
})
const jobs: Job[] = Array.from({ length: 51 }, (_, i) => ({
  id: String(i),
  title: "Engineer",
  company: "Fixture",
  country: "Germany",
  url: `https://example.com/${i}`,
  remote: "onsite",
  visaSignal: "possible",
  visaSignalSource: "rules",
  sponsorVerified: false,
  source: "fixture",
  status: "new",
  isActive: true,
  freshness: "fresh",
  seenAt: new Date().toISOString(),
  match: {
    score: 100 - Math.floor(i / 3),
    relevant: true,
    eligible: true,
    reviewable: true,
    reasons: [],
    gaps: [],
  },
}))

test("existing top 50 applications cannot starve the 51st eligible job across match pages", async (t) => {
  const env = { ...process.env }
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
  })
  t.after(() => {
    process.env = env
  })
  const requested: string[] = []
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      switch (url.pathname.split("/").at(-1)) {
        case "account_profiles":
          return Response.json({ data: candidate, version: 1 })
        case "account_countries":
          return Response.json([
            { country: "Germany", added_at: new Date().toISOString() },
          ])
        case "read_account_matches_for":
          return Response.json({
            jobs,
            total: jobs.length,
            profileVersion: 1,
            generation: "fixture",
            matching: { profileCurrent: true },
          })
        case "application_runs":
          return Response.json(
            jobs.slice(0, 50).map((job) => ({ job_id: job.id }))
          )
        case "request_automatic_application_for":
          requested.push(JSON.parse(String(init?.body)).p_job)
          return Response.json(
            { code: "P0001", message: "Monthly application limit reached" },
            { status: 400 }
          )
        default:
          throw Error(`Unexpected operation ${url.pathname}`)
      }
    }
  )
  assert.deepEqual(await autoApplyForAccount("user"), {
    started: [],
    limited: true,
  })
  assert.deepEqual(requested, ["50"])
  requested.length = 0
  await requestAutoApplications(
    supabaseServerClient(),
    "user",
    candidate,
    jobs,
    async (id) => {
      requested.push(id)
      return {
        data: null,
        error: { code: "P0001", message: "Monthly application limit reached" },
      }
    }
  )
  assert.deepEqual(requested, ["50"])
})

test("dispatch recovery visits pending intents and keeps retrying after dispatch failure", async (t) => {
  const env = { ...process.env }
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
  })
  t.after(() => {
    process.env = env
  })
  const intents = [
    { id: "a", status: "queued_prepare", revision: 1 },
    { id: "b", status: "queued", revision: 4 },
    { id: "c", status: "ready", revision: 2 },
    {
      id: "d",
      status: "queued",
      revision: 3,
      retry_after: new Date(Date.now() + 300000).toISOString(),
    },
  ]
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith("/recover_application_preparation"))
      return Response.json(0)
    assert.equal(url.searchParams.has("automatic"), false)
    assert.equal(
      url.searchParams.get("or"),
      "(status.in.(queued_prepare,queued),and(status.eq.ready,automatic.eq.true))"
    )
    assert.ok(url.searchParams.get("updated_at")?.startsWith("lt."))
    assert.equal(url.searchParams.get("limit"), "100")
    return Response.json(intents)
  })
  const visited: string[] = []
  const cursor = await recoverPendingApplicationDispatches(
    null,
    undefined,
    async (run) => {
      visited.push(run.id)
      if (run.id === "a") throw Error("Injected start failure")
    }
  )
  assert.equal(cursor, "d")
  assert.deepEqual(visited, ["a", "b", "c"])
  visited.length = 0
  await recoverPendingApplicationDispatches(null, undefined, async (run) => {
    visited.push(run.id)
  })
  assert.deepEqual(
    visited,
    ["a", "b", "c"],
    "failed starts are not lost; original revisions are replayed"
  )
})
