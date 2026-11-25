import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
const alice = "00000000-0000-4000-8000-000000000001",
  bob = "00000000-0000-4000-8000-000000000002"

test("individual retries preserve upstream work, ownership, quotas and send boundaries", async (t) => {
  const db = new PGlite()
  const query = <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => db.query<T>(sql, params)
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;insert into auth.users values('${alice}'),('${bob}');
create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
create table public.account_profiles(user_id uuid primary key);create table public.account_ai_usage(user_id uuid,day date,attempts integer,primary key(user_id,day));create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
create table public.test_quota(allowed boolean,calls integer);insert into public.test_quota values(true,0);
create function public.reserve_tailoring_attempt() returns boolean language plpgsql as $$declare ok boolean;begin update public.test_quota set calls=calls+1 returning allowed into ok;return ok;end$$;
insert into public.account_profiles values('${alice}'),('${bob}');`)
    for (const migration of [
      "202610290004_application_runner.sql",
      "202610290005_application_claim.sql",
      "202610300001_automatic_applications.sql",
      "202610300002_site_independent_applications.sql",
      "202611010034_application_tasks.sql",
      "202611020042_application_step_retry.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${migration}`, import.meta.url),
          "utf8"
        )
      )
    const create = async (
      status = "needs_attention",
      stage = "tailor_resume",
      upstream = true
    ) => {
      await db.exec("reset role")
      const {
        rows: [{ id }],
      } = await query<{ id: string }>(
        `insert into application_runs(user_id,target_url,status,revision,prepare_attempts,packet,approved_packet,approved_revision,approved_at,automatic,auto_submit_requested_at,preparation_token,receipt) values($1,'https://employer.example/apply/'||gen_random_uuid()::text,$2,2,1,'{"private":"old packet"}','{"private":"old packet"}',2,now(),true,now(),gen_random_uuid(),case when $2='submitted' then '{"text":"existing receipt"}'::jsonb else null end) returning id`,
        [alice, status]
      )
      if (upstream)
        for (const s of ["load_source", "read_employer_form"])
          await query(
            "insert into application_tasks(application_id,revision,stage,state,output) values($1,2,$2,'completed',$3::jsonb)",
            [id, s, JSON.stringify({ privateCheckpoint: s })]
          )
      await query(
        "insert into application_tasks(application_id,revision,stage,state,error_code) values($1,2,$2,'blocked','unexpected_failure')",
        [id, stage]
      )
      await db.exec(
        `set role authenticated;select set_config('request.jwt.claim.sub','${alice}',false)`
      )
      return id
    }
    await t.test(
      "tailoring retry copies only completed upstream outputs into a fenced new revision",
      async () => {
        const id = await create()
        const result = await query<{ revision: number }>(
          "select retry_application_step($1,2,'tailor_resume') revision",
          [id]
        )
        assert.equal(result.rows[0].revision, 3)
        assert.equal(
          (
            await query(
              "select retry_application_step($1,2,'tailor_resume') revision",
              [id]
            )
          ).rows[0].revision,
          null
        )
        await assert.rejects(
          query(
            "select output from application_tasks where application_id=$1",
            [id]
          ),
          /permission denied/
        )
        await db.exec("reset role")
        const {
          rows: [run],
        } = await query(
          "select status,revision,prepare_attempts,packet,approved_packet,approved_revision,approved_at,auto_submit_requested_at,preparation_token from application_runs where id=$1",
          [id]
        )
        assert.equal(run.status, "queued_prepare")
        assert.equal(run.revision, 3)
        assert.equal(run.prepare_attempts, 2)
        for (const key of [
          "packet",
          "approved_packet",
          "approved_revision",
          "approved_at",
          "auto_submit_requested_at",
          "preparation_token",
        ])
          assert.equal(run[key], null)
        const { rows: copied } = await query(
          "select stage,state,output from application_tasks where application_id=$1 and revision=3 order by stage",
          [id]
        )
        assert.equal(copied.length, 2)
        for (const task of copied) {
          assert.equal(task.state, "completed")
          assert.deepEqual(task.output, { privateCheckpoint: task.stage })
        }
        assert.equal(
          (
            await query(
              "select state from application_tasks where application_id=$1 and revision=2 and stage='tailor_resume'",
              [id]
            )
          ).rows[0].state,
          "blocked"
        )
        assert.equal(
          (
            await query(
              "select record_application_task($1,2,gen_random_uuid(),'tailor_resume','start') result",
              [id]
            )
          ).rows[0].result,
          null
        )
      }
    )
    await t.test(
      "another account, stale revisions, completed steps and all send stages cannot retry",
      async () => {
        const id = await create()
        await db.exec(
          `select set_config('request.jwt.claim.sub','${bob}',false)`
        )
        assert.equal(
          (
            await query(
              "select retry_application_step($1,2,'tailor_resume') result",
              [id]
            )
          ).rows[0].result,
          null
        )
        await db.exec(
          `select set_config('request.jwt.claim.sub','${alice}',false)`
        )
        for (const [rev, stage] of [
          [1, "tailor_resume"],
          [2, "load_source"],
          [2, "submit"],
          [2, "confirm"],
          [2, "fill_employer_form"],
          [2, "unrecognized"],
        ])
          assert.equal(
            (
              await query("select retry_application_step($1,$2,$3) result", [
                id,
                rev,
                stage,
              ])
            ).rows[0].result,
            null
          )
        await db.exec("reset role;set role anon")
        await assert.rejects(
          query("select retry_application_step($1,2,'tailor_resume')", [id]),
          /permission denied/
        )
      }
    )
    await t.test(
      "active, cancelled, sent and uncertain submissions are excluded",
      async () => {
        for (const status of [
          "preparing",
          "queued_prepare",
          "running",
          "submitting",
          "submitted",
          "submission_unknown",
          "cancelled",
        ]) {
          const id = await create(status)
          assert.equal(
            (
              await query(
                "select retry_application_step($1,2,'tailor_resume') result",
                [id]
              )
            ).rows[0].result,
            null
          )
        }
      }
    )
    await t.test(
      "missing checkpoints and exhausted quota cannot partially reset a run",
      async () => {
        const id = await create("needs_attention", "tailor_resume", false)
        await assert.rejects(
          query("select retry_application_step($1,2,'tailor_resume')", [id]),
          /checkpoint unavailable/
        )
        const limited = await create()
        await db.exec(
          "reset role;update test_quota set allowed=false;set role authenticated"
        )
        await assert.rejects(
          query("select retry_application_step($1,2,'tailor_resume')", [
            limited,
          ]),
          /Monthly AI limit/
        )
        await db.exec("reset role")
        assert.equal(
          (
            await query("select revision from application_runs where id=$1", [
              limited,
            ])
          ).rows[0].revision,
          2
        )
        await db.exec("update test_quota set allowed=true")
        await query(
          "update application_runs set prepare_attempts=3 where id=$1",
          [limited]
        )
        await db.exec("set role authenticated")
        assert.equal(
          (
            await query(
              "select retry_application_step($1,2,'tailor_resume') result",
              [limited]
            )
          ).rows[0].result,
          null
        )
      }
    )
    await t.test(
      "a load-source retry needs no upstream checkpoint",
      async () => {
        const id = await create("needs_attention", "load_source", false)
        assert.equal(
          (
            await query(
              "select retry_application_step($1,2,'load_source') result",
              [id]
            )
          ).rows[0].result,
          3
        )
      }
    )
  } finally {
    await db.close()
  }
})
