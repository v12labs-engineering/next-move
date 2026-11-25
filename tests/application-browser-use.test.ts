import { WebSocketServer } from "ws"
import { once } from "node:events"
import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { existsSync } from "node:fs"
import { chromium, type Page } from "playwright-core"
import { applicationFailure } from "../lib/applications/pipeline"
import { hasEmployerAccountGate } from "../lib/server/applications/employer-auth"
import {
  browserUseConfiguration,
  browserUseModelConfiguration,
  browserUseRunner,
  BrowserUseWorkerError,
  browserUsePage,
} from "../lib/server/applications/browser-use"

test("real browser target resolution follows popups and rejects closed or foreign tabs", async () => {
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      (existsSync(macChrome) ? macChrome : chromium.executablePath()),
    headless: true,
  })
  try {
    const context = await browser.newContext()
    const original = await context.newPage()
    const popup = await context.newPage()
    const foreign = await (await browser.newContext()).newPage()
    const target = async (page: Page) => {
      const cdp = await page.context().newCDPSession(page)
      try {
        return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId
      } finally {
        await cdp.detach()
      }
    }
    const popupId = await target(popup)
    assert.equal(await browserUsePage(original, popupId), popup)
    assert.equal(await browserUsePage(popup, await target(original)), original)
    await assert.rejects(
      browserUsePage(original, await target(foreign)),
      /no longer available/
    )
    await popup.close()
    await assert.rejects(
      browserUsePage(original, popupId),
      /no longer available/
    )
  } finally {
    await browser.close()
  }
})

test("only a visible account screen without a guest route is classified as gated", async () => {
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      (existsSync(macChrome) ? macChrome : chromium.executablePath()),
  })
  try {
    const page = await browser.newPage()
    const cases = [
      ["<h1>Create Account</h1><input type=password>", true],
      ["<h1>Log in or create account</h1><input type=email>", true],
      ["<h1>Start your application</h1><input type=email>", false],
      ["<h1>Create your profile</h1><input type=email>", false],
      ["<h1>Verify your email</h1><input autocomplete=one-time-code>", false],
      [
        "<h1>Sign in</h1><input type=password><a href=/guest>Apply as a guest</a>",
        false,
      ],
      [
        "<h1 hidden>Sign in</h1><input type=email><button>Apply</button>",
        false,
      ],
      ["<h1>Sign in</h1><input type=password><input type=file>", false],
    ] as const
    for (const [html, expected] of cases) {
      await page.setContent(html)
      assert.equal(await hasEmployerAccountGate(page), expected, html)
    }
  } finally {
    await browser.close()
  }
})

function environment(t: TestContext) {
  const settings = {
    BROWSER_USE_WORKER_URL: "https://worker.example.test",
    BROWSER_USE_WORKER_TOKEN: "fixture-token-with-at-least-32-characters",
    TAILORING_BASE_URL: "https://model.example.test/v1",
    TAILORING_MODEL: "fixture",
    BROWSER_USE_MODEL: "browser-fixture",
    TAILORING_API_KEY: "fictional",
  }
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
}

test("production requires an authenticated HTTPS Python worker, local execution is explicit", () => {
  assert.throws(() => browserUseConfiguration({}), /not configured/)
  assert.throws(
    () =>
      browserUseConfiguration({ VERCEL: "1", BROWSER_USE_PYTHON: "/python" }),
    /not configured/
  )
  assert.throws(
    () =>
      browserUseConfiguration({
        BROWSER_USE_WORKER_URL: "http://public.example",
      }),
    /HTTPS/
  )
  assert.throws(
    () =>
      browserUseConfiguration({
        BROWSER_USE_WORKER_URL: "https://worker.example",
      }),
    /token/
  )
  assert.deepEqual(browserUseConfiguration({ BROWSER_USE_PYTHON: "/python" }), {
    python: "/python",
  })
})

test("Boat uses its own reachable model while tailoring uses Docker host Ollama", () => {
  const env = {
    APPLICATION_BROWSER_PROVIDER: "boat",
    TAILORING_OLLAMA_MODEL: "local-fixture",
  }
  assert.throws(
    () => browserUseModelConfiguration(env),
    /endpoint is not configured/
  )
  assert.throws(
    () =>
      browserUseModelConfiguration({
        ...env,
        BROWSER_USE_BASE_URL: "http://host.docker.internal:11434/v1",
        BROWSER_USE_MODEL: "local-fixture",
        BROWSER_USE_API_KEY: "fixture-key",
      }),
    /secure provider endpoint/
  )
  assert.deepEqual(
    browserUseModelConfiguration({
      ...env,
      BROWSER_USE_BASE_URL: "https://model.example.test/v1",
      BROWSER_USE_MODEL: "browser-fixture",
      BROWSER_USE_API_KEY: "fixture-key",
    }),
    {
      baseURL: "https://model.example.test/v1",
      modelId: "browser-fixture",
      apiKey: "fixture-key",
      reasoning: undefined,
    }
  )
})

