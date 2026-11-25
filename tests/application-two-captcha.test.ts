import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test, { type TestContext } from "node:test"
import type { Page } from "playwright-core"
import { trackBrowserbaseCaptcha } from "../lib/server/applications/captcha"
import { ComputerBrowser } from "../lib/server/applications/computer-browser"
import { solveCaptcha } from "../lib/server/applications/native-agent"
import { tryTwoCaptchaGrid } from "../lib/server/applications/two-captcha"

function fixture(t: TestContext) {
  const previous = process.env.TWOCAPTCHA_API_KEY
  process.env.TWOCAPTCHA_API_KEY = "private-fixture-key"
  t.after(() => {
    if (previous === undefined) delete process.env.TWOCAPTCHA_API_KEY
    else process.env.TWOCAPTCHA_API_KEY = previous
  })
  let now = 0,
    clear = false,
    generation = 0,
    creates = 0,
    polls = 0
  let host = "www.google.com",
    response: unknown = [1, 3],
    processing = false,
    failure = false
  let duringPoll = () => {}
  let afterClick: (n: number) => void = () => {}
  let afterGridRead = () => {}
  let dynamic = false
  let originalImage: string | undefined
  let animated = false
  let animationFrame = 0
  let gridCaptures = 0
  let unsolvableResults = 0
  const images = Array.from({ length: 9 }, (_, i) => `public-image-${i}`)
  const selected = new Set<number>(),
    actions: string[] = [],
    requests: Record<string, unknown>[] = [],
    createdAt: number[] = [],
    logs: unknown[][] = []
  const events = new EventEmitter()
  t.mock.method(Date, "now", () => now)
  t.mock.method(console, "info", (...args: unknown[]) => logs.push(args))
  const root = { parentFrame: () => null }
  const element = {
    isVisible: async () => !clear,
    dispose: async () => {},
    boundingBox: async () => ({ x: 0, y: 0, width: 300, height: 400 }),
    screenshot: async (options?: { animations?: string }) =>
      Buffer.from(
        `challenge-${generation}-${[...selected].join()}-${animated && options?.animations !== "disabled" ? ++animationFrame : 0}`
      ),
  }
  const targets = [
    ...images.map((_, i) => ({
      selector: `#tile${i}`,
      kind: "click",
      label: `Tile ${i + 1}`,
      tile: true,
    })),
    { selector: "#verify", kind: "click", label: "Verify", tile: false },
  ]
  const frame = {
    parentFrame: () => root,
    frameElement: async () => element,
    url: () => `https://${host}/recaptcha/api2/bframe`,
    evaluate: async (_fn: unknown, arg: unknown) => {
      const isGrid = !!arg && typeof arg === "object" && "selectors" in arg
      const result = isGrid
        ? {
            originalImage,
            selector: "table",
            instructions: dynamic
              ? "Select all bicycles. Click verify once there are none left"
              : "Select all bicycles",
            rows: 3,
            columns: 3,
            tiles: images.map((image, i) => ({
              selector: `#tile${i}`,
              image,
              selected: selected.has(i),
            })),
          }
        : {
            mode: "challenge",
            targets,
            signature: `${generation}-${[...selected].join()}`,
            message: "Synthetic challenge",
          }
      if (isGrid) afterGridRead()
      return result
    },
    locator: (selector: string) => ({
      screenshot: async () => {
        gridCaptures++
        return Buffer.from("cropped-public-grid-only")
      },
      click: async () => {
        actions.push(selector)
        if (selector === "#reload") {
          generation++
          selected.clear()
          for (let i = 0; i < images.length; i++) images[i] += "-fresh"
          return
        }
        if (selector === "#verify") {
          clear = true
          return
        }
        const match = /^#tile([0-8])$/.exec(selector)
        assert.ok(match, "Only observed challenge controls may be clicked")
        const i = Number(match[1])
        selected.add(i)
        afterClick(i)
      },
    }),
  }
  let checkbox = false
  const anchor = {
    parentFrame: () => root,
    frameElement: async () => element,
    url: () => "https://www.google.com/recaptcha/api2/anchor",
    locator: () => ({
      count: async () => 1,
      isVisible: async () => true,
      getAttribute: async () => "false",
      click: async () => {
        actions.push("#recaptcha-anchor")
        checkbox = false
      },
    }),
  }
  const page = {
    context: () => root,
    frames: () => (checkbox ? [anchor] : [frame]),
    mainFrame: () => root,
    on: events.on.bind(events),
    off: events.off.bind(events),
    locator: () => ({ count: async () => (clear ? 0 : 1) }),
    waitForTimeout: async (ms: number) => {
      now += ms
    },
  } as unknown as Page
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      assert.equal(url.origin, "https://api.2captcha.com")
      assert.equal(init?.redirect, "error")
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      assert.equal(body.clientKey, "private-fixture-key")
      if (url.pathname === "/createTask") {
        creates++
        createdAt.push(now)
        assert.deepEqual(body.task, {
          type: "GridTask",
          body:
            originalImage ||
            Buffer.from("cropped-public-grid-only").toString("base64"),
          ...(originalImage ? { imgType: "recaptcha" } : {}),
          comment: dynamic
            ? "Select all bicycles. Click verify once there are none left"
            : "Select all bicycles",
          rows: 3,
          columns: 3,
          canNoAnswer: 1,
        })
        return Response.json(
          failure
            ? {
                errorId: 12,
                errorDescription:
                  "private-fixture-key signed connection secret",
              }
            : { errorId: 0, taskId: creates }
        )
      }
      assert.equal(url.pathname, "/getTaskResult")
      polls++
      duringPoll()
      if (unsolvableResults > 0) {
        unsolvableResults--
        return Response.json({
          errorId: 12,
          errorDescription: "private provider diagnostic",
        })
      }
      return Response.json(
        processing
          ? { errorId: 0, status: "processing" }
          : { errorId: 0, status: "ready", solution: { click: response } }
      )
    }
  )
  return {
    page,
    checkbox: () => {
      checkbox = true
    },
    dynamic: (value = true) => {
      dynamic = value
    },
    originalImages: () => {
      originalImage = Buffer.from("original-image-pixels").toString("base64")
    },
    actions,
    requests,
    createdAt,
    logs,
    ready: async () => clear,
    counts: () => ({ creates, polls }),
    gridCaptures: () => gridCaptures,
    now: () => now,
    elapse: (ms: number) => {
      now += ms
    },
    noKey: () => {
      delete process.env.TWOCAPTCHA_API_KEY
    },
    fail: () => {
      failure = true
    },
    unsolvable: (count = 1, reload = true) => {
      unsolvableResults = count
      if (reload)
        targets.push({
          selector: "#reload",
          kind: "click",
          label: "Get a new challenge",
          tile: false,
        })
    },
    processing: () => {
      processing = true
    },
    response: (value: unknown) => {
      response = value
    },
    unsupported: () => {
      host = "unrecognized.example.test"
    },
    mutate: () => {
      generation++
    },
    clear: () => {
      clear = true
    },
    challengeAgain: () => {
      clear = false
      selected.clear()
      generation++
    },
    replace: (i: number) => {
      images[i] += "-replacement"
      selected.delete(i)
      generation++
    },
    duringPoll: (fn: () => void) => {
      duringPoll = fn
    },
    afterClick: (fn: (i: number) => void) => {
      afterClick = fn
    },
    afterGridRead: (fn: () => void) => {
      afterGridRead = fn
    },
    animate: () => {
      animated = true
    },
    emit: (text: string) => events.emit("console", { text: () => text }),
  }
}

