import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@supabase/supabase-js"
import { finishCatalogRefresh } from "@/lib/server/catalog/finish-refresh"

async function fixture() {
  const postgres = new PGlite()
  await postgres.exec(
    "create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;"
  )
  await postgres.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202610300007_durable_catalog_refresh.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  await postgres.exec("set role service_role")
  const { rows } = await postgres.query<{ claim: { id: string } }>(
    "select claim_catalog_refresh() claim"
  )
  const id = rows[0].claim.id
  let finishes = 0,
    loseCompletionResponse = false,
    rejectCompletion = false
  const db = createClient("https://local-fixture.example", "fixture-only", {
    auth: { persistSession: false },
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname === "/rest/v1/catalog_refresh_runs") {
          assert.equal(url.searchParams.get("id"), `eq.${id}`)
          const result = await postgres.query<{ status: string }>(
            "select status from catalog_refresh_runs where id=$1",
            [id]
          )
          return Response.json(result.rows[0])
        }
        assert.equal(url.pathname, "/rest/v1/rpc/finish_catalog_refresh")
        const body = JSON.parse(String(init?.body))
        finishes++
        if (rejectCompletion)
          return Response.json(
            { message: "Injected completion failure" },
            { status: 500 }
          )
        await postgres.query("select finish_catalog_refresh($1,$2,$3)", [
          body.p_id,
          body.p_status,
          JSON.stringify(body.p_result),
        ])
        if (loseCompletionResponse) {
          loseCompletionResponse = false
          throw new Error("Injected lost completion response")
        }
        return new Response(null, { status: 204 })
      },
    },
  })
  return {
    db,
    id,
    close: () => postgres.close(),
    finishes: () => finishes,
    loseNextCompletionResponse: () => {
      loseCompletionResponse = true
    },
    rejectCompletion: () => {
      rejectCompletion = true
    },
    status: async () =>
      (
        await postgres.query<{ status: string; result: unknown }>(
          "select status,result from catalog_refresh_runs where id=$1",
          [id]
        )
      ).rows[0],
  }
}

test("matching enqueue failure remains retryable after catalog completion commits", async () => {
  const f = await fixture()
  try {
    let attempts = 0
    const enqueue = async () => {
      if (++attempts === 1) throw new Error("Matching queue unavailable")
    }
    const receipt = { published: 1 }
    await assert.rejects(
      finishCatalogRefresh(f.db, f.id, "completed", receipt, enqueue),
      /Matching queue unavailable/
    )
    assert.deepEqual(await f.status(), {
      status: "completed",
      result: receipt,
    })
    // Even the workflow's error handler must not overwrite published success.
    await finishCatalogRefresh(f.db, f.id, "failed", {}, enqueue)
    assert.equal(attempts, 2)
    assert.equal(f.finishes(), 1)
    assert.deepEqual(await f.status(), {
      status: "completed",
      result: receipt,
    })
  } finally {
    await f.close()
  }
})

test("lost database completion acknowledgement recovers matching without completing twice", async () => {
  const f = await fixture()
  try {
    let enqueued = 0
    const enqueue = async () => {
      enqueued++
    }
    f.loseNextCompletionResponse()
    await assert.rejects(
      finishCatalogRefresh(f.db, f.id, "partial", { published: 2 }, enqueue)
    )
    assert.equal(enqueued, 0)
    assert.equal((await f.status()).status, "partial")
    await finishCatalogRefresh(f.db, f.id, "partial", {}, enqueue)
    assert.equal(enqueued, 1)
    assert.equal(f.finishes(), 1)
  } finally {
    await f.close()
  }
})

test("matching is not enqueued when catalog completion was not committed", async () => {
  const f = await fixture()
  try {
    f.rejectCompletion()
    await assert.rejects(
      finishCatalogRefresh(f.db, f.id, "completed", {}, async () => {
        assert.fail("Uncommitted completion must not dispatch matching")
      })
    )
    assert.equal((await f.status()).status, "queued")
  } finally {
    await f.close()
  }
})

test("an already terminal refresh still propagates repeated matching admission failures", async () => {
  const f = await fixture()
  try {
    const failEnqueue = async () => {
      throw new Error("Matching admission still unavailable")
    }
    for (let attempt = 0; attempt < 3; attempt++)
      await assert.rejects(
        finishCatalogRefresh(f.db, f.id, "paused", {}, failEnqueue),
        /Matching admission still unavailable/
      )
    assert.equal(f.finishes(), 1)
  } finally {
    await f.close()
  }
})
