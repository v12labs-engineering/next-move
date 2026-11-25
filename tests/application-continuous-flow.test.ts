import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
const alice = "00000000-0000-4000-8000-000000000001"
const bob = "00000000-0000-4000-8000-000000000002"
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

async function database(automaticRetry = true) {
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
    "202610310004_application_question_preferences",
    "202611010031_application_profile_daily_limit",
    "202611010034_application_tasks",
    "202611020038_telegram_approvals",
    "202611020042_application_step_retry",
    "202611030044_recover_stale_applications",
    "202611030045_application_queue",
    "202611030046_telegram_application_continuation",
    "202611040048_application_answer_reuse_defaults",
    "202611040049_application_employer_acknowledgement",
    "202611050051_application_failure_retries",
    "202611050055_retry_unconfirmed_application",
    "202611060056_continuous_automatic_applications",
    "202611060059_continuous_application_retries",
    "202611080062_revision_fenced_preparation_retry",
    "202611080064_automatic_unconfirmed_retry",
    "202611190096_automatic_preparation_retry_checkpoints",
    "202611190097_remove_application_daily_limit",
  ]) {
    if (
      !automaticRetry &&
      migration === "202611080064_automatic_unconfirmed_retry"
    )
      continue
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${migration}.sql`, import.meta.url),
        "utf8"
      )
    )
  }
  return db
}

test("automatic tailoring retry only requires checkpoints from stages it runs", async () => {
  const db = await database()
  try {
    const {
      rows: [{ id }],
    } = await db.query<{ id: string }>(
      "select request_automatic_application_for($1,'job-1') id",
      [alice]
    )
    await db.query(
      "update application_runs set status='needs_attention' where id=$1",
      [id]
    )
    await db.query(
      `insert into application_tasks(application_id,revision,stage,state,output)
       values ($1,1,'load_source','completed','{"source":"fixture"}'),
              ($1,1,'tailor_resume','failed',null)`,
      [id]
    )
    await db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub','${alice}',false)`
    )
    const retry = () =>
      db.query("select retry_application_step($1,1,'tailor_resume') revision", [
        id,
      ])
    await db.exec("reset role")
    await db.query("update application_runs set automatic=false where id=$1", [
      id,
    ])
    await db.exec("set role authenticated")
    await assert.rejects(retry(), /Completed step checkpoint unavailable/)
    await db.exec("reset role")
    await db.query("update application_runs set automatic=true where id=$1", [
      id,
    ])
    await db.exec("set role authenticated")
    assert.deepEqual((await retry()).rows, [{ revision: 2 }])
    await db.exec("reset role")
    assert.deepEqual(
      (
        await db.query(
          "select stage,output from application_tasks where application_id=$1 and revision=2",
          [id]
        )
      ).rows,
      [{ stage: "load_source", output: { source: "fixture" } }]
    )
  } finally {
    await db.close()
  }
})

