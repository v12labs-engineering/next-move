import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"

const alice = "00000000-0000-4000-8000-000000000001"
const bob = "00000000-0000-4000-8000-000000000002"

test("precomputed matches publish atomically, paginate, keep live statuses and fence stale workers", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      create table account_profiles(user_id uuid primary key references auth.users,version integer not null,data jsonb default '{}');
      create table account_countries(user_id uuid,country text);
      create table job_catalog(id text primary key,country text default 'India',is_active boolean default true,last_checked_at timestamptz default now());
      create table account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
      insert into auth.users values('${alice}'),('${bob}');
      insert into account_profiles(user_id,version) values('${alice}',1),('${bob}',1);
      insert into account_countries values('${alice}','India'),('${alice}','Canada'),('${bob}','India');
      insert into job_catalog(id) select 'job-'||n from generate_series(1,205) n;
      update job_catalog set country='Canada' where id='job-1';
      create index job_catalog_active_matching_cursor_idx on job_catalog(country,id) include(last_checked_at) where is_active;
      grant select on account_profiles,job_catalog,account_job_states to service_role;`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610310011_precomputed_matches.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const readerMigration = await readFile(
      new URL(
        "../supabase/migrations/202610310015_match_posting_window.sql",
        import.meta.url
      ),
      "utf8"
    )
    await db.exec(readerMigration)
    const rpc = async <T>(sql: string, values: unknown[] = []) =>
      (await db.query<{ result: T }>(`select ${sql} as result`, values)).rows[0]
        .result
    const read = async (filters = {}) =>
      rpc<{
        jobs: { id: string; status: string }[]
        total: number
        offset: number
        generation: string | null
        counts: {
          toReview: number
          confirmed: number
          fresh: number
          new: number
        }
        matching: { stale: boolean; status: string }
      }>("read_account_matches($1)", [filters])
    const claim = async () =>
      rpc<{ token: string; profileVersion: number } | null>(
        "claim_account_matching($1)",
        [alice]
      )
    const stage = async (token: string, jobs: unknown[]) =>
      rpc("stage_account_matches($1,$2,$3)", [alice, token, jobs])
    const publish = async (token: string, count: number) =>
      rpc<boolean>("publish_account_matches($1,$2,$3,$4)", [
        alice,
        token,
        { catalog: { totalJobs: 205 } },
        count,
      ])
    const jobs = Array.from({ length: 205 }, (_, i) => ({
      id: `job-${i + 1}`,
      title: "Nurse",
      company: `Hospital ${i}`,
      country: i === 0 ? "Canada" : "India",
      url: `https://example.com/${i}`,
      status: "new",
      isActive: true,
      seenAt: new Date().toISOString(),
      postedDate: new Date().toISOString(),
      freshness: "fresh",
      visaSignal: "possible",
      match: {
        score: 205 - i,
        relevant: true,
        reviewable: true,
        eligible: i % 2 === 0,
      },
    }))
    await db.exec("set role service_role")
    const run = (await claim())!
    assert.ok(run.token)
    assert.equal(
      await claim(),
      null,
      "concurrent requests must reuse an active run"
    )
    await stage(run.token, jobs.slice(0, 200))
    await stage(run.token, jobs.slice(200))
    await db.exec(
      `reset role; set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    assert.equal(
      (await read()).jobs.length,
      0,
      "partial builds must be invisible"
    )
    await assert.rejects(claim(), /permission denied/)
    await assert.rejects(
      db.query(
        "insert into account_match_jobs(user_id,generation,job_id,job) values($1,$2,'forged','{}')",
        [alice, run.token]
      ),
      /permission denied/
    )
    await db.exec("reset role; set role service_role")
    await assert.rejects(publish(run.token, 204), /Incomplete/)
    assert.equal(await publish(run.token, 205), true)
    assert.equal(
      await publish(run.token, 205),
      true,
      "publication retry is idempotent"
    )
    await db.exec(
      `reset role; set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    const first = await read({ limit: 100, sort: "score", country: "all" })
    const second = await read({ limit: 100, offset: 100, sort: "score" })
    const last = await read({ limit: 100, offset: 200, sort: "score" })
    assert.equal(first.total, 205)
    assert.deepEqual(
      [first.jobs.length, second.jobs.length, last.jobs.length],
      [100, 100, 5]
    )
    assert.equal(
      new Set([...first.jobs, ...second.jobs, ...last.jobs].map((j) => j.id))
        .size,
      205
    )
    assert.equal((await read({ limit: 10000 })).jobs.length, 200)
    assert.equal((await read({ strict: true })).total, 103)
    assert.equal((await read({ country: "Canada" })).total, 1)
    assert.equal(first.jobs[0].id, "job-1")
    assert.equal((await read({ query: "hospital 204" })).jobs[0].id, "job-205")
    assert.equal((await read({ visa: "confirmed" })).total, 0)
    assert.equal(
      (await read({ visa: "confirmed", visaExempt: ["Canada"] })).total,
      1
    )
    await db.exec(
      `reset role; insert into account_job_states values('${alice}','job-1','dismissed',now()); set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    assert.equal((await read()).total, 204)
    assert.equal((await read({ view: "saved" })).jobs[0].status, "dismissed")
    await db.exec(`set request.jwt.claim.sub='${bob}'`)
    assert.equal((await read()).total, 0)
    assert.equal(
      (await db.query("select * from account_match_jobs")).rows.length,
      0
    )
    await db.exec("reset role; set role anon")
    await assert.rejects(read(), /permission denied/)
    await db.exec(
      `reset role; update account_profiles set version=2 where user_id='${alice}'; set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    assert.equal((await read()).total, 0, "old profile scores cannot be served")
    await db.exec("reset role; set role service_role")
    const newer = (await claim())!
    assert.notEqual(newer.token, run.token)
    await assert.rejects(stage(run.token, jobs), /superseded/)
    await stage(newer.token, jobs.slice(0, 200))
    await stage(newer.token, jobs.slice(200))
    await db.exec(
      `reset role; update account_profiles set version=3 where user_id='${alice}'; set role service_role`
    )
    assert.equal(
      await publish(newer.token, 205),
      false,
      "profile edits fence old results"
    )
    const latest = (await claim())!
    await stage(latest.token, jobs.slice(0, 200))
    await stage(latest.token, jobs.slice(200))
    assert.equal(await publish(latest.token, 205), true)
    await db.exec(
      `reset role; update job_catalog set is_active=false where id='job-2'; set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    const changed = await read()
    assert.equal(changed.matching.stale, true)
    assert.equal(
      changed.total,
      203,
      "closed jobs disappear without waiting for a rebuild"
    )
    await db.exec("reset role; set role service_role")
    const rebuilding = (await claim())!
    await stage(rebuilding.token, jobs.slice(0, 10))
    await db.exec(
      `reset role; set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    assert.equal(
      (await read()).total,
      203,
      "partial refreshes retain the complete previous generation"
    )
    assert.equal((await read()).matching.status, "running")
    await db.exec("reset role; set role service_role")
    await rpc("fail_account_matching($1,$2)", [alice, rebuilding.token])
    assert.equal(await claim(), null, "failure cooldown prevents retry storms")
    await db.exec(
      `reset role; set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    assert.equal((await read()).total, 203)
    assert.equal((await read()).matching.status, "failed")
    await db.exec(
      `reset role; update account_match_state set retry_at=now()-interval '1 second' where user_id='${alice}'; set role service_role`
    )
    const recovery = (await claim())!
    await stage(recovery.token, jobs.slice(0, 10))
    await rpc("reset_account_matches($1,$2)", [alice, recovery.token])
    assert.equal(
      (
        await db.query("select * from account_match_jobs where generation=$1", [
          recovery.token,
        ])
      ).rows.length,
      0
    )
    await stage(recovery.token, jobs.slice(0, 200))
    await stage(recovery.token, jobs.slice(200))
    assert.equal(await publish(recovery.token, 205), true)
    await db.exec(
      `reset role; set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    const resetPage = await read({ generation: latest.token, offset: 100 })
    assert.equal(
      resetPage.offset,
      0,
      "a changed generation restarts pagination"
    )
    assert.equal(resetPage.generation, recovery.token)
    await db.exec(
      `reset role; update account_match_state set computed_at=now()-interval '16 minutes' where user_id='${alice}'; set role service_role`
    )
    const expiring = (await claim())!
    await db.exec(
      `reset role; update account_match_state set lease_until=now()-interval '1 second' where user_id='${alice}'; set role service_role`
    )
    const replacement = (await claim())!
    assert.notEqual(replacement.token, expiring.token)
    await assert.rejects(stage(expiring.token, jobs.slice(0, 1)), /superseded/)
    await db.exec("reset role")
    // An unrelated global catalogue must not become the reader's scan range.
    await db.exec(
      "insert into job_catalog(id) select 'unrelated-'||n from generate_series(1,20000) n; analyze"
    )
    const start = readerMigration.indexOf("with owned_scores as materialized (")
    const query = readerMigration
      .slice(start, readerMigration.indexOf(" into result;", start))
      .replaceAll("s.profile_version=v", "true")
      .replaceAll("s.generation", "$2")
      .replace(/\bu\b/g, "$1")
      .replace(/\bp_filters\b/g, "($3::jsonb)")
      .replace(/\blim\b/g, "$4")
      .replace(/\boff\b/g, "$5")
    const plans = await db.query("explain (format json) " + query, [
      alice,
      recovery.token,
      { view: "jobs", sort: "score" },
      25,
      0,
    ])
    const scans: Record<string, unknown>[] = []
    function visit(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (value && typeof value === "object") {
        const node = value as Record<string, unknown>
        if (node["Relation Name"] === "job_catalog") scans.push(node)
        Object.values(node).forEach(visit)
      }
    }
    visit(plans.rows)
    assert.ok(scans.length > 0)
    assert.ok(
      scans.every(
        (scan) =>
          scan["Node Type"] === "Index Only Scan" &&
          scan["Index Name"] === "job_catalog_active_matching_cursor_idx" &&
          String(scan["Index Cond"]).includes("job_id")
      ),
      "availability must use bounded covering-index lookups for owned score IDs"
    )
    const settings = await db.query<{ proconfig: string[] }>(
      "select proconfig from pg_proc where proname='read_account_matches'"
    )
    assert.ok(
      settings.rows[0].proconfig.includes("plan_cache_mode=force_custom_plan")
    )
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='${alice}'`
    )
    for (let i = 0; i < 12; i++) {
      assert.equal(
        (await read({ country: i % 2 ? "Canada" : "India" })).total,
        i % 2 ? 0 : 203
      )
    }

    // A fixed transaction time makes exact rolling-window boundaries testable.
    await db.exec(`reset role; begin;
      update account_match_jobs set job=job || jsonb_build_object('postedDate',now()-interval '60 days')
        where user_id='${alice}' and generation='${recovery.token}';
      update account_match_jobs m set job=m.job || jsonb_build_object('postedDate',x.posted)
        from (values ('job-3',now()-interval '1 day'),('job-4',now()-interval '7 days'),
          ('job-5',now()-interval '7 days 1 millisecond'),('job-6',now()-interval '30 days'),
          ('job-7',now()-interval '30 days 1 millisecond'),('job-8',null),
          ('job-9',now()+interval '1 day'),('job-13',null),('job-14',null),
          ('job-15',now()-interval '1 day')) x(id,posted)
        where m.job_id=x.id and m.user_id='${alice}' and m.generation='${recovery.token}';
      update account_match_jobs set job=job || jsonb_build_object('seenAt',now()-interval '60 days')
        where user_id='${alice}' and job_id='job-3';
      insert into account_job_states values
        ('${alice}','job-10','applied',now()),('${alice}','job-11','interested',now()),
        ('${alice}','job-12','dismissed',now()),('${alice}','job-13','interested',now()),
        ('${alice}','job-14','applied',now());
      update job_catalog set is_active=false where id in ('job-10','job-11');
      update job_catalog set last_checked_at=now()-interval '8 days' where id='job-15';
      set role authenticated; set request.jwt.claim.sub='${alice}';`)
    const week = await read({ sort: "newest" })
    assert.deepEqual(
      week.jobs.map((job) => job.id),
      ["job-3", "job-4", "job-11", "job-13"]
    )
    assert.equal(week.total, 4)
    assert.equal(week.counts.toReview, 2)
    assert.equal(week.counts.new, 2)
    assert.equal(week.counts.fresh, 1)
    assert.equal((await read({ datePosted: "week" })).total, week.total)
    const month = await read({ datePosted: "month", sort: "newest" })
    assert.deepEqual(
      month.jobs.map((job) => job.id),
      ["job-3", "job-4", "job-5", "job-6", "job-11", "job-13"]
    )
    assert.equal(month.total, 6)
    assert.equal(month.counts.toReview, 4)
    assert.equal(month.counts.new, 4)
    assert.equal(month.counts.fresh, 1)
    assert.deepEqual(
      (
        await read({ datePosted: "month", sort: "newest", limit: 2, offset: 2 })
      ).jobs.map((job) => job.id),
      ["job-5", "job-6"]
    )
    assert.equal((await read({ query: "hospital 4" })).total, 0)
    assert.equal(
      (await read({ query: "hospital 4", datePosted: "month" })).total,
      1
    )
    assert.equal(
      (await read({ hidden: true })).total,
      6,
      "older applied jobs remain accessible; older dismissed jobs do not fill discovery"
    )
    const saved = await read({ view: "saved" })
    assert.deepEqual(
      new Set(saved.jobs.map((job) => job.id)),
      new Set(["job-1", "job-10", "job-11", "job-12", "job-13", "job-14"])
    )
    assert.equal(
      (await read({ view: "saved", datePosted: "month" })).total,
      saved.total
    )
    assert.equal(
      (await read({ view: "all" })).total,
      6,
      "command search follows the default window while retaining saved/applied jobs"
    )
    await db.exec("reset role; rollback")
  } finally {
    await db.close()
  }
})
