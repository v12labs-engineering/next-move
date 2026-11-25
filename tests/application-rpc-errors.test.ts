import assert from "node:assert/strict"
import test from "node:test"
import { rpcError } from "@/lib/server/applications/store"
import { apiError } from "@/lib/server/http"

test("application RPC errors distinguish limits, profile and listing problems", async () => {
  const cases = [
    ["Monthly AI limit reached", 429, /AI request allowance/],
    ["Monthly application limit reached", 429, /application allowance/],
    ["Daily preparation limit reached", 429, /preparation limit/],
    ["Daily AI limit reached", 429, /daily AI request allowance/],
    ["Complete your profile", 422, /Complete your profile/],
    ["Unsupported or expired listing", 422, /Refresh jobs/],
    ["A public HTTPS listing is required", 422, /public HTTPS/],
    ["Application changed; reload before editing", 409, /Reload and review/],
  ] as const
  for (const [message, status, expected] of cases) {
    assert.throws(
      () => rpcError({ code: "P0001", message }),
      (error) => {
        assert.equal(apiError(error).status, status)
        assert.match((error as Error).message, expected)
        return true
      }
    )
  }
})

test("unknown RPC messages stay private and non-application failures propagate", () => {
  assert.throws(
    () => rpcError({ code: "P0001", message: "private packet value" }),
    (error) => {
      assert.doesNotMatch((error as Error).message, /private packet value/)
      return true
    }
  )
  const databaseError = { code: "57014", message: "private SQL" }
  assert.throws(
    () => rpcError(databaseError),
    (error) => error === databaseError
  )
  assert.doesNotThrow(() => rpcError(null))
})