test("unverifiable automatic sends retry once, fence old workers and retain the limit after explicit retry", async () => {
  const db = await database()
  try {
    const id = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-1') id",
        [alice]
      )
    ).rows[0].id
    await db.query(
      "update application_runs set status='ready',packet=$2 where id=$1",
      [id, JSON.stringify(packet)]
    )
    await db.query("select queue_automatic_application($1,1)", [id])
    await db.query("select * from claim_application($1,1)", [id])
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [id]
    )
    const retry = (
      await db.query<{
        status: string
        revision: number
        attempt_start_revision: number
        approved_revision: number
        unconfirmed_retry_count: number
        delayed: boolean
      }>(
        `update application_runs set status='submission_unknown' where id=$1
      returning status,revision,attempt_start_revision,approved_revision,unconfirmed_retry_count,retry_after>now() delayed`,
        [id]
      )
    ).rows[0]
    assert.deepEqual(retry, {
      status: "queued",
      revision: 2,
      attempt_start_revision: 2,
      approved_revision: 2,
      unconfirmed_retry_count: 1,
      delayed: true,
    })
    assert.equal(
      (await db.query("select * from claim_application($1,2)", [id])).rows
        .length,
      0,
      "Honor the persisted retry delay"
    )
    assert.equal(
      (await db.query("select * from claim_application($1,1)", [id])).rows
        .length,
      0,
      "An old workflow cannot claim the retry"
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          'select confirm_application($1,1,\'{"text":"late receipt"}\') ok',
          [id]
        )
      ).rows[0].ok,
      false
    )
    assert.deepEqual(
      (
        await db.query(
          "select status,revision from application_events where application_id=$1 order by id desc limit 2",
          [id]
        )
      ).rows,
      [
        { status: "queued", revision: 2 },
        { status: "submission_unknown", revision: 1 },
      ]
    )
    await db.query(
      "update application_runs set retry_after=now()-interval '1 second' where id=$1",
      [id]
    )
    assert.equal(
      (await db.query("select * from claim_application($1,2)", [id])).rows
        .length,
      1
    )
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [id]
    )
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [id]
    )
    assert.deepEqual(
      (
        await db.query(
          "select status,revision,unconfirmed_retry_count,receipt from application_runs where id=$1",
          [id]
        )
      ).rows[0],
      {
        status: "submission_unknown",
        revision: 2,
        unconfirmed_retry_count: 1,
        receipt: null,
      }
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    assert.equal(
      (
        await db.query<{ v: number }>(
          "select retry_unconfirmed_application($1,2) v",
          [id]
        )
      ).rows[0].v,
      3
    )
    await db.exec("reset role")
    await db.query("select queue_automatic_application($1,3)", [id])
    await db.query("select * from claim_application($1,3)", [id])
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [id]
    )
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [id]
    )
    assert.deepEqual(
      (
        await db.query(
          "select status,revision,unconfirmed_retry_count from application_runs where id=$1",
          [id]
        )
      ).rows[0],
      {
        status: "submission_unknown",
        revision: 3,
        unconfirmed_retry_count: 1,
      },
      "A manual retry does not refill the automatic retry allowance"
    )
  } finally {
    await db.close()
  }
})

test("timeout recovery queues one retry and keeps old tasks on their original revision", async () => {
  const db = await database()
  try {
    const id = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-1') id",
        [alice]
      )
    ).rows[0].id
    await db.query(
      "update application_runs set status='submitting',packet=$2,approved_packet=$2,approved_revision=1,updated_at=now()-interval '20 minutes' where id=$1",
      [id, JSON.stringify(packet)]
    )
    await db.query(
      "insert into application_tasks(application_id,revision,stage,state) values($1,1,'submit','running')",
      [id]
    )
    assert.equal(
      (await db.query<{ n: number }>("select recover_stale_applications() n"))
        .rows[0].n,
      1
    )
    assert.deepEqual(
      (
        await db.query(
          "select status,revision,unconfirmed_retry_count from application_runs where id=$1",
          [id]
        )
      ).rows[0],
      { status: "queued", revision: 2, unconfirmed_retry_count: 1 }
    )
    assert.deepEqual(
      (
        await db.query(
          "select revision,state,error_code from application_tasks where application_id=$1",
          [id]
        )
      ).rows[0],
      { revision: 1, state: "blocked", error_code: "submission_unknown" }
    )
    assert.equal(
      (await db.query<{ n: number }>("select recover_stale_applications() n"))
        .rows[0].n,
      0,
      "Recovery replays cannot schedule an extra attempt"
    )
    await db.query(
      "update application_runs set status='submitting',updated_at=now()-interval '20 minutes' where id=$1",
      [id]
    )
    await db.query("select recover_stale_applications()")
    assert.deepEqual(
      (
        await db.query(
          "select status,revision,unconfirmed_retry_count from application_runs where id=$1",
          [id]
        )
      ).rows[0],
      { status: "submission_unknown", revision: 2, unconfirmed_retry_count: 1 }
    )
  } finally {
    await db.close()
  }
})