async function worker(t: TestContext, scenario: string) {
  environment(t)
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await once(server, "listening")
  const address = server.address()
  assert.ok(typeof address === "object" && address)
  process.env.BROWSER_USE_WORKER_URL = `http://127.0.0.1:${address.port}`
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  let closed!: () => void
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve
  })
  const replies: unknown[] = []
  server.on("connection", (socket, request) => {
    assert.equal(
      request.headers.authorization,
      `Bearer ${process.env.BROWSER_USE_WORKER_TOKEN}`
    )
    socket.on("close", closed)
    let initial = true
    socket.on("message", (data, isBinary) => {
      assert.equal(
        isBinary,
        false,
        "Python receive_text requires text WebSocket frames"
      )
      const value = JSON.parse(String(data))
      if (initial) {
        initial = false
        assert.equal(value.connectUrl, "wss://fixture")
        assert.equal(value.model.modelId, "browser-fixture")
        assert.equal(process.env.TAILORING_MODEL, "fixture")
        if (scenario === "timeout") return
        if (scenario === "truncated") {
          socket.close()
          return
        }
        socket.send(
          JSON.stringify({
            type: "progress",
            actions: [],
            timing: {
              phase: "model",
              durationMs: 120,
              elapsedMs: 200,
              turn: 1,
              ok: true,
              privateInput: "must-not-be-logged",
            },
          })
        )
        socket.send(
          JSON.stringify({
            type: scenario === "failure" ? "failure" : "reserve",
          })
        )
      } else {
        replies.push(value)
        socket.send(
          JSON.stringify(
            replies.length === 1
              ? {
                  type: "tool",
                  name: "review",
                  arguments: { epoch: 4 },
                  pageId: "active-popup",
                }
              : { type: "complete" }
          )
        )
      }
    })
  })
  return { replies, disconnected }
}

test("one authenticated connection reserves, relays tools, and closes the owned run", async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, "info", (...args: unknown[]) => logs.push(args))
  const { replies, disconnected } = await worker(t, "success")
  let reservations = 0
  await browserUseRunner("wss://fixture")({
    logContext: { applicationId: "fixture", revision: 5 },
    task: "Synthetic only",
    tools: {},
    timeout: 1000,
    reserveDecision: async () => {
      reservations++
    },
    execute: async (name, args, pageId) => {
      assert.equal(reservations, 1)
      assert.equal(name, "review")
      assert.deepEqual(args, { epoch: 4 })
      assert.equal(
        pageId,
        "active-popup",
        "Business tools must receive the worker's current target"
      )
      return { done: true }
    },
  })
  await disconnected
  assert.deepEqual(replies, [{ ok: true }, { done: true }])
  assert.ok(
    logs.some((entry) => JSON.stringify(entry).includes('"phase":"model"'))
  )
  assert.ok(
    logs.some((entry) =>
      JSON.stringify(entry).includes('"applicationId":"fixture"')
    )
  )
  assert.ok(!JSON.stringify(logs).includes("must-not-be-logged"))
})

for (const scenario of ["quota", "failure", "truncated", "timeout"] as const) {
  test(`worker ${scenario} cannot trigger a tool or leave the run connected`, async (t) => {
    const { disconnected } = await worker(t, scenario)
    await assert.rejects(
      browserUseRunner("wss://fixture")({
        task: "Synthetic only",
        tools: {},
        timeout: scenario === "timeout" ? 50 : 1000,
        reserveDecision: async () => {
          throw Error("Quota reached")
        },
        execute: async () => assert.fail("No operation permitted"),
      })
    )
    await disconnected
  })
}

test("worker validation exposes a stable diagnostic without private inputs", () => {
  const error = new BrowserUseWorkerError({
    type: "failure",
    code: "ValidationError",
    validation: [{ path: "task", code: "string_too_long" }],
  })
  assert.equal(error.diagnostic, "browser_use_task_too_long")
  assert.equal(error.message, "Browser Use agent failed")
  assert.equal(applicationFailure(error).retryable, false)
  assert.equal(applicationFailure(error).code, "configuration")
  const interrupted = new BrowserUseWorkerError({
    type: "failure",
    code: "RuntimeError",
  })
  assert.equal(applicationFailure(interrupted).retryable, true)
  assert.equal(applicationFailure(interrupted).code, "temporary_unavailable")
})
