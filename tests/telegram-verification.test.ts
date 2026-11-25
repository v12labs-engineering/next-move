import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import type { Page } from "playwright-core"
import { TelegramVerificationBridge } from "../lib/server/applications/telegram-verification-bridge"
import { supabaseServerClient } from "../lib/server/supabase-server"
import { assistanceStages } from "../lib/applications/pipeline"
import {
  sealVerificationCode,
  openVerificationCode,
  handleTelegramVerification,
  sendVerificationPhoto,
} from "../lib/server/telegram/verification"
const env = {
  TELEGRAM_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "123456:fixture",
  TELEGRAM_BOT_USERNAME: "fixture_bot",
  TELEGRAM_APP_ORIGIN: "https://app.example.test",
  TELEGRAM_WEBHOOK_SECRET: "verification-fixture-secret-0123456789",
  NEXT_PUBLIC_SUPABASE_URL: "https://verification.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "fixture",
}
const challenge = "20000000-0000-4000-8000-000000000001"

for (const mode of ["code", "challenge", "unsupported"]) {
  test(`automatic Telegram bridge accepts only OTP input: ${mode}`, async (t) => {
    const previous = { ...process.env }
    Object.assign(process.env, env)
    t.after(() => {
      process.env = previous
    })
    const sent: { text: string; reply_markup?: unknown }[] = []
    let published = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        if (url.hostname === "api.telegram.org") {
          assert.ok(
            url.pathname.endsWith("/sendMessage"),
            "Never send challenge images"
          )
          sent.push(JSON.parse(String(init?.body)))
          return Response.json({ ok: true, result: { message_id: 100 } })
        }
        if (url.pathname.endsWith("/application_runs"))
          return Response.json({
            user_id: "alice",
            title: "Engineer",
            company: "Fixture",
          })
        if (url.pathname.endsWith("/telegram_connections"))
          return Response.json({
            user_id: "alice",
            thread_id: "telegram:42",
          })
        assert.ok(url.pathname.endsWith("/application_tasks"))
        published++
        return Response.json({ application_id: challenge })
      }
    )
    const frame = {
      parentFrame: () => null,
      url: () => "https://employer.example/verify",
      evaluate: async () =>
        mode === "unsupported"
          ? null
          : {
              mode,
              signature: "fixture",
              message: "Verification needed",
              targets: [
                { selector: "#code", kind: "code", label: "Code", tile: false },
              ],
            },
    }
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      url: () => frame.url(),
    } as unknown as Page
    const bridge = await TelegramVerificationBridge.connect(
      supabaseServerClient(),
      page,
      {
        id: challenge,
        revision: 2,
        sessionId: challenge,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        at: assistanceStages[2],
        codeOnly: true,
      }
    )
    assert.ok(bridge)
    if (mode === "code") {
      await bridge.start()
      assert.equal(sent.length, 1)
      assert.match(sent[0].text, /verification code/)
      assert.doesNotMatch(
        JSON.stringify(sent),
        /live employer browser|hv:.*click/
      )
      assert.equal(published, 2)
    } else {
      await assert.rejects(bridge.start(), /CAPTCHA|verification could not/)
      assert.equal(sent.length, 0)
      assert.equal(published, 0)
    }
  })
}
test("verification codes are encrypted, authenticated and never confused with passwords", (t) => {
  const previous = { ...process.env }
  Object.assign(process.env, env)
  t.after(() => {
    process.env = previous
  })
  const cipher = sealVerificationCode("012345")
  assert.equal(openVerificationCode(cipher), "012345")
  assert.notEqual(cipher, sealVerificationCode("012345"))
  assert.doesNotMatch(cipher, /012345/)
  const tampered = Buffer.from(cipher, "base64url")
  tampered[28] ^= 1
  assert.throws(() => openVerificationCode(tampered.toString("base64url")))
  assert.throws(() => sealVerificationCode("long password with spaces"))
  assert.throws(() => sealVerificationCode("https://bad.example"))
})
for (const scenario of ["code", "click", "stale", "wrong-reply"])
  test(`verification relay handles ${scenario} without restarting an application`, async (t) => {
    const previous = { ...process.env }
    Object.assign(process.env, env)
    t.after(() => {
      process.env = previous
    })
    let queued = 0
    const sent: string[] = []
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        const op = url.pathname.split("/").at(-1)
        if (url.hostname === "api.telegram.org") {
          sent.push(JSON.parse(String(init?.body)).text)
          return Response.json({ ok: true, result: { message_id: 100 } })
        }
        if (op === "telegram_connections")
          return Response.json({ user_id: "alice" })
        if (op === "application_tasks") {
          assert.equal(url.searchParams.get("application.user_id"), "eq.alice")
          if (scenario === "stale" || scenario === "wrong-reply")
            return Response.json(null)
          return Response.json({
            output: {
              telegramChallenge: {
                id: challenge,
                mode: scenario === "code" ? "code" : "challenge",
                replyMessageId: "42",
              },
            },
          })
        }
        assert.equal(op, "queue_telegram_verification")
        queued++
        const body = JSON.parse(String(init?.body))
        assert.equal(body.p_thread, "telegram:42")
        assert.equal(body.p_challenge, challenge)
        if (scenario === "code") {
          assert.equal(openVerificationCode(body.p_value), "012345")
          assert.equal(body.p_reply, "42")
          assert.doesNotMatch(String(init?.body), /012345/)
        } else {
          assert.equal(body.p_target, 2)
          assert.equal(body.p_action, "click")
        }
        return Response.json(true)
      }
    )
    const handled = await handleTelegramVerification({
      thread: "telegram:42",
      text: "012345",
      messageId: "update:1",
      ...(scenario === "code" || scenario === "wrong-reply"
        ? { replyTo: 42 }
        : { action: `hv:${challenge}:click:2` }),
    })
    assert.equal(queued, scenario === "code" || scenario === "click" ? 1 : 0)
    assert.equal(handled, scenario !== "wrong-reply")
    assert.ok(sent.every((text) => !text.includes("012345")))
  })
