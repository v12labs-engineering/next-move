import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { dispatchCatalogRefresh } from "@/lib/server/catalog/dispatch"

function fixture(options: { reused?: boolean; failSave?: boolean } = {}) {
  const requests: { path: string; method: string; body: unknown }[] = []
  const db = createClient("https://database.example", "fixture-service-key", {
    auth: { persistSession: false },
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        requests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        })
        if (url.pathname.endsWith("/rpc/claim_catalog_refresh"))
          return Response.json({
            id: "refresh-fixture",
            claimed: !options.reused,
            status: options.reused ? "running" : "queued",
            workflow_id: options.reused ? "existing-workflow" : null,
          })
        assert.equal(url.pathname, "/rest/v1/catalog_refresh_runs")
        assert.equal(url.searchParams.get("id"), "eq.refresh-fixture")
        if (options.failSave)
          return Response.json(
            { message: "Storage unavailable" },
            { status: 400 }
          )
        return new Response(null, { status: 204 })
      },
    },
  })
  return { db, requests }
}

test("Vercel scheduled collection enqueues maintenance and records its workflow ID", async () => {
  const { db, requests } = fixture()
  const result = await dispatchCatalogRefresh(
    db,
    { scheduled: true },
    async (id, prepare) => {
      assert.equal(id, "refresh-fixture")
      assert.equal(prepare, true)
      return "vercel-workflow-fixture"
    }
  )
  assert.deepEqual(result, {
    id: "refresh-fixture",
    workflowRunId: "vercel-workflow-fixture",
    status: "queued",
    reused: false,
  })
  assert.deepEqual(
    requests.map(({ method, body }) => ({ method, body })),
    [
      { method: "POST", body: {} },
      { method: "PATCH", body: { workflow_id: "vercel-workflow-fixture" } },
    ]
  )
})

test("overlapping triggers reuse the active refresh without starting another workflow", async () => {
  const { db, requests } = fixture({ reused: true })
  const result = await dispatchCatalogRefresh(
    db,
    { scheduled: true },
    async () => {
      assert.fail("An active refresh must not enqueue another workflow")
    }
  )
  assert.equal(result.reused, true)
  assert.equal(result.workflowRunId, "existing-workflow")
  assert.equal(requests.length, 1)
})

test("operator source scopes are persisted before the workflow starts", async () => {
  const { db, requests } = fixture()
  await dispatchCatalogRefresh(
    db,
    { sourceIds: ["ashby:example"] },
    async (_id, prepare) => {
      assert.equal(prepare, false)
      assert.deepEqual(requests[1].body, { targets: ["ashby:example"] })
      return "scoped-workflow"
    }
  )
})

test("unconfirmed enqueue and workflow-ID write failures fail without releasing the lease", async () => {
  const uncertain = fixture()
  await assert.rejects(
    dispatchCatalogRefresh(uncertain.db, { scheduled: true }, async () => {
      throw new Error("Enqueue response lost")
    }),
    /Enqueue response lost/
  )
  assert.equal(uncertain.requests.length, 1)
  const failedSave = fixture({ failSave: true })
  await assert.rejects(
    dispatchCatalogRefresh(
      failedSave.db,
      { scheduled: true },
      async () => "started-workflow"
    )
  )
  assert.equal(failedSave.requests.length, 2)
  for (const { requests } of [uncertain, failedSave])
    assert.equal(
      requests.some(({ path }) => path.endsWith("/finish_catalog_refresh")),
      false
    )
})
