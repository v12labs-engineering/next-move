import assert from "node:assert/strict"
import test from "node:test"
import { persistApplicationReceipt } from "../lib/server/applications/receipt"
import { supabaseServerClient } from "../lib/server/supabase-server"
import { applicationFailure } from "../lib/applications/pipeline"

const receipt = {
  text: "Application received",
  url: "https://employer.example/thanks",
  confirmedAt: "2026-11-02T00:00:00.000Z",
  resumeHash: "approved-resume-hash",
}

for (const scenario of [
  "saved",
  "lost_response",
  "retry_save",
  "unavailable",
  "different_receipt",
  "changed_revision",
] as const) {
  test(`receipt persistence: ${scenario}`, async (t) => {
    const old = { ...process.env }
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: "https://receipt.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
    })
    t.after(() => {
      process.env = old
    })
    let writes = 0,
      reads = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | Request | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        if (url.pathname.endsWith("/confirm_application")) {
          writes++
          assert.deepEqual(JSON.parse(String(init?.body)), {
            p_id: "application-id",
            p_revision: 2,
            p_receipt: receipt,
          })
          if (
            scenario === "saved" ||
            (scenario === "retry_save" && writes === 2)
          )
            return Response.json(true)
          return Response.json(
            { message: "secret provider payload" },
            { status: 503 }
          )
        }
        assert.ok(url.pathname.endsWith("/application_runs"))
        assert.equal(url.searchParams.get("id"), "eq.application-id")
        reads++
        if (scenario === "unavailable")
          return Response.json(
            { message: "private database error" },
            { status: 503 }
          )
        return Response.json({
          status: scenario === "retry_save" ? "submitting" : "submitted",
          revision: scenario === "changed_revision" ? 3 : 2,
          approved_revision: 2,
          receipt:
            scenario === "different_receipt"
              ? { ...receipt, resumeHash: "other" }
              : receipt,
        })
      }
    )
    const operation = persistApplicationReceipt(
      supabaseServerClient(15_000),
      "application-id",
      2,
      receipt
    )
    if (["saved", "lost_response", "retry_save"].includes(scenario))
      await operation
    else
      await assert.rejects(operation, (error) => {
        assert.equal(
          applicationFailure(error).code,
          "receipt_persistence_failed"
        )
        assert.doesNotMatch(applicationFailure(error).message, /secret|private/)
        return true
      })
    assert.equal(writes, scenario === "retry_save" ? 2 : 1)
    assert.equal(reads, scenario === "saved" ? 0 : 1)
  })
}
