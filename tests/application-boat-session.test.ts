import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import type { Browser } from "playwright-core"
import { withBoatSession } from "../lib/server/applications/boat-session"
import { uploadApplicationDocuments } from "../lib/server/applications/browser-documents"

function fixture() {
  const requests: { url: string; body: unknown }[] = []
  const context = {}
  let closed = 0
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context],
    isConnected: () => closed === 0,
    close: async () => {
      closed++
    },
  }) as unknown as Browser
  const options = {
    env: { BOAT_API_KEY: "private-api-key" },
    fetcher: (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body })
      if (url.endsWith("/sandboxes"))
        return Response.json({
          sandbox: { id: "bx_abcdefgh" },
          hostedPorts: [
            { url: "https://fixture-8080.on.boat.dev?_token=private-access" },
          ],
        })
      if (url.includes("_token="))
        return new Response(null, {
          status: 302,
          headers: { "set-cookie": "access=private-cookie; HttpOnly; Secure" },
        })
      if (url.endsWith("/session"))
        return Response.json({ ready: true, recording: true })
      return Response.json({ ok: true })
    }) as typeof fetch,
    connect: (async (_url, options) => {
      assert.equal(options?.headers?.Cookie, "access=private-cookie")
      assert.match(
        options?.headers?.Authorization || "",
        /^Bearer [a-f0-9]{64}$/
      )
      return browser
    }) as typeof import("playwright-core").chromium.connectOverCDP,
  }
  return { options, requests, browser, closed: () => closed }
}
test("Boat sessions isolate credentials, stage documents and release once", async () => {
  const f = fixture()
  await withBoatSession(async (browser, id, release) => {
    assert.equal(id, "bx_abcdefgh")
    assert.deepEqual(
      await uploadApplicationDocuments(browser.contexts()[0], id, [
        {
          name: "Resume.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("synthetic"),
        },
      ]),
      ["/tmp/.uploads/Resume.pdf"]
    )
    await release()
    await release()
  }, f.options)
  const create = JSON.parse(String(f.requests[0].body))
  assert.equal(create.noEnv, true)
  assert.equal(create.monitoring, false)
  assert.equal(create.ttlSeconds, 900)
  assert.equal(create.visibility, "private")
  assert.equal(JSON.stringify(create).includes("private-api-key"), false)
  assert.equal(f.requests.filter((r) => r.url.endsWith("/stop")).length, 1)
  assert.equal(f.closed(), 1)
})
test("Boat session failure releases VM without dispatching another attempt", async () => {
  const f = fixture()
  await assert.rejects(
    withBoatSession(async () => {
      throw new Error("synthetic failure")
    }, f.options),
    /synthetic failure/
  )
  assert.equal(f.requests.filter((r) => r.url.endsWith("/sandboxes")).length, 1)
  assert.equal(f.requests.filter((r) => r.url.endsWith("/stop")).length, 1)
})

test("an interrupted Boat connection settles an outstanding browser operation", async () => {
  const f = fixture()
  const session = withBoatSession(async (browser) => {
    ;(browser as unknown as EventEmitter).emit("disconnected")
    return new Promise<never>(() => {})
  }, f.options)
  const outcome = await Promise.race([
    session.catch((error: unknown) => error),
    new Promise((resolve) => setTimeout(() => resolve("still running"), 250)),
  ])
  assert.ok(outcome instanceof Error, String(outcome))
  assert.match(outcome.message, /Boat browser disconnected/)
  assert.equal(f.closed(), 1)
  assert.equal(f.requests.filter((r) => r.url.endsWith("/stop")).length, 1)
})
test("missing Boat credentials allocate nothing", async () => {
  await assert.rejects(
    withBoatSession(async () => assert.fail(), { env: {} }),
    /not configured/
  )
})

test("Boat CAPTCHA stays in its VM and rejects missing solver results", async () => {
  const { solveCaptcha } =
    await import("../lib/server/applications/captcha-solver")
  const f = fixture()
  await withBoatSession(async (browser) => {
    const context = browser.contexts()[0]
    Object.assign(context, {
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: "ABC123" } }),
        detach: async () => {},
      }),
    })
    const page = { context: () => context } as import("playwright-core").Page
    await assert.rejects(solveCaptcha(page, Date.now() + 10000))
    const request = f.requests.find((r) => r.url.endsWith("/captcha"))
    assert.ok(request)
    const body = JSON.parse(String(request.body))
    assert.equal(body.pageId, "ABC123")
    assert.ok(body.timeoutMs > 0 && body.timeoutMs <= 10000)
  }, f.options)
})
