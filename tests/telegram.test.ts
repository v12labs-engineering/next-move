import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { type ApplicationPacket } from "../lib/applications"
import {
  actionId,
  currentQuestion,
  editCode,
  parseAction,
  parseAnswer,
  questionMessage,
  transition,
  type TelegramRequest,
} from "../lib/telegram"

const alice = "00000000-0000-4000-8000-000000000001"
const bob = "00000000-0000-4000-8000-000000000002"
const application = "10000000-0000-4000-8000-000000000001"
const thread = "telegram:15551234567"
const packet: ApplicationPacket = {
  title: "Engineer",
  company: "Synthetic employer",
  resume: "A fictional candidate resume with TypeScript experience.",
  notices: "Employer notice",
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
    {
      id: "notice",
      label: "Notice period",
      help: "Days",
      kind: "number",
      required: true,
      options: [],
    },
    {
      id: "visa",
      label: "Require sponsorship?",
      help: "",
      kind: "radio",
      required: true,
      options: ["Yes", "No"],
    },
    {
      id: "resume",
      label: "Resume",
      help: "",
      kind: "resume",
      required: true,
      options: [],
    },
  ],
  answers: { email: "candidate@example.test" },
}
function request(): TelegramRequest {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    user_id: alice,
    application_id: application,
    revision: 1,
    version: 2,
    packet,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    state: {
      initialized: true,
      editing: false,
      answers: { ...packet.answers },
      confirmed: [],
      proposals: { notice: { answer: "30", source: "Your saved answer" } },
    },
  }
}
test("Telegram proposals need confirmation, edits bind to one turn, and final approval needs all answers", () => {
  let q = request()
  assert.equal(currentQuestion(q)?.id, "notice")
  assert.match(
    questionMessage(q, "https://app.example.test").text,
    /Suggested answer: "30"/
  )
  assert.throws(() => transition(q, "send"), /confirm every/)
  const action = parseAction(actionId(q, "edit"))!
  assert.equal(action.version, 2)
  assert.equal(parseAction("tg:bad:1:send"), null)
  q = { ...q, state: transition(q, "edit").state, version: 3 }
  assert.throws(() => transition(q, "confirm", "60"), /Reply with/)
  assert.throws(() => transition(q, "confirm", "20000000-2:60"), /Reply with/)
  q = {
    ...q,
    state: transition(q, "confirm", `${editCode(q)}:60`).state,
    version: 4,
  }
  assert.equal(q.state.answers.notice, "60")
  assert.equal(
    currentQuestion(q)?.id,
    "notice",
    "Edited text is a draft until separately confirmed"
  )
  q = { ...q, state: transition(q, "confirm").state, version: 5 }
  assert.equal(currentQuestion(q)?.id, "visa")
  assert.throws(() => transition(q, "use"), /enter your answer/)
  q = { ...q, state: transition(q, "edit").state, version: 6 }
  q = {
    ...q,
    state: transition(q, "confirm", `${editCode(q)}:no`).state,
    version: 7,
  }
  q = { ...q, state: transition(q, "confirm").state, version: 8 }
  assert.equal(currentQuestion(q), undefined)
  assert.match(
    questionMessage(q, "https://app.example.test").text,
    /Approve & send authorizes/
  )
  assert.equal(transition(q, "send").finish, true)
  assert.equal(transition(request(), "use").state.answers.notice, "30")
  assert.equal(
    request().state.answers.notice,
    undefined,
    "Reducers never mutate the stored snapshot"
  )
  assert.equal(parseAnswer(packet.fields[1], "not a number"), null)
  assert.equal(parseAnswer(packet.fields[2], "maybe"), null)
  assert.deepEqual(
    parseAnswer({ ...packet.fields[2], kind: "checkbox" }, '["Yes"]'),
    ["Yes"]
  )
  assert.equal(
    parseAnswer({ ...packet.fields[2], kind: "checkbox" }, "Yes,No"),
    null
  )
})