test("simultaneous OTP replies stay bound to their own application prompts", async (t) => {
  const previous = { ...process.env }
  Object.assign(process.env, env)
  t.after(() => {
    process.env = previous
  })
  const challenges = [challenge, "20000000-0000-4000-8000-000000000002"]
  const queued: string[] = []
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const op = url.pathname.split("/").at(-1)
      if (url.hostname === "api.telegram.org")
        return Response.json({ ok: true, result: { message_id: 100 } })
      if (op === "telegram_connections")
        return Response.json({ user_id: "alice" })
      if (op === "application_tasks") {
        assert.equal(url.searchParams.get("application.user_id"), "eq.alice")
        const reply = Number(
          url.searchParams
            .get("output->telegramChallenge->>replyMessageId")
            ?.slice(3)
        )
        assert.ok(reply === 41 || reply === 42)
        return Response.json({
          output: {
            telegramChallenge: {
              id: challenges[reply - 41],
              mode: "code",
              replyMessageId: String(reply),
            },
          },
        })
      }
      assert.equal(op, "queue_telegram_verification")
      const body = JSON.parse(String(init?.body))
      assert.equal(body.p_challenge, challenges[Number(body.p_reply) - 41])
      queued.push(body.p_challenge)
      return Response.json(true)
    }
  )
  for (const replyTo of [42, 41]) {
    assert.equal(
      await handleTelegramVerification({
        thread: "telegram:42",
        replyTo,
        messageId: `update:${replyTo}`,
        text: "012345",
      }),
      true
    )
  }
  assert.deepEqual(queued, [...challenges].reverse())
})

