import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { followupMessage } from "@/lib/applications/followup"
import { sweepTelegramFollowups } from "@/lib/server/telegram/followup"

test("follow-up delivery claims confirmed and manually applied jobs for the current connection", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table job_source_directory (kind text, enabled boolean);
      create table alexandria_search_control (singleton boolean, enabled boolean);
      create table job_catalog (id text primary key, company text, title text, url text);
      create table telegram_connections (user_id uuid primary key, thread_id text);
      create table application_runs (id uuid primary key, user_id uuid, status text, receipt jsonb,
        job_id text, packet jsonb, target_url text);
      create table account_job_states (user_id uuid, job_id text, status text, updated_at timestamptz,
        primary key(user_id, job_id));
      grant select on all tables in schema public to service_role;
      insert into job_catalog values
        ('confirmed', 'Example Robotics', 'Engineer', 'https://example.test/jobs/1'),
        ('manual', 'Example Robotics', 'Designer', 'https://example.test/jobs/2');
    `)
    for (const migration of [
      "202611110068_application_followup.sql",
      "202611110069_manual_application_followup.sql",
      "202611110070_telegram_application_followup.sql",
    ]) {
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${migration}`, import.meta.url),
          "utf8"
        )
      )
    }
    const user = randomUUID()
    const application = randomUUID()
    await db.query(
      "insert into telegram_connections values ($1, 'telegram:42')",
      [user]
    )
    await db.query(
      `insert into application_runs values ($1, $2, 'submitting', null, 'confirmed',
        '{"company":"Example Robotics","title":"Engineer"}', 'https://example.test/jobs/1')`,
      [application, user]
    )
    const queued = async () =>
      (
        await db.query<{ id: string; job_id: string }>(
          "select id, job_id from telegram_followup_notifications order by job_id"
        )
      ).rows
    assert.deepEqual(await queued(), [])
    await db.query(
      "update application_runs set status='submitted', receipt='{}' where id=$1",
      [application]
    )
    assert.deepEqual(await queued(), [])
    await db.query(
      `update application_runs set status='submitted',
        receipt='{"text":"Application received","confirmedAt":"2026-11-11T00:00:00Z"}' where id=$1`,
      [application]
    )
    assert.deepEqual(
      (await queued()).map((row) => row.job_id),
      ["confirmed"]
    )

    await db.query(
      "insert into account_job_states values ($1, 'manual', 'applied', now()), ($1, 'confirmed', 'applied', now())",
      [user]
    )
    const queueManual = (jobId: string) =>
      db.query("select queue_telegram_followup($1, $2, null)", [user, jobId])
    await db.exec("set role authenticated")
    await assert.rejects(queueManual("manual"), /permission denied/)
    await db.exec("set role service_role")
    await queueManual("confirmed")
    await queueManual("manual")
    await queueManual("manual")
    const rows = await queued()
    assert.deepEqual(
      rows.map((row) => row.job_id),
      ["confirmed", "manual"]
    )
    const claim = async (id: string, token: string) =>
      (
        await db.query<{ claimed: boolean }>(
          "select claim_telegram_followup($1, $2) as claimed",
          [id, token]
        )
      ).rows[0].claimed
    const target = async (id: string, token: string) =>
      (
        await db.query<{
          value: { thread: string; applicationId: string | null } | null
        }>("select telegram_followup_target($1, $2) as value", [id, token])
      ).rows[0].value
    const token = randomUUID()
    for (const { id, job_id } of rows) {
      assert.equal(await claim(id, token), true)
      assert.equal(await claim(id, randomUUID()), false)
      const destination = await target(id, token)
      assert.equal(destination?.thread, "telegram:42")
      assert.equal(
        destination?.applicationId,
        job_id === "confirmed" ? application : null
      )
    }
    await db.exec("reset role")
    await db.query(
      "update account_job_states set status='dismissed' where user_id=$1 and job_id='manual'",
      [user]
    )
    assert.equal(await target(rows[1].id, token), null)
    await db.query("delete from telegram_connections where user_id=$1", [user])
    assert.equal(await target(rows[0].id, token), null)
    assert.deepEqual(await queued(), [])
  } finally {
    await db.close()
  }
})

test("Telegram follow-up uses the cached drafts and retries delivery without another provider lookup", async (t) => {
  const oldEnv = { ...process.env }
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://followup.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
    FIRECRAWL_API_KEY: "fixture-only",
    TELEGRAM_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:synthetic_token",
    TELEGRAM_BOT_USERNAME: "synthetic_test_bot",
    TELEGRAM_APP_ORIGIN: "https://app.example.test",
    TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret-01234567890123",
  })
  t.after(() => {
    process.env = oldEnv
  })
  const id = randomUUID()
  const userId = randomUUID()
  const applicationId = randomUUID()
  const contact = {
    name: "Alex Example",
    title: "Technical Recruiter",
    reason: "Recruiting",
    profileUrl: "https://www.linkedin.com/in/alex-example",
  } as const
  let complete = false
  let deferred = false
  let sends = 0
  let lease: string
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const payload =
        typeof init?.body === "string" ? JSON.parse(init.body) : {}
      switch (url.pathname.split("/").at(-1)) {
        case "claim_telegram_followup":
          lease = payload.p_token
          return Response.json(true)
        case "telegram_followup_target":
          assert.equal(payload.p_token, lease)
          return Response.json({
            userId,
            applicationId,
            jobId: "job",
            thread: "telegram:42",
            attempts: sends + 1,
            employer: {
              company: "Example Robotics",
              title: "Engineer",
              targetUrl: "https://example.test/jobs/1",
            },
          })
        case "reserve_application_followup":
          assert.equal(payload.p_user_id, userId)
          assert.equal(payload.p_id, applicationId)
          return Response.json({ status: "cached", contacts: [contact] })
        case "telegram_followup_notifications":
          if (init?.method !== "PATCH")
            return Response.json(complete ? [] : [{ id }])
          assert.equal(url.searchParams.get("lease_token"), `eq.${lease}`)
          assert.equal(payload.lease_token, null)
          if (payload.completed_at) complete = true
          else deferred = Date.parse(payload.next_attempt_at) > Date.now()
          return new Response(null, { status: 204 })
        case "sendMessage":
          assert.equal(payload.chat_id, "42")
          assert.ok(
            payload.text.includes(
              followupMessage(contact, "Engineer", "Example Robotics")
            )
          )
          assert.equal(
            payload.reply_markup.inline_keyboard[0][0].url,
            contact.profileUrl
          )
          assert.equal(payload.protect_content, true)
          sends++
          return sends === 1
            ? Response.json({ ok: false }, { status: 503 })
            : Response.json({ ok: true, result: { message_id: 42 } })
        default:
          assert.fail(`Unexpected fixture endpoint: ${url.pathname}`)
      }
    }
  )
  assert.equal(await sweepTelegramFollowups(), 0)
  assert.equal(deferred, true)
  assert.equal(complete, false)
  assert.equal(await sweepTelegramFollowups(), 1)
  assert.equal(await sweepTelegramFollowups(), 0)
  assert.equal(sends, 2)
})
