import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { applicationStatusGroups } from "../lib/applications/activity"
import { applicationQueueRetryAt } from "../lib/server/applications/queue"
import { queuePreparedAutomaticApplication } from "../lib/server/applications/worker"
import { ownedApplication } from "../lib/server/applications/store"
import { supabaseServerClient } from "../lib/server/supabase-server"

const alice = "00000000-0000-4000-8000-000000000001"
const bob = "00000000-0000-4000-8000-000000000002"
const token = "00000000-0000-4000-8000-000000000003"
const packet = {
  title: "Engineer",
  company: "Example",
  resume:
    "Verified experience building TypeScript applications and SQL databases.",
  fields: [],
  answers: {},
  notices: "",
  formHash: "fixture",
  tailored: true,
}

async function database() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    insert into auth.users values('${alice}'),('${bob}');
    create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
    create table public.account_profiles(user_id uuid primary key,data jsonb default '{}');
    create table public.account_ai_usage(user_id uuid,day date,attempts integer not null check(attempts between 1 and 10),primary key(user_id,day));
    create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
    create function public.reserve_tailoring_attempt() returns boolean language sql as $$select true$$;
    insert into public.account_profiles(user_id) values('${alice}'),('${bob}');
    insert into public.job_catalog(id,title,company,url) select 'job-'||i,'Engineer','Example','https://careers.example.com/jobs/'||i from generate_series(1,6) i;
  `)
  for (const migration of [
    "202610290004_application_runner",
    "202610290005_application_claim",
    "202610300001_automatic_applications",
    "202610300002_site_independent_applications",
    "202610300018_monthly_plan_limits",
    "202610310001_application_computer_budget",
    "202610310002_monthly_usage_counter",
    "202610310003_application_question_memory",
    "202611010031_application_profile_daily_limit",
    "202611010034_application_tasks",
    "202611030044_recover_stale_applications",
    "202611030045_application_queue",
    "202611040049_application_employer_acknowledgement",
    "202611050051_application_failure_retries",
    "202611060056_continuous_automatic_applications",
    "202611190097_remove_application_daily_limit",
  ])
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${migration}.sql`, import.meta.url),
        "utf8"
      )
    )
  return db
}

test("an explicit employer acknowledgement only permits the owned distinct job and reviewed revision", async () => {
  const db = await database()
  try {
    const ids: string[] = []
    for (const job of ["job-1", "job-2"]) {
      const requested = await db.query<{ id: string }>(
        "select request_automatic_application_for($1,$2) id",
        [alice, job]
      )
      ids.push(requested.rows[0].id)
    }
    const [older, current] = ids
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [older]
    )
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb,started_at=now() where id=$1",
      [current, JSON.stringify(packet)]
    )
    await db.query("select queue_automatic_application($1,1)", [current])
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [current])).rows
        .length,
      0
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [bob])
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select acknowledge_employer_conflict($1,1,$2)", [
        current,
        older,
      ]),
      /not allowed/
    )
    await assert.rejects(
      db.query(
        "insert into application_employer_acknowledgements(application_id,revision,conflicting_application_id,user_id) values($1,1,$2,$3)",
        [current, older, bob]
      ),
      /permission denied/
    )
    await db.exec("reset role")
    await assert.rejects(
      db.query("update application_runs set job_id='job-1' where id=$1", [
        current,
      ]),
      /duplicate key/,
      "the same job remains protected by database uniqueness"
    )
    await db.query("update application_runs set job_id=null where id=$1", [
      current,
    ])
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select acknowledge_employer_conflict($1,1,$2)", [
        current,
        older,
      ]),
      /not allowed/
    )
    await db.exec("reset role")
    await db.query("update application_runs set job_id='job-2' where id=$1", [
      current,
    ])
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [older]
    )
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select acknowledge_employer_conflict($1,1,$2)", [
        current,
        older,
      ]),
      /not allowed/
    )
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [older]
    )
    await db.exec("set role authenticated")
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select acknowledge_employer_conflict($1,1,$2) ok",
          [current, older]
        )
      ).rows[0].ok,
      true
    )
    await db.exec("reset role")
    await db.query("select queue_automatic_application($1,1)", [current])
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [current])).rows
        .length,
      1
    )
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_runs where id=$1",
          [older]
        )
      ).rows[0].status,
      "submission_unknown"
    )
    await db.query("update application_runs set status='ready' where id=$1", [
      current,
    ])
    await db.query(
      "update application_employer_acknowledgements set acknowledged_at=now()-interval '31 minutes' where application_id=$1",
      [current]
    )
    await db.query("select queue_automatic_application($1,1)", [current])
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [current])).rows
        .length,
      0,
      "expired acknowledgements cannot authorize a send"
    )
    await db.query(
      "update application_employer_acknowledgements set acknowledged_at=now() where application_id=$1",
      [current]
    )
    await db.query(
      "update application_runs set status='ready',revision=2 where id=$1",
      [current]
    )
    await db.query("select queue_automatic_application($1,2)", [current])
    assert.equal(
      (await db.query("select * from claim_application($1,2)", [current])).rows
        .length,
      0,
      "an edited revision must be acknowledged again"
    )
    await db.query(
      "update application_runs set employer_key='n8n' where id=any($1::uuid[])",
      [ids]
    )
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select acknowledge_employer_conflict($1,2,$2)", [
        current,
        older,
      ]),
      /not allowed/
    )
  } finally {
    await db.close()
  }
})

