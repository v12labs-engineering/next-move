import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const alice = "00000000-0000-4000-8000-000000000001"
const bob = "00000000-0000-4000-8000-000000000002"

test("unconfirmed retries require the owner and current revision and reopen for explicit review", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated;
      create table public.job_catalog(id text primary key);
      insert into auth.users values('${alice}'),('${bob}');
    `)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290004_application_runner.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(`alter table application_runs add column automatic boolean default true,
      add column auto_submit_requested_at timestamptz default now(),
      add column preparation_token uuid, add column decision_attempts integer default 60,
      add column automatic_retry_count integer default 2, add column retry_after timestamptz;
    `)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611050055_retry_unconfirmed_application.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const create = async (
      status = "submission_unknown",
      receipt: string | null = null
    ) => {
      await db.exec("reset role")
      const {
        rows: [r],
      } = await db.query<{ id: string }>(
        `insert into application_runs(user_id,target_url,status,revision,packet,approved_packet,approved_revision,approved_at,prepare_attempts,receipt)
        values($1,gen_random_uuid()::text,$2,3,'{"resume":"saved"}','{"resume":"saved"}',3,now(),3,$3::jsonb) returning id`,
        [alice, status, receipt]
      )
      await db.exec(
        `set role authenticated; select set_config('request.jwt.claim.sub','${alice}',false)`
      )
      return r.id
    }
    const retry = async (id: string, revision = 3) =>
      (
        await db.query<{ revision: number | null }>(
          "select retry_unconfirmed_application($1,$2) revision",
          [id, revision]
        )
      ).rows[0].revision
    const id = await create()
    await db.exec(`select set_config('request.jwt.claim.sub','${bob}',false)`)
    assert.equal(await retry(id), null)
    await db.exec(`select set_config('request.jwt.claim.sub','${alice}',false)`)
    assert.equal(await retry(id, 2), null)
    assert.equal(await retry(id), 4)
    assert.equal(await retry(id), null)
    const {
      rows: [run],
    } = await db.query<Record<string, unknown>>(
      "select * from application_runs where id=$1",
      [id]
    )
    assert.equal(run.status, "ready")
    assert.deepEqual(run.packet, { resume: "saved" })
    assert.equal(run.automatic, false)
    assert.equal(run.decision_attempts, 0)
    assert.equal(run.automatic_retry_count, 0)
    for (const key of [
      "approved_packet",
      "approved_revision",
      "approved_at",
      "auto_submit_requested_at",
      "started_at",
      "retry_after",
    ])
      assert.equal(run[key], null)
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_events where application_id=$1 order by id",
          [id]
        )
      ).rows[0].status,
      "submission_unknown"
    )
    for (const status of [
      "submitted",
      "running",
      "submitting",
      "queued",
      "ready",
      "needs_attention",
      "cancelled",
    ]) {
      assert.equal(
        await retry(
          await create(
            status,
            status === "submitted" ? '{"text":"confirmed"}' : null
          )
        ),
        null
      )
    }
    assert.equal(
      await retry(await create("submission_unknown", '{"text":"confirmed"}')),
      null
    )
    await db.exec("reset role; set role anon")
    await assert.rejects(retry(id), /permission denied/)
    await db.exec("reset role; set role service_role")
    await assert.rejects(retry(id), /permission denied/)
  } finally {
    await db.close()
  }
})