test("missing 2Captcha configuration immediately permits Telegram fallback without reading or sending a screenshot", async (t) => {
  const f = fixture(t)
  f.noKey()
  Object.assign(f.page, {
    frames: () => assert.fail("No key must not capture challenge data"),
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.deepEqual(f.counts(), { creates: 0, polls: 0 })
  assert.equal(f.now(), 0)
})

test("2Captcha clicks its one-based grid answer in the same verification frame, verifies and never submits an application", async (t) => {
  const f = fixture(t)
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#verify"])
  assert.deepEqual(f.counts(), { creates: 1, polls: 1 })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.counts().creates, 1)
})

test("browser detection starts 2Captcha immediately and solves a later challenge in the same session", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  t.after(stop)
  const browser = new ComputerBrowser(f.page)
  await browser.waitForCaptcha()
  assert.deepEqual(f.createdAt, [0])
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#verify"])
  await browser.waitForCaptcha()
  assert.equal(f.counts().creates, 1)
  f.challengeAgain()
  const detectedAt = f.now()
  await browser.waitForCaptcha()
  assert.deepEqual(f.createdAt, [0, detectedAt])
  assert.equal(f.counts().creates, 2)
})

test("clear browser pages never create a 2Captcha task or wait for solver events", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  t.after(stop)
  f.clear()
  await new ComputerBrowser(f.page).waitForCaptcha()
  assert.equal(f.now(), 0)
  assert.equal(f.counts().creates, 0)
})

