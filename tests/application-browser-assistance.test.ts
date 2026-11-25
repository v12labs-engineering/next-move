import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createClient } from "@supabase/supabase-js"
import { supabaseServerClient } from "../lib/server/supabase-server"
import {
  applicationBrowserLiveUrl,
  waitForApplicationHuman,
  HUMAN_VERIFICATION_WAIT_MS,
} from "../lib/server/applications/browser-assistance"
import { notifyBrowserAssistance } from "../lib/server/telegram/browser-assistance"
import { assistanceStages } from "../lib/applications/pipeline"
import { TelegramVerificationBridge } from "../lib/server/applications/telegram-verification-bridge"
import type { Page } from "playwright-core"

const id = "10000000-0000-4000-8000-000000000001"
const sessionId = "20000000-0000-4000-8000-000000000001"

test("Boat OTP publishes the app waiting state and starts its Telegram prompt", async (t) => {
  const f = fixture(t)
  let prompted = false
  t.mock.method(
    TelegramVerificationBridge,
    "connect",
    async () =>
      ({
        start: async () => {
          prompted = true
          assert.equal(f.task.error_code, "telegram_verification_required")
          assert.match(String(f.task.message), /verification code.*Telegram/)
          assert.equal(
            (f.task.output as { browserAssistance: { sessionId: string } })
              .browserAssistance.sessionId,
            "bx_fixture123"
          )
        },
      }) as unknown as TelegramVerificationBridge
  )
  await waitForApplicationHuman(
    f.db,
    id,
    4,
    "bx_fixture123",
    async () => true,
    Infinity,
    assistanceStages[2],
    false,
    {} as Page,
    true
  )
  assert.equal(prompted, true)
  assert.equal(f.task.output, null)
})

test("automatic OTP assistance without Telegram never requests live browser operation", async (t) => {
  const f = fixture(t)
  f.task.output = null
  await assert.rejects(
    waitForApplicationHuman(
      f.db,
      id,
      4,
      sessionId,
      async () => false,
      Infinity,
      assistanceStages[2],
      false,
      undefined,
      true
    ),
    /verification could not be completed through Telegram/
  )
  assert.equal(f.task.output, null)
  assert.equal(f.provider.calls, 0)
})
function fixture(t: TestContext, fieldHelp = false) {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-only",
    BROWSERBASE_API_KEY: "browser-key",
    BROWSERBASE_PROJECT_ID: "project-fixture",
    TELEGRAM_ENABLED: "false",
  }
  const old = { ...process.env }
  Object.assign(process.env, env)
  t.after(() => {
    process.env = old
  })
  const run = {
    id,
    user_id: "alice",
    status: fieldHelp ? "running" : "submitting",
    revision: 4,
    approved_revision: 4,
    updated_at: new Date().toISOString(),
  }
  const task: Record<string, unknown> = {
    application_id: id,
    revision: 4,
    stage: fieldHelp ? "fill_employer_form" : "submit",
    state: "running",
    error_code: fieldHelp
      ? "employer_control_help"
      : "human_verification_required",
    output: {
      browserAssistance: {
        sessionId,
        expiresAt: new Date(
          Date.now() + HUMAN_VERIFICATION_WAIT_MS
        ).toISOString(),
      },
    },
  }
  const provider = {
    calls: 0,
    project: env.BROWSERBASE_PROJECT_ID,
    state: "RUNNING",
    url: "https://www.browserbase.com/devtools/fixture?token=private-link",
    beforeReturn: () => {},
  }
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === "https://api.browserbase.com") {
        provider.calls++
        if (url.pathname.endsWith("/debug")) {
          assert.equal(url.searchParams.get("expiresIn"), "60")
          provider.beforeReturn()
          return Response.json({
            debuggerFullscreenUrl: provider.url,
            wsUrl: "wss://private-key-do-not-return",
          })
        }
        return Response.json({
          id: sessionId,
          projectId: provider.project,
          status: provider.state,
        })
      }
      assert.equal(url.origin, env.NEXT_PUBLIC_SUPABASE_URL)
      const user = url.searchParams.get("user_id")
      const single = new Headers(init?.headers)
        .get("accept")
        ?.includes("vnd.pgrst.object")
      if (url.pathname.endsWith("/application_runs")) {
        if (user && user !== "eq.alice") return Response.json([])
        return Response.json(single ? run : [run])
      }
      assert.equal(url.searchParams.get("application_id"), `eq.${id}`)
      assert.equal(url.searchParams.get("revision"), "eq.4")
      assert.equal(
        url.searchParams.get("stage"),
        fieldHelp ? "eq.fill_employer_form" : "eq.submit"
      )
      assert.equal(url.searchParams.get("state"), "eq.running")
      if (init?.method === "PATCH")
        Object.assign(task, JSON.parse(String(init.body)))
      const errorCode = url.searchParams.get("error_code")
      return Response.json(
        errorCode &&
          !(errorCode.startsWith("in.")
            ? errorCode
                .slice(4, -1)
                .split(",")
                .includes(String(task.error_code))
            : task.error_code === errorCode.slice(3))
          ? []
          : single
            ? task
            : [task]
      )
    }
  )
  const account = (user: string) => ({
    user: { id: user },
    db: createClient(env.NEXT_PUBLIC_SUPABASE_URL, `user-${user}`, {
      auth: { persistSession: false },
    }),
  })
  return { run, task, provider, account, db: supabaseServerClient() }
}

