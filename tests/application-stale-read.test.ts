import assert from "node:assert/strict"
import test from "node:test"
import { ownedApplication } from "../lib/server/applications/store"
import { supabaseServerClient } from "../lib/server/supabase-server"
import {
  APPLICATION_SEND_BUDGET_MS,
  APPLICATION_SEND_STALE_MS,
} from "../lib/applications/pipeline"

const id = "00000000-0000-4000-8000-000000000001"
const owner = "00000000-0000-4000-8000-000000000002"

test("stale detection leaves room for the sending budget and function cleanup", () => {
  assert.ok(APPLICATION_SEND_STALE_MS > APPLICATION_SEND_BUDGET_MS + 30_000)
})

test("stale progress reads return the newly queued retry instead of the requested failure status", async (t) => {
  const previous = { ...process.env }
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://stale-read.example",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
  })
  t.after(() => {
    process.env = previous
  })
  const updatedAt = new Date(Date.now() - 16 * 60_000).toISOString()
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return Response.json({
          id,
          status: "queued",
          revision: 2,
          approved_revision: 2,
          message: "Retrying automatically (1 of 1).",
          updated_at: new Date().toISOString(),
        })
      return Response.json({
        id,
        status: "submitting",
        revision: 1,
        approved_revision: 1,
        automatic: true,
        updated_at: updatedAt,
      })
    }
  )
  const result = await ownedApplication(
    { db: supabaseServerClient(), user: { id: owner } },
    id
  )
  assert.equal(result.status, "queued")
  assert.equal(result.revision, 2)
  assert.equal(result.approved_revision, 2)
  assert.equal(result.message, "Retrying automatically (1 of 1).")
})

for (const status of ["running", "submitting"] as const) {
  for (const minutes of [11, 14, 16]) {
    test(`progress read of ${status} at ${minutes} minutes respects the live worker window`, async (t) => {
      const previous = { ...process.env }
      Object.assign(process.env, {
        NEXT_PUBLIC_SUPABASE_URL: "https://stale-read.example",
        SUPABASE_SERVICE_ROLE_KEY: "fixture",
      })
      t.after(() => {
        process.env = previous
      })
      const updatedAt = new Date(Date.now() - minutes * 60_000).toISOString()
      const run = {
        id,
        status,
        revision: 1,
        automatic: true,
        updated_at: updatedAt,
      }
      let writes = 0
      t.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input)
          )
          assert.equal(url.pathname, "/rest/v1/application_runs")
          assert.equal(url.searchParams.get("id"), `eq.${id}`)
          assert.equal(url.searchParams.get("user_id"), `eq.${owner}`)
          if (init?.method === "PATCH") {
            writes++
            assert.equal(url.searchParams.get("status"), `eq.${status}`)
            assert.equal(url.searchParams.get("updated_at"), `eq.${updatedAt}`)
            return Response.json({ id })
          }
          return Response.json(run)
        }
      )
      const result = await ownedApplication(
        { db: supabaseServerClient(), user: { id: owner } },
        id
      )
      assert.equal(writes, minutes < 15 ? 0 : 1)
      assert.equal(
        result.status,
        minutes < 15
          ? status
          : status === "submitting"
            ? "submission_unknown"
            : "needs_attention"
      )
    })
  }
}
