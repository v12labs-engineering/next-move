import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { chromium } from "playwright-core"
import { supabaseServerClient } from "../../lib/server/supabase-server"
import { waitForApplicationHuman } from "../../lib/server/applications/browser-assistance"
import { handleTelegramUpdate } from "../../lib/server/telegram/bot"
import {
  readVerificationView,
  applyVerificationResponse,
} from "../../lib/server/applications/verification-surface"
declare global {
  interface Window {
    verifications?: number
    received?: string
    sent?: number
    clicks?: number
    verified?: boolean
  }
}
type TaskOutput = {
  browserAssistance?: { sessionId: string; expiresAt: string }
  telegramChallenge?: {
    id: string
    mode: string
    state: string
    replyMessageId?: string
    targetCount?: number
    command?: { action: string; target: number | null; value: string } | null
  }
}
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  chromiumSandbox: true,
})
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
let checks = 0
try {
  const otp = `<form onsubmit="event.preventDefault();window.verifications=(window.verifications||0)+1;window.received=document.querySelector('input').value;document.body.innerHTML='<h1>Verification accepted</h1>'"><label>Verification code<input autocomplete="one-time-code" oninput="document.querySelector('button').disabled=false"></label><button disabled>Verify</button></form>`
  await page.setContent(otp)
  const view = await readVerificationView(page)
  assert.equal(view.mode, "code")
  assert.equal(view.targets.length, 2)
  await mkdir(".local-data", { recursive: true })
  await writeFile(".local-data/telegram-code-preview.png", view.image)
  await applyVerificationResponse(page, view, {
    action: "code",
    value: "012345",
  })
  assert.deepEqual(
    await page.evaluate(() => ({
      n: window.verifications,
      value: window.received,
    })),
    { n: 1, value: "012345" }
  )
  checks++
  const segmented = `<input aria-label="Applicant name" value="Fictional applicant"><div role="dialog"><p>A verification code was sent. To submit your application, enter the 8-character code to confirm you're a human.</p><label>Security code</label>${Array.from({ length: 8 }, (_, i) => `<input id="security-input-${i}" maxlength="1">`).join("")}<button onclick="window.verifications=(window.verifications||0)+1;window.received=[...document.querySelectorAll('[id^=security-input]')].map(e=>e.value).join('');document.body.innerHTML='<h1>Verification accepted</h1>'">Submit application</button></div>`
  await page.setContent(segmented)
  await page.evaluate(() => {
    window.verifications = 0
  })
  assert.equal(
    (await readVerificationView(page)).targets.some((t) => t.kind === "click"),
    false
  )
  const splitCode = await readVerificationView(page, true)
  assert.equal(splitCode.mode, "code")
  assert.equal(
    splitCode.targets.filter((target) => target.kind === "code").length,
    8
  )
  await assert.rejects(
    applyVerificationResponse(page, splitCode, {
      action: "code",
      value: "123456",
    }),
    /Invalid/
  )
  assert.equal(await page.locator("#security-input-0").inputValue(), "")
  const screenshot = page.screenshot.bind(page)
  let codeScreenshots = 0
  page.screenshot = async (...args) => {
    codeScreenshots++
    return screenshot(...args)
  }
  const codeBegan = performance.now()
  await applyVerificationResponse(page, splitCode, {
    action: "code",
    value: "AB12CD34",
  })
  const codeElapsedMs = Math.round(performance.now() - codeBegan)
  page.screenshot = screenshot
  console.log(
    JSON.stringify({
      codeEntry: { screenshots: codeScreenshots, elapsedMs: codeElapsedMs },
    })
  )
  assert.equal(
    codeScreenshots,
    0,
    "Code-entry revalidation must not transfer screenshots"
  )
  assert.deepEqual(
    await page.evaluate(() => ({
      count: window.verifications,
      value: window.received,
    })),
    { count: 1, value: "AB12CD34" }
  )
  checks++
  const embedded = `<form onsubmit="event.preventDefault();window.verifications=(window.verifications||0)+1"><input id="applicant" value="Fictional applicant"><fieldset><p>A verification code was sent. Enter the 8-character code to confirm you are human.</p>${Array.from({ length: 8 }, (_, i) => `<input id="security-input-${i}" maxlength="1">`).join("")}</fieldset><button type="submit">Submit application</button></form>`
  await page.setContent(embedded)
  assert.equal(
    (await readVerificationView(page)).targets.some((t) => t.kind === "click"),
    false
  )
  const embeddedView = await readVerificationView(page, true)
  assert.equal(embeddedView.targets.filter((t) => t.kind === "click").length, 1)
  await page.locator("#applicant").fill("Changed applicant")
  await assert.rejects(
    applyVerificationResponse(page, embeddedView, {
      action: "code",
      value: "AB12CD34",
    }),
    /changed/
  )
  await page.locator("#applicant").fill("Fictional applicant")
  await page.evaluate(() => {
    window.verifications = 0
  })
  await applyVerificationResponse(
    page,
    await readVerificationView(page, true),
    { action: "code", value: "AB12CD34" }
  )
  assert.equal(await page.evaluate(() => window.verifications), 1)
  checks++
  await page.setContent(
    segmented.replace(
      "<label>Security code</label>",
      '<label>Security code</label><input type="password">'
    )
  )
  assert.equal((await readVerificationView(page)).mode, "unsupported")
  await page.setContent(segmented.replace(/<p>.*?<\/p>/, ""))
  assert.equal((await readVerificationView(page)).mode, "unsupported")
  await page.setContent(
    '<form><label>Middle initial<input maxlength="1"></label><button>Verify</button></form>'
  )
  assert.equal((await readVerificationView(page)).mode, "unsupported")
  checks++
  await page.setContent(
    `<form><label>Verification code<input autocomplete="one-time-code" oninput="document.querySelector('button').textContent='Submit application'"></label><button type="button" onclick="window.sent=(window.sent||0)+1">Verify</button></form>`
  )
  const swapped = await readVerificationView(page)
  await assert.rejects(
    applyVerificationResponse(page, swapped, {
      action: "code",
      value: "123456",
    }),
    /changed/
  )
  assert.equal(await page.evaluate(() => window.sent || 0), 0)
  checks++
  await page.setContent(
    `<form><label>Verification code<input autocomplete="one-time-code" oninput="document.body.innerHTML='<button onclick=window.sent=1>Submit application</button>'"></label><button>Verify</button></form>`
  )
  await applyVerificationResponse(page, await readVerificationView(page), {
    action: "code",
    value: "123456",
  })
  assert.equal(await page.evaluate(() => window.sent || 0), 0)
  checks++
  await page.setContent(otp)
  await assert.rejects(
    applyVerificationResponse(
      page,
      await readVerificationView(page),
      { action: "code", value: "123456" },
      Date.now() - 1
    ),
    /expired/
  )
  assert.equal(await page.locator("input").inputValue(), "")
  checks++
  await page.setContent(
    `<form><label>Verification code<input autocomplete="one-time-code"></label><input type="file"><button>Submit application</button></form>`
  )
  assert.equal((await readVerificationView(page)).mode, "unsupported")
  checks++
  await page.setContent(
    `<form><input autocomplete="one-time-code"><input type="password"><button>Verify</button></form>`
  )
  assert.equal((await readVerificationView(page)).mode, "unsupported")
  checks++
  await page.route("https://www.google.com/recaptcha/fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<style>td{width:70px;height:70px;border:2px solid black}canvas{width:60px;height:60px}</style><h3>Generated QA controls, not a CAPTCHA</h3><table><tr><td onclick="window.clicks=(window.clicks||0)+1;this.style.borderColor='red'"><canvas width=60 height=60></canvas></td><td onclick="window.clicks=(window.clicks||0)+1;this.style.borderColor='red'"><canvas width=60 height=60></canvas></td></tr></table><button onclick="window.verified=true">Verify</button>`,
    })
  )
  await page.setContent(
    '<iframe style="width:420px;height:340px" src="https://www.google.com/recaptcha/fixture"></iframe>'
  )
  await page.locator("iframe").waitFor()
  const frame = await page
    .locator("iframe")
    .contentFrame()
    .locator("button")
    .waitFor()
    .then(
      () => page.frames().find((f) => f.url().includes("/recaptcha/fixture"))!
    )
  const challenge = await readVerificationView(page)
  assert.equal(challenge.mode, "challenge")
  assert.equal(challenge.targets.filter((t) => t.tile).length, 2)
  await writeFile(".local-data/telegram-challenge-preview.png", challenge.image)
  await applyVerificationResponse(page, challenge, {
    action: "click",
    target: 0,
  })
  assert.equal(await frame.evaluate(() => window.clicks), 1)
  await assert.rejects(
    applyVerificationResponse(page, challenge, { action: "click", target: 0 }),
    /changed/
  )
  checks++
  const beforePixels = await readVerificationView(page)
  await frame
    .locator("canvas")
    .first()
    .evaluate((el) => {
      const canvas = el as HTMLCanvasElement
      const c = canvas.getContext("2d")!
      c.fillStyle = "red"
      c.fillRect(0, 0, 60, 60)
    })
  await assert.rejects(
    applyVerificationResponse(page, beforePixels, {
      action: "click",
      target: 1,
    }),
    /changed/
  )
  checks++
  const current = await readVerificationView(page)
  await applyVerificationResponse(page, current, {
    action: "click",
    target: current.targets.findIndex((t) => t.label === "Verify"),
  })
  assert.equal(await frame.evaluate(() => window.verified), true)
  checks++
  await page.setContent("<h1>We could not confirm the result</h1>")
  const unsupported = await readVerificationView(page)
  assert.equal(unsupported.mode, "unsupported")
  assert.equal(unsupported.targets.length, 0)
  checks++
  // Full in-process worker -> Telegram prompt -> authenticated reply -> inbox
  // claim -> original browser action -> task cleanup, with generated transport.
  const previousEnv = { ...process.env },
    originalFetch = globalThis.fetch
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://relay.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
    TELEGRAM_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:fixture",
    TELEGRAM_BOT_USERNAME: "fixture_bot",
    TELEGRAM_APP_ORIGIN: "https://app.example.test",
    TELEGRAM_WEBHOOK_SECRET: "verification-fixture-secret-0123456789",
  })
  const id = "10000000-0000-4000-8000-000000000001",
    sessionId = "bx_fixture123"
  let output: TaskOutput | null = null,
    errorCode = "",
    providerMessage = 100,
    codePrompt = 0,
    queuedValue = "",
    photos = 0
  const currentOutput = (): TaskOutput | null => output
  const matches = (url: URL) =>
    (
      [
        [
          "output->browserAssistance->>sessionId",
          output?.browserAssistance?.sessionId,
        ],
        ["output->telegramChallenge->>id", output?.telegramChallenge?.id],
        ["output->telegramChallenge->>state", output?.telegramChallenge?.state],
        [
          "output->telegramChallenge->>replyMessageId",
          output?.telegramChallenge?.replyMessageId,
        ],
      ] satisfies [string, string | undefined][]
    ).every(
      ([name, value]) =>
        !url.searchParams.has(name) ||
        url.searchParams.get(name) === `eq.${value}`
    )
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      op = url.pathname.split("/").at(-1)
    if (url.hostname === "api.telegram.org") {
      if (op === "sendPhoto") {
        photos++
        return Response.json({
          ok: true,
          result: { message_id: ++providerMessage },
        })
      }
      const body = JSON.parse(String(init?.body))
      if (op === "answerCallbackQuery")
        return Response.json({ ok: true, result: true })
      assert.equal(op, "sendMessage")
      assert.equal(body.chat_id, "42")
      if (body.reply_markup?.force_reply) codePrompt = providerMessage + 1
      assert.doesNotMatch(body.text, /012345|https:\/\/.*browserbase/)
      return Response.json({
        ok: true,
        result: { message_id: ++providerMessage },
      })
    }
    assert.equal(url.hostname, "relay.example.test")
    if (op === "telegram_connections")
      return init?.method === "PATCH"
        ? new Response(null, { status: 204 })
        : Response.json({ user_id: "alice", thread_id: "telegram:42" })
    if (op === "application_runs")
      return Response.json({
        id,
        user_id: "alice",
        revision: 2,
        approved_revision: 2,
        status: "submitting",
        title: "Generated engineer",
        company: "QA employer",
      })
    if (op === "application_tasks") {
      if (!matches(url)) return Response.json(null)
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body))
        if ("output" in patch) output = patch.output
        if ("error_code" in patch) errorCode = patch.error_code
        return url.searchParams.has("select")
          ? Response.json({ application_id: id })
          : new Response(null, { status: 204 })
      }
      if (url.searchParams.has("error_code"))
        assert.equal(errorCode, "telegram_verification_required")
      return Response.json({ output, application: { user_id: "alice" } })
    }
    if (op === "queue_telegram_verification") {
      const body = JSON.parse(String(init?.body))
      const current = currentOutput()
      assert.ok(current?.telegramChallenge)
      assert.equal(body.p_challenge, current.telegramChallenge.id)
      assert.equal(body.p_reply, String(codePrompt))
      queuedValue = body.p_value
      assert.ok(!queuedValue.includes("012345"))
      current.telegramChallenge = {
        ...current.telegramChallenge,
        state: "queued",
        command: { action: "code", target: null, value: body.p_value },
      }
      return Response.json(true)
    }
    throw new Error(`Unexpected bridge operation: ${op}`)
  }
  try {
    await page.setContent(otp)
    await page.evaluate(() => {
      window.verifications = 0
    })
    const waiting = waitForApplicationHuman(
      supabaseServerClient(),
      id,
      2,
      sessionId,
      async () => await page.evaluate(() => window.verifications === 1),
      Date.now() + 45000,
      undefined,
      false,
      page,
      true
    )
    const readyDeadline = Date.now() + 10000
    while (
      !codePrompt ||
      currentOutput()?.telegramChallenge?.replyMessageId !== String(codePrompt)
    ) {
      if (Date.now() > readyDeadline)
        throw new Error("No bound Telegram code prompt")
      await new Promise((r) => setTimeout(r, 20))
    }
    await handleTelegramUpdate({
      update_id: 123,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 42 },
        text: "012345",
        reply_to_message: { message_id: codePrompt },
      },
    })
    await waiting
    assert.equal(await page.evaluate(() => window.verifications), 1)
    assert.equal(
      photos,
      0,
      "Email codes need a direct reply prompt, not a screenshot message"
    )
    assert.equal(output, null)
    assert.equal(errorCode, null)
    assert.ok(queuedValue)
    checks++
  } finally {
    globalThis.fetch = originalFetch
    process.env = previousEnv
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      noEmployerContacted: true,
      noRealCaptchaUsed: true,
      verificationActionsOnly: true,
    })
  )
} finally {
  await browser.close()
}