test("a failed primary solve hands off immediately without repeating paid tasks", async (t) => {
  const f = fixture(t)
  f.fail()
  const browser = new ComputerBrowser(f.page)
  await assert.rejects(browser.waitForCaptcha(), /Human verification required/)
  assert.deepEqual(f.createdAt, [0])
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(f.counts().creates, 1)
  f.clear()
  await browser.waitForCaptcha()
  f.challengeAgain()
  await assert.rejects(browser.waitForCaptcha(), /Human verification required/)
  assert.equal(f.counts().creates, 2)
})

for (const answer of [[0], [17], [1, 1], "untrusted-selector", null]) {
  test(`invalid grid answer ${JSON.stringify(answer)} cannot click a control`, async (t) => {
    const f = fixture(t)
    f.response(answer)
    assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
    assert.deepEqual(f.actions, [])
  })
}

test("unsolvable provider responses permit Telegram fallback without leaking provider details", async (t) => {
  const f = fixture(t)
  f.fail()
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.deepEqual(f.actions, [])
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /private-fixture-key|signed connection/
  )
  assert.ok(
    f.logs.some((log) => {
      const details = log[1] as Record<string, unknown>
      return (
        details.phase === "create_task" && details.reason === "provider_error"
      )
    }),
    "failure diagnostics must distinguish provider rejection without logging its body"
  )
})

test("an unsolvable grid refreshes only the challenge and solves again in the same filled session", async (t) => {
  const f = fixture(t)
  f.unsolvable()
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#reload", "#tile0", "#tile2", "#verify"])
  assert.deepEqual(f.counts(), { creates: 2, polls: 2 })
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /private provider diagnostic|private-fixture-key/
  )
})

test("challenge refresh is bounded to once even when both solutions fail", async (t) => {
  const f = fixture(t)
  f.unsolvable(2)
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.deepEqual(f.actions, ["#reload"])
  assert.deepEqual(f.counts(), { creates: 2, polls: 2 })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(f.counts().creates, 2)
})

test("an unsolvable grid without an observed reload control never reloads the application", async (t) => {
  const f = fixture(t)
  f.unsolvable(1, false)
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.deepEqual(f.actions, [])
  assert.deepEqual(f.counts(), { creates: 1, polls: 1 })
})

test("challenge refresh cannot extend the caller's remaining time budget", async (t) => {
  const f = fixture(t)
  f.unsolvable()
  f.duringPoll(() => f.elapse(10_000))
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready, 20_000), false)
  assert.deepEqual(f.actions, [])
  assert.deepEqual(f.counts(), { creates: 1, polls: 1 })
})

