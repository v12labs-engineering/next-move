import assert from "node:assert/strict"
import test from "node:test"
import {
  processMatchBatch,
  type MatchCursor,
} from "@/lib/server/matching/build"

test("matching keeps every saved job, past any fixed cap", async (t) => {
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
  const states = Array.from({ length: 1050 }, (_, i) => ({
    job_id: `saved-${String(i).padStart(4, "0")}`,
    status: i % 2 ? "applied" : "dismissed",
  }))
  const listing = (id: string) => ({
    id,
    title: "Registered Nurse",
    company: "Hospital",
    country: "India",
    city: "Hyderabad",
    url: `https://example.com/${id}`,
    work_mode: "onsite",
    visa_signal: "possible",
    sponsorship_evidence: "",
    sponsor_verified: false,
    source: "fixture",
    posted_at: now,
    last_checked_at: now,
    discovered_at: now,
    is_active: false,
    description: "Deliver patient care.",
  })
  let cursor: MatchCursor = {
    token,
    batch: 0,
    country: 0,
    after: null,
    phase: "catalog",
    measuredAt: now,
  }
  const checkpointed = new Map<string, string>()
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const op = url.pathname.split("/").at(-1)!
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const inList = (key: string) =>
      url.searchParams
        .get(key)
        ?.match(/^in\.\((.*)\)$/)?.[1]
        .split(",")
    if (op === "begin_account_match_build")
      return Response.json({
        cursor,
        profile: {
          data: {
            fullName: "Example Nurse",
            headline: "Registered Nurse",
            currentLocation: null,
            targetRoles: ["Registered Nurse"],
            skills: ["Patient care"],
            experienceYears: 3,
            workModes: ["onsite"],
            sponsorshipRequired: false,
            excludedCompanies: [],
            resumeText:
              "Registered Nurse delivering patient care in hospital wards. Maintained patient records and coordinated clinical handovers with colleagues.",
          },
          version: 1,
          countries: [{ country: "India", added_at: now }],
        },
        facts: null,
      })
    if (op === "catalog_matching_batch")
      return Response.json({ items: [], hasMore: false })
    if (op === "account_job_states") {
      const after = url.searchParams.get("job_id")?.replace(/^gt\./, "")
      const limit = Number(url.searchParams.get("limit"))
      return Response.json(
        states.filter((s) => !after || s.job_id > after).slice(0, limit)
      )
    }
    if (op === "job_catalog")
      return Response.json((inList("id") ?? []).map(listing))
    if (op === "checkpoint_account_match_batch") {
      for (const job of body.p_payload.jobs)
        checkpointed.set(job.id, job.status)
      cursor = body.p_next
      return Response.json(cursor)
    }
    throw new Error(`Unexpected operation: ${op}`)
  }
  for (let i = 0; i < 20 && !(await processMatchBatch(userId, token, 1)); i++);
  assert.equal(cursor.phase, "done")
  assert.equal(checkpointed.size, states.length)
  for (const s of states) assert.equal(checkpointed.get(s.job_id), s.status)
})