test("legacy single-slot queue processes FIFO across preparation and sending, independently per account", async () => {
  const db = await database()
  try {
    const request = async (job: string, user = alice) =>
      (
        await db.query<{ id: string }>(
          "select request_automatic_application_for($1,$2) id",
          [user, job]
        )
      ).rows[0].id
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () => request("job-1"))
    )
    assert.equal(new Set(duplicates).size, 1)
    const first = duplicates[0],
      second = await request("job-2"),
      other = await request("job-1", bob)
    const prepare = (id: string) =>
      db.query("select * from claim_application_preparation($1,$2)", [
        id,
        token,
      ])
    const claims = await Promise.all([
      prepare(second),
      prepare(first),
      prepare(first),
      prepare(other),
    ])
    assert.deepEqual(
      claims.map((r) => r.rows.length),
      [0, 1, 0, 1]
    )
    assert.equal((await prepare(second)).rows.length, 0)
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb where id=$1",
      [first, JSON.stringify(packet)]
    )
    assert.equal(
      (await prepare(second)).rows.length,
      0,
      "the automatic handoff keeps the first job's place"
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_automatic_application($1,1) ok",
          [first]
        )
      ).rows[0].ok,
      true
    )
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [first])).rows
        .length,
      1
    )
    assert.equal((await prepare(second)).rows.length, 0)
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [first]
    )
    assert.equal((await prepare(second)).rows.length, 0)
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [first]
    )
    assert.equal((await prepare(second)).rows.length, 1)
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb where id=$1",
      [second, JSON.stringify(packet)]
    )
    await db.query("select queue_automatic_application($1,1)", [second])
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [second])).rows
        .length,
      0,
      "an uncertain send still blocks the same employer"
    )
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_runs where id=$1",
          [second]
        )
      ).rows[0].status,
      "needs_attention"
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    assert.equal(
      (await db.query("select id from application_runs")).rows.length,
      2,
      "other accounts' queue entries remain private"
    )
    await assert.rejects(prepare(second), /permission denied/)
    await assert.rejects(
      db.query("select application_queue_turn($1)", [second]),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})