test("manual attempts, saved receipts, edited packets and employer rejection cannot trigger automatic resubmission", async () => {
  const db = await database()
  try {
    for (const [index, scenario] of [
      "manual",
      "receipt",
      "edited",
      "rejected",
    ].entries()) {
      const id = (
        await db.query<{ id: string }>(
          `insert into application_runs(user_id,job_id,target_url,status,automatic,packet,approved_packet,approved_revision,receipt)
        values($1,$2,$3,'submitting',$4,$5,$6,1,$7) returning id`,
          [
            alice,
            `job-${index + 1}`,
            `https://careers.example.com/${scenario}`,
            scenario !== "manual",
            JSON.stringify(
              scenario === "edited"
                ? {
                    ...packet,
                    resume: "An edited resume with different saved contents.",
                  }
                : packet
            ),
            JSON.stringify(packet),
            scenario === "receipt" ? '{"text":"Application received"}' : null,
          ]
        )
      ).rows[0].id
      if (scenario === "rejected")
        await db.query(
          "insert into application_tasks(application_id,revision,stage,state,error_code) values($1,1,'submit','blocked','employer_rejected')",
          [id]
        )
      await db.query(
        "update application_runs set status='submission_unknown' where id=$1",
        [id]
      )
      assert.deepEqual(
        (
          await db.query(
            "select status,revision,unconfirmed_retry_count from application_runs where id=$1",
            [id]
          )
        ).rows[0],
        {
          status: "submission_unknown",
          revision: 1,
          unconfirmed_retry_count: 0,
        },
        scenario
      )
    }
  } finally {
    await db.close()
  }
})

test("installing the retry policy preserves historical unconfirmed applications", async () => {
  const db = await database(false)
  try {
    const id = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-1') id",
        [alice]
      )
    ).rows[0].id
    await db.query(
      "update application_runs set status='submission_unknown',packet=$2,approved_packet=$2,approved_revision=1 where id=$1",
      [id, JSON.stringify(packet)]
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611080064_automatic_unconfirmed_retry.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    assert.deepEqual(
      (
        await db.query(
          "select status,revision,unconfirmed_retry_count from application_runs where id=$1",
          [id]
        )
      ).rows[0],
      { status: "submission_unknown", revision: 1, unconfirmed_retry_count: 0 }
    )
  } finally {
    await db.close()
  }
})

test("explicit retry retains automatic continuation through a later missing-answer edit", async () => {
  const db = await database()
  try {
    const id = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-1') id",
        [alice]
      )
    ).rows[0].id
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb,started_at=now() where id=$1",
      [id, JSON.stringify(packet)]
    )
    await db.query("select queue_automatic_application($1,1)", [id])
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [id]
    )
    await db.query(
      "update application_runs set status='submission_unknown',unconfirmed_retry_count=1 where id=$1",
      [id]
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    assert.equal(
      (
        await db.query<{ v: number }>(
          "select retry_unconfirmed_application($1,1) v",
          [id]
        )
      ).rows[0].v,
      2
    )
    await db.exec("reset role")
    const run = (
      await db.query<{ automatic: boolean }>(
        "select automatic from application_runs where id=$1",
        [id]
      )
    ).rows[0]
    assert.equal(
      run.automatic,
      true,
      "Retry is the instruction to continue, not another review gate"
    )
    assert.equal(
      (
        await db.query<{ v: boolean }>(
          "select queue_automatic_application($1,2) v",
          [id]
        )
      ).rows[0].v,
      true,
      "Prior uncertain attempt must not poison the newly authorized attempt"
    )
    // A pre-send question pause and a saved answer must continue within that attempt.
    await db.query("update application_runs set status='running' where id=$1", [
      id,
    ])
    await db.query(
      "update application_runs set status='ready',approved_packet=null,approved_revision=null where id=$1",
      [id]
    )
    await db.exec("set role authenticated")
    const revision = (
      await db.query<{ v: number }>(
        "select save_application_review($1,2,'{}',$2,'{}',false) v",
        [id, packet.resume]
      )
    ).rows[0].v
    await db.exec("reset role")
    assert.equal(
      (
        await db.query<{ v: boolean }>(
          "select queue_automatic_application($1,$2) v",
          [id, revision]
        )
      ).rows[0].v,
      true
    )
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [id]
    )
    await db.query(
      "update application_runs set status='ready',approved_packet=null,approved_revision=null where id=$1",
      [id]
    )
    assert.equal(
      (
        await db.query<{ v: boolean }>(
          "select queue_automatic_application($1,$2) v",
          [id, revision]
        )
      ).rows[0].v,
      false,
      "A new send intent still blocks automatic replay"
    )
  } finally {
    await db.close()
  }
})

