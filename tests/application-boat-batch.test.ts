import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

async function fixture() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.application_runs (
      id uuid primary key default gen_random_uuid(), user_id uuid, status text,
      retry_after timestamptz, automatic boolean default true,
      auto_submit_requested_at timestamptz, revision integer default 1
    );
    create table public.application_tasks (
      application_id uuid, revision integer, next_retry_at timestamptz
    );
  `)
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202611120071_application_boat_batches.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  const value = async (query: string, args: unknown[]) =>
    (
      await db.query<{ value: Record<string, string | null> | null }>(
        query,
        args
      )
    ).rows[0].value
  return {
    db,
    acquire: (account: string, id: string, seconds = 800) =>
      value("select acquire_application_boat_session($1,$2,$3) value", [
        account,
        id,
        seconds,
      ]),
    check: (batch: string) =>
      value("select check_application_boat_batch($1) value", [batch]),
    publish: (batch: string) =>
      db.query(
        "update application_boat_batches set sandbox_id='bx_abcdefgh',access_url='private' where id=$1",
        [batch]
      ),
    release: (batch: string, id: string) =>
      value("select release_application_boat_session($1,$2) value", [
        batch,
        id,
      ]),
    setIdle: (batch: string, seconds: number) =>
      db.query(
        "update application_boat_batches set idle_since=clock_timestamp()-make_interval(secs=>$2) where id=$1",
        [batch, seconds]
      ),
  }
}

test("a Boat batch is per account and supports two isolated browser leases, including OTP waits", async () => {
  const f = await fixture()
  const [account, other, first, second, third] = Array.from({ length: 5 }, () =>
    randomUUID()
  )
  try {
    const initial = await f.acquire(account, first)
    assert.equal(initial?.batchId, first)
    assert.equal(
      await f.acquire(account, second),
      null,
      "another worker cannot create a second VM"
    )
    const independent = await f.acquire(other, third)
    assert.equal(independent?.batchId, third)
    await f.publish(first)
    assert.equal((await f.acquire(account, second))?.batchId, first)
    assert.equal(
      await f.acquire(account, randomUUID()),
      null,
      "both browser slots are occupied"
    )
    await f.release(first, first)
    await f.setIdle(first, 120)
    assert.ok(
      (await f.check(first))?.checkAt,
      "an active lease keeps the VM running through OTP"
    )
    await f.release(first, second)
    assert.ok(
      (await f.check(first))?.checkAt,
      "the last release starts the idle grace period"
    )
    await f.setIdle(first, 46)
    assert.equal((await f.check(first))?.sandboxId, "bx_abcdefgh")
    assert.equal(
      await f.acquire(account, randomUUID()),
      null,
      "no session may join a stopping VM"
    )
    await f.db.query("delete from application_boat_batches where id=$1", [
      first,
    ])
    const next = randomUUID()
    assert.equal((await f.acquire(account, next))?.batchId, next)
  } finally {
    await f.db.close()
  }
})

test("ready queue work extends the idle grace, and the cap drains stuck batches", async () => {
  const f = await fixture()
  const account = randomUUID()
  const batch = randomUUID()
  try {
    await f.acquire(account, batch)
    await f.publish(batch)
    await f.release(batch, batch)
    await f.setIdle(batch, 50)
    await f.db.query(
      "insert into application_runs(user_id,status) values ($1,'queued')",
      [account]
    )
    assert.ok((await f.check(batch))?.checkAt)
    const next = randomUUID()
    assert.equal((await f.acquire(account, next))?.batchId, batch)
    await f.release(batch, next)
    await f.setIdle(batch, 91)
    assert.equal((await f.check(batch))?.sandboxId, "bx_abcdefgh")
  } finally {
    await f.db.close()
  }
})

test("an expired worker lease releases the VM, even when a retry or candidate answer is pending", async () => {
  const f = await fixture()
  const account = randomUUID()
  const batch = randomUUID()
  try {
    await f.acquire(account, batch)
    await f.publish(batch)
    await f.db.query(
      "update application_boat_sessions set expires_at=now()-interval '1 minute'"
    )
    await f.db.query(
      `insert into application_runs(user_id,status,retry_after)
      values ($1,'queued',now()+interval '5 minutes'),($1,'ready',null)`,
      [account]
    )
    assert.equal((await f.check(batch))?.sandboxId, "bx_abcdefgh")
  } finally {
    await f.db.close()
  }
})

test("VM rotation drains active sessions and batch credentials are service-only", async () => {
  const f = await fixture()
  const account = randomUUID()
  const batch = randomUUID()
  try {
    await f.acquire(account, batch)
    await f.publish(batch)
    await f.db.query(
      "update application_boat_batches set reserved_at=now()-interval '18 minutes'"
    )
    assert.equal(await f.acquire(account, randomUUID()), null)
    assert.ok((await f.check(batch))?.checkAt)
    await f.release(batch, batch)
    assert.equal((await f.check(batch))?.sandboxId, "bx_abcdefgh")
    await f.db.exec("set role authenticated")
    await assert.rejects(f.check(batch), /permission denied/)
    await assert.rejects(
      f.db.query("select access_url from application_boat_batches"),
      /permission denied/
    )
  } finally {
    await f.db.close()
  }
})