test("two-slot queue preserves handoffs, cooldowns, account isolation and employer guards", async () => {
  const db = await database()
  try {
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611060058_application_concurrency.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const request = async (job: string, user = alice) =>
      (
        await db.query<{ id: string }>(
          "select request_automatic_application_for($1,$2) id",
          [user, job]
        )
      ).rows[0].id
    const ids: string[] = []
    for (const job of ["job-1", "job-2", "job-3", "job-4"])
      ids.push(await request(job))
    const [first, second, third, fourth] = ids
    assert.equal(
      await request("job-1"),
      first,
      "Capacity never duplicates a saved job"
    )
    const other = await request("job-1", bob)
    const prepare = async (id: string) =>
      (
        await db.query("select * from claim_application_preparation($1,$2)", [
          id,
          token,
        ])
      ).rows.length
    assert.equal(
      await prepare(third),
      0,
      "Only the first two eligible entries may start"
    )
    assert.equal(await prepare(second), 1)
    assert.equal(
      await prepare(second),
      0,
      "A replay cannot claim an active job"
    )
    assert.equal(await prepare(first), 1)
    assert.equal(await prepare(third), 0)
    assert.equal(await prepare(other), 1, "Account slots are independent")
    const queue = async (id: string) => {
      await db.query(
        "update application_runs set status='ready',packet=$2::jsonb where id=$1",
        [id, JSON.stringify(packet)]
      )
      assert.equal(
        (
          await db.query<{ ok: boolean }>(
            "select queue_automatic_application($1,1) ok",
            [id]
          )
        ).rows[0].ok,
        true
      )
    }
    const send = async (id: string) =>
      (await db.query("select * from claim_application($1,1)", [id])).rows
        .length
    await queue(first)
    assert.equal(await send(first), 1)
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb where id=$1",
      [second, JSON.stringify(packet)]
    )
    assert.equal(
      await prepare(third),
      0,
      "A prepared automatic handoff reserves its slot"
    )
    await queue(second)
    assert.equal(
      await send(second),
      0,
      "Same-employer simultaneous sends remain blocked"
    )
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_runs where id=$1",
          [second]
        )
      ).rows[0].status,
      "needs_attention"
    )
    assert.equal(await prepare(third), 1, "A paused job releases its slot")
    assert.equal(await prepare(fourth), 0)
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [first]
    )
    await queue(third)
    assert.equal(
      await send(third),
      0,
      "An uncertain same-employer result still blocks sending"
    )
    await db.query(
      "update application_runs set retry_after=now()+interval '1 hour' where id=$1",
      [fourth]
    )
    const fifth = await request("job-5")
    // Preparation cooldowns live in task checkpoints, submission cooldowns in retry_after.
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb,started_at=now(),employer_key='different-employer' where id=$1",
      [fourth, JSON.stringify(packet)]
    )
    await db.query("select queue_automatic_application($1,1)", [fourth])
    assert.equal(await send(fourth), 0)
    assert.equal(
      await prepare(fifth),
      1,
      "A retry cooldown does not hold a slot"
    )
    await db.query("update application_runs set retry_after=null where id=$1", [
      fourth,
    ])
    assert.equal(
      await send(fourth),
      1,
      "A different employer can use the other slot"
    )
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select application_queue_turn($1)", [first]),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})

test("two distinct employer submissions fill both slots until one finishes", async () => {
  const db = await database()
  try {
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611060058_application_concurrency.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const ids: string[] = []
    for (const job of ["job-1", "job-2", "job-3"]) {
      const id = (
        await db.query<{ id: string }>(
          "select request_automatic_application_for($1,$2) id",
          [alice, job]
        )
      ).rows[0].id
      ids.push(id)
      await db.query(
        "update application_runs set status='ready',packet=$2::jsonb,started_at=now(),employer_key=$3 where id=$1",
        [id, JSON.stringify(packet), job]
      )
      await db.query("select queue_automatic_application($1,1)", [id])
    }
    const send = async (id: string) =>
      (await db.query("select * from claim_application($1,1)", [id])).rows
        .length
    assert.equal(await send(ids[0]), 1)
    assert.equal(await send(ids[1]), 1)
    assert.equal(await send(ids[2]), 0)
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [ids[0]]
    )
    assert.equal(
      await send(ids[2]),
      0,
      "A code wait after submission retains its slot"
    )
    await db.query("select confirm_application($1,1,$2::jsonb)", [
      ids[0],
      JSON.stringify({
        text: "Application received",
        confirmedAt: new Date().toISOString(),
      }),
    ])
    assert.equal(await send(ids[2]), 1)
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from application_runs where status in ('preparing','running','submitting')"
        )
      ).rows[0].n,
      2
    )
  } finally {
    await db.close()
  }
})

