import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  notifyApplicationTelegram,
  sweepTelegram,
} from "../lib/server/telegram/delivery"
import { prepareApplication } from "../lib/server/applications/worker"

const application = "10000000-0000-4000-8000-000000000001"
const user = "00000000-0000-4000-8000-000000000001"

const telegramEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://attention.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
  TELEGRAM_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "123456:synthetic_token",
  TELEGRAM_BOT_USERNAME: "synthetic_test_bot",
  TELEGRAM_APP_ORIGIN: "https://app.example.test",
  TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret-01234567890123",
}

for (const scenario of [
  "no_packet",
  "answered_packet",
  "preparation_failure",
  "transport_failure",
  "stale_claim",
  "question_packet",
  "ready_packet",
  "ready_manual",
  "ready_transport_failure",
]) {
  test(`Telegram alerts needs-attention applications: ${scenario}`, async (t) => {
    const oldEnv = { ...process.env }
    Object.assign(process.env, telegramEnv)
    t.after(() => {
      process.env = oldEnv
    })
    const ready = scenario.startsWith("ready_")
    let status = ready
      ? "ready"
      : scenario === "preparation_failure"
        ? "preparing"
        : "needs_attention"
    let delivered = false
    let failure: Record<string, unknown> | undefined
    let reviewClaims = 0
    let reviewDelivered = false
    const packet = {
      title: "Engineer",
      company: "Fixture employer",
      resume: "A sufficiently long fictional resume for testing.",
      tailored: true,
      formHash: "fixture",
      notices: "",
      answers: {},
      fields: [
        {
          id: "salary",
          label: "What are your salary expectations?",
          help: "",
          kind: "text",
          required: true,
          options: [],
        },
      ],
    }
    const sent: { text: string; chat_id: string; reply_markup?: unknown }[] = []
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        const op = url.pathname.split("/").at(-1)
        if (url.hostname === "api.telegram.org") {
          assert.equal(
            op,
            "sendMessage",
            "An alert must never submit or approve"
          )
          sent.push(JSON.parse(String(init?.body)))
          if (scenario.endsWith("transport_failure"))
            return Response.json({ ok: false }, { status: 503 })
          return Response.json({ ok: true, result: { message_id: 42 } })
        }
        if (op === "claim_application_preparation")
          return Response.json({
            id: application,
            user_id: user,
            job_id: null,
            revision: 1,
          })
        if (op === "record_application_task")
          return Response.json({ state: "running", attempts: 3 })
        if (op === "account_profiles")
          return Response.json(
            { message: "fixture storage failure" },
            { status: 503 }
          )
        if (url.pathname.includes("/auth/v1/admin/users/"))
          return Response.json({ id: user })
        if (op === "application_runs") {
          if (init?.method === "PATCH") {
            status = JSON.parse(String(init?.body)).status
            return new Response(null, { status: 204 })
          }
          return Response.json({ user_id: user })
        }
        if (op === "claim_telegram_submission") return Response.json(null)
        if (op === "claim_telegram_attention")
          return Response.json(
            delivered || !["needs_attention", "ready"].includes(status)
              ? null
              : {
                  application_id: application,
                  version: 1,
                  attempts: 1,
                  thread_id: "telegram:42",
                  title: scenario === "answered_packet" ? "Engineer" : null,
                  company:
                    scenario === "answered_packet" ? "Fixture employer" : null,
                }
          )
        if (op === "telegram_attention_notifications") {
          if (init?.method === "PATCH") {
            const body = JSON.parse(String(init?.body))
            delivered = !!body.delivered_at
            if (body.last_error) failure = body
            return new Response(null, { status: 204 })
          }
          return Response.json(
            scenario === "stale_claim"
              ? null
              : {
                  application_id: application,
                  revision: 1,
                  ...(scenario === "question_packet" ||
                  scenario === "answered_packet" ||
                  ready
                    ? {
                        application: {
                          status,
                          automatic: scenario !== "ready_manual",
                          packet:
                            scenario === "answered_packet"
                              ? { ...packet, answers: { salary: "120000" } }
                              : packet,
                          message: "Complete the missing questions.",
                        },
                      }
                    : {}),
                }
          )
        }
        if (op === "continue_telegram_application") {
          assert.notEqual(
            scenario,
            "answered_packet",
            "A failure with no missing answers must send a status alert rather than opening an empty question review"
          )
          assert.equal(
            ready,
            false,
            "A waiting alert must not replace the selected conversation"
          )
          const body = JSON.parse(String(init?.body))
          assert.equal(body.p_application, application)
          assert.equal(body.p_action, "review")
          return Response.json({ userId: user, applicationId: application })
        }
        if (op === "telegram_requests") {
          if (init?.method === "PATCH") {
            reviewDelivered = true
            return new Response(null, { status: 204 })
          }
          return Response.json({
            id: application,
            application: { status, message: "Complete the missing questions." },
          })
        }
        if (op === "claim_telegram_delivery") {
          reviewClaims++
          if (scenario === "question_packet" && !reviewDelivered)
            return Response.json({
              id: application,
              user_id: user,
              application_id: application,
              revision: 1,
              version: 1,
              packet,
              state: {
                answers: {},
                confirmed: [],
                initialized: true,
                editing: false,
              },
              expires_at: "2099-01-01T00:00:00Z",
              ai_draft_attempted: true,
              thread_id: "telegram:42",
            })
          // An older delivered question owns the sequential review queue.
          return Response.json(null)
        }
        throw new Error(`Unexpected fixture operation: ${op}`)
      }
    )
    if (scenario === "preparation_failure")
      await prepareApplication(application)
    else await notifyApplicationTelegram(application)
    assert.equal(status, ready ? "ready" : "needs_attention")
    if (scenario === "stale_claim") {
      assert.equal(
        sent.length,
        0,
        "A changed application or disconnected identity cannot receive a stale alert"
      )
      return
    }
    assert.equal(
      sent.length,
      1,
      "Attention alerts must not depend on missing answers or the active review"
    )
    assert.equal(sent[0].chat_id, "42")
    if (ready) {
      assert.match(sent[0].text, /needs your answers/)
      assert.match(sent[0].text, /1 required question/)
      assert.deepEqual(sent[0].reply_markup, {
        inline_keyboard: [
          [
            scenario === "ready_manual"
              ? {
                  text: "Answer questions",
                  url: `https://app.example.test/applications/${application}`,
                }
              : {
                  text: "Answer questions",
                  callback_data: `app:${application}:1:review`,
                },
          ],
        ],
      })
      if (scenario === "ready_transport_failure") {
        assert.equal(delivered, false)
        assert.equal(failure?.last_error, "delivery_failed")
        return
      }
      assert.equal(delivered, true)
      await notifyApplicationTelegram(application)
      assert.equal(
        sent.length,
        1,
        "The same waiting packet must not alert twice"
      )
      return
    }
    if (scenario === "question_packet") {
      assert.match(sent[0].text, /What are your salary expectations/)
      assert.doesNotMatch(sent[0].text, /Continue here/)
      assert.equal(delivered, true)
      await notifyApplicationTelegram(application)
      assert.equal(sent.length, 1)
      return
    }
    assert.match(sent[0].text, /needs your attention/)
    assert.doesNotMatch(sent[0].text, /https:\/\/app\.example\.test/)
    assert.deepEqual(
      sent[0].reply_markup,
      {
        inline_keyboard: [
          [
            {
              text: "Check status",
              callback_data: `app:${application}:1:status`,
            },
          ],
        ],
      },
      "Attention alerts must continue the selected application without authorizing send"
    )
    assert.equal(reviewClaims, 1)
    if (scenario === "transport_failure") {
      assert.equal(delivered, false)
      assert.equal(failure?.last_error, "delivery_failed")
      assert.equal(failure?.lease_token, null)
      assert.ok(
        new Date(String(failure?.next_attempt_at)).getTime() > Date.now()
      )
      return
    }
    assert.equal(delivered, true)
    await notifyApplicationTelegram(application)
    assert.equal(
      sent.length,
      1,
      "Worker replays must not repeat a delivered alert"
    )
  })
}

