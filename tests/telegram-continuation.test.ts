import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  applicationTelegramAction,
  parseApplicationTelegramAction,
} from "../lib/telegram/applications"
import { handleTelegramUpdate } from "../lib/server/telegram/bot"
import { questionMessage, type TelegramRequest } from "../lib/telegram"

const user = "00000000-0000-4000-8000-000000000001"
const other = "00000000-0000-4000-8000-000000000002"
const first = "10000000-0000-4000-8000-000000000001"
const second = "10000000-0000-4000-8000-000000000002"
const qid = "20000000-0000-4000-8000-000000000001"
const packet = {
  title: "Engineer",
  company: "Chosen employer",
  resume: "Exact fictional prepared resume for QA, with sufficient length.",
  notices: "Exact employer notice.",
  formHash: "fixture",
  tailored: true,
  fields: [
    {
      id: "notice",
      label: "Notice period",
      help: "Days",
      kind: "number" as const,
      required: true,
      options: [],
    },
  ],
  answers: {},
}
const state = {
  initialized: true,
  editing: false,
  answers: {},
  confirmed: [],
  proposals: {},
}

test("application buttons bind exact identity and revision within Telegram's limit", () => {
  for (const action of ["review", "retry", "browser", "status"] as const) {
    const value = applicationTelegramAction(first, 99, action)
    assert.ok(Buffer.byteLength(value) <= 64)
    assert.deepEqual(parseApplicationTelegramAction(value), {
      id: first,
      revision: 99,
      action,
    })
  }
  for (const bad of [
    `app:${first}:0:review`,
    `app:${first}:1:send`,
    `app:${first}:9007199254740992:review`,
    "apps:10",
  ])
    assert.equal(parseApplicationTelegramAction(bad), null)
})
test("final Telegram approval links to the resume without sending it in chat", () => {
  const q: TelegramRequest = {
    id: qid,
    user_id: user,
    application_id: first,
    revision: 1,
    version: 1,
    packet: { ...packet, answers: { notice: "30" } },
    state: { ...state, answers: { notice: "30" } },
    expires_at: "2099-01-01T00:00:00Z",
  }
  const prompt = questionMessage(q, "https://app.example.test")
  assert.ok(!prompt.text.includes(packet.resume))
  assert.match(prompt.text, /Resume prepared.*application page/)
  assert.ok(prompt.text.includes(packet.notices))
  assert.match(prompt.text, /Approve & send authorizes/)
})
for (const scenario of [
  "selected",
  "qualification-review",
  "ready-complete",
  "confirmed",
  "stale",
  "other-account",
  "expired-browser",
  "live-browser",
  "list",
]) {
  test(`Telegram continuation callback: ${scenario}`, async (t) => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: "https://continuation.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "fixture",
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "123456:fixture",
      TELEGRAM_BOT_USERNAME: "fixture_bot",
      TELEGRAM_APP_ORIGIN: "https://app.example.test",
      TELEGRAM_WEBHOOK_SECRET: "fixture-secret-of-sufficient-length",
      BROWSERBASE_API_KEY: "fixture",
      BROWSERBASE_PROJECT_ID: "project-fixture",
    }
    const old = { ...process.env }
    Object.assign(process.env, env)
    t.after(() => {
      process.env = old
    })
    const sent: {
      text: string
      reply_markup?: {
        inline_keyboard: {
          text: string
          url?: string
          callback_data?: string
        }[][]
      }
      protect_content?: boolean
    }[] = []
    let selected = 0,
      provider = 0
    const chosenPacket = ["qualification-review", "ready-complete"].includes(
      scenario
    )
      ? { ...packet, answers: { notice: "30" } }
      : packet
    const run = {
      id: second,
      user_id: user,
      status: scenario.includes("browser")
        ? "submitting"
        : scenario === "confirmed"
          ? "submitted"
          : scenario === "ready-complete"
            ? "ready"
            : "needs_attention",
      revision: 2,
      approved_revision: 2,
      automatic: true,
      packet: chosenPacket,
      receipt:
        scenario === "confirmed"
          ? {
              text: "Synthetic receipt confirmed",
              confirmedAt: "2026-11-03T00:00:00Z",
            }
          : null,
      prepare_attempts: 1,
      updated_at: new Date().toISOString(),
      message:
        scenario === "qualification-review"
          ? "Not confirmed in your resume: 5 years of experience. Review before continuing."
          : "Please complete your notice period.",
    }
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        const op = url.pathname.split("/").at(-1)
        if (url.hostname === "api.telegram.org") {
          if (op === "answerCallbackQuery")
            return Response.json({ ok: true, result: true })
          assert.equal(op, "sendMessage")
          sent.push(JSON.parse(String(init?.body)))
          return Response.json({ ok: true, result: { message_id: 42 } })
        }
        if (url.hostname === "api.browserbase.com") {
          provider++
          if (op === "debug") {
            assert.equal(url.searchParams.get("expiresIn"), "60")
            return Response.json({
              debuggerFullscreenUrl:
                "https://www.browserbase.com/devtools/fixture?token=ephemeral-fixture",
            })
          }
          return Response.json({
            id: "30000000-0000-4000-8000-000000000001",
            projectId: env.BROWSERBASE_PROJECT_ID,
            status: "RUNNING",
          })
        }
        if (op === "telegram_connections")
          return init?.method === "PATCH"
            ? new Response(null, { status: 204 })
            : Response.json({ user_id: user })
        if (op === "application_runs") {
          if (scenario === "other-account") return Response.json(null)
          if (scenario === "list")
            return Response.json(
              Array.from({ length: 10 }, (_, i) => ({
                ...run,
                id: i ? first : second,
                title: packet.title,
                company: packet.company,
              })),
              { headers: { "content-range": "0-9/12" } }
            )
          if (
            url.searchParams.get("select")?.includes("auto_submit_requested_at")
          )
            return Response.json(run)
          if (init?.method === "PATCH")
            return new Response(null, { status: 204 })
          assert.equal(url.searchParams.get("user_id"), `eq.${user}`)
          return Response.json(run)
        }
        if (op === "application_tasks")
          return Response.json({
            output: {
              browserAssistance: {
                sessionId: "30000000-0000-4000-8000-000000000001",
                expiresAt: new Date(
                  Date.now() + (scenario === "expired-browser" ? -1000 : 60000)
                ).toISOString(),
              },
            },
          })
        if (op === "queue_automatic_application") return Response.json(false)
        if (op === "continue_telegram_application") {
          selected++
          const body = JSON.parse(String(init?.body))
          assert.equal(body.p_application, second)
          assert.equal(body.p_action, "review")
          return Response.json({
            userId: user,
            applicationId: second,
            action: "review",
          })
        }
        if (op === "claim_telegram_delivery")
          return Response.json({
            id: qid,
            user_id: user,
            application_id: second,
            revision: 2,
            version: 3,
            packet: chosenPacket,
            state: { ...state, answers: chosenPacket.answers },
            ai_draft_attempted: true,
            expires_at: "2099-01-01T00:00:00Z",
            thread_id: "telegram:42",
          })
        if (op === "telegram_requests")
          return init?.method === "PATCH"
            ? new Response(null, { status: 204 })
            : Response.json({
                id: qid,
                application: {
                  status: run.status,
                  message: run.message,
                  automatic: run.automatic,
                },
              })
        throw new Error(`Unexpected fixture operation: ${op}`)
      }
    )
    const message = {
      message_id: 10,
      date: 1,
      chat: { id: 42, type: "private" },
      from: { id: 42 },
    }
    const action = scenario.includes("browser") ? "browser" : "review"
    await handleTelegramUpdate(
      scenario === "list"
        ? { update_id: 1, message: { ...message, text: "/applications" } }
        : {
            update_id: 1,
            callback_query: {
              id: "click",
              from: { id: 42 },
              message,
              data: applicationTelegramAction(
                second,
                scenario === "stale" ? 1 : 2,
                action
              ),
            },
          }
    )
    assert.equal(
      selected,
      ["selected", "qualification-review", "ready-complete"].includes(scenario)
        ? 1
        : 0
    )
    if (scenario === "selected")
      assert.match(sent.at(-1)!.text, /Chosen employer[\s\S]*Notice period/)
    if (["qualification-review", "ready-complete"].includes(scenario)) {
      assert.equal(
        sent.length,
        0,
        "A completed automatic review must not send an approval card"
      )
    }
    if (scenario === "confirmed") {
      assert.match(sent.at(-1)!.text, /Synthetic receipt confirmed/)
      assert.equal(sent.at(-1)!.reply_markup, undefined)
    }
    if (scenario === "stale") assert.match(sent[0].text, /changed/)
    if (scenario === "other-account") assert.match(sent[0].text, /unavailable/)
    if (scenario === "expired-browser") {
      assert.match(sent[0].text, /window has ended/)
      assert.equal(provider, 0)
      assert.equal(sent[0].reply_markup, undefined)
    }
    if (scenario === "live-browser") {
      assert.equal(provider, 2)
      assert.match(sent[0].text, /Do not submit again/)
      assert.doesNotMatch(sent[0].text, /ephemeral-fixture/)
      assert.match(
        sent[0].reply_markup!.inline_keyboard[0][0].url!,
        /^https:\/\/www.browserbase.com\//
      )
      assert.equal(sent[0].protect_content, true)
    }
    if (scenario === "list")
      assert.equal(
        sent[0].reply_markup!.inline_keyboard.at(-1)![0].callback_data,
        "apps:10"
      )
  })
}

