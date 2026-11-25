import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import {
  applicationFailure,
  ApplicationCaptchaError,
  canQueueApplicationRetry,
  preparationRetryAt,
} from "../lib/applications/pipeline"
import { applicationPauseReason } from "../lib/server/applications/browser"
const alice = "00000000-0000-4000-8000-000000000001",
  bob = "00000000-0000-4000-8000-000000000002"

test("task checkpoints are private, fenced, bounded and cannot recover a send", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;insert into auth.users values('${alice}'),('${bob}');
 create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
 create table public.account_profiles(user_id uuid primary key);
 create table public.account_ai_usage(user_id uuid,day date,attempts integer,primary key(user_id,day));
 create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
 create function public.reserve_tailoring_attempt() returns boolean language sql as $$ select true $$;
 insert into public.account_profiles values('${alice}'),('${bob}');
 insert into public.job_catalog(id,title,company,url) values('job-1','Engineer','Example','https://jobs.ashbyhq.com/example/1af7a193-334d-4d5c-b45d-250122d9c3f1');`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290004_application_runner.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290005_application_claim.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610300001_automatic_applications.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610300002_site_independent_applications.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611010034_application_tasks.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const id = "00000000-0000-4000-8000-000000000010"
    const token = "00000000-0000-4000-8000-000000000011"
    const newToken = "00000000-0000-4000-8000-000000000012"
    await db.query(
      "insert into application_runs(id,user_id,job_id,target_url,automatic) values($1,$2,'job-1','https://example.test/apply',true)",
      [id, alice]
    )
    await db.query("select * from claim_application_preparation($1,$2)", [
      id,
      token,
    ])
    const task = async (
      stage: string,
      action: string,
      data = {},
      lease = token,
      revision = 1
    ) =>
      (
        await db.query<{
          t: { state: string; attempts: number; output: unknown } | null
        }>("select record_application_task($1,$2,$3,$4,$5,$6::jsonb) t", [
          id,
          revision,
          lease,
          stage,
          action,
          JSON.stringify(data),
        ])
      ).rows[0].t
    assert.equal((await task("load_source", "start"))?.attempts, 1)
    await task("load_source", "complete", {
      output: { secret: "private resume" },
    })
    assert.deepEqual((await task("load_source", "start"))?.output, {
      secret: "private resume",
    })
    assert.equal(await task("tailor_resume", "start", {}, newToken), null)
    assert.equal(await task("tailor_resume", "start", {}, token, 2), null)
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal((await task("tailor_resume", "start"))?.attempts, attempt)
      await task("tailor_resume", "fail", {
        state: "retry_wait",
        error_code: "temporary_unavailable",
        message: "Temporary provider error",
        next_retry_at: new Date(Date.now() + 60000).toISOString(),
      })
      assert.equal(
        await task("tailor_resume", "start"),
        null,
        "backoff is enforced in Postgres"
      )
      await db.exec(
        "update application_tasks set next_retry_at=now()-interval '1 second' where stage='tailor_resume'"
      )
    }
    assert.equal(
      await task("tailor_resume", "start"),
      null,
      "dispatch replay cannot reset the task budget"
    )
    await db.exec(
      "update application_runs set updated_at=now()-interval '11 minutes'"
    )
    await db.query("select recover_application_preparation($1)", [alice])
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_runs"
        )
      ).rows[0].status,
      "needs_attention"
    )
    await db.exec(
      "delete from application_tasks where stage='tailor_resume'; update application_runs set status='preparing',updated_at=now()-interval '11 minutes'"
    )
    await db.query("select recover_application_preparation($1)", [alice])
    await db.query("select * from claim_application_preparation($1,$2)", [
      id,
      newToken,
    ])
    assert.equal(
      await task("validate_packet", "start"),
      null,
      "dead workers lose their token"
    )
    assert.equal(
      (await task("load_source", "start", {}, newToken))?.state,
      "completed"
    )
    await db.exec("update application_runs set status='cancelled'")
    assert.equal(await task("validate_packet", "start", {}, newToken), null)
    await db.query(
      "update application_runs set status='submitting',approved_revision=revision,approved_packet='{}',updated_at=now()-interval '11 minutes' where id=$1",
      [id]
    )
    await db.query("select recover_application_preparation($1)", [alice])
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_runs"
        )
      ).rows[0].status,
      "submitting"
    )
    await db.exec("set role authenticated")
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    assert.equal(
      (await db.query("select stage,state from application_tasks")).rows.length,
      1
    )
    await assert.rejects(
      db.exec("select output from application_tasks"),
      /permission denied/
    )
    await assert.rejects(
      db.exec("update application_tasks set state='completed'"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select * from claim_application_preparation($1,$2)", [
        id,
        newToken,
      ]),
      /permission denied/
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [bob])
    assert.equal(
      (await db.query("select stage from application_tasks")).rows.length,
      0
    )
    await db.exec("reset role; set role anon")
    await assert.rejects(
      db.exec("select stage from application_tasks"),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})

test("stale active runs stop safely and an interrupted send is never retried", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;insert into auth.users values('${alice}');
 create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
 create table public.account_profiles(user_id uuid primary key);
 create table public.account_ai_usage(user_id uuid,day date,attempts integer,primary key(user_id,day));
 create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
 create function public.reserve_tailoring_attempt() returns boolean language sql as $$ select true $$;
 insert into public.account_profiles values('${alice}');`)
    for (const name of [
      "202610290004_application_runner",
      "202610290005_application_claim",
      "202610300001_automatic_applications",
      "202610300002_site_independent_applications",
      "202611010034_application_tasks",
      "202611030044_recover_stale_applications",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
          "utf8"
        )
      )
    const runs = {
      sending: "00000000-0000-4000-8000-000000000020",
      filling: "00000000-0000-4000-8000-000000000021",
      fresh: "00000000-0000-4000-8000-000000000022",
      automatic: "00000000-0000-4000-8000-000000000023",
    }
    for (const [key, id] of Object.entries(runs))
      await db.query(
        "insert into application_runs(id,user_id,target_url,automatic) values($1,$2,$3,$4)",
        [id, alice, `https://example.test/apply/${key}`, key === "automatic"]
      )
    await db.query(
      "update application_runs set status=case id when $1::uuid then 'submitting' when $3::uuid then 'running' else 'preparing' end,approved_revision=revision,approved_packet='{}',updated_at=now()-interval '20 minutes' where id<>$2",
      [runs.sending, runs.fresh, runs.filling]
    )
    await db.query(
      "update application_runs set status='running',approved_revision=revision,approved_packet='{}',updated_at=now() where id=$1",
      [runs.fresh]
    )
    await db.query(
      "insert into application_tasks(application_id,revision,stage,state) values($1,1,'submit','running')",
      [runs.sending]
    )
    assert.equal(
      (await db.query<{ n: number }>("select recover_stale_applications() n"))
        .rows[0].n,
      2
    )
    const status = async (id: string) =>
      (
        await db.query<{ status: string }>(
          "select status from application_runs where id=$1",
          [id]
        )
      ).rows[0].status
    assert.equal(await status(runs.sending), "submission_unknown")
    assert.equal(await status(runs.filling), "needs_attention")
    assert.equal(await status(runs.fresh), "running")
    assert.equal(await status(runs.automatic), "preparing")
    assert.deepEqual(
      (
        await db.query(
          "select state,error_code from application_tasks where application_id=$1",
          [runs.sending]
        )
      ).rows[0],
      { state: "blocked", error_code: "submission_unknown" }
    )
  } finally {
    await db.close()
  }
})

