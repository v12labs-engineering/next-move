import assert from "node:assert/strict"
import test from "node:test"
import { authenticationFailure } from "@/lib/server/session"

test("authentication outages do not become sign-out redirects", () => {
  for (const error of [
    { status: 500 },
    { status: 504 },
    { status: 0 },
    { status: 429 },
    new DOMException("Timed out", "TimeoutError"),
  ]) {
    assert.equal(authenticationFailure(error).status, 503)
  }
})

test("missing or rejected authentication still requires sign-in", () => {
  for (const status of [400, 401, 403, 422])
    assert.equal(authenticationFailure({ status }).status, 401)
})
