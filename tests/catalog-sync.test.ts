import assert from "node:assert/strict"
import test from "node:test"
import { syncCatalog } from "@/lib/server/catalog/sync"

test("collection does not claim leased work is complete or skip legacy unmeasured snapshots", async (t) => {
  const originalFetch = globalThis.fetch,
    oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  t.after(() => {
    globalThis.fetch = originalFetch
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
  })
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only-key"
  let leased = false,
    blocked = false,
    fetched = 0
  const claimed: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "api.ashbyhq.com") {
      fetched++
      return Response.json({ jobs: [] })
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname.endsWith("/catalog_storage_usage"))
      return Response.json({ database_bytes: 10_000_000 })
    if (url.pathname.endsWith("/catalog_collection_availability"))
      return Response.json(
        body.p_after || !blocked
          ? []
          : [
              {
                id: "ashby:blocked",
                retry_at: new Date(Date.now() + 60_000).toISOString(),
                lease_until: null,
              },
            ]
      )
    if (url.pathname.endsWith("/job_source_directory"))
      return Response.json(
        url.searchParams.has("id")
          ? []
          : [
              ...(blocked
                ? [
                    {
                      id: "ashby:blocked",
                      kind: "ashby",
                      board: "blocked",
                      company: "Blocked",
                    },
                  ]
                : []),
              {
                id: "ashby:example",
                kind: "ashby",
                board: "example",
                company: "Example",
              },
            ]
      )
    if (url.pathname.endsWith("/catalog_source_health"))
      return Response.json(
        body.p_after
          ? []
          : [
              {
                id: "ashby:example",
                enabled: true,
                countries: ["India"],
                complete: null,
                pending: false,
                failed: false,
                last_success_at: new Date().toISOString(),
                last_started_at: null,
              },
            ]
      )
    if (url.pathname.endsWith("/catalog_source_demand"))
      return Response.json(
        body.p_after || !blocked
          ? []
          : [{ source: "ashby:blocked", demand: 100 }]
      )
    if (url.pathname.endsWith("/begin_catalog_run")) {
      claimed.push(body.p_source)
      return Response.json(
        leased ? null : { id: "run", token: "token", next_page: 1 }
      )
    }
    if (url.pathname.endsWith("/checkpoint_catalog_page"))
      return new Response(null, { status: 204 })
    if (url.pathname.endsWith("/reserve_catalog_storage"))
      return new Response(null, { status: 204 })
    if (url.pathname.endsWith("/finish_catalog_run"))
      return Response.json({ accepted_count: 0, duplicate_count: 0 })
    throw new Error(`Unexpected external request: ${url.pathname}`)
  }
  const first = await syncCatalog()
  assert.equal(fetched, 1)
  assert.equal(first.complete, true)
  leased = true
  const second = await syncCatalog()
  assert.equal(second.complete, false)
  assert.equal(second.results[0].reason, "leased")
  leased = false
  blocked = true
  claimed.length = 0
  const third = await syncCatalog({ maxSources: 1 })
  assert.deepEqual(claimed, ["ashby:example"])
  assert.equal(third.deferredSources, 1)
  assert.equal(third.complete, false)
})

test("parallel feed fetches queue snapshot writes instead of competing for database statement deadlines", async (t) => {
  const original = globalThis.fetch,
    oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  t.after(() => {
    globalThis.fetch = original
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
  })
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only-key"
  let active = 0,
    peak = 0,
    writes = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.hostname === "api.ashbyhq.com") return Response.json({ jobs: [] })
    if (url.pathname.endsWith("/job_source_directory"))
      return Response.json(
        url.searchParams.has("id")
          ? []
          : [1, 2, 3, 4].map((n) => ({
              id: `ashby:example${n}`,
              kind: "ashby",
              board: `example${n}`,
              company: "Example",
            }))
      )
    if (url.pathname.endsWith("/catalog_storage_usage"))
      return Response.json({ database_bytes: 10000000 })
    if (
      [
        "/catalog_source_health",
        "/catalog_source_demand",
        "/catalog_collection_availability",
      ].some((name) => url.pathname.endsWith(name))
    )
      return Response.json([])
    if (url.pathname.endsWith("/begin_catalog_run"))
      return Response.json({
        id: body.p_source,
        token: "fixture-token",
        next_page: 1,
      })
    if (url.pathname.endsWith("/reserve_catalog_storage"))
      return new Response(null, { status: 204 })
    if (
      ["/checkpoint_catalog_page", "/finish_catalog_run"].some((name) =>
        url.pathname.endsWith(name)
      )
    ) {
      active++
      peak = Math.max(peak, active)
      writes++
      await new Promise((r) => setTimeout(r, 10))
      active--
      return url.pathname.endsWith("/finish_catalog_run")
        ? Response.json({ accepted_count: 0, duplicate_count: 0 })
        : new Response(null, { status: 204 })
    }
    throw Error("Unexpected test endpoint")
  }
  const result = await syncCatalog({ concurrency: 4 })
  assert.equal(result.complete, true)
  assert.equal(writes, 8)
  assert.equal(peak, 1)
})