test("retry boundary preserves ownership, missing answers, cooldowns and Telegram continuation", async () => {
  const db = await database()
  try {
    const pending = {
      ...packet,
      fields: [
        {
          id: "notice",
          label: "Notice period",
          kind: "text",
          required: true,
          options: [],
          help: "",
        },
      ],
    }
    const id = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-1') id",
        [alice]
      )
    ).rows[0].id
    await db.query(
      "update application_runs set status='submission_unknown',packet=$2,approved_packet=$2,approved_revision=1 where id=$1",
      [id, JSON.stringify(pending)]
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [bob])
    await db.exec("set role authenticated")
    assert.equal(
      (
        await db.query<{ v: number | null }>(
          "select retry_unconfirmed_application($1,1) v",
          [id]
        )
      ).rows[0].v,
      null
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    assert.equal(
      (
        await db.query<{ v: number | null }>(
          "select retry_unconfirmed_application($1,9) v",
          [id]
        )
      ).rows[0].v,
      null
    )
    assert.equal(
      (
        await db.query<{ v: number }>(
          "select retry_unconfirmed_application($1,1) v",
          [id]
        )
      ).rows[0].v,
      2
    )
    assert.equal(
      (
        await db.query<{ v: number | null }>(
          "select retry_unconfirmed_application($1,2) v",
          [id]
        )
      ).rows[0].v,
      null,
      "Replayed retry cannot advance the boundary twice"
    )
    await db.exec("reset role")
    assert.equal(
      (
        await db.query<{ v: boolean }>(
          "select queue_automatic_application($1,2) v",
          [id]
        )
      ).rows[0].v,
      false,
      "Missing facts still pause"
    )
    await db.query(
      "insert into telegram_connections(user_id,thread_id,label) values($1,'telegram:42','Fixture')",
      [alice]
    )
    assert.ok(
      (
        await db.query<{ v: unknown }>(
          "select continue_telegram_application('telegram:42',$1,2,'review','new-attempt-question') v",
          [id]
        )
      ).rows[0].v,
      "The prior attempt does not block questions for the new attempt"
    )
    const request = (
      await db.query<{ id: string; version: number }>(
        "select id,version from telegram_requests where application_id=$1 and revision=2",
        [id]
      )
    ).rows[0]
    const rev = (
      await db.query<{ v: { revision: number } }>(
        "select transition_telegram_request('telegram:42',$1,$2,$3,'final-answer',true,false) v",
        [
          request.id,
          request.version,
          JSON.stringify({
            answers: { notice: "30 days" },
            confirmed: ["notice"],
            initialized: true,
          }),
        ]
      )
    ).rows[0].v.revision
    assert.equal(
      (
        await db.query<{ v: boolean }>(
          "select status='queued' v from application_runs where id=$1 and revision=$2",
          [id, rev]
        )
      ).rows[0].v,
      true
    )
    await db.query("select * from claim_application($1,$2)", [id, rev])
    await db.query(
      "insert into application_tasks(application_id,revision,stage,state) values($1,1,'submit','blocked'),($1,$2,'fill_employer_form','running')",
      [id, rev]
    )
    assert.ok(
      (
        await db.query<{ v: unknown }>(
          "select queue_application_retry($1,$2,'fill_employer_form','temporary_unavailable','Temporary') v",
          [id, rev]
        )
      ).rows[0].v,
      "An old attempt cannot disable bounded pre-send recovery"
    )
    assert.equal(
      (
        await db.query<{ automatic: boolean }>(
          "select automatic from application_runs where id=$1",
          [id]
        )
      ).rows[0].automatic,
      true
    )
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query(
        "update application_runs set attempt_start_revision=revision where id=$1",
        [id]
      ),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})

