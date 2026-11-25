import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { readAccountState } from "@/lib/server/account-store"
import { candidateSchema } from "@/lib/candidate"
import { packDescriptions } from "@/lib/server/catalog/content"

test("matching overlaps source health and scans destinations with bounded concurrency", async () => {
  const countries = ["India", "Germany", "Ireland", "Japan"]
  const now = new Date().toISOString()
  const candidate = candidateSchema.parse({
    fullName: "Example Engineer",
    headline: "Backend Engineer",
    currentLocation: null,
    targetRoles: ["Backend Engineer"],
    skills: ["TypeScript"],
    experienceYears: 3,
    targetCountries: countries,
    workModes: ["onsite"],
    sponsorshipRequired: false,
    excludedCompanies: [],
    resumeText:
      "Backend Engineer delivering TypeScript software in backend services. Maintained API integrations and coordinated software releases with colleagues.",
  })
  const events: string[] = []
  let sourceTitle = "Backend Engineer"
  let failCountry = false
  let scans = 0,
    peakScans = 0
  const scanned = new Set<string>()
  const db = createClient("https://db.example", "fixture-key", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        const params = JSON.parse(String(init?.body ?? "{}"))
        if (url.pathname.endsWith("account_profiles"))
          return Response.json({ data: candidate, version: 1 })
        if (url.pathname.endsWith("account_countries"))
          return Response.json(
            countries.map((country) => ({ country, added_at: now }))
          )
        if (url.pathname.endsWith("account_job_states"))
          return Response.json([
            { job_id: "saved", status: "interested", updated_at: now },
          ])
        if (url.pathname.endsWith("catalog_matching_overview")) {
          await new Promise((resolve) => setTimeout(resolve, 80))
          events.push("health finished")
          return Response.json({
            totalJobs: 4,
            sources: 0,
            failedSources: 0,
            lastUpdatedAt: null,
            health: [],
          })
        }
        if (url.pathname.endsWith("catalog_matching_batch")) {
          if (failCountry && params.p_countries.includes("Japan"))
            return Response.json(
              { message: "Destination scan failed" },
              { status: 400 }
            )
          events.push("scan started")
          scans++
          peakScans = Math.max(peakScans, scans)
          await new Promise((resolve) => setTimeout(resolve, 20))
          scans--
          for (const country of params.p_countries) scanned.add(country)
          return Response.json({
            items: params.p_after
              ? []
              : params.p_countries.map((country: string) => ({
                  id: country,
                  title: sourceTitle,
                  company: "Hospital",
                  country,
                  city: "",
                  url: `https://example.com/${country}`,
                  work_mode: "onsite",
                  visa_signal: "possible",
                  sponsorship_evidence: "",
                  sponsor_verified: false,
                  source: "example",
                  posted_at: now,
                  last_checked_at: now,
                  discovered_at: now,
                  is_active: true,
                })),
            hasMore: false,
          })
        }
        if (url.pathname.endsWith("job_catalog")) {
          if (init?.method === "HEAD")
            return new Response(null, { headers: { "content-range": "0-0/4" } })
          if (url.searchParams.get("select") === "*")
            return Response.json([
              {
                id: "saved",
                title: "Backend Engineer",
                company: "Saved hospital",
                country: "Canada",
                city: "Toronto",
                url: "https://example.com/saved",
                description: "Deliver TypeScript software in backend services.",
                work_mode: "onsite",
                visa_signal: "possible",
                sponsorship_evidence: "",
                sponsor_verified: false,
                source: "example",
                posted_at: now,
                last_checked_at: now,
                discovered_at: now,
                is_active: false,
              },
            ])
          const ids = url.searchParams.get("id")!.slice(4, -1).split(",")
          return Response.json(
            ids.map((id) => ({
              id,
              description: "Deliver TypeScript software in backend services.",
            }))
          )
        }
        throw new Error(`Unexpected database request ${url.pathname}`)
      },
    },
  })
  const started = performance.now()
  const state = await readAccountState({
    db,
    user: { id: "00000000-0000-4000-8000-000000000001" },
  })
  console.info(
    `Controlled matching latency: ${Math.round(performance.now() - started)}ms`
  )
  assert.equal(state.jobs.length, 5)
  assert.equal(
    state.jobs.find((job) => job.id === "saved")?.status,
    "interested"
  )
  assert.deepEqual([...scanned].sort(), [...countries].sort())
  assert.ok(
    events.indexOf("scan started") < events.indexOf("health finished"),
    "Source health must not block matching"
  )
  assert.ok(
    peakScans > 1 && peakScans <= 3,
    `Expected 2–3 concurrent destination scans, got ${peakScans}`
  )
  assert.ok(
    state.jobs.every((job) =>
      job.match?.reasons.some((reason) => reason.includes("TypeScript"))
    )
  )
  sourceTitle = "Registered Nurse"
  candidate.targetRoles = [sourceTitle]
  const scoped = await readAccountState({
    db,
    user: { id: "00000000-0000-4000-8000-000000000001" },
  })
  assert.deepEqual(scoped.jobs.map((job) => job.id), ["saved"])
  failCountry = true
  await assert.rejects(
    readAccountState({
      db,
      user: { id: "00000000-0000-4000-8000-000000000001" },
    }),
    (error: { message?: string }) => error.message === "Destination scan failed"
  )
})