test("Telegram relay verification keeps an owner-checked Live View escape hatch", async (t) => {
  const f = fixture(t)
  f.task.error_code = "telegram_verification_required"
  const url = await applicationBrowserLiveUrl(f.account("alice"), id, 4)
  assert.equal(url, f.provider.url)
  assert.equal(f.provider.calls, 2)
})

test("Boat assistance never passes its session ID to the Browserbase API", async (t) => {
  const f = fixture(t)
  f.task.error_code = "telegram_verification_required"
  f.task.output = {
    browserAssistance: {
      sessionId: "bx_fixture123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  }
  await assert.rejects(
    applicationBrowserLiveUrl(f.account("alice"), id, 4),
    /Telegram verification prompt/
  )
  assert.equal(f.provider.calls, 0)
})

for (const connected of [true, false]) {
  test(`human assistance ${connected ? "alerts the connected Telegram account" : "respects a disconnected Telegram account"}`, async (t) => {
    const previous = { ...process.env }
    t.after(() => {
      process.env = previous
    })
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "fixture",
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "123456:synthetic_token",
      TELEGRAM_BOT_USERNAME: "synthetic_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret-01234567890123",
      TELEGRAM_APP_ORIGIN: "https://app.example.test",
    })
    let messages = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        if (url.hostname === "api.telegram.org") {
          messages++
          const body = JSON.parse(String(init?.body))
          assert.equal(body.chat_id, "42")
          assert.doesNotMatch(body.text, /https:\/\/app\.example\.test/)
          assert.deepEqual(body.reply_markup.inline_keyboard, [
            [
              {
                text: "Open live employer browser",
                callback_data: `app:${id}:4:browser`,
              },
            ],
            [{ text: "Check status", callback_data: `app:${id}:4:status` }],
          ])
          assert.doesNotMatch(
            body.text,
            /browserbase.com|token=|wsUrl|sessionId/
          )
          return Response.json({ ok: true, result: { message_id: 1 } })
        }
        if (url.pathname.endsWith("/application_runs")) {
          assert.equal(
            url.searchParams.get("status"),
            "in.(preparing,running,submitting)"
          )
          assert.equal(url.searchParams.get("revision"), "eq.4")
          return Response.json([{ user_id: "alice", status: "submitting" }])
        }
        assert.equal(url.searchParams.get("user_id"), "eq.alice")
        return Response.json(connected ? [{ thread_id: "telegram:42" }] : [])
      }
    )
    await notifyBrowserAssistance(id, 4)
    assert.equal(messages, Number(connected))
  })
}

test("only the owner and exact active revision can obtain a short-lived live URL", async (t) => {
  const f = fixture(t)
  // The runtime requires only the account identity and its RLS-scoped client.
  const alice = f.account("alice") as Parameters<
    typeof applicationBrowserLiveUrl
  >[0]
  const bob = f.account("bob") as Parameters<
    typeof applicationBrowserLiveUrl
  >[0]
  await assert.rejects(applicationBrowserLiveUrl(bob, id, 4), /not found/)
  await assert.rejects(
    applicationBrowserLiveUrl(alice, id, 3),
    /no longer waiting/
  )
  assert.equal(f.provider.calls, 0)
  assert.equal(await applicationBrowserLiveUrl(alice, id, 4), f.provider.url)
  assert.equal(f.provider.calls, 2)
})