test("cancelled and paused jobs release the queue; a resumed review joins the tail; long waits preserve consent", async () => {
  const db = await database()
  try {
    const ids: string[] = []
    for (const job of ["job-1", "job-2", "job-3"])
      ids.push(
        (
          await db.query<{ id: string }>(
            "select request_automatic_application_for($1,$2) id",
            [alice, job]
          )
        ).rows[0].id
      )
    const prepare = (id: string) =>
      db.query("select * from claim_application_preparation($1,$2)", [
        id,
        token,
      ])
    await db.query(
      "update application_runs set status='needs_attention' where id=$1",
      [ids[0]]
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.query("select cancel_application($1,1)", [ids[1]])
    assert.equal((await prepare(ids[2])).rows.length, 1)
    const waiting = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-5') id",
        [alice]
      )
    ).rows[0].id
    // A completed review is explicitly approved again and waits behind active work.
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb,auto_submit_requested_at=null where id=$1",
      [ids[0], JSON.stringify(packet)]
    )
    await db.query("select approve_application($1,1)", [ids[0]])
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [ids[0]])).rows
        .length,
      0
    )
    await db.query(
      "update application_runs set status='needs_attention' where id=$1",
      [ids[2]]
    )
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [ids[0]])).rows
        .length,
      0,
      "a resumed review waits behind jobs already queued"
    )
    assert.equal((await prepare(waiting)).rows.length, 1)
    await db.query(
      "update application_runs set status='needs_attention' where id=$1",
      [waiting]
    )
    // Waiting longer than 30 minutes is not a stale approval or a dead worker.
    await db.query(
      "update application_runs set approved_at=now()-interval '2 hours',queue_entered_at=now()-interval '2 hours' where id=$1",
      [ids[0]]
    )
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [ids[0]])).rows
        .length,
      1
    )
    await db.query(
      "update application_runs set status='needs_attention' where id=$1",
      [ids[0]]
    )
    const fourth = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-4') id",
        [alice]
      )
    ).rows[0].id
    await db.query(
      "update application_runs set auto_submit_requested_at=now()-interval '2 hours',queue_entered_at=now()-interval '2 hours',updated_at=now()-interval '2 hours' where id=$1",
      [fourth]
    )
    assert.equal(
      (await db.query<{ n: number }>("select recover_stale_applications() n"))
        .rows[0].n,
      0,
      "pending entries are not dead workers"
    )
    assert.equal((await prepare(fourth)).rows.length, 1)
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb where id=$1",
      [fourth, JSON.stringify(packet)]
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_automatic_application($1,1) ok",
          [fourth]
        )
      ).rows[0].ok,
      true
    )
  } finally {
    await db.close()
  }
})

test("waiting workflows stop on cancellation/revision changes, and missing answers release the automatic handoff", async (t) => {
  const env = { ...process.env }
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://queue.example",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
  })
  t.after(() => {
    process.env = env
  })
  let run = {
    id: alice,
    job_id: "job-1",
    target_url: "https://careers.example.com/jobs/1",
    status: "queued",
    revision: 2,
    packet: {
      ...packet,
      fields: [
        {
          id: "question",
          label: "Required answer",
          help: "",
          kind: "text",
          required: true,
          options: [],
        },
      ],
    },
    automatic: true,
    auto_submit_requested_at: new Date().toISOString(),
    retry_after: null as string | null,
    updated_at: new Date(Date.now() - 3_600_000).toISOString(),
  }
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      assert.match(url.pathname, /\/application_runs$/)
      if (init?.method === "PATCH") {
        assert.equal(url.searchParams.get("revision"), "eq.2")
        assert.equal(url.searchParams.get("status"), "eq.ready")
        const body = JSON.parse(String(init.body))
        assert.equal(body.auto_submit_requested_at, null)
        run = { ...run, ...body }
        return new Response(null, { status: 204 })
      }
      const matches =
        (!url.searchParams.has("status") ||
          url.searchParams.get("status") === `eq.${run.status}`) &&
        (!url.searchParams.has("revision") ||
          url.searchParams.get("revision") === `eq.${run.revision}`)
      return Response.json(matches ? run : null)
    }
  )
  assert.ok(await applicationQueueRetryAt(alice, "queued", 2))
  assert.equal(await applicationQueueRetryAt(alice, "queued", 1), null)
  assert.equal(
    (
      await ownedApplication(
        {
          db: supabaseServerClient(),
          user: {
            id: alice,
          },
        },
        alice
      )
    ).status,
    "queued",
    "a progress read must not expire a waiting job"
  )
  run.retry_after = new Date(Date.now() + 300000).toISOString()
  assert.equal(
    await applicationQueueRetryAt(alice, "queued", 2),
    run.retry_after
  )
  run.status = "cancelled"
  assert.equal(await applicationQueueRetryAt(alice, "queued", 2), null)
  run.status = "ready"
  assert.equal(await queuePreparedAutomaticApplication(alice), null)
  assert.equal(run.auto_submit_requested_at, null)
  assert.deepEqual(applicationStatusGroups.queue, ["queued_prepare", "queued"])
  assert.deepEqual(applicationStatusGroups.flight, [
    "preparing",
    "running",
    "submitting",
  ])
})