test("a lost create response is never retried as another paid task", async (t) => {
  const f = fixture(t)
  let creates = 0
  t.mock.method(globalThis, "fetch", async () => {
    creates++
    throw new Error("private provider body")
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(creates, 1)
  assert.deepEqual(f.actions, [])
})

test("provider HTTP rejections log safe correlation metadata without body or key", async (t) => {
  const f = fixture(t)
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    return new Response("private provider body with private-fixture-key", {
      status: 400,
      headers: {
        "cf-ray": "a55857c7aecc8b64-IAD",
        "content-type": "text/html",
      },
    })
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(requests, 1)
  assert.deepEqual(f.actions, [])
  assert.ok(
    f.logs.some((log) => (log[1] as { status?: number }).status === 400)
  )
  assert.ok(
    f.logs.some(
      (log) =>
        (log[1] as { edgeRequestId?: string }).edgeRequestId ===
        "a55857c7aecc8b64-IAD"
    )
  )
  assert.ok(
    f.logs.some(
      (log) => (log[1] as { responseType?: string }).responseType === "html"
    )
  )
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /private provider body|private-fixture-key/
  )
})

test("a transient create error recovers within the shared deadline", async (t) => {
  const f = fixture(t)
  const accepted = globalThis.fetch
  let requests = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/createTask" && ++requests === 1)
        return new Response("provider unavailable", { status: 520 })
      return accepted(input, init)
    }
  )
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(requests, 2)
  assert.equal(f.now(), 10000)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#verify"])
})

test("transient errors exhaust three creates without unbounded costs or late actions", async (t) => {
  const f = fixture(t)
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    return new Response("provider unavailable", { status: 520 })
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(requests, 3)
  assert.equal(f.now(), 10000)
  assert.deepEqual(f.actions, [])
})

test("failed create attempts share the six-task budget with replacement grids", async (t) => {
  const f = fixture(t)
  const accepted = globalThis.fetch
  let requests = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/createTask" && ++requests === 1)
        return new Response("provider unavailable", { status: 503 })
      return accepted(input, init)
    }
  )
  f.afterClick((i) => f.replace(i))
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(requests, 6)
  assert.equal(f.counts().creates, 5)
  assert.ok(!f.actions.includes("#verify"))
})

test("a transient poll failure reuses its task instead of creating another", async (t) => {
  const f = fixture(t)
  const accepted = globalThis.fetch
  let polls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/getTaskResult" && ++polls === 1)
        return new Response("provider unavailable", { status: 502 })
      return accepted(input, init)
    }
  )
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.counts().creates, 1)
  assert.equal(polls, 2)
  assert.equal(f.now(), 10000)
})

test("a transient HTTP failure cannot extend the outer deadline to retry", async (t) => {
  const f = fixture(t)
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    f.elapse(16000)
    return new Response("provider unavailable", { status: 503 })
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready, 20000), false)
  assert.equal(requests, 1)
  assert.equal(f.now(), 16000)
  assert.deepEqual(f.actions, [])
})

test("polling uses a single four-minute budget and stops without applying a late answer", async (t) => {
  const f = fixture(t)
  f.processing()
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(f.now(), 240_000)
  assert.equal(f.counts().creates, 1)
  assert.deepEqual(f.actions, [])
})

test("slower multi-round grid answers still have time to verify in the same browser", async (t) => {
  const f = fixture(t)
  f.duringPoll(() => f.elapse(35_000))
  let replaced = false
  f.afterClick((i) => {
    if (!replaced) {
      replaced = true
      f.replace(i)
      f.response([5])
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.counts().creates, 2)
  assert.equal(f.now(), 80_000)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#tile4", "#verify"])
})

test("a shorter worker deadline still bounds a slow solver without clicking late answers", async (t) => {
  const f = fixture(t)
  f.processing()
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready, 35_000), false)
  assert.equal(f.now(), 35_000)
  assert.deepEqual(f.actions, [])
  assert.equal(f.counts().creates, 1)
})