test("upload, duplicate and sign-in failures keep distinct safe reasons", () => {
  assert.equal(
    applicationFailure(new Error("Already applied to this job")).code,
    "duplicate_application"
  )
  for (const message of [
    "Required employer upload",
    "Employer rejected the uploaded document",
    "Employer document upload did not finish",
  ])
    assert.equal(applicationFailure(new Error(message)).code, "employer_upload")
})

test("only known temporary failures retry and raw errors stay private", () => {
  for (const error of [
    Object.assign(new Error("secret provider payload"), { statusCode: 503 }),
    Object.assign(new Error("rate limited"), { status: 429 }),
    new Error("Connection closed"),
    new Error("Timed out"),
  ]) {
    const failure = applicationFailure(error)
    assert.equal(failure.retryable, true)
    assert.doesNotMatch(failure.message, /secret/)
  }
  for (const message of [
    "Human verification required",
    "Application decision quota reached",
    "Browser provider not configured",
    "Application form not found",
    "Unsupported destination",
    "Unexpected secret payload",
  ]) {
    assert.equal(applicationFailure(new Error(message)).retryable, false)
  }
  assert.equal(Date.parse(preparationRetryAt(2, 0)), 60000)
})

test("computer execution limits are not reported as provider billing limits", () => {
  for (const message of [
    "Application computer time budget exceeded",
    "Application computer decision budget reached",
  ]) {
    const failure = applicationFailure(new Error(message))
    assert.equal(failure.code, "execution_limit")
    assert.equal(failure.retryable, false)
    assert.doesNotMatch(failure.message, /account|allowance|update your limit/)
    assert.match(failure.message, /employer form.*retry preparation/i)
  }
  assert.equal(
    applicationFailure(
      Object.assign(new Error("provider payment"), { status: 402 })
    ).code,
    "processing_limit"
  )
  assert.equal(
    applicationFailure(new Error("Monthly AI limit reached")).code,
    "processing_limit"
  )
})

