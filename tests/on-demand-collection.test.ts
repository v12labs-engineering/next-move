import assert from "node:assert/strict"
import test from "node:test"
import { syncCatalog } from "@/lib/server/catalog/sync"

test("on-demand collection rejects oversized and resumed snapshots without publishing partial boards", async (t) => {
  const oldFetch = globalThis.fetch,
    oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  t.after(() => {
    globalThis.fetch = oldFetch
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
  })
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only-key"
  let resumed = false,
    fetches = 0,
    checkpoints = 0,
    published = 0
  let globalReads = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : {}
    if (
      [
        "job_source_directory",
        "catalog_source_health",
        "catalog_source_demand",
        "catalog_collection_availability",
      ].some((path) => url.pathname.endsWith("/" + path))
    )
      globalReads++
    if (url.hostname === "api.ashbyhq.com") {
      fetches++
      return Response.json({
        jobs: [1, 2].map((n) => ({
          title: "Software Engineer",
          jobUrl: `https://jobs.ashbyhq.com/example/${n}`,
          isListed: true,
          descriptionPlain:
            "Develop software applications and maintain reliable backend services. ".repeat(
              5
            ),
          address: { addressCountry: "IN" },
        })),
      })
    }
    if (url.pathname.endsWith("/catalog_storage_usage"))
      return Response.json({ database_bytes: 1000000 })
    if (url.pathname.endsWith("/catalog_collection_sources"))
      return Response.json(
        body.p_ids.map((id: string) => ({
          id,
          kind: "ashby",
          board: "example",
          company: "Example",
          enabled: true,
          countries: ["India"],
          last_success_at: new Date(Date.now() - 2 * 3600000).toISOString(),
          last_started_at: null,
          complete: true,
          failed: false,
          pending: false,
          lease_until: null,
          retry_at: null,
        }))
      )
    if (url.pathname.endsWith("/job_source_directory"))
      return Response.json(
        url.searchParams.getAll("id").some((value) => value.startsWith("gt."))
          ? []
          : [
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
                last_success_at: new Date(
                  Date.now() - 2 * 3600000
                ).toISOString(),
                last_started_at: null,
                complete: true,
                failed: false,
                pending: false,
              },
            ]
      )
    if (
      url.pathname.endsWith("/catalog_source_demand") ||
      url.pathname.endsWith("/catalog_collection_availability")
    )
      return Response.json([])
    if (url.pathname.endsWith("/begin_catalog_run"))
      return Response.json({
        id: "run",
        token: "token",
        next_page: resumed ? null : 1,
      })
    if (url.pathname.endsWith("/catalog_run_size"))
      return Response.json({ records: resumed ? 200 : 0, bytes: 0 })
    if (url.pathname.endsWith("/defer_catalog_run"))
      return new Response(null, { status: 204 })
    if (url.pathname.endsWith("/checkpoint_catalog_page")) {
      checkpoints++
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("/finish_catalog_run")) {
      published++
      return Response.json({ accepted_count: 2, duplicate_count: 0 })
    }
    if (url.pathname.endsWith("/reserve_catalog_storage"))
      return new Response(null, { status: 204 })
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  const fresh = await syncCatalog({ sourceIds: ["ashby:example"] })
  assert.equal(fetches, 0)
  assert.equal(fresh.results[0].reason, "fresh")
  const options = {
    sourceIds: ["ashby:example"],
    freshnessMs: 3600000,
    maxSnapshotRecords: 1,
    maxSnapshotBytes: 1000000,
  }
  const limited = await syncCatalog(options)
  assert.ok(limited.results[0].error?.includes("snapshot limit"))
  assert.equal(checkpoints, 0)
  assert.equal(published, 0)
  assert.equal(
    globalReads,
    0,
    "Small scoped runs must not scan global source metadata"
  )
  const empty = await syncCatalog({ sourceIds: [] })
  assert.equal(empty.enabledSources, 0)
  assert.equal(empty.results.length, 0)
  resumed = true
  fetches = 0
  const resumedResult = await syncCatalog(options)
  assert.ok(resumedResult.results[0].error?.includes("snapshot limit"))
  assert.equal(fetches, 0)
  assert.equal(published, 0)
  resumed = false
  const byteLimited = await syncCatalog({
    ...options,
    maxSnapshotRecords: 100,
    maxSnapshotBytes: 1,
  })
  assert.ok(byteLimited.results[0].error?.includes("snapshot limit"))
  assert.equal(published, 0)
  const bodyLimited = await syncCatalog({
    ...options,
    maxSnapshotRecords: 100,
    maxSnapshotBytes: 1000000,
    maxResponseBytes: 10,
  })
  assert.ok(bodyLimited.results[0].error?.includes("size limit"))
  assert.equal(checkpoints, 0)
  assert.equal(published, 0)
})