test("Telegram migration enforces linking, RLS, exact revisions, replay protection and atomic review/dispatch", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      insert into auth.users values('${alice}'),('${bob}');
      create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
      create table public.account_profiles(user_id uuid primary key);insert into public.account_profiles values('${alice}'),('${bob}');
      create table public.account_ai_usage(user_id uuid,day date,attempts integer,primary key(user_id,day));
      create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
      create function public.reserve_tailoring_attempt() returns boolean language sql as $$select true$$;
      create table public.draft_quota(calls integer);insert into public.draft_quota values(0);grant select on public.draft_quota to service_role;
      create function public.reserve_ai_attempt(uuid) returns boolean language plpgsql security definer as $$begin update public.draft_quota set calls=calls+1;return (select calls<=1 from public.draft_quota);end$$;
      insert into public.job_catalog values('fixture','Engineer','Synthetic employer','Germany','https://employer.example.test',true,now());`)
    for (const name of [
      "202610290004_application_runner.sql",
      "202610290005_application_claim.sql",
      "202610300001_automatic_applications.sql",
      "202610300002_site_independent_applications.sql",
      "202610310003_application_question_memory.sql",
      "202610310004_application_question_preferences.sql",
      "202611020038_telegram_approvals.sql",
      "202611020041_telegram_ai_drafts.sql",
      "202611040048_application_answer_reuse_defaults.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}`, import.meta.url),
          "utf8"
        )
      )
    await db.query(
      "insert into application_runs(id,user_id,job_id,target_url,status,packet,employer_key,automatic) values($1,$2,'fixture','https://employer.example.test','ready',$3::jsonb,'fixture',true)",
      [application, alice, JSON.stringify(packet)]
    )
    const user = async (id: string) => {
      await db.exec("reset role")
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ])
      await db.exec("set role authenticated")
    }
    const service = () => db.exec("reset role;set role service_role")
    const scalar = async <T>(sql: string, args: unknown[] = []) =>
      (await db.query<{ v: T }>(`select (${sql}) v`, args)).rows[0].v
    await user(alice)
    await db.query("select begin_telegram_link($1)", ["a".repeat(64)])
    await assert.rejects(
      db.query("select begin_telegram_link($1)", ["b".repeat(64)]),
      /Wait a minute/
    )
    assert.equal(await scalar("select confirm_telegram_link()"), false)
    await assert.rejects(
      db.query("select claim_telegram_link($1,$2,'test')", [
        "a".repeat(64),
        thread,
      ]),
      /permission denied/
    )
    await service()
    assert.equal(
      await scalar("select claim_telegram_link($1,$2,'…234567')", [
        "a".repeat(64),
        thread,
      ]),
      true
    )
    assert.equal(
      await scalar("select claim_telegram_link($1,$2,'other')", [
        "a".repeat(64),
        "telegram:9999999999",
      ]),
      false
    )
    await user(bob)
    assert.equal(await scalar("select confirm_telegram_link()"), false)
    assert.equal(await scalar("select telegram_link_status()"), null)
    await user(alice)
    assert.equal(await scalar("select confirm_telegram_link()"), true)
    assert.equal(
      (await db.query("select * from telegram_connections")).rows.length,
      1
    )
    await assert.rejects(
      db.exec("select * from telegram_requests"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select reserve_telegram_ai_draft($1,1,$2)", [
        application,
        application,
      ]),
      /permission denied/
    )
    await assert.rejects(
      db.query(
        "select transition_telegram_request($1,$2,1,'{}'::jsonb,null,false,false)",
        [thread, application]
      ),
      /permission denied/
    )
    await user(bob)
    assert.equal(
      (await db.query("select * from telegram_connections")).rows.length,
      0
    )
    await service()
    let row = (
      await db.query<TelegramRequest>("select * from telegram_requests")
    ).rows[0]
    assert.equal(
      row.revision,
      1,
      "Connecting enqueues already waiting applications"
    )
    const token = "30000000-0000-4000-8000-000000000001"
    assert.ok(
      await scalar("select claim_telegram_delivery($1,$2)", [alice, token])
    )
    assert.equal(
      await scalar("select claim_telegram_delivery($1,$2)", [alice, token]),
      null,
      "Active delivery lease excludes another sender"
    )
    const reserve = (version: number, lease: string | null) =>
      scalar<string>("select reserve_telegram_ai_draft($1,$2,$3)", [
        row.id,
        version,
        lease,
      ])
    assert.equal(await reserve(99, token), "stale")
    assert.equal(await reserve(1, bob), "stale")
    assert.equal(await reserve(1, null), "stale")
    assert.equal(await scalar("select calls from draft_quota"), 0)
    assert.equal(await reserve(1, token), "reserved")
    assert.equal(
      await reserve(1, token),
      "stale",
      "Duplicate delivery cannot consume a second AI attempt"
    )
    assert.equal(await scalar("select calls from draft_quota"), 1)
    assert.deepEqual(
      await scalar(
        "select packet->'answers' from application_runs where id=$1",
        [application]
      ),
      packet.answers,
      "Reserving a draft does not fill the application"
    )
    const change = async (
      sender: string,
      version: number,
      state: unknown,
      message: string | null,
      finish = false
    ) =>
      scalar<{ revision: number } | null>(
        "select transition_telegram_request($1,$2,$3,$4::jsonb,$5,$6,false)",
        [sender, row.id, version, JSON.stringify(state), message, finish]
      )
    const state = {
      ...request().state,
      answers: { ...packet.answers, notice: "60", visa: "No" },
      confirmed: ["notice", "visa"],
    }
    assert.equal(await change("telegram:9999999999", 1, state, "forged"), null)
    assert.equal(await change(thread, 99, state, "stale"), null)
    await assert.rejects(
      change(
        thread,
        1,
        { ...state, answers: packet.answers },
        "incomplete",
        true
      ),
      /Complete required/
    )
    assert.ok(await change(thread, 1, state, "draft"))
    assert.equal(await change(thread, 1, state, "duplicate"), null)
    assert.equal(
      await change(thread, 2, state, "draft"),
      null,
      "Even a new turn cannot reuse an inbound message"
    )
    const direct = transition(
      {
        ...request(),
        automatic: true,
        state: {
          ...state,
          confirmed: ["notice"],
        },
      },
      "choose:1"
    )
    assert.equal(direct.finish, true)
    const finished = await change(
      thread,
      2,
      direct.state,
      "approve",
      direct.finish
    )
    assert.equal(finished?.revision, 2)
    assert.equal(await change(thread, 2, state, "approve", true), null)
    const run = (
      await db.query<{
        status: string
        revision: number
        approved_packet: ApplicationPacket
      }>(
        "select status,revision,approved_packet from application_runs where id=$1",
        [application]
      )
    ).rows[0]
    assert.equal(run.status, "queued")
    assert.equal(run.revision, 2)
    assert.equal(run.approved_packet.answers.notice, "60")
    assert.equal(
      await scalar(
        "select dispatch_revision from telegram_requests where id=$1",
        [row.id]
      ),
      2,
      "Dispatch intent commits with approval"
    )
    assert.equal(
      await scalar(
        "select count(*)::int from account_application_questions where reuse_scope<>'never'"
      ),
      2,
      "Telegram-confirmed answers use the default reuse scope"
    )
    const claimed = await db.query("select * from claim_application($1,2)", [
      application,
    ])
    assert.equal(claimed.rows.length, 1)
    assert.equal(
      (await db.query("select * from claim_application($1,2)", [application]))
        .rows.length,
      0,
      "Duplicate dispatches cannot claim the send twice"
    )
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [application]
    )
    const receipt = JSON.stringify({
      text: "Synthetic employer receipt",
      url: "https://employer.example.test/receipt",
      confirmedAt: new Date().toISOString(),
    })
    assert.equal(
      await scalar("select confirm_application($1,2,$2::jsonb)", [
        application,
        receipt,
      ]),
      true
    )
    assert.equal(
      await scalar("select confirm_application($1,2,$2::jsonb)", [
        application,
        receipt,
      ]),
      false
    )
    await db.exec("reset role")
    assert.equal(
      await scalar(
        "select count(*)::int from account_job_states where status='applied'"
      ),
      1
    )
    // A same-revision packet replacement invalidates the prior buttons too.
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='ready',revision=3,approved_packet=null,approved_revision=null,packet=$1::jsonb where id=$2",
      [JSON.stringify(packet), application]
    )
    row = (
      await db.query<TelegramRequest>(
        "select * from telegram_requests where revision=3"
      )
    ).rows[0]
    assert.ok(
      await scalar("select claim_telegram_delivery($1,$2)", [alice, token])
    )
    assert.equal(await reserve(row.version, token), "allowance")
    assert.equal(
      await reserve(row.version, token),
      "stale",
      "An exhausted allowance is not retried on every notification"
    )
    await db.query("update application_runs set packet=$1::jsonb where id=$2", [
      JSON.stringify({ ...packet, notices: "Changed notice" }),
      application,
    ])
    await service()
    assert.equal(await change(thread, 1, state, "old-snapshot", true), null)
    assert.ok(
      ((await scalar("select version from telegram_requests where id=$1", [
        row.id,
      ])) as number) > 1
    )
    await user(alice)
    await db.exec("select disconnect_telegram()")
    await service()
    assert.equal(
      await scalar(
        "select count(*)::int from telegram_requests where status='pending'"
      ),
      0
    )
    assert.equal(
      await scalar(
        "select count(*)::int from telegram_requests where status='completed' and dispatched_at is null"
      ),
      1,
      "Disconnecting notifications preserves committed submission dispatch"
    )
    assert.equal(await change(thread, 2, state, "disconnected", true), null)
    await db.exec("reset role;set role anon")
    await assert.rejects(
      db.exec("select * from telegram_connections"),
      /permission denied/
    )
    await assert.rejects(
      db.exec("select confirm_telegram_link()"),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})

test("automatic applications continue after the last direct answer without Approve & send", () => {
  const q = { ...request(), automatic: true }
  q.state.confirmed = ["notice"]
  q.state.answers.notice = "30"
  const chosen = transition(q, "choose:1")
  assert.equal(chosen.state.answers.visa, "No")
  assert.equal(chosen.finish, true)
  assert.equal(transition({ ...q, automatic: false }, "choose:1").finish, false)

  q.state.confirmed = ["visa"]
  q.state.answers.visa = "No"
  q.state.editing = false
  const reply = transition(q, "confirm", `${editCode(q)}:45`)
  assert.equal(reply.state.answers.notice, "45")
  assert.equal(reply.finish, true)
  assert.equal(transition(q, "pause").finish, false)
})
