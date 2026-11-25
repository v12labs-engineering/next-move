import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test, { type TestContext } from "node:test"
import type { Page } from "playwright-core"
import {
  ComputerBrowser,
  type ComputerControl,
} from "../lib/server/applications/computer-browser"
import {
  trackBrowserbaseCaptcha,
  waitForBrowserbaseCaptcha,
} from "../lib/server/applications/captcha"

function fixture(t: TestContext) {
  let now = 0
  let afterPoll = () => {}
  const emitter = new EventEmitter()
  const logs: unknown[][] = []
  t.mock.method(Date, "now", () => now)
  t.mock.method(console, "info", (...args: unknown[]) => logs.push(args))
  const page = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    waitForTimeout: async (ms: number) => {
      now += ms
      afterPoll()
    },
  } as unknown as Page
  const emit = (text: string) => emitter.emit("console", { text: () => text })
  return {
    page,
    emit,
    logs,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    poll: (run: () => void) => {
      afterPoll = run
    },
  }
}

test("receipt readiness shares one solver wait and human polling adds no further wait", async (t) => {
  const f = fixture(t)
  Object.assign(f.page, {
    locator: () => ({ count: async () => 1 }),
    frames: () => assert.fail("Do not read challenge frame contexts"),
  })
  const stop = trackBrowserbaseCaptcha(f.page)
  const browser = new ComputerBrowser(f.page)
  const ready = async () => {
    try {
      await browser.observe({ screenshot: false, waitForCaptcha: false })
      return true
    } catch (error) {
      assert.equal((error as Error).message, "Human verification required")
      return false
    }
  }
  assert.equal(await waitForBrowserbaseCaptcha(f.page, ready), false)
  assert.equal(f.now(), 30_000, "One shared automatic wait")
  for (let i = 0; i < 3; i++) assert.equal(await ready(), false)
  assert.equal(f.now(), 30_000, "Human polling must be immediate")
  stop()
})

test("a readable form cannot bypass an active solver", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  f.emit("browserbase-solving-started")
  f.poll(() => {
    if (f.now() === 500) f.emit("browserbase-solving-finished")
  })
  assert.equal(await waitForBrowserbaseCaptcha(f.page, async () => true), true)
  assert.equal(f.now(), 500)
  stop()
})

test("an already-running solve keeps its original deadline when the tool starts waiting later", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  f.emit("browserbase-solving-started")
  f.advance(20_000)
  await assert.rejects(
    waitForBrowserbaseCaptcha(f.page, async () => false),
    /solver still active/
  )
  assert.equal(f.now(), 30_000)
  stop()
})

for (const phase of ["before", "after"] as const) {
  test(`the actual form action waits for a solver that starts ${phase} filling`, async (t) => {
    const f = fixture(t)
    let fills = 0
    const context = {}
    const control = {
      selector: "#email",
      id: "email",
      name: "email",
      type: "email",
      tag: "input",
      role: "",
      label: "Email",
      disabled: false,
    } as ComputerControl
    Object.assign(f.page, {
      context: () => context,
      parentFrame: () => null,
      isDetached: () => false,
      frames: () => [f.page],
      evaluate: async () => ({
        title: "Synthetic form",
        text: "Email",
        notices: "",
        controls: [control],
      }),
      locator: (selector: string) => ({
        count: async () => (selector.includes("iframe") ? 0 : 1),
        fill: async () => {
          if (phase === "before") assert.equal(f.now(), 500)
          fills++
          if (phase === "after") f.emit("browserbase-solving-started")
        },
      }),
    })
    const stop = trackBrowserbaseCaptcha(f.page)
    const browser = new ComputerBrowser(f.page)
    await browser.observe({ screenshot: false })
    if (phase === "before") f.emit("browserbase-solving-started")
    f.poll(() => {
      if (f.now() === 500) f.emit("browserbase-solving-finished")
    })
    await browser.action(
      browser.observation.controls[0],
      "fill",
      "synthetic@example.test"
    )
    assert.equal(fills, 1)
    assert.equal(f.now(), 500)
    stop()
  })
}

test("provider solving resumes immediately after clearance without a fixed delay", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  let cleared = false
  f.emit("browserbase-solving-started")
  f.poll(() => {
    if (f.now() >= 500) {
      f.emit("browserbase-solving-finished")
      cleared = true
    }
  })
  assert.equal(
    await waitForBrowserbaseCaptcha(f.page, async () => cleared),
    true
  )
  assert.equal(f.now(), 500)
  stop()
})

test("solver errors and restarted challenges share the same bounded wait", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  let cleared = false
  f.emit("browserbase-solving-started")
  f.poll(() => {
    if (f.now() === 500) f.emit("browserbase-solving-errored")
    if (f.now() === 1000) f.emit("browserbase-solving-started")
    if (f.now() === 1500) {
      f.emit("browserbase-solving-finished")
      cleared = true
    }
  })
  assert.equal(
    await waitForBrowserbaseCaptcha(f.page, async () => cleared),
    true
  )
  assert.equal(f.now(), 1500)
  stop()
})

test("an active solver at timeout never opens a competing human handoff", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  f.emit("browserbase-solving-started")
  await assert.rejects(
    waitForBrowserbaseCaptcha(f.page, async () => false),
    /solver still active/
  )
  assert.equal(f.now(), 30_000)
  stop()
})

test("an inactive failed solver permits manual fallback after its bounded wait", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  f.emit("browserbase-solving-started")
  f.emit("browserbase-solving-errored")
  assert.equal(
    await waitForBrowserbaseCaptcha(f.page, async () => false),
    false
  )
  assert.equal(f.now(), 30_000)
  stop()
})

test("a delayed solver start stays within the original blocked-page wait", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  let cleared = false
  f.poll(() => {
    if (f.now() === 4_000) f.emit("browserbase-solving-started")
    if (f.now() === 6_000) {
      f.emit("browserbase-solving-finished")
      cleared = true
    }
  })
  assert.equal(
    await waitForBrowserbaseCaptcha(f.page, async () => cleared),
    true
  )
  assert.equal(f.now(), 6_000)
  stop()
})

test("a blocked page with no solver events uses a bounded wait and never logs arbitrary console text", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  f.emit("private answer https://private.example?token=secret")
  assert.equal(
    await waitForBrowserbaseCaptcha(f.page, async () => false),
    false
  )
  assert.equal(f.now(), 30_000)
  assert.deepEqual(f.logs, [])
  stop()
  assert.equal(
    await waitForBrowserbaseCaptcha(f.page, async () => false),
    false
  )
  f.emit("browserbase-solving-started")
  assert.deepEqual(f.logs, [])
})