test("a changed picture while the provider is solving cannot receive stale tile clicks", async (t) => {
  const f = fixture(t)
  f.duringPoll(f.mutate)
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.deepEqual(f.actions, [])
})

test("a neighboring dynamic tile changing between validation and click can refresh without abandoning unchanged answer tiles", async (t) => {
  const f = fixture(t)
  let replaced = false
  f.afterGridRead(() => {
    if (!replaced && f.actions.includes("#tile0")) {
      replaced = true
      f.replace(0)
      f.response([5])
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#tile4", "#verify"])
  assert.equal(f.counts().creates, 2)
})

test("an in-flight target replacement discards the old answer and gets a fresh bounded solution", async (t) => {
  const f = fixture(t)
  let replaced = false
  f.afterGridRead(() => {
    if (!replaced && f.actions.includes("#tile0")) {
      replaced = true
      f.replace(2)
      f.response([5])
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#tile0", "#tile4", "#verify"])
  assert.equal(f.counts().creates, 2)
})

test("continuous in-flight changes exhaust three guarded observations without retrying paid tasks or clicking stale answers", async (t) => {
  const f = fixture(t)
  let changes = 0
  f.afterGridRead(() => {
    if (f.actions.includes("#tile0")) {
      changes++
      f.mutate()
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(changes, 3)
  assert.deepEqual(f.actions, ["#tile0"])
  assert.equal(f.counts().creates, 1)
})

test("replacement tiles require another bounded grid solution rather than reusing earlier imagery", async (t) => {
  const f = fixture(t)
  let replaced = false
  f.afterClick((i) => {
    if (!replaced) {
      replaced = true
      f.replace(i)
      f.response([5])
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.counts().creates, 2)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#tile4", "#verify"])
})

test("a no-matching-images response uses only the observed Verify control", async (t) => {
  const f = fixture(t)
  f.response("No_matching_images")
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#verify"])
})

test("visual transitions do not invalidate an unchanged grid answer", async (t) => {
  const f = fixture(t)
  f.animate()
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#verify"])
  assert.equal(f.counts().creates, 1)
})

test("Verify refreshes a rejected pre-click view before acting on the unchanged grid", async (t) => {
  const f = fixture(t)
  let changed = false
  f.afterGridRead(() => {
    if (!changed && f.actions.includes("#tile2")) {
      changed = true
      f.mutate()
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#verify"])
  assert.equal(f.counts().creates, 1)
})

test("an image replaced at the Verify guard requires a new solution before Verify", async (t) => {
  const f = fixture(t)
  let changed = false
  f.afterGridRead(() => {
    if (!changed && f.actions.includes("#tile2")) {
      changed = true
      f.replace(4)
      f.response([5])
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#tile4", "#verify"])
  assert.equal(f.counts().creates, 2)
})

test("continuous changes at Verify exhaust its guard without a click or another paid task", async (t) => {
  const f = fixture(t)
  let changes = 0
  f.afterGridRead(() => {
    if (f.actions.includes("#tile2")) {
      changes++
      f.mutate()
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.deepEqual(f.actions, ["#tile0", "#tile2"])
  assert.equal(changes, 3)
  assert.equal(f.counts().creates, 1)
})

test("unsupported challenge frames are never sent to 2Captcha", async (t) => {
  const f = fixture(t)
  f.unsupported()
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.equal(f.requests.length, 0)
})

test("an active Browserbase solver prevents a second solver or competing human handoff", async (t) => {
  const f = fixture(t)
  const stop = trackBrowserbaseCaptcha(f.page)
  f.emit("browserbase-solving-started")
  await assert.rejects(
    tryTwoCaptchaGrid(f.page, f.ready),
    /solver still active/
  )
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.actions, [])
  stop()
})

test("original reCAPTCHA images use the recognition pipeline", async (t) => {
  const f = fixture(t)
  f.originalImages()
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal((f.requests[0].task as { imgType: string }).imgType, "recaptcha")
})

test("dynamic replacements settle before another solve and never Verify early", async (t) => {
  const f = fixture(t)
  f.dynamic()
  f.response([1])
  let clickedAt: number | undefined
  f.afterClick(() => {
    clickedAt = f.now()
  })
  f.afterGridRead(() => {
    if (clickedAt !== undefined && f.now() - clickedAt >= 1500) {
      f.replace(0)
      f.response("No_matching_images")
      clickedAt = undefined
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.counts().creates, 2)
  assert.deepEqual(f.actions, ["#tile0", "#verify"])
  assert.ok(f.createdAt[1] - f.createdAt[0] >= 7000)
})

test("missing dynamic replacements cannot cause an early Verify", async (t) => {
  const f = fixture(t)
  f.dynamic()
  f.response([1])
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), false)
  assert.deepEqual(f.actions, ["#tile0"])
  assert.equal(f.counts().creates, 1)
})

test("native CAPTCHA handoff reaches 2Captcha and verifies the grid", async (t) => {
  const f = fixture(t)
  const result = await solveCaptcha(f.page, Infinity, {
    applicationId: "fixture",
    revision: 1,
  })
  assert.equal(result.solved, true)
  assert.deepEqual(f.counts(), { creates: 1, polls: 1 })
  assert.deepEqual(f.actions, ["#tile0", "#tile2", "#verify"])
  assert.ok(JSON.stringify(f.logs).includes('"phase":"started"'))
  assert.ok(!JSON.stringify(f.logs).includes("private-fixture-key"))
})

test("native CAPTCHA checkbox activation hands the resulting grid to 2Captcha", async (t) => {
  const f = fixture(t)
  f.checkbox()
  assert.equal((await solveCaptcha(f.page, Infinity)).solved, true)
  assert.deepEqual(f.actions, [
    "#recaptcha-anchor",
    "#tile0",
    "#tile2",
    "#verify",
  ])
  assert.deepEqual(f.counts(), { creates: 1, polls: 1 })
})

test("tile validation captures the provider grid only once per round", async (t) => {
  const f = fixture(t)
  f.response([1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.gridCaptures(), 1)
  assert.equal(f.actions.length, 10)
})

test("multi-round answers can finish beyond the former two-minute cap", async (t) => {
  const f = fixture(t)
  f.duringPoll(() => f.elapse(65_000))
  let replaced = false
  f.afterClick((i) => {
    if (!replaced) {
      replaced = true
      f.replace(i)
      f.response([5])
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.now(), 140_000)
  assert.equal(f.counts().creates, 2)
  assert.equal(f.actions.at(-1), "#verify")
})

test("a challenge clearing while waiting for dynamic replacements succeeds without Verify", async (t) => {
  const f = fixture(t)
  f.dynamic()
  f.response([1])
  let clickedAt: number | undefined
  f.afterClick(() => {
    clickedAt = f.now()
  })
  const ready = async () => {
    if (clickedAt !== undefined && f.now() - clickedAt >= 500) f.clear()
    return f.ready()
  }
  assert.equal(await tryTwoCaptchaGrid(f.page, ready), true)
  assert.deepEqual(f.actions, ["#tile0"])
  assert.equal(f.counts().creates, 1)
})

test("a new prompt during replacement polling gets a fresh solution", async (t) => {
  const f = fixture(t)
  f.dynamic()
  f.response([1])
  let changed = false
  f.afterClick(() => {
    if (!changed) {
      changed = true
      f.dynamic(false)
      f.replace(0)
    }
  })
  assert.equal(await tryTwoCaptchaGrid(f.page, f.ready), true)
  assert.equal(f.counts().creates, 2)
  assert.deepEqual(f.actions, ["#tile0", "#tile0", "#verify"])
})