test("SQL selection preserves answers and fences stale, duplicate and unsafe retries", async () => {
  const db = new PGlite()
  try {
    await db.exec(
      `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;insert into auth.users values('${user}'),('${other}');create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());create table public.account_profiles(user_id uuid primary key);insert into public.account_profiles values('${user}'),('${other}');create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));create function public.reserve_tailoring_attempt() returns boolean language sql as $$select true$$;`
    )
    for (const name of [
      "202610290004_application_runner.sql",
      "202610290005_application_claim.sql",
      "202610300001_automatic_applications.sql",
      "202610300002_site_independent_applications.sql",
      "202610310003_application_question_memory.sql",
      "202610310004_application_question_preferences.sql",
      "202611020038_telegram_approvals.sql",
      "202611030046_telegram_application_continuation.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}`, import.meta.url),
          "utf8"
        )
      )
    await db.query(
      "insert into telegram_connections(user_id,thread_id,label) values($1,'telegram:42','Fixture'),($2,'telegram:43','Other')",
      [user, other]
    )
    for (const id of [first, second])
      await db.query(
        "insert into application_runs(id,user_id,target_url,status,packet,automatic) values($1,$2,$3,'ready',$4,true)",
        [
          id,
          user,
          `https://employer.example.test/${id}`,
          JSON.stringify(packet),
        ]
      )
    await db.query(
      "update telegram_requests set created_at=now()-interval '1 hour',delivered_version=version where application_id=$1",
      [first]
    )
    await db.exec("set role service_role")
    const select = async (
      id: string,
      revision = 1,
      action = "review",
      message = `select:${id}:${Math.random()}`,
      thread = "telegram:42"
    ) =>
      (
        await db.query<{ v: { userId: string } | null }>(
          "select continue_telegram_application($1,$2,$3,$4,$5) v",
          [thread, id, revision, action, message]
        )
      ).rows[0].v
    const secondRequest = async () =>
      (
        await db.query<{ id: string; version: number; state: unknown }>(
          "select id,version,state from telegram_requests where application_id=$1",
          [second]
        )
      ).rows[0]
    assert.equal(
      (
        await db.query<{ v: unknown }>(
          "select claim_telegram_delivery($1,gen_random_uuid()) v",
          [user]
        )
      ).rows[0].v,
      null,
      "The older delivered review blocks default delivery"
    )
    assert.ok(await select(second, 1, "review", "selection-1"))
    const q = await secondRequest()
    const claim = (
      await db.query<{ v: { application_id: string } }>(
        "select claim_telegram_delivery($1,gen_random_uuid()) v",
        [user]
      )
    ).rows[0].v
    assert.equal(claim.application_id, second)
    const old = (
      await db.query<{ id: string; version: number }>(
        "select id,version from telegram_requests where application_id=$1",
        [first]
      )
    ).rows[0]
    assert.equal(
      (
        await db.query<{ v: unknown }>(
          "select transition_telegram_request('telegram:42',$1,$2,$3,'old-reply') v",
          [old.id, old.version, JSON.stringify(state)]
        )
      ).rows[0].v,
      null
    )
    const edited = {
      ...state,
      answers: { notice: "30" },
      confirmed: ["notice"],
    }
    await db.query(
      "select transition_telegram_request('telegram:42',$1,$2,$3,'answer-b')",
      [q.id, q.version, JSON.stringify(edited)]
    )
    assert.ok(await select(first))
    assert.ok(await select(second))
    assert.deepEqual(
      (await secondRequest()).state,
      edited,
      "Switching applications preserves confirmed answers"
    )
    const version = (await secondRequest()).version
    assert.equal(await select(second, 1, "review", "selection-1"), null)
    assert.equal(
      (await secondRequest()).version,
      version,
      "Webhook replay cannot reset the selected conversation"
    )
    assert.equal(await select(second, 99), null)
    assert.equal(
      await select(second, 1, "review", "other-account", "telegram:43"),
      null
    )
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='needs_attention',packet=null,auto_submit_requested_at=now() where id=$1",
      [second]
    )
    await db.exec("set role service_role")
    assert.ok(await select(second, 1, "retry", "retry-1"))
    const retried = (
      await db.query<{
        status: string
        revision: number
        auto_submit_requested_at: string | null
      }>(
        "select status,revision,auto_submit_requested_at from application_runs where id=$1",
        [second]
      )
    ).rows[0]
    assert.equal(retried.status, "queued_prepare")
    assert.equal(retried.revision, 2)
    assert.equal(
      retried.auto_submit_requested_at,
      null,
      "Retry requires renewed explicit approval"
    )
    assert.equal(await select(second, 1, "retry", "retry-1"), null)
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='needs_attention' where id=$1",
      [second]
    )
    await db.query(
      "insert into application_events(application_id,user_id,status,revision) values($1,$2,'submitting',1)",
      [second, user]
    )
    await db.exec("set role service_role")
    assert.equal(
      await select(second, 2, "retry"),
      null,
      "A previous send intent can never be retried from Telegram"
    )
    assert.equal(await select(second, 2, "review"), null)
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`reset role;set role ${role}`)
      await assert.rejects(
        db.query(
          "select continue_telegram_application('telegram:42',$1,1,'review','forged')",
          [first]
        ),
        /permission denied/
      )
    }
  } finally {
    await db.close()
  }
})
