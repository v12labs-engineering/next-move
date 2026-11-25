import assert from "node:assert/strict"
import test from "node:test"
import { apiError } from "@/lib/server/http"

test("database failures log safe error codes without logging private messages or details", async (t) => {
  const entries: unknown[][] = []
  t.mock.method(console, "error", (...args: unknown[]) => entries.push(args))
  const response = apiError({
    code: "57014",
    message: "query contains private resume content",
    details: "private profile details",
    hint: "private SQL parameters",
  })
  assert.equal(response.status, 503)
  assert.deepEqual(entries, [
    ["API request failed", { type: "DatabaseError", code: "57014" }],
  ])
  assert.ok(!JSON.stringify(await response.json()).includes("private"))

  entries.length = 0
  apiError({ code: "private user input", message: "private resume" })
  assert.deepEqual(entries, [["API request failed", { type: "DatabaseError" }]])
})