test("retry queue fences stale workers, respects due times, releases other jobs and bounds attempts", async () => {
  const db = await database()
  try {
    const ids: string[] = []
    for (const job of ["job-1", "job-2"]) {
      const result = await db.query<{ id: string }>(
        "select request_automatic_application_for($1,$2) id",
        [alice, job]
      )
      const id = result.rows[0].id
      ids.push(id)
      await db.query(
        "update application_runs set status='ready',packet=$2::jsonb,started_at=now() where id=$1",
        [id, JSON.stringify(packet)]
      )
      await db.query("select queue_automatic_application($1,1)", [id])
    }
    const [id, other] = ids
    const claim = (revision: number) =>
      db.query("select * from claim_application($1,$2)", [id, revision])
    const task = (revision: number, stage = "fill_employer_form") =>
      db.query("select record_application_task($1,$2,null,$3,'start')", [
        id,
        revision,
        stage,
      ])
    const retry = async (revision: number, code = "captcha_unresolved") =>
      (
        await db.query<{ value: { revision: number; retryAt: string } | null }>(
          "select queue_application_retry($1,$2,'fill_employer_form',$3,'Temporary failure') value",
          [id, revision, code]
        )
      ).rows[0].value
    assert.equal((await claim(1)).rows.length, 1)
    await task(1)
    await db.query(
      "insert into application_tasks(application_id,revision,stage,state,output) values($1,1,'validate_packet','completed',$2::jsonb)",
      [id, JSON.stringify({ grounded: true })]
    )
    assert.equal(
      await retry(1, "employer_access"),
      null,
      "OTP/sign-in must not be retried"
    )
    await db.exec("set role authenticated")
    await assert.rejects(retry(1), /permission denied/)
    await db.exec("reset role")
    const first = await retry(1)
    assert.equal(first?.revision, 2)
    assert.ok(Date.parse(first!.retryAt) - Date.now() > 290000)
    assert.equal(await retry(1), null, "duplicate scheduling is idempotent")
    assert.equal((await claim(1)).rows.length, 0)
    assert.equal(
      (await claim(2)).rows.length,
      0,
      "early claims are blocked in Postgres"
    )
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [other])).rows
        .length,
      1,
      "backoff releases the account queue"
    )
    assert.equal(
      (
        await db.query<{ value: unknown }>(
          "select record_application_task($1,1,null,'fill_employer_form','fail','{}') value",
          [id]
        )
      ).rows[0].value,
      null
    )
    assert.deepEqual(
      (
        await db.query(
          "select output from application_tasks where application_id=$1 and revision=2 and stage='validate_packet'",
          [id]
        )
      ).rows,
      [{ output: { grounded: true } }]
    )
    await db.query(
      "update application_runs set status='cancelled' where id=$1",
      [other]
    )
    const due = async () => {
      await db.query(
        "update application_runs set retry_after=now()-interval '1 second' where id=$1",
        [id]
      )
      await db.query(
        "update application_tasks set next_retry_at=now()-interval '1 second' where application_id=$1",
        [id]
      )
    }
    await due()
    assert.equal((await claim(2)).rows.length, 1)
    assert.equal(
      (await claim(2)).rows.length,
      0,
      "duplicate workflows cannot claim twice"
    )
    await task(2)
    const second = await retry(2)
    assert.equal(second?.revision, 3)
    assert.ok(Date.parse(second!.retryAt) - Date.now() > 890000)
    await due()
    assert.equal((await claim(3)).rows.length, 1)
    await task(3)
    assert.equal(await retry(3), null, "no fourth browser attempt")
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select automatic_retry_count n from application_runs where id=$1",
          [id]
        )
      ).rows[0].n,
      2
    )
  } finally {
    await db.close()
  }
})

