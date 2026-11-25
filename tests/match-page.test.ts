import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { readMatchPage } from "@/lib/server/matching/store"

// Exercise the request seam: no catalogue, description, source-health or scoring requests.
test("repeat page visits only read the profile and persisted matching page", async () => {
  const calls: string[] = []
  let expectedDatePosted = "month"
  const db = createClient("https://db.example", "fixture-key", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input)
        ).pathname
        calls.push(path)
        if (path.endsWith("account_profiles"))
          return Response.json({
            version: 1,
            data: {
              fullName: "Example Nurse",
              headline: "Registered Nurse",
              currentLocation: "Pune, India",
              targetRoles: ["Registered Nurse"],
              skills: ["Patient care"],
              experienceYears: 3,
              workModes: ["onsite"],
              sponsorshipRequired: true,
              excludedCompanies: [],
              resumeText:
                "Registered Nurse delivering patient care in hospital wards. Maintained patient records and coordinated clinical handovers with colleagues.",
            },
          })
        if (path.endsWith("account_countries"))
          return Response.json([{ country: "India", added_at: "2026-10-31" }])
        if (path.endsWith("read_account_matches")) {
          const { p_filters: filters } = JSON.parse(String(init?.body))
          assert.equal(filters.limit, 25)
          assert.equal(filters.offset, 25)
          assert.equal(filters.datePosted, expectedDatePosted)
          assert.equal(filters.country, "India")
          assert.deepEqual(filters.visaExempt, ["India"])
          if (expectedDatePosted === "day") {
            assert.equal(filters.query, "engineer platform")
            assert.equal(filters.city, "Pune")
            assert.equal(filters.company, "Example")
            assert.equal(filters.workMode, "hybrid")
            assert.equal(filters.category, "software")
            assert.equal(filters.jobStatus, "interested")
            assert.equal(filters.employmentType, "contract")
            assert.equal(filters.experienceLevel, "unknown")
            assert.equal(filters.salary, "1000000")
          }
          return Response.json({
            jobs: [{ id: "persisted" }],
            catalog: null,
            total: 51,
            offset: 25,
            limit: 25,
            counts: { new: 51 },
            matching: { status: "ready", stale: false },
          })
        }
        throw new Error(`Request path must not scan the catalogue: ${path}`)
      },
    },
  })
  const account = { db, user: { id: "00000000-0000-4000-8000-000000000001" } }
  for (const datePosted of [undefined, "week", "month", "day"]) {
    expectedDatePosted = datePosted ?? "month"
    const params = new URLSearchParams({ offset: "25", view: "jobs" })
    if (datePosted) params.set("datePosted", datePosted)
    if (datePosted === "month") params.set("country", "Canada")
    if (datePosted === "day") {
      params.set("query", " engineer platform ")
      params.set("city", " Pune ")
      params.set("company", "Example")
      params.set("workMode", "hybrid")
      params.set("category", "software")
      params.set("jobStatus", "interested")
      params.set("employmentType", "contract")
      params.set("experienceLevel", "unknown")
      params.set("salary", "1000000")
    }
    const page = await readMatchPage(account, params)
    assert.equal(page.state.jobs[0].id, "persisted")
    assert.equal(page.total, 51)
    assert.equal(page.state.trackedCountries[0].country, "India")
  }
  assert.equal(calls.length, 12)
  await assert.rejects(
    readMatchPage(account, new URLSearchParams({ limit: "201" }))
  )
  await assert.rejects(
    readMatchPage(account, new URLSearchParams({ offset: "-1" }))
  )
  await assert.rejects(
    readMatchPage(account, new URLSearchParams({ sort: "arbitrary" }))
  )
  await assert.rejects(
    readMatchPage(account, new URLSearchParams({ datePosted: "year" }))
  )
  for (const key of [
    "workMode",
    "category",
    "jobStatus",
    "employmentType",
    "experienceLevel",
    "salary",
  ]) {
    await assert.rejects(
      readMatchPage(account, new URLSearchParams({ [key]: "arbitrary" }))
    )
  }
  assert.equal(
    calls.length,
    12,
    "invalid filters must be rejected before querying"
  )
})