test("submission banners preserve safe task reasons without raw diagnostics", () => {
  for (const error of [
    new Error("Employer application cooldown"),
    new Error("Unsupported employer control"),
    new Error("Application computer time budget exceeded"),
    new Error("Human verification required"),
    new Error("Browser provider not configured"),
    Object.assign(
      new Error("private provider payload https://secret.example"),
      {
        statusCode: 503,
      }
    ),
    new Error("private candidate answers https://secret.example"),
  ]) {
    const failure = applicationFailure(error)
    const banner = applicationPauseReason(error)
    assert.equal(banner, `${failure.message} Nothing has been submitted.`)
    assert.doesNotMatch(banner, /private|secret/)
  }
  assert.doesNotMatch(
    applicationPauseReason(
      new Error("Application computer time budget exceeded")
    ),
    /allowance|account limit|processing limit/
  )
})

test("a browser closed mid-run is retryable, so a retry can report the real limit", () => {
  for (const message of [
    "page.goto: Target page, context or browser has been closed",
    "browserType.connectOverCDP: Browser has been closed",
  ]) {
    const failure = applicationFailure(new Error(message))
    assert.equal(failure.code, "temporary_unavailable")
    assert.equal(failure.retryable, true)
  }
})

test("CAPTCHA retries use cooldowns while OTP and permanent failures stay out of the queue", () => {
  const failure = applicationFailure(new ApplicationCaptchaError())
  assert.equal(failure.code, "captcha_unresolved")
  assert.equal(failure.retryable, true)
  assert.equal(Date.parse(preparationRetryAt(1, 0, failure.code)), 300000)
  assert.equal(Date.parse(preparationRetryAt(2, 0, failure.code)), 900000)
  assert.equal(canQueueApplicationRetry(failure.code), true)
  for (const code of [
    "employer_access",
    "configuration",
    "processing_limit",
    "unsupported_control",
    "submission_unknown",
    "receipt_unconfirmed",
  ])
    assert.equal(canQueueApplicationRetry(code), false, code)
})
