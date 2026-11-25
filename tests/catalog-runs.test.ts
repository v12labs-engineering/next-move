import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"

test("collection checkpoints survive restart and stale workers cannot publish or expire jobs", async () => {
  const db = new PGlite()
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role; create type visa_confidence as enum('confirmed','possible','no'); create table job_catalog(id text primary key,title text not null,company text not null,country text not null,city text,url text not null,description text not null,work_mode text not null,visa_signal visa_confidence,sponsorship_evidence text,sponsor_verified boolean,source text,posted_at timestamptz,discovered_at timestamptz default now()); grant all on job_catalog to service_role; create table account_countries(user_id uuid,country text);"
    )
    for (const file of [
      "202610290002_live_catalog.sql",
      "202610290006_catalog_collection.sql",
      "202610290007_catalog_backoff.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${file}`, import.meta.url),
          "utf8"
        )
      )
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select begin_catalog_run('ashby:n8n')"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select * from job_catalog_runs"),
      /permission denied/
    )
    await db.exec("set role service_role")
    const begin = async () =>
      (
        await db.query<{
          run: { id: string; token: string; next_page: number | null }
        }>("select begin_catalog_run('ashby:n8n') run")
      ).rows[0].run
    const first = await begin()
    assert.ok(first.id)
    assert.equal(await begin(), null)
    const posting = {
      id: "nurse-1",
      title: "Registered Nurse",
      company: "Hospital",
      country: "India",
      city: null,
      url: "https://example.com/jobs/1",
      description: "Patient care",
      work_mode: "onsite",
      visa_signal: "possible",
      sponsorship_evidence: "Unknown",
      source: "ashby:n8n",
      posted_at: null,
    }
    await db.query(
      "select checkpoint_catalog_page($1,$2,1,2,$3::jsonb,1,0,1)",
      [first.id, first.token, JSON.stringify([posting])]
    )
    assert.equal((await db.query("select * from job_catalog")).rows.length, 0)
    await db.exec(
      "reset role; update job_catalog_sources set lease_until=now()-interval '1 minute'; set role service_role"
    )
    const resumed = await begin()
    assert.equal(resumed.id, first.id)
    assert.equal(resumed.next_page, 2)
    assert.notEqual(resumed.token, first.token)
    await assert.rejects(
      db.query("select finish_catalog_run($1,$2)", [first.id, first.token]),
      /lease/
    )
    await db.query(
      "select checkpoint_catalog_page($1,$2,2,null,$3::jsonb,1,0,1)",
      [resumed.id, resumed.token, JSON.stringify([posting])]
    )
    const finished = (
      await db.query<{
        result: {
          new_count: number
          duplicate_count: number
          fetched_count: number
        }
      }>("select finish_catalog_run($1,$2) result", [resumed.id, resumed.token])
    ).rows[0].result
    assert.equal(finished.new_count, 1)
    assert.equal(finished.duplicate_count, 1)
    assert.equal(finished.fetched_count, 2)
    assert.equal(
      (await db.query("select * from job_catalog where is_active")).rows.length,
      1
    )
    const next = await begin()
    await db.query("select pause_catalog_run($1,$2,'Source unavailable')", [
      next.id,
      next.token,
    ])
    assert.equal(
      (await db.query("select * from job_catalog where is_active")).rows.length,
      1
    )
    const retry = await begin()
    assert.equal(retry.id, next.id)
    await db.query(
      "select checkpoint_catalog_page($1,$2,1,null,'[]'::jsonb,0,0,1)",
      [retry.id, retry.token]
    )
    const expired = (
      await db.query<{ result: { expired_count: number } }>(
        "select finish_catalog_run($1,$2) result",
        [retry.id, retry.token]
      )
    ).rows[0].result
    assert.equal(expired.expired_count, 1)
    const large = await begin()
    const jobs = Array.from({ length: 5001 }, (_, index) => ({
      ...posting,
      id: `large-${index}`,
      url: `https://example.com/jobs/large-${index}`,
    }))
    await db.query(
      "select checkpoint_catalog_page($1,$2,1,null,$3::jsonb,5001,0,1)",
      [large.id, large.token, JSON.stringify(jobs)]
    )
    // A recovered snapshot must not label old page observations as newly checked.
    await db.exec(
      "reset role; update job_catalog_run_items set observed_at=now()-interval '2 days'; set role service_role"
    )
    await db.query("select finish_catalog_run($1,$2)", [large.id, large.token])
    assert.equal(
      (await db.query("select id from job_catalog where is_active")).rows
        .length,
      5001
    )
    assert.equal(
      (
        await db.query(
          "select id from job_catalog where is_active and last_checked_at<now()-interval '1 day'"
        )
      ).rows.length,
      5001
    )
    const refresh = await begin()
    await db.query(
      "select checkpoint_catalog_page($1,$2,1,null,$3::jsonb,5001,0,1)",
      [refresh.id, refresh.token, JSON.stringify(jobs)]
    )
    await db.exec(
      "reset role; update job_catalog_run_items set observed_at=now()-interval '2 days'; set role service_role"
    )
    const unchanged = (
      await db.query<{ result: { new_count: number; updated_count: number } }>(
        "select finish_catalog_run($1,$2) result",
        [refresh.id, refresh.token]
      )
    ).rows[0].result
    assert.equal(unchanged.new_count, 0)
    assert.equal(unchanged.updated_count, 0)
    assert.equal(
      (
        await db.query(
          "select id from job_catalog where is_active and last_checked_at<now()-interval '1 day'"
        )
      ).rows.length,
      5001
    )
    await db.exec("set role authenticated")
    const health = await db.query<{ countries: string[] }>(
      "select * from catalog_source_health() where id='ashby:n8n'"
    )
    assert.deepEqual(health.rows[0].countries, ["India"])
    await assert.rejects(
      db.query("select * from catalog_source_demand()"),
      /permission denied/
    )
    await db.exec("set role service_role")
    const throttled = await begin()
    await db.query(
      "select defer_catalog_run($1,$2,'Source HTTP 429',3,now()+interval '1 hour')",
      [throttled.id, throttled.token]
    )
    const deferred = (
      await db.query<{ run: { deferred: boolean; retry_at: string } }>(
        "select begin_catalog_run('ashby:n8n') run"
      )
    ).rows[0].run
    assert.equal(deferred.deferred, true)
    assert.ok(deferred.retry_at)
  } finally {
    await db.close()
  }
})
