import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  deliverTelegramSubmission,
  sweepTelegramSubmissions,
} from "../lib/server/telegram/submission"
import { notifyApplicationTelegram } from "../lib/server/telegram/delivery"

const application = "10000000-0000-4000-8000-000000000001"
const user = "00000000-0000-4000-8000-000000000001"
const token = "20000000-0000-4000-8000-000000000001"
const receipt = {
  text: "Your application was successfully submitted.",
  confirmedAt: "2026-11-06T13:51:43Z",
}

for (const scenario of [
  "delivered",
  "worker",
  "sweep",
  "transport_failure",
  "stale_claim",
  "disconnected",
  "changed_recipient",
  "changed_revision",
  "unconfirmed",
  "missing_receipt",
  "disabled",
]) {
  test(`Telegram submission confirmation: ${scenario}`, async (t) => {
    const oldEnv = { ...process.env }
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: "https://submission.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
      TELEGRAM_ENABLED: scenario === "disabled" ? "false" : "true",
      TELEGRAM_BOT_TOKEN: "123456:synthetic_token",
      TELEGRAM_BOT_USERNAME: "synthetic_test_bot",
      TELEGRAM_APP_ORIGIN: "https://app.example.test",
      TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret-01234567890123",
    })
    t.after(() => {
      process.env = oldEnv
    })
    let delivered = false
    let failure: Record<string, unknown> | undefined
    const sent: { text: string; chat_id: string; reply_markup: unknown }[] = []
    const operations: string[] = []
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        const op = url.pathname.split("/").at(-1)!
        operations.push(op)
        if (op === "claim_telegram_submission")
          return Response.json(
            delivered
              ? null
              : {
                  application_id: application,
                  revision: 6,
                  attempts: 1,
                  thread_id: "telegram:42",
                  title: "Engineer",
                  company: "Fixture employer",
                }
          )
        if (op === "telegram_submission_notifications") {
          if (init?.method === "PATCH") {
            const body = JSON.parse(String(init.body))
            if (body.delivered_at) {
              assert.equal(body.provider_message_id, "42")
              delivered = true
            } else failure = body
            assert.ok(url.searchParams.get("lease_token")?.startsWith("eq."))
            return new Response(null, { status: 204 })
          }
          if (!url.searchParams.has("application_id"))
            return Response.json(
              delivered ? [] : [{ application_id: application }]
            )
          return Response.json(
            scenario === "stale_claim"
              ? null
              : {
                  revision: 6,
                  application: {
                    status:
                      scenario === "unconfirmed"
                        ? "submission_unknown"
                        : "submitted",
                    revision: scenario === "changed_revision" ? 7 : 6,
                    receipt: scenario === "missing_receipt" ? null : receipt,
                  },
                  connection:
                    scenario === "disconnected"
                      ? null
                      : {
                          thread_id:
                            scenario === "changed_recipient"
                              ? "telegram:43"
                              : "telegram:42",
                        },
                }
          )
        }
        if (op === "sendMessage") {
          sent.push(JSON.parse(String(init?.body)))
          if (scenario === "transport_failure")
            return Response.json({ ok: false }, { status: 503 })
          return Response.json({ ok: true, result: { message_id: 42 } })
        }
        if (["claim_telegram_attention", "application_runs"].includes(op))
          return Response.json(null)
        throw new Error(`Unexpected fixture operation: ${op}`)
      }
    )
    const send = () =>
      scenario === "worker"
        ? notifyApplicationTelegram(application)
        : scenario === "sweep"
          ? sweepTelegramSubmissions()
          : deliverTelegramSubmission(application)
    await send()
    if (["delivered", "worker", "sweep"].includes(scenario)) {
      assert.equal(sent.length, 1)
      assert.equal(sent[0].chat_id, "42")
      assert.match(sent[0].text, /Application submitted successfully/)
      assert.match(sent[0].text, /Fixture employer · Engineer/)
      assert.ok(sent[0].text.includes(receipt.text))
      assert.deepEqual(sent[0].reply_markup, {
        inline_keyboard: [
          [
            {
              text: "View confirmation",
              callback_data: `app:${application}:6:status`,
            },
          ],
        ],
      })
      assert.equal(delivered, true)
      await send()
      assert.equal(
        sent.length,
        1,
        "A delivered notification is not repeated on replay"
      )
    } else if (scenario === "transport_failure") {
      assert.equal(delivered, false)
      assert.equal(failure?.last_error, "delivery_failed")
      assert.equal(failure?.lease_token, null)
      assert.ok(Date.parse(String(failure?.next_attempt_at)) > Date.now())
    } else assert.equal(sent.length, 0)
    assert.ok(
      !operations.includes("confirm_application"),
      "Notifications never repeat the application transition"
    )
    if (scenario === "disabled") assert.equal(operations.length, 0)
  })
}