test("pre-submit field assistance is owner/revision scoped and clears the exact task after completion", async (t) => {
  const f = fixture(t, true)
  const alice = f.account("alice") as Parameters<
    typeof applicationBrowserLiveUrl
  >[0]
  const bob = f.account("bob") as Parameters<
    typeof applicationBrowserLiveUrl
  >[0]
  await assert.rejects(applicationBrowserLiveUrl(bob, id, 4), /not found/)
  await assert.rejects(
    applicationBrowserLiveUrl(alice, id, 3),
    /no longer waiting/
  )
  assert.equal(await applicationBrowserLiveUrl(alice, id, 4), f.provider.url)
  await waitForApplicationHuman(
    f.db,
    id,
    4,
    sessionId,
    async () => {
      assert.equal(f.task.error_code, "employer_control_help")
      assert.match(String(f.task.message), /Do not submit.*sending is blocked/)
      assert.equal(f.run.status, "running")
      return true
    },
    Infinity,
    assistanceStages[1],
    true
  )
  assert.equal(f.task.output, null)
  await assert.rejects(applicationBrowserLiveUrl(alice, id, 4), /expired/)
})

test("pre-submit assistance respects cancellation and reserves time to persist an outcome", async (t) => {
  const f = fixture(t, true)
  await assert.rejects(
    waitForApplicationHuman(
      f.db,
      id,
      4,
      sessionId,
      async () => true,
      Date.now() + 10_000,
      assistanceStages[1],
      true
    ),
    /Unsupported employer control/
  )
  f.run.status = "cancelled"
  await assert.rejects(
    waitForApplicationHuman(
      f.db,
      id,
      4,
      sessionId,
      async () => true,
      Infinity,
      assistanceStages[1],
      true
    ),
    /Approval no longer active/
  )
  assert.equal(f.task.output, null)
})

for (const failure of [
  "expired",
  "completed",
  "different-project",
  "bad-url",
  "raced",
]) {
  test(`browser assistance refuses ${failure} access`, async (t) => {
    const f = fixture(t)
    if (failure === "expired")
      f.task.output = {
        browserAssistance: {
          sessionId,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        },
      }
    if (failure === "completed") f.run.status = "submitted"
    if (failure === "different-project") f.provider.project = "another-project"
    if (failure === "bad-url")
      f.provider.url = "https://browserbase.com.evil.example/session"
    if (failure === "raced")
      f.provider.beforeReturn = () => {
        f.task.output = null
      }
    const expected =
      failure === "completed"
        ? /no longer waiting/
        : failure === "different-project"
          ? /has ended/
          : failure === "bad-url"
            ? /Invalid browser assistance/
            : /expired/
    await assert.rejects(
      applicationBrowserLiveUrl(
        f.account("alice") as Parameters<typeof applicationBrowserLiveUrl>[0],
        id,
        4
      ),
      expected
    )
  })
}

test("human assistance publishes only service task metadata and clears it after completion", async (t) => {
  const f = fixture(t)
  await waitForApplicationHuman(f.db, id, 4, sessionId, async () => {
    assert.equal(f.task.error_code, "human_verification_required")
    assert.deepEqual(Object.keys(f.task.output as object), [
      "browserAssistance",
    ])
    assert.doesNotMatch(
      JSON.stringify(f.task.output),
      /connectUrl|wsUrl|apiKey|token=/
    )
    return true
  })
  assert.equal(f.task.output, null)
  assert.equal(f.task.error_code, null)
})

for (const failure of ["expired", "revoked", "browser-failed"]) {
  test(`human assistance clears access after ${failure}`, async (t) => {
    const f = fixture(t)
    let now = Date.now()
    t.mock.method(Date, "now", () => now)
    if (failure === "revoked") f.run.approved_revision = 3
    await assert.rejects(
      waitForApplicationHuman(f.db, id, 4, sessionId, async () => {
        if (failure === "browser-failed")
          throw new Error("Browser disconnected")
        now += HUMAN_VERIFICATION_WAIT_MS
        return false
      }),
      /time expired|Approval no longer active|Browser disconnected/
    )
    assert.equal(f.task.output, null)
    assert.equal(f.task.error_code, null)
  })
}

test("human assistance is not offered when the worker cannot wait for a person", async () => {
  await assert.rejects(
    waitForApplicationHuman(
      {} as Parameters<typeof waitForApplicationHuman>[0],
      id,
      4,
      sessionId,
      async () => true,
      Date.now() + 10_000
    ),
    /assistance time expired/
  )
})