test("scheduled recovery delivers attention alerts despite an unrelated failed dispatch", async (t) => {
  const oldEnv = { ...process.env }
  Object.assign(process.env, telegramEnv)
  t.after(() => {
    process.env = oldEnv
  })
  const events: string[] = []
  let delivered = false
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const op = url.pathname.split("/").at(-1)
      if (op === "application_tasks" && init?.method === "PATCH") {
        assert.equal(
          url.searchParams.get("output->telegramChallenge"),
          "not.is.null"
        )
        assert.equal(JSON.parse(String(init.body)).output, null)
        return new Response(null, { status: 204 })
      }
      if (op === "telegram_submission_notifications") return Response.json([])
      if (op === "telegram_attention_notifications") {
        if (init?.method === "PATCH") {
          delivered = !!JSON.parse(String(init?.body)).delivered_at
          return new Response(null, { status: 204 })
        }
        if (url.searchParams.has("application_id"))
          return Response.json({ application_id: application })
        return Response.json(delivered ? [] : [{ application_id: application }])
      }
      if (op === "claim_telegram_attention")
        return Response.json({
          application_id: application,
          version: 1,
          attempts: 1,
          thread_id: "telegram:42",
        })
      if (op === "sendMessage") {
        events.push("alert")
        return Response.json({ ok: true, result: { message_id: 42 } })
      }
      if (op === "telegram_requests") {
        events.push("dispatch")
        return Response.json(
          { message: "fixture dispatch failure" },
          { status: 400 }
        )
      }
      throw new Error(`Unexpected fixture operation: ${op}`)
    }
  )
  await assert.rejects(sweepTelegram())
  assert.deepEqual(events, ["alert", "dispatch"])
  assert.equal(
    delivered,
    true,
    "Recovery commits delivery before unrelated dispatch work"
  )
  await assert.rejects(sweepTelegram())
  assert.deepEqual(
    events,
    ["alert", "dispatch", "dispatch"],
    "A retry skips the delivered alert"
  )
})