test("submission outbox is atomic, receipt-only, deduplicated and service-only", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table telegram_connections(user_id uuid primary key,thread_id text not null);
      create table job_catalog(id text primary key,title text,company text);
      create table application_runs(id uuid primary key,user_id uuid,job_id text,status text,revision int default 1,packet jsonb,receipt jsonb);
      grant all on all tables in schema public to service_role;
      insert into telegram_connections values('${user}','telegram:42');
      insert into application_runs(id,user_id,status,receipt) values('${application}','${user}','submitted','${JSON.stringify(receipt)}');
    `)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611060057_telegram_submission_notifications.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const count = async () =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from telegram_submission_notifications"
        )
      ).rows[0].n
    const claim = async () =>
      (
        await db.query<{
          value: { thread_id: string; attempts: number } | null
        }>("select claim_telegram_submission($1,$2) as value", [
          application,
          token,
        ])
      ).rows[0].value
    assert.equal(await count(), 0, "No historical notification flood")
    await db.exec("update application_runs set receipt=receipt")
    assert.equal(await count(), 0)
    for (const status of [
      "running",
      "submitting",
      "submission_unknown",
      "needs_attention",
    ]) {
      await db.query("update application_runs set status=$1", [status])
      assert.equal(await count(), 0)
    }
    await db.exec("update application_runs set status='submitted',receipt=null")
    assert.equal(await count(), 0, "Status alone is not a receipt")
    await db.exec("begin")
    await db.query("update application_runs set receipt=$1", [
      JSON.stringify(receipt),
    ])
    assert.equal(await count(), 1)
    await db.exec("rollback")
    assert.equal(
      await count(),
      0,
      "A failed receipt transaction cannot queue success"
    )
    await db.query("update application_runs set receipt=$1", [
      JSON.stringify(receipt),
    ])
    await db.exec("set role service_role")
    assert.equal((await claim())?.thread_id, "telegram:42")
    assert.equal(
      await claim(),
      null,
      "Concurrent senders are excluded by the lease"
    )
    await db.exec(
      "update telegram_submission_notifications set lease_until=now()-interval '1 second',next_attempt_at=now()+interval '1 minute'"
    )
    assert.equal(await claim(), null, "Backoff survives a worker restart")
    await db.exec(
      "update telegram_submission_notifications set next_attempt_at=now()-interval '1 second'"
    )
    assert.equal((await claim())?.attempts, 2, "Abandoned leases can recover")
    await db.exec(
      "update telegram_submission_notifications set delivered_at=now(),lease_token=null,lease_until=null"
    )
    await db.exec(
      "update application_runs set receipt=receipt,status='submitted'"
    )
    assert.equal(
      await claim(),
      null,
      "Repeated receipt writes never reset delivery"
    )
    await db.exec("reset role")
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`)
      await assert.rejects(
        db.query("select * from telegram_submission_notifications"),
        /permission denied/
      )
      await assert.rejects(claim(), /permission denied/)
      await db.exec("reset role")
    }
    await db.exec("delete from telegram_connections")
    assert.equal(await count(), 0)
    await db.query(
      "insert into telegram_connections values($1,'telegram:43')",
      [user]
    )
    await db.exec("update application_runs set receipt=receipt")
    assert.equal(
      await count(),
      0,
      "Reconnect and replay do not send old receipts to a new chat"
    )
    await db.exec(
      "update application_runs set status='submitting',receipt=null"
    )
    await db.query(
      "update application_runs set status='submitted',receipt=$1",
      [JSON.stringify(receipt)]
    )
    await db.exec("update telegram_submission_notifications set attempts=5")
    assert.equal(await claim(), null, "Retries stop after five attempts")
    await db.exec("update application_runs set status='submission_unknown'")
    assert.equal(
      await count(),
      0,
      "Invalidating confirmation removes pending disclosure"
    )
    await db.exec("delete from telegram_connections")
    await db.exec("update application_runs set receipt=null")
    await db.query(
      "update application_runs set status='submitted',receipt=$1",
      [JSON.stringify(receipt)]
    )
    assert.equal(
      await count(),
      0,
      "Unlinked accounts never queue notifications"
    )
  } finally {
    await db.close()
  }
})