for (const channel of ["app", "telegram", "step"])
  test(`automatic preparation retry retains dispatch intent through ${channel}`, async () => {
    const db = await database()
    try {
      const id = (
        await db.query<{ id: string }>(
          "select request_automatic_application_for($1,'job-1') id",
          [alice]
        )
      ).rows[0].id
      await db.query(
        "update application_runs set status='needs_attention',auto_submit_requested_at=null where id=$1",
        [id]
      )
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        alice,
      ])
      if (channel === "telegram") {
        await db.query(
          "insert into telegram_connections(user_id,thread_id,label) values($1,'telegram:42','Fixture')",
          [alice]
        )
        assert.ok(
          (
            await db.query<{ v: unknown }>(
              "select continue_telegram_application('telegram:42',$1,1,'retry','retry-preparation') v",
              [id]
            )
          ).rows[0].v
        )
      } else {
        await db.query(
          "insert into application_tasks(application_id,revision,stage,state) values($1,1,'load_source','failed')",
          [id]
        )
        await db.exec("set role authenticated")
        const sql =
          channel === "step"
            ? "select retry_application_step($1,1,'load_source') v"
            : "select retry_application_preparation_revision($1,1) v"
        assert.ok((await db.query<{ v: unknown }>(sql, [id])).rows[0].v)
        await db.exec("reset role")
      }
      const run = (
        await db.query<{
          automatic: boolean
          auto_submit_requested_at: string | null
          status: string
        }>(
          "select automatic,auto_submit_requested_at,status from application_runs where id=$1",
          [id]
        )
      ).rows[0]
      assert.equal(run.automatic, true)
      assert.ok(run.auto_submit_requested_at)
      assert.equal(run.status, "queued_prepare")
      await db.query(
        "update application_runs set status='cancelled' where id=$1",
        [id]
      )
      const cancelled = (
        await db.query<{ auto_submit_requested_at: string | null }>(
          "select auto_submit_requested_at from application_runs where id=$1",
          [id]
        )
      ).rows[0]
      assert.equal(cancelled.auto_submit_requested_at, null)
      assert.equal(
        (
          await db.query<{ v: boolean }>(
            "select queue_automatic_application($1,2) v",
            [id]
          )
        ).rows[0].v,
        false,
        "Cancelled applications cannot dispatch automatically"
      )
    } finally {
      await db.close()
    }
  })

test("preparation retries cannot act on an unseen revision", async () => {
  const db = await database()
  try {
    const id = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-1') id",
        [alice]
      )
    ).rows[0].id
    await db.query(
      "update application_runs set status='cancelled',revision=2 where id=$1",
      [id]
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    // The request was rendered for revision 1, before a newer cancellation.
    const retry = async (revision: number | null) =>
      (
        await db.query<{ v: boolean }>(
          "select retry_application_preparation_revision($1,$2) v",
          [id, revision]
        )
      ).rows[0].v
    const retried = await retry(1)
    assert.equal(
      retried,
      false,
      "A stale retry must preserve the newer cancellation"
    )
    assert.equal(await retry(null), false)
    await db.exec("reset role")
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [bob])
    await db.exec("set role authenticated")
    assert.equal(await retry(2), false, "Another account cannot retry the run")
    await db.exec("reset role")
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    assert.equal(
      await retry(2),
      true,
      "A current explicit retry can resume a cancelled run"
    )
    assert.equal(
      await retry(2),
      false,
      "Replaying the request cannot start another preparation"
    )
    await db.exec("reset role")
    const current = (
      await db.query<{
        status: string
        revision: number
        automatic: boolean
        intent: string | null
      }>(
        "select status,revision,automatic,auto_submit_requested_at intent from application_runs where id=$1",
        [id]
      )
    ).rows[0]
    assert.equal(current.revision, 3)
    assert.equal(current.status, "queued_prepare")
    assert.equal(current.automatic, true)
    assert.ok(current.intent)
    for (const state of [
      "running",
      "submitting",
      "submission_unknown",
      "submitted",
    ]) {
      await db.query(
        "update application_runs set status=$2,receipt=case when $2='submitted' then '{}'::jsonb else null end where id=$1",
        [id, state]
      )
      await db.exec("set role authenticated")
      assert.equal(await retry(3), false, `${state} cannot be retried`)
      await db.exec("reset role")
    }
    await db.query(
      "update application_runs set status='needs_attention',receipt=null where id=$1",
      [id]
    )
    await db.exec("set role authenticated")
    assert.equal(
      await retry(3),
      false,
      "Historical send intent remains protected"
    )
    await db.exec("reset role")
    await db.query("delete from application_events where application_id=$1", [
      id,
    ])
    await db.query(
      "update application_runs set receipt='{}'::jsonb where id=$1",
      [id]
    )
    await db.exec("set role authenticated")
    assert.equal(await retry(3), false, "A saved receipt remains protected")
    await db.exec("reset role")
    await db.query(
      "update application_runs set receipt=null,prepare_attempts=3 where id=$1",
      [id]
    )
    await db.exec("set role authenticated")
    assert.equal(await retry(3), false, "The preparation budget is unchanged")
    await db.exec("reset role; set role anon")
    await assert.rejects(retry(3), /permission denied/)
  } finally {
    await db.close()
  }
})