test("verification screenshot is protected multipart content, with sanitized provider errors", async (t) => {
  const previous = { ...process.env }
  Object.assign(process.env, env)
  t.after(() => {
    process.env = previous
  })
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.match(String(input), /sendPhoto$/)
      const form = init!.body as FormData
      assert.equal(form.get("chat_id"), "42")
      assert.equal(form.get("protect_content"), "true")
      assert.ok(form.get("photo") instanceof Blob)
      return Response.json({ ok: true, result: { message_id: 42 } })
    }
  )
  assert.equal(
    await sendVerificationPhoto(
      "telegram:42",
      Buffer.from("generated screenshot"),
      "Generated fixture",
      []
    ),
    "42"
  )
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { ok: false, description: env.TELEGRAM_BOT_TOKEN },
      { status: 503 }
    )
  )
  await assert.rejects(
    sendVerificationPhoto("telegram:42", Buffer.from("fixture"), "Fixture", []),
    (error) => {
      assert.doesNotMatch(String(error), /123456|fixture-secret|token/)
      return true
    }
  )
})
test("verification SQL rejects forwarded, duplicate, stale and expired responses", async () => {
  const db = new PGlite()
  const user = "00000000-0000-4000-8000-000000000001",
    other = "00000000-0000-4000-8000-000000000002",
    app = "10000000-0000-4000-8000-000000000001"
  try {
    await db.exec(
      `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;insert into auth.users values('${user}'),('${other}');create table public.account_profiles(user_id uuid primary key);insert into public.account_profiles values('${user}'),('${other}');create table public.application_runs(id uuid primary key,user_id uuid,status text,revision integer,approved_revision integer);insert into public.application_runs values('${app}','${user}','submitting',2,2);create table public.application_tasks(application_id uuid,revision integer,stage text,state text,error_code text,output jsonb,primary key(application_id,revision,stage));create table public.telegram_connections(user_id uuid primary key,thread_id text unique);insert into telegram_connections values('${user}','telegram:42'),('${other}','telegram:43');create table public.telegram_inbound(message_id text primary key,received_at timestamptz default now());grant all on all tables in schema public to service_role;`
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611030047_telegram_verification_bridge.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const output = {
      browserAssistance: {
        sessionId: "30000000-0000-4000-8000-000000000001",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      telegramChallenge: {
        id: challenge,
        mode: "code",
        state: "waiting",
        replyMessageId: "42",
        targetCount: 2,
      },
    }
    await db.query(
      "insert into application_tasks values($1,2,'submit','running','telegram_verification_required',$2)",
      [app, JSON.stringify(output)]
    )
    await db.exec("set role service_role")
    const queue = async (
      thread = "telegram:42",
      id = challenge,
      update = "update:1",
      reply = "42"
    ) =>
      (
        await db.query<{ v: boolean }>(
          "select queue_telegram_verification($1,$2,'code',null,$3,$4,$5) v",
          [thread, id, "a".repeat(48), reply, update]
        )
      ).rows[0].v
    assert.equal(await queue("telegram:43"), false)
    assert.equal(await queue("telegram:42", other), false)
    assert.equal(
      await queue("telegram:42", challenge, "update:bad", "41"),
      false
    )
    assert.equal(await queue(), true)
    assert.equal(await queue(), false)
    const row = (
      await db.query<{
        output: {
          telegramChallenge: { state: string; command: { value: string } }
        }
      }>("select output from application_tasks")
    ).rows[0]
    assert.equal(row.output.telegramChallenge.state, "queued")
    assert.equal(row.output.telegramChallenge.command.value, "a".repeat(48))
    await db.exec("reset role")
    output.browserAssistance.expiresAt = new Date(
      Date.now() - 10000
    ).toISOString()
    await db.query("update application_tasks set output=$1", [
      JSON.stringify(output),
    ])
    await db.exec("set role service_role")
    assert.equal(await queue("telegram:42", challenge, "update:expired"), false)
    await db.exec("reset role")
    output.browserAssistance.expiresAt = new Date(
      Date.now() + 60000
    ).toISOString()
    output.telegramChallenge.mode = "challenge"
    await db.query("update application_tasks set output=$1", [
      JSON.stringify(output),
    ])
    await db.exec("set role service_role")
    const click = async (target: number) =>
      (
        await db.query<{ v: boolean }>(
          "select queue_telegram_verification('telegram:42',$1,'click',$2,null,null,'click:1') v",
          [challenge, target]
        )
      ).rows[0].v
    assert.equal(await click(3), false)
    assert.equal(await click(-1), false)
    assert.equal(await click(1), true)
    await db.exec("reset role")
    await db.query("update application_tasks set output=$1", [
      JSON.stringify(output),
    ])
    await db.query("update application_runs set status='submission_unknown'")
    await db.exec("set role service_role")
    assert.equal(
      await click(0),
      false,
      "An ended or uncertain run cannot accept a verification command"
    )
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='submitting',approved_revision=1"
    )
    await db.exec("set role service_role")
    assert.equal(
      await click(0),
      false,
      "A changed approval cannot accept a verification command"
    )
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`reset role;set role ${role}`)
      await assert.rejects(
        db.query(
          "select queue_telegram_verification('telegram:42',$1,'click',0,null,null,'forged')",
          [challenge]
        ),
        /permission denied/
      )
    }
  } finally {
    await db.close()
  }
})
