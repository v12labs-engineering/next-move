import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { rpcError } from "@/lib/server/applications/store"
import { apiError } from "@/lib/server/http"

const alice = "00000000-0000-4000-8000-000000000001"
const migrations = [
  "202610290004_application_runner",
  "202610290005_application_claim",
  "202610300001_automatic_applications",
  "202610300002_site_independent_applications",
  "202610300018_monthly_plan_limits",
  "202610310001_application_computer_budget",
  "202610310002_monthly_usage_counter",
  "202611010031_application_profile_daily_limit",
  "202611190097_remove_application_daily_limit",
]

async function database() {
  const db = new PGlite()
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;insert into auth.users values('${alice}');
 create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
 create table public.account_profiles(user_id uuid primary key,data jsonb default '{}');
 create table public.account_ai_usage(user_id uuid,day date,attempts integer not null check(attempts between 1 and 10),primary key(user_id,day));
 create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
 create function public.reserve_tailoring_attempt() returns boolean language sql as $$ select true $$;
 insert into public.account_profiles(user_id) values('${alice}');
 insert into public.job_catalog(id,title,company,url) select 'job-'||i,'Engineer','Co '||i,'https://jobs.ashbyhq.com/co'||i||'/1af7a193-334d-4d5c-b45d-25012'||lpad(i::text,7,'0') from generate_series(1,12) i;`)
  for (const name of migrations)
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
        "utf8"
      )
    )
  return db
}

test("exhausted AI allowance explains why Tailor & apply is blocked below the application cap", async () => {
  const db = await database()
  try {
    await db.query("insert into account_ai_usage values($1,current_date,30)", [
      alice,
    ])
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    let failure: unknown
    try {
      await db.query("select request_automatic_application('job-1')")
      assert.fail("The exhausted AI allowance must block admission")
    } catch (error) {
      failure = error
    }
    assert.match((failure as Error).message, /Monthly AI limit reached/)
    try {
      rpcError(failure as { code: string; message: string })
      assert.fail("The RPC error must reach the API response")
    } catch (error) {
      const response = apiError(error)
      assert.equal(response.status, 429)
      assert.match(
        (await response.json()).error,
        /AI request allowance.*30 days/
      )
    }
    const usage = (
      await db.query<{ applications_used: number }>(
        "select * from account_usage()"
      )
    ).rows[0]
    assert.equal(usage.applications_used, 0)
  } finally {
    await db.close()
  }
})

test("manual and background admissions ignore a saved daily cap and deduplicate repeat requests", async () => {
  const db = await database()
  try {
    await db.query(
      "update account_profiles set data=$1::jsonb where user_id=$2",
      [JSON.stringify({ autoApply: { dailyLimit: 2 } }), alice]
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    const first = (
      await db.query<{ id: string }>(
        "select request_automatic_application('job-1') id"
      )
    ).rows[0].id
    await db.query("select create_application('job-2')")
    await db.query("select create_application('job-3')")
    assert.equal(
      (
        await db.query<{ id: string }>(
          "select request_automatic_application('job-1') id"
        )
      ).rows[0].id,
      first
    )
    await db.exec("reset role;set role service_role")
    await db.query("select request_automatic_application_for($1,'job-4')", [
      alice,
    ])
    await db.exec("reset role")
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select sum(attempts)::integer n from account_ai_usage"
        )
      ).rows[0].n,
      4
    )
  } finally {
    await db.close()
  }
})

test("local Compose admits AI work above the default allowance and still records usage", async () => {
  const db = await database()
  try {
    await db.query(
      "insert into account_ai_usage values($1,(now() at time zone 'UTC')::date,30)",
      [alice]
    )
    await db.exec(
      await readFile(
        new URL("../deploy/local/ai-allowance.sql", import.meta.url),
        "utf8"
      )
    )
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    const reservation = await db.query<{ ok: boolean }>(
      "select reserve_tailoring_attempt() ok"
    )
    assert.equal(reservation.rows[0].ok, true)
    const application = await db.query<{ id: string }>(
      "select create_application('job-1') id"
    )
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='preparing' where id=$1",
      [application.rows[0].id]
    )
    await db.exec("set role service_role")
    const decision = await db.query<{ ok: boolean }>(
      "select reserve_application_decision($1) ok",
      [application.rows[0].id]
    )
    assert.equal(decision.rows[0].ok, true)
    await db.exec("reset role;set role authenticated")
    const usage = await db.query(
      "select ai_used, ai_limit, applications_limit from account_usage()"
    )
    assert.deepEqual(usage.rows, [
      { ai_used: 33, ai_limit: 2147483647, applications_limit: 10 },
    ])
  } finally {
    await db.close()
  }
})

test("visual turns enforce both a 32-decision revision ceiling and the unchanged account AI quota", async () => {
  const db = await database()
  try {
    await db.exec(
      "insert into plans values('computer-qa',100,100);insert into account_plans(user_id,plan) values('" +
        alice +
        "','computer-qa')"
    )
    const id = "00000000-0000-4000-8000-000000000099"
    await db.query(
      "insert into application_runs(id,user_id,target_url,status) values($1,$2,'https://synthetic.example.test/application','preparing')",
      [id, alice]
    )
    await db.exec("set role service_role")
    for (let i = 0; i < 32; i++)
      assert.equal(
        (
          await db.query<{ ok: boolean }>(
            "select reserve_application_decision($1) ok",
            [id]
          )
        ).rows[0].ok,
        true
      )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select reserve_application_decision($1) ok",
          [id]
        )
      ).rows[0].ok,
      false
    )
    await db.exec("reset role")
    assert.equal(
      (
        await db.query<{ used: number }>(
          "select attempts used from account_ai_usage where user_id=$1",
          [alice]
        )
      ).rows[0].used,
      32
    )
    await db.query(
      "update application_runs set decision_attempts=0 where id=$1",
      [id]
    )
    await db.query(
      "update account_ai_usage set attempts=100 where user_id=$1",
      [alice]
    )
    await db.exec("set role service_role")
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select reserve_application_decision($1) ok",
          [id]
        )
      ).rows[0].ok,
      false
    )
    await db.exec("reset role;set role authenticated")
    await assert.rejects(
      db.query("select reserve_application_decision($1)", [id]),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})

test("free plan allows 10 applications and 30 AI requests per 30 days", async () => {
  const db = await database()
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      alice,
    ])
    await db.exec("set role authenticated")
    for (let i = 1; i <= 10; i++)
      await db.query("select request_automatic_application($1)", [`job-${i}`])
    await assert.rejects(
      db.query("select create_application('job-11')"),
      /Monthly application limit reached/
    )
    const usage = (
      await db.query<{
        applications_used: number
        applications_limit: number
        ai_used: number
      }>("select * from account_usage()")
    ).rows[0]
    assert.equal(usage.applications_used, 10)
    assert.equal(usage.applications_limit, 10)
    assert.equal(usage.ai_used, 10)
    for (let i = 0; i < 20; i++)
      assert.equal(
        (
          await db.query<{ ok: boolean }>(
            "select reserve_tailoring_attempt() ok"
          )
        ).rows[0].ok,
        true
      )
    assert.equal(
      (await db.query<{ ok: boolean }>("select reserve_tailoring_attempt() ok"))
        .rows[0].ok,
      false
    )
    await assert.rejects(
      db.query("select request_automatic_application_for($1,'job-12')", [
        alice,
      ]),
      /permission denied/
    )
    await db.exec("reset role")
    // Usage older than 30 days no longer counts; plans are data.
    await db.exec(
      "update application_runs set created_at=now()-interval '31 days';update account_ai_usage set day=day-31"
    )
    await db.exec("insert into plans values('pro',600,900)")
    await db.query("insert into account_plans(user_id,plan) values($1,'pro')", [
      alice,
    ])
    await db.exec("set role service_role")
    const id = (
      await db.query<{ id: string }>(
        "select request_automatic_application_for($1,'job-12') id",
        [alice]
      )
    ).rows[0].id
    const run = (
      await db.query<{ automatic: boolean; user_id: string }>(
        "select automatic,user_id from application_runs where id=$1",
        [id]
      )
    ).rows[0]
    assert.equal(run.automatic, true)
    assert.equal(run.user_id, alice)
  } finally {
    await db.close()
  }
})