test("the account response keeps description-based evidence and finds relevant jobs beyond 3,000 rows", async (t) => {
  const candidate = candidateSchema.parse({
    fullName: "Example Engineer",
    headline: "Backend Engineer",
    currentLocation: null,
    targetRoles: ["Backend Engineer"],
    skills: ["TypeScript"],
    experienceYears: 3,
    targetCountries: ["India"],
    workModes: ["onsite"],
    sponsorshipRequired: false,
    excludedCompanies: [],
    resumeText:
      "Backend Engineer delivering TypeScript software in backend services. Maintained API integrations and coordinated software releases with colleagues.",
  })
  const now = new Date().toISOString()
  const records = Array.from({ length: 3202 }, (_, index) => ({
    id: String(index).padStart(5, "0"),
    title: index >= 3200 ? "Backend Engineer" : "Accountant",
    company: "Example",
    country: "India",
    city: "Hyderabad",
    url: `https://example.com/jobs/${index}`,
    description: "Provide TypeScript software. Requires 4 years of experience.",
    work_mode: "onsite",
    visa_signal: "possible",
    sponsorship_evidence: "Unknown",
    sponsor_verified: false,
    source: "example",
    posted_at: now,
    last_checked_at: now,
    discovered_at: now,
    is_active: true,
  }))
  let metadataPages = 0
  let archived = false
  const [pack] = packDescriptions(
    records.filter((row) => row.id === "03200" || row.id === "03201")
  )
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async (_input, init) => {
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(
      new Headers(init?.headers).get("range")!
    )!
    return new Response(
      new Uint8Array(pack.body.subarray(Number(first), Number(last) + 1)),
      {
        status: 206,
        headers: {
          "Content-Range": `bytes ${first}-${last}/${pack.body.length}`,
        },
      }
    )
  }
  const hydrated: string[] = []
  const db = createClient("https://db.example", "fixture-key", {
    auth: { persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        switch (url.pathname) {
          case "/rest/v1/account_profiles":
            return Response.json({ data: candidate, version: 1 })
          case "/rest/v1/account_countries":
            return Response.json([{ country: "India", added_at: now }])
          case "/rest/v1/account_job_states":
            return Response.json([])
          case "/rest/v1/rpc/catalog_matching_overview": {
            assert.deepEqual(JSON.parse(String(init?.body)).p_countries, [
              "India",
            ])
            return Response.json({
              totalJobs: 3201,
              sources: 1,
              failedSources: 0,
              lastUpdatedAt: now,
              health: [
                {
                  id: "example",
                  countries: ["India"],
                  enabled: true,
                  last_success_at: now,
                  complete: true,
                  failed: false,
                  pending: false,
                },
              ],
            })
          }
          case "/rest/v1/rpc/catalog_matching_batch": {
            const params = JSON.parse(String(init?.body))
            assert.deepEqual(params.p_countries, ["India"])
            assert.equal(params.p_limit, 1000)
            metadataPages++
            return Response.json({
              items: records
                .filter((row) => !params.p_after || row.id > params.p_after)
                .slice(0, 500)
                .map((row) => ({ ...row, description: undefined })),
              hasMore:
                records.filter(
                  (row) => !params.p_after || row.id > params.p_after
                ).length > 500,
            })
          }
          case "/rest/v1/job_catalog": {
            if (init?.method === "HEAD")
              return new Response(null, {
                headers: { "content-range": "0-0/3201" },
              })
            const requested = url.searchParams.get("id")
            if (requested?.startsWith("in.(")) {
              const ids = requested.slice(4, -1).split(",")
              hydrated.push(...ids)
              return Response.json(
                records
                  .filter((row) => ids.includes(row.id))
                  .map(({ id, description }) => ({
                    id,
                    description: archived ? "" : description,
                    description_ref: archived ? pack.refs.get(id) : null,
                  }))
              )
            }
            throw new Error("Unbounded catalogue read")
          }
          default:
            throw new Error(`Unexpected database request ${url.pathname}`)
        }
      },
    },
  })
  const result = await readAccountState({
    db,
    user: { id: "00000000-0000-4000-8000-000000000001" },
  })
  // Compact rows have no description-copy evidence; matching labels alone
  // cannot prove that these two different vacancy URLs are duplicates.
  assert.deepEqual(result.jobs.map((job) => job.id), ["03200", "03201"])
  assert.equal(result.jobs[0].match?.eligible, true)
  assert.ok(
    result.jobs[0].match?.reasons.some((reason) =>
      reason.includes("TypeScript")
    )
  )
  assert.equal(result.jobs[0].description, undefined)
  assert.equal(result.catalog?.coverage?.[0].activeVacancies, 3202)
  assert.equal(result.catalog?.coverage?.[0].relevantVacancies, 2)
  assert.equal(metadataPages, 7)
  assert.deepEqual(hydrated, ["03200", "03201"])
  archived = true
  const objectBacked = await readAccountState({
    db,
    user: { id: "00000000-0000-4000-8000-000000000001" },
  })
  assert.deepEqual(
    objectBacked.jobs[0].match,
    result.jobs[0].match,
    "Moving descriptions must preserve skills, experience gating and match explanations"
  )
})