test("attention outbox covers missing packets and answered packets without blocking behind a review", async () => {
  const db = new PGlite()
  const complete = "10000000-0000-4000-8000-000000000002"
  const older = "10000000-0000-4000-8000-000000000003"
  const token = "20000000-0000-4000-8000-000000000001"
  const otherToken = "20000000-0000-4000-8000-000000000002"
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      insert into auth.users values('${user}');
      create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
      create table public.account_profiles(user_id uuid primary key);
      insert into public.account_profiles values('${user}');
      create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
      create function public.reserve_tailoring_attempt() returns boolean language sql as $$select true$$;
    `)
    for (const name of [
      "202610290004_application_runner.sql",
      "202610290005_application_claim.sql",
      "202610300001_automatic_applications.sql",
      "202610300002_site_independent_applications.sql",
      "202610310003_application_question_memory.sql",
      "202610310004_application_question_preferences.sql",
      "202611020038_telegram_approvals.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}`, import.meta.url),
          "utf8"
        )
      )
    await db.query(
      "insert into telegram_connections(user_id,thread_id,label) values($1,'telegram:42','Fixture')",
      [user]
    )
    const packet = {
      title: "Engineer",
      company: "Fixture employer",
      resume: "A fictional resume with TypeScript experience.",
      notices: "",
      formHash: "fixture",
      tailored: true,
      fields: [
        {
          id: "email",
          label: "Email",
          help: "",
          kind: "email",
          required: true,
          options: [],
        },
      ],
      answers: { email: "candidate@example.test" },
    }
    for (const [id, status, p] of [
      [older, "ready", { ...packet, answers: {} }],
      [application, "needs_attention", null],
      [complete, "needs_attention", packet],
    ])
      await db.query(
        "insert into application_runs(id,user_id,target_url,status,packet) values($1,$2,$3,$4,$5::jsonb)",
        [
          id,
          user,
          `https://employer.example/${id}`,
          status,
          p === null ? null : JSON.stringify(p),
        ]
      )
    await db.exec("update telegram_requests set delivered_version=version")
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from telegram_requests"
        )
      ).rows[0].n,
      1,
      "The original queue excludes both reported needs-attention cases"
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611030043_telegram_attention_notifications.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from telegram_attention_notifications"
        )
      ).rows[0].n,
      2,
      "Migration backfills current failures without altering review turns"
    )
    const reviewsBefore = (
      await db.query("select * from telegram_requests order by id")
    ).rows
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611080063_telegram_waiting_question_alerts.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from telegram_attention_notifications where application_id=$1",
          [older]
        )
      ).rows[0].n,
      1,
      "An application waiting for answers needs an independent alert even behind an older delivered review"
    )
    assert.deepEqual(
      (await db.query("select * from telegram_requests order by id")).rows,
      reviewsBefore,
      "Adding waiting alerts does not modify review selections, answers or approvals"
    )
    await db.exec("update telegram_requests set attempts=5,delivered_version=0")
    await db.exec("set role service_role")
    const claim = async (id: string, lease = token) =>
      (
        await db.query<{
          value: { thread_id: string; version: number; attempts: number } | null
        }>("select claim_telegram_attention($1,$2) as value", [id, lease])
      ).rows[0].value
    assert.equal(
      (
        await db.query<{ value: unknown }>(
          "select claim_telegram_delivery($1,$2) as value",
          [user, token]
        )
      ).rows[0].value,
      null,
      "An exhausted older review cannot be claimed by normal question delivery"
    )
    for (const id of [application, complete, older]) {
      assert.equal(
        (await claim(id))?.thread_id,
        "telegram:42",
        "Both attention alerts can be claimed independently"
      )
      assert.equal(
        await claim(id, otherToken),
        null,
        "An active lease excludes a duplicate sender"
      )
    }
    await db.exec("reset role")
    await db.query(
      "update telegram_attention_notifications set delivered_at=now(),lease_token=null,lease_until=null where application_id=$1",
      [older]
    )
    assert.equal(
      await claim(older),
      null,
      "A waiting-question alert is delivered once"
    )
    await db.query("update application_runs set packet=packet where id=$1", [
      older,
    ])
    assert.equal(
      await claim(older),
      null,
      "Unchanged waiting packets do not re-alert"
    )
    await db.query("update application_runs set packet=$1::jsonb where id=$2", [
      JSON.stringify(packet),
      older,
    ])
    assert.equal(
      await claim(older),
      null,
      "Answering every question removes its alert"
    )
    await db.query(
      "update application_runs set packet=$1::jsonb,revision=2 where id=$2",
      [JSON.stringify({ ...packet, answers: {} }), older]
    )
    assert.ok(await claim(older), "A later unanswered packet has a new alert")
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [older]
    )
    assert.equal(
      await claim(older),
      null,
      "A resumed send invalidates the old alert"
    )
    await db.query(
      "update application_runs set status='ready',revision=3 where id=$1",
      [older]
    )
    // An optional blank question and a resume upload must not create alerts.
    for (const field of [
      { ...packet.fields[0], required: false },
      { ...packet.fields[0], kind: "resume" },
    ]) {
      await db.query(
        "update application_runs set packet=$1::jsonb where id=$2",
        [JSON.stringify({ ...packet, fields: [field], answers: {} }), older]
      )
      assert.equal(await claim(older), null)
    }
    await db.query("update application_runs set packet=$1::jsonb where id=$2", [
      JSON.stringify({ ...packet, answers: { email: "not-an-email" } }),
      older,
    ])
    assert.ok(await claim(older), "Invalid required answers also alert")
    // Restore a waiting packet for the disconnect/reconnect checks below.
    await db.query("update application_runs set packet=$1::jsonb where id=$2", [
      JSON.stringify({ ...packet, answers: {} }),
      older,
    ])
    // A retry waits for backoff; an abandoned delivery lease can be recovered.
    await db.query(
      "update telegram_attention_notifications set lease_until=now()-interval '1 second',next_attempt_at=now()+interval '5 minutes' where application_id=$1",
      [application]
    )
    assert.equal(await claim(application), null)
    await db.query(
      "update telegram_attention_notifications set next_attempt_at=now()-interval '1 second' where application_id=$1",
      [application]
    )
    assert.equal((await claim(application, otherToken))?.attempts, 2)
    await db.query(
      "update telegram_attention_notifications set delivered_at=now(),lease_token=null,lease_until=null where application_id=$1 and lease_token=$2",
      [application, otherToken]
    )
    assert.equal(
      await claim(application),
      null,
      "A delivered alert is not sent on worker replay"
    )
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='needs_attention',updated_at=now() where id=$1",
      [application]
    )
    assert.equal(
      (
        await db.query<{ version: number }>(
          "select version from telegram_attention_notifications where application_id=$1",
          [application]
        )
      ).rows[0].version,
      1,
      "A repeated status write does not create duplicate alerts"
    )
    await db.query(
      "update application_runs set message='A different problem' where id=$1",
      [complete]
    )
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from telegram_attention_notifications where application_id=$1 and lease_token=$2",
          [complete, token]
        )
      ).rows[0].n,
      0,
      "A new failure invalidates an older worker's claim"
    )
    assert.equal((await claim(complete))?.version, 2)
    await db.query(
      "update application_runs set status='cancelled' where id=$1",
      [complete]
    )
    assert.equal(
      await claim(complete),
      null,
      "Resolved or cancelled failures cannot alert"
    )
    await db.query("delete from telegram_connections where user_id=$1", [user])
    assert.equal(
      await claim(application),
      null,
      "Disconnect invalidates pending disclosure"
    )
    assert.equal(
      await claim(older),
      null,
      "Disconnect also removes waiting-question alerts"
    )
    await db.query(
      "insert into telegram_connections(user_id,thread_id,label) values($1,'telegram:43','Other fixture')",
      [user]
    )
    assert.equal(
      (await claim(application))?.thread_id,
      "telegram:43",
      "Reconnect backfills failures to the current identity"
    )
    assert.equal(
      (await claim(older))?.thread_id,
      "telegram:43",
      "Reconnect backfills waiting questions independently of the review queue"
    )
    assert.equal(
      await claim(complete),
      null,
      "Reconnect cannot revive a cancelled application"
    )
    await db.query(
      "update telegram_attention_notifications set attempts=5,lease_until=null where application_id=$1",
      [application]
    )
    assert.equal(
      await claim(application),
      null,
      "Repeated transport failures have a bounded retry budget"
    )
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`set role ${role}`)
      await assert.rejects(
        db.query("select * from telegram_attention_notifications"),
        /permission denied/
      )
      await assert.rejects(
        db.query("select claim_telegram_attention($1,$2)", [
          application,
          token,
        ]),
        /permission denied/
      )
      await db.exec("reset role")
    }
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_runs where id=$1",
          [application]
        )
      ).rows[0].status,
      "needs_attention",
      "Notifications never change application status or approval"
    )
  } finally {
    await db.close()
  }
})
