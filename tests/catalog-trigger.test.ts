import assert from "node:assert/strict"
import test from "node:test"
import { triggerCatalog } from "../scripts/catalog/trigger-catalog.mjs"

const secret = "test-only-collector-trigger-secret-123456"
test("the scheduler reports durable enqueue separately from completed collection", async () => {
  let calls = 0
  const result = await triggerCatalog(secret, async () => {
    calls++
    return Response.json(
      {
        ok: true,
        complete: false,
        accepted: true,
        results: [],
        refresh: { id: "fixture-refresh", status: "queued" },
      },
      { status: 202 }
    )
  })
  assert.equal(calls, 1)
  assert.equal(result.complete, false)
  assert.equal(result.accepted, true)
})

test("the trigger can refresh a 65-source directory in bounded twelve-source subsets", async () => {
  let calls = 0
  const result = await triggerCatalog(secret, async () => {
    calls++
    return Response.json({
      ok: true,
      complete: calls === 6,
      remainingSources: Math.max(0, 65 - calls * 12),
      results: [{ source: "batch", count: 1 }],
    })
  })
  assert.equal(calls, 6)
  assert.equal(result.complete, true)
})

test("the scheduled trigger sends credentials only to the configured staging collector", async () => {
  let destination = ""
  const result = await triggerCatalog(
    secret,
    async (url: string | URL | Request, options?: RequestInit) => {
      destination = String(url)
      assert.equal(options?.method, "POST")
      assert.equal(options?.redirect, "error")
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        `Bearer ${secret}`
      )
      assert.equal(new Headers(options?.headers).has("if-match"), false)
      return Response.json({
        ok: true,
        complete: true,
        enabledSources: 8,
        results: [{ source: "example", skipped: true, reason: "fresh" }],
      })
    }
  )
  assert.equal(
    destination,
    "https://job-search-chi-amber.vercel.app/api/catalog/sync"
  )
  assert.equal(result.complete, true)
})

test("rate limits, unfinished work and unexpected responses cannot be reported as success", async () => {
  await assert.rejects(
    triggerCatalog(secret, async () =>
      Response.json(
        { ok: false, complete: false, results: [] },
        { status: 207 }
      )
    ),
    /unfinished/
  )
  await assert.rejects(
    triggerCatalog(secret, async () =>
      Response.json({ ok: true, complete: false, results: [] })
    ),
    /unfinished/
  )
  await assert.rejects(
    triggerCatalog(
      secret,
      async () => new Response("Rate limited", { status: 429 })
    ),
    /HTTP 429/
  )
  await assert.rejects(
    triggerCatalog(secret, async () => Response.json({ status: "ready" })),
    /Unexpected/
  )
})

test("a scheduled run resumes healthy checkpoint batches until publication completes", async () => {
  let calls = 0
  const result = await triggerCatalog(secret, async () => {
    calls++
    return Response.json({
      ok: true,
      complete: calls === 3,
      enabledSources: 8,
      results:
        calls === 3
          ? [{ source: "arbeitnow", count: 1700 }]
          : [{ source: "arbeitnow", pending: true, runId: "existing-run" }],
    })
  })
  assert.equal(result.complete, true)
  assert.equal(calls, 3)
})

test("the scheduler does not spin on backoff or lease contention", async () => {
  for (const reason of ["backoff", "leased"]) {
    let calls = 0
    await assert.rejects(
      triggerCatalog(secret, async () => {
        calls++
        return Response.json({
          ok: true,
          complete: false,
          results: [{ source: "arbeitnow", pending: true, reason }],
        })
      }),
      /unfinished/
    )
    assert.equal(calls, 1)
  }
})

test("an endpoint that keeps reporting pending work cannot cause an unbounded trigger loop", async () => {
  let calls = 0
  await assert.rejects(
    triggerCatalog(secret, async () => {
      calls++
      return Response.json({
        ok: true,
        complete: false,
        results: [{ source: "arbeitnow", pending: true }],
      })
    }),
    /unfinished/
  )
  assert.equal(calls, 10)
})