test("matching retries a timed-out metadata page with a smaller batch without losing jobs", async () => {
  const now = new Date().toISOString()
  const candidate = candidateSchema.parse({
    fullName: "Example Engineer",
    headline: "Backend Engineer",
    currentLocation: null,
    targetRoles: ["Backend Engineer"],
    skills: ["TypeScript"],
    experienceYears: 3,
    targetCountries: ["India"],
    workModes: ["onsite"],
    sponsorshipRequired: false,
    excludedCompanies: [],
    resumeText:
      "Backend Engineer delivering TypeScript software in backend services. Maintained API integrations and coordinated software releases with colleagues.",
  })
  const limits: number[] = []
  const db = createClient("https://db.example", "fixture-key", {
    auth: { persistSession: false },
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input)
        ).pathname
          .split("/")
          .at(-1)
        if (path === "account_profiles")
          return Response.json({ data: candidate, version: 1 })
        if (path === "account_countries")
          return Response.json([{ country: "India", added_at: now }])
        if (path === "account_job_states") return Response.json([])
        if (path === "catalog_matching_overview")
          return Response.json({
            totalJobs: 1,
            sources: 0,
            failedSources: 0,
            lastUpdatedAt: null,
            health: [],
          })
        if (path === "catalog_matching_batch") {
          const params = JSON.parse(String(init?.body))
          limits.push(params.p_limit)
          assert.equal(params.p_after, null, "retry must keep the same cursor")
          if (params.p_limit === 1000)
            return Response.json(
              {
                code: "57014",
                message: "canceling statement due to statement timeout",
              },
              { status: 500 }
            )
          return Response.json({
            items: [
              {
                id: "nurse",
                title: "Backend Engineer",
                company: "Hospital",
                country: "India",
                city: "Hyderabad",
                url: "https://example.com/nurse",
                work_mode: "onsite",
                visa_signal: "possible",
                sponsorship_evidence: "",
                sponsor_verified: false,
                source: "fixture",
                posted_at: now,
                last_checked_at: now,
                discovered_at: now,
                is_active: true,
              },
            ],
            hasMore: false,
          })
        }
        if (path === "job_catalog")
          return Response.json([
            {
              id: "nurse",
              description: "Deliver TypeScript software in backend services.",
            },
          ])
        throw new Error(`Unexpected request ${path}`)
      },
    },
  })
  const state = await readAccountState({
    db,
    user: { id: "00000000-0000-4000-8000-000000000001" },
  })
  assert.deepEqual(limits, [1000, 500])
  assert.equal(state.jobs.length, 1)
  assert.ok(
    state.jobs[0].match?.reasons.some((reason) =>
      reason.includes("TypeScript")
    )
  )
})

test("a failed country read drains other outstanding scans before allowing a retry", async () => {
  const countries = ["India", "Germany", "Canada"]
  const candidate = candidateSchema.parse({
    fullName: "Example Engineer",
    headline: "Backend Engineer",
    currentLocation: null,
    targetRoles: ["Backend Engineer"],
    skills: ["TypeScript"],
    experienceYears: 3,
    targetCountries: countries,
    workModes: ["onsite"],
    sponsorshipRequired: false,
    excludedCompanies: [],
    resumeText:
      "Backend Engineer delivering TypeScript software in backend services. Maintained API integrations and coordinated software releases with colleagues.",
  })
  let active = 0
  const db = createClient("https://db.example", "fixture-key", {
    auth: { persistSession: false },
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input)
        ).pathname
          .split("/")
          .at(-1)
        if (path === "account_profiles")
          return Response.json({ data: candidate, version: 1 })
        if (path === "account_countries")
          return Response.json(
            countries.map((country) => ({
              country,
              added_at: new Date().toISOString(),
            }))
          )
        if (path === "account_job_states") return Response.json([])
        if (path === "catalog_matching_overview")
          return Response.json({
            totalJobs: 0,
            sources: 0,
            failedSources: 0,
            lastUpdatedAt: null,
            health: [],
          })
        if (path === "catalog_matching_batch") {
          const params = JSON.parse(String(init?.body))
          if (params.p_countries[0] === "India")
            return Response.json(
              { code: "42501", message: "scan unavailable" },
              { status: 400 }
            )
          active++
          await new Promise((resolve) => setTimeout(resolve, 30))
          active--
          return Response.json({ items: [], hasMore: false })
        }
        throw new Error(`Unexpected request ${path}`)
      },
    },
  })
  await assert.rejects(
    readAccountState({
      db,
      user: { id: "00000000-0000-4000-8000-000000000001" },
    }),
    (error) => (error as { message?: string }).message === "scan unavailable"
  )
  assert.equal(
    active,
    0,
    "workflow retries must not overlap unfinished scans from the failed attempt"
  )
})
