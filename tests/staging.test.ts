import assert from "node:assert/strict"
import test from "node:test"
import { assertStagingTarget, redact } from "../scripts/lib/staging.mjs"

const ref = "abcdefghijklmnopqrst"
const config = {
  environment: "staging",
  supabase: { projectName: "job-search-staging", projectRef: ref },
}
test("staging commands reject the private project and mismatched URLs", () => {
  assert.equal(
    assertStagingTarget(config, {
      NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
    }),
    ref
  )
  assert.throws(() =>
    assertStagingTarget({ ...config, environment: "production" }, {})
  )
  assert.throws(
    () =>
      assertStagingTarget(
        {
          ...config,
          supabase: { ...config.supabase, projectRef: "jzvgkjmhugogvpanwjyy" },
        },
        {}
      ),
    /private/
  )
  assert.throws(
    () =>
      assertStagingTarget(config, {
        NEXT_PUBLIC_SUPABASE_URL: "https://another.supabase.co",
      }),
    /does not match/
  )
  assert.throws(
    () =>
      assertStagingTarget(
        config,
        { NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co` },
        ref
      ),
    /private/
  )
})
test("staging CLI output redacts configured credentials", () => {
  assert.equal(
    redact("failed secret-token and secret-password", {
      SUPABASE_ACCESS_TOKEN: "secret-token",
      SUPABASE_DB_PASSWORD: "secret-password",
    }),
    "failed [redacted] and [redacted]"
  )
})
