import assert from "node:assert/strict"
import test from "node:test"
import type { Browser } from "playwright-core"
import { applicationFailure } from "../lib/applications/pipeline"
import {
  withBrowserSession,
  applicationBrowserProvider,
} from "../lib/server/applications/browser-session"

function fixture() {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  let closes = 0
  const browser = {
    contexts: () => [{}],
    close: async () => {
      closes++
    },
  } as unknown as Browser
  const options = {
    env: {
      BROWSERBASE_API_KEY: "test-only",
      BROWSERBASE_PROJECT_ID: "test-project",
      BROWSER_USE_PYTHON: "/fixture/python",
    },
    fetcher: (async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body || "{}")),
      })
      return Response.json({
        id: "test-session",
        connectUrl: "wss://connect.browserbase.com?apiKey=private-test-key",
        region: "us-east-1",
      })
    }) as typeof fetch,
    connect: (async () =>
      browser) as typeof import("playwright-core").chromium.connectOverCDP,
  }
  return { options, requests, browser, closes: () => closes }
}

test("Browserbase remains the browser host and Browser Use is required before session allocation", async () => {
  assert.equal(applicationBrowserProvider({}), "browserbase")
  assert.throws(
    () =>
      applicationBrowserProvider({ APPLICATION_BROWSER_PROVIDER: "removed" }),
    /must be browserbase/
  )
  await assert.rejects(
    withBrowserSession(async () => assert.fail(), { env: {} }),
    /not configured/
  )
})
for (const [worker, override, expected] of [
  ["iad1", "", "us-east-1"],
  ["icn1", "", "ap-southeast-1"],
  ["iad1", "eu-central-1", "eu-central-1"],
]) {
  test(`browser region ${worker} / ${override}`, async () => {
    const f = fixture()
    Object.assign(f.options.env, {
      VERCEL_REGION: worker,
      BROWSERBASE_REGION: override,
    })
    await withBrowserSession(async () => {}, f.options)
    assert.equal(f.requests[0].body.region, expected)
  })
}
test("invalid region allocates no session", async () => {
  const f = fixture()
  Object.assign(f.options.env, { BROWSERBASE_REGION: "invalid" })
  await assert.rejects(
    withBrowserSession(async () => assert.fail(), f.options),
    /not configured/
  )
  assert.equal(f.requests.length, 0)
})
test("session creation enables recording and preserves solver/log settings, timeout and idempotent release", async () => {
  const f = fixture()
  assert.equal(
    await withBrowserSession(async (browser, id, release) => {
      assert.equal(browser, f.browser)
      assert.equal(id, "test-session")
      await release()
      await release()
      return "prepared"
    }, f.options),
    "prepared"
  )
  assert.deepEqual(f.requests[0].body.browserSettings, {
    solveCaptchas: false,
    recordSession: true,
    logSession: false,
  })
  assert.equal(f.requests[0].body.timeout, 800)
  assert.equal(f.requests[0].body.proxies, true)
  assert.equal(f.requests[0].body.keepAlive, true)
  assert.equal(
    f.requests.filter((r) => r.body.status === "REQUEST_RELEASE").length,
    1
  )
  assert.equal(f.closes(), 1)
})
test("connection errors redact details and release the remote session", async () => {
  const f = fixture()
  f.options.connect = async () => {
    throw Error("private-test-key")
  }
  await assert.rejects(
    withBrowserSession(async () => assert.fail(), f.options),
    { message: "Browserbase browser could not start" }
  )
  assert.equal(f.requests.at(-1)?.body.status, "REQUEST_RELEASE")
})
test("callback failure preserves its reason and releases the browser", async () => {
  const f = fixture()
  await assert.rejects(
    withBrowserSession(async () => {
      throw Error("Human verification required")
    }, f.options),
    /Human verification required/
  )
  assert.equal(f.closes(), 1)
  assert.equal(f.requests.at(-1)?.body.status, "REQUEST_RELEASE")
})
for (const status of [402, 403, 429]) {
  test(`provider status ${status} retains classification without exposing details`, async () => {
    const f = fixture()
    f.options.fetcher = async () =>
      Response.json({ error: "private provider detail" }, { status })
    await assert.rejects(
      withBrowserSession(async () => assert.fail(), f.options),
      (error: unknown) => {
        assert.equal(
          applicationFailure(error).code,
          status === 402
            ? "processing_limit"
            : status === 403
              ? "configuration"
              : "rate_limited"
        )
        assert.doesNotMatch((error as Error).message, /private/)
        return true
      }
    )
  })
}