test("retry scheduling rejects send intent, uncertain outcomes, cancellation and edited approval", async () => {
  const db = await database()
  try {
    for (const condition of [
      "submit_task",
      "submitting",
      "submission_unknown",
      "submitted",
      "cancelled",
      "edited",
    ]) {
      const created = await db.query<{ id: string }>(
        "insert into application_runs(user_id,target_url,status,packet,approved_packet,approved_revision,approved_at) values($1,$2,'running',$3::jsonb,$3::jsonb,1,now()) returning id",
        [alice, "https://example.test/" + condition, JSON.stringify(packet)]
      )
      const id = created.rows[0].id
      await db.query(
        "select record_application_task($1,1,null,'fill_employer_form','start')",
        [id]
      )
      if (condition === "submit_task")
        await db.query(
          "select record_application_task($1,1,null,'submit','start')",
          [id]
        )
      else if (condition === "edited")
        await db.query(
          'update application_runs set packet=packet||\'{"notices":"edited"}\'::jsonb where id=$1',
          [id]
        )
      else if (condition === "submitted")
        await db.query(
          "update application_runs set status='submitted',receipt='{\"text\":\"received\"}'::jsonb where id=$1",
          [id]
        )
      else
        await db.query("update application_runs set status=$2 where id=$1", [
          id,
          condition,
        ])
      const result = await db.query<{ v: unknown }>(
        "select queue_application_retry($1,1,'fill_employer_form','temporary_unavailable','Temporary') v",
        [id]
      )
      assert.equal(result.rows[0].v, null, condition)
    }
  } finally {
    await db.close()
  }
})

test("automatic mode continues complete answers without renewed permission, but never replays a send", async () => {
  const db = await database()
  try {
    const {
      rows: [run],
    } = await db.query<{ id: string }>(
      "select request_automatic_application_for($1,$2) id",
      [alice, "job-1"]
    )
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb,auto_submit_requested_at=null,started_at=now()-interval '2 days' where id=$1",
      [run.id, JSON.stringify(packet)]
    )
    const queue = async (revision = 1) =>
      (
        await db.query<{ queued: boolean }>(
          "select queue_automatic_application($1,$2) queued",
          [run.id, revision]
        )
      ).rows[0].queued
    assert.equal(await queue(2), false, "stale revisions cannot queue")
    await db.query("update application_runs set automatic=false where id=$1", [
      run.id,
    ])
    assert.equal(await queue(), false, "manual review remains explicit")
    await db.query(
      "update application_runs set automatic=true,status='cancelled' where id=$1",
      [run.id]
    )
    assert.equal(await queue(), false, "cancelled runs remain cancelled")
    const missing = {
      ...packet,
      fields: [
        {
          id: "salary",
          label: "Salary",
          kind: "number",
          required: true,
          options: [],
        },
      ],
    }
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb where id=$1",
      [run.id, JSON.stringify(missing)]
    )
    assert.equal(await queue(), false, "new required information still pauses")
    await db.query("update application_runs set packet=$2::jsonb where id=$1", [
      run.id,
      JSON.stringify(packet),
    ])
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select queue_automatic_application($1,1)", [run.id]),
      /permission denied/
    )
    await db.exec("reset role")
    assert.equal(
      (
        await db.query<{ queued: boolean }>(
          "select queue_automatic_application($1,1) queued",
          [run.id]
        )
      ).rows[0].queued,
      true
    )
    assert.equal(
      (
        await db.query<{ queued: boolean }>(
          "select queue_automatic_application($1,1) queued",
          [run.id]
        )
      ).rows[0].queued,
      false
    )
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [run.id]
    )
    await db.query("update application_runs set status='ready' where id=$1", [
      run.id,
    ])
    assert.equal(
      (
        await db.query<{ queued: boolean }>(
          "select queue_automatic_application($1,1) queued",
          [run.id]
        )
      ).rows[0].queued,
      false
    )
  } finally {
    await db.close()
  }
})
