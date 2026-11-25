import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@supabase/supabase-js"
import {
  cleanupCatalog,
  retainCatalogObservations,
} from "@/lib/server/catalog/retention"

const migration = (file: string) =>
  readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8")

test("retention deletes only expired unprotected jobs, fences reimport and protects shared/in-flight description packs", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create type visa_confidence as enum('confirmed','possible','no');
      create table job_catalog(id text primary key,title text not null default 'Fixture',company text not null default 'Example',country text not null default 'India',city text,url text not null,description text not null default '',work_mode text not null default 'onsite',visa_signal visa_confidence default 'possible',sponsorship_evidence text default '',sponsor_verified boolean default false,source text default 'ashby:n8n',posted_at timestamptz,discovered_at timestamptz default now());
      grant all on job_catalog to service_role;
      create table account_countries(user_id uuid,country text);
      create table account_job_states(user_id text,job_id text references job_catalog on delete cascade,status text);
      create table resume_drafts(id text,job_id text references job_catalog,content text);
      create table application_runs(id text,job_id text references job_catalog,target_url text,status text,receipt jsonb);
      create table account_match_jobs(job_id text references job_catalog on delete cascade);
      create table job_search_runs(id uuid,dispatch_token uuid,status text,created_at timestamptz,countries text[],sources jsonb,results jsonb);
      grant all on account_job_states,resume_drafts,application_runs,account_match_jobs to service_role;`)
    for (const file of [
      "202610290002_live_catalog.sql",
      "202610290006_catalog_collection.sql",
      "202610290007_catalog_backoff.sql",
      "202610310005_catalog_description_objects.sql",
    ])
      await db.exec(await migration(file))
    const matchingMigration = await migration(
      "202610310011_precomputed_matches.sql"
    )
    await db.exec(
      matchingMigration.slice(
        0,
        matchingMigration.indexOf("create table public.account_match_state")
      )
    )
    await db.exec("grant select on catalog_match_revision to service_role")
    const fails = async (
      operation: () => PromiseLike<unknown>,
      pattern: RegExp
    ) => {
      await db.exec("savepoint expected_error")
      try {
        await assert.rejects(async () => operation(), pattern)
      } finally {
        await db.exec(
          "rollback to savepoint expected_error; release savepoint expected_error"
        )
      }
    }
    // The capacity migration renames this helper in the real schema.
    await db.exec(
      "alter function checkpoint_catalog_page(uuid,uuid,integer,integer,jsonb,integer,integer,integer) rename to checkpoint_catalog_page_without_capacity"
    )
    await db.exec(await migration("202610310016_catalog_retention.sql"))
    await db.exec(
      await migration("202610310017_catalog_revision_safe_update.sql")
    )
    await db.exec(`begin;
      -- Seed historical rows as they existed before retention was enabled.
      alter table job_catalog disable trigger a_catalog_retention_insert;
      insert into job_catalog(id,url,posted_at) select id,'https://example.com/'||id,now()-interval '60 days' from unnest(array['old','saved','applied','draft','submitted','cancelled','url-only','dismissed']) id;
      alter table job_catalog enable trigger a_catalog_retention_insert;
      insert into job_catalog(id,url,posted_at) values('cutoff','https://example.com/cutoff',now()-interval '30 days'),('recent','https://example.com/recent',now()-interval '1 day'),('unknown','https://example.com/unknown',null);
      insert into account_job_states values('another-account','saved','interested'),('owner','applied','applied'),('owner','dismissed','dismissed');
      insert into resume_drafts values('draft-record','draft','keep this draft');
      insert into application_runs values('receipt','submitted','https://example.com/submitted','submitted','{"confirmation":"keep-me"}'),('cancelled-run','cancelled','https://example.com/cancelled','cancelled',null),('no-job-id',null,'https://example.com/url-only','submitted','{"confirmation":"keep-too"}');
      insert into account_match_jobs values('old');
      set role authenticated;`)
    for (const sql of [
      "select cleanup_catalog_jobs()",
      "select claim_catalog_content_cleanup()",
      "select catalog_retention_jobs('[]')",
      "select finish_catalog_content_cleanup('{}','00000000-0000-4000-8000-000000000001')",
    ])
      await fails(() => db.query(sql), /permission denied/)
    await db.exec("reset role;set role service_role")
    const rpc = async <T>(sql: string, values: unknown[] = []) =>
      (await db.query<{ r: T }>(`select ${sql} r`, values)).rows[0].r
    const revisionBefore = (
      await db.query<{ revision: number }>(
        "select revision from catalog_match_revision"
      )
    ).rows[0].revision
    await fails(() => rpc("cleanup_catalog_jobs(1001)"), /Invalid/)
    assert.equal(
      (await rpc<{ deleted: number }>("cleanup_catalog_jobs(1)")).deleted,
      1
    )
    assert.equal(
      (await rpc<{ deleted: number }>("cleanup_catalog_jobs(500)")).deleted,
      1
    )
    assert.equal(
      (await rpc<{ deleted: number }>("cleanup_catalog_jobs(500)")).deleted,
      0
    )
    assert.equal(
      (
        await db.query<{ revision: number }>(
          "select revision from catalog_match_revision"
        )
      ).rows[0].revision,
      revisionBefore + 3,
      "cleanup invalidates cached matches through the live statement trigger"
    )
    assert.deepEqual(
      new Set(
        (await db.query<{ id: string }>("select id from job_catalog")).rows.map(
          (r) => r.id
        )
      ),
      new Set([
        "saved",
        "applied",
        "draft",
        "submitted",
        "cancelled",
        "url-only",
        "cutoff",
        "recent",
        "unknown",
      ])
    )
    assert.equal(
      (await db.query("select * from application_runs")).rows.length,
      3
    )
    assert.deepEqual(
      (
        await db.query<{ receipt: unknown }>(
          "select receipt from application_runs where id='receipt'"
        )
      ).rows[0].receipt,
      { confirmation: "keep-me" }
    )
    assert.equal((await db.query("select * from resume_drafts")).rows.length, 1)
    assert.equal(
      (await db.query("select * from account_match_jobs")).rows.length,
      0
    )
    await db.exec(
      "insert into job_catalog(id,url,posted_at) values('old','https://example.com/old',now()-interval '60 days')"
    )
    assert.equal(
      (await db.query("select * from job_catalog where id='old'")).rows.length,
      0,
      "old direct imports cannot return"
    )
    const observations = [
      {
        id: "old",
        posted_at: new Date(Date.now() - 60 * 86400000).toISOString(),
      },
      {
        id: "saved",
        posted_at: new Date(Date.now() - 60 * 86400000).toISOString(),
      },
      { id: "fresh-import", posted_at: new Date().toISOString() },
      { id: "unknown-import", posted_at: null },
    ]
    assert.deepEqual(
      (
        await rpc<{ id: string }[]>("catalog_retention_jobs($1)", [
          observations,
        ])
      ).map((r) => r.id),
      ["saved", "fresh-import", "unknown-import"]
    )
    // Whole unused packs are eligible; mixed, staging-referenced and new uploads are not.
    const ids = ["a", "b", "c", "d"].map((n) => n.repeat(64))
    for (const id of ids)
      await db.query(
        "insert into catalog_content_packs(id,bytes,ready,created_at) values($1,10,true,now()-interval '2 days')",
        [id]
      )
    const ref = (pack: string) => ({
      v: 1,
      pack,
      offset: 0,
      length: 10,
      bytes: 10,
      sha256: "f".repeat(64),
    })
    await db.query(
      "update job_catalog set description_ref=$1 where id='saved'",
      [ref(ids[1])]
    )
    const run = await rpc<{ id: string; token: string }>(
      "begin_catalog_run('ashby:n8n')"
    )
    const posting = {
      id: "staged",
      title: "Fixture",
      company: "Example",
      country: "India",
      url: "https://example.com/staged",
      description: "",
      description_ref: ref(ids[2]),
      work_mode: "onsite",
      visa_signal: "possible",
      source: "ashby:n8n",
      posted_at: null,
    }
    await db.query(
      "select checkpoint_catalog_page_without_capacity($1,$2,1,null,$3,2,0,1)",
      [
        run.id,
        run.token,
        [
          posting,
          {
            ...posting,
            id: "expired-checkpoint",
            posted_at: new Date(Date.now() - 60 * 86400000).toISOString(),
          },
        ],
      ]
    )
    assert.equal(
      (await db.query("select * from job_catalog_run_items")).rows.length,
      1,
      "checkpoints exclude expired new observations"
    )
    await db.query(
      "update catalog_content_packs set created_at=now() where id=$1",
      [ids[3]]
    )
    const claimed = await rpc<{ id: string; token: string }[]>(
      "claim_catalog_content_cleanup()"
    )
    assert.deepEqual(
      claimed.map((p) => p.id),
      [ids[0]]
    )
    await fails(
      () =>
        db.query(
          "update job_catalog set description_ref=$1 where id='recent'",
          [ref(ids[0])]
        ),
      /Unverified/
    )
    await fails(
      () =>
        db.query(
          "insert into job_catalog_run_items(run_id,id,data) values($1,'bad',$2)",
          [run.id, { ...posting, id: "bad", description_ref: ref(ids[0]) }]
        ),
      /Unverified/
    )
    await fails(
      () => rpc("reserve_catalog_content($1,10)", [ids[0]]),
      /being removed/
    )
    assert.deepEqual(
      await rpc("claim_catalog_content_cleanup()"),
      [],
      "active claims are leased to one worker"
    )
    await db.query(
      "update catalog_content_packs set deleting_at=now()-interval '16 minutes' where id=$1",
      [ids[0]]
    )
    const retried = await rpc<{ id: string; token: string }[]>(
      "claim_catalog_content_cleanup()"
    )
    assert.deepEqual(
      retried.map((p) => p.id),
      [ids[0]],
      "failed object deletes are retryable after lease expiry"
    )
    assert.equal(
      await rpc("finish_catalog_content_cleanup($1,$2)", [
        [ids[0]],
        claimed[0].token,
      ]),
      0,
      "a stale worker cannot acknowledge a replacement claim"
    )
    assert.equal(
      await rpc("finish_catalog_content_cleanup($1,$2)", [
        [ids[0], ids[1]],
        retried[0].token,
      ]),
      1
    )
    assert.equal(
      (await db.query("select * from catalog_content_packs")).rows.length,
      3
    )
    await db.query(
      "insert into job_catalog_run_items(run_id,id,data) values($1,'expired-pending',$2)",
      [
        run.id,
        {
          ...posting,
          id: "expired-pending",
          posted_at: new Date(Date.now() - 60 * 86400000).toISOString(),
        },
      ]
    )
    const published = await rpc<{ new_count: number }>(
      "finish_catalog_run_without_capacity($1,$2)",
      [run.id, run.token]
    )
    assert.equal(
      published.new_count,
      1,
      "pending snapshots recheck age before publication and report actual new jobs"
    )
    assert.equal(
      (await db.query("select * from job_catalog where id like 'expired-%'"))
        .rows.length,
      0
    )
    await db.exec("reset role;rollback")
  } finally {
    await db.close()
  }
})

test("retention filters expired new observations before archive and preserves old existing history", async () => {
  const now = new Date("2026-10-31T12:00:00Z")
  const db = createClient("https://fixture.example", "fixture", {
    global: { fetch: async () => Response.json([{ id: "saved" }]) },
  })
  const jobs = [
    { id: "old", posted_at: "2026-09-01" },
    { id: "saved", posted_at: "2026-09-01" },
    { id: "boundary", posted_at: "2026-10-01T12:00:00Z" },
    { id: "unknown", posted_at: null },
  ]
  assert.deepEqual(
    (await retainCatalogObservations(db, jobs, now)).map((j) => j.id),
    ["saved", "boundary", "unknown"]
  )
})

test("object cleanup never frees the ledger after a failed storage deletion", async () => {
  const events: string[] = []
  let fail = true
  const db = createClient("https://fixture.example", "fixture", {
    global: {
      fetch: async (input) => {
        const path = new URL(String(input)).pathname.split("/").at(-1)!
        events.push(path)
        if (path === "cleanup_catalog_jobs")
          return Response.json({ deleted: 2, more: false, busy: false })
        if (path === "claim_catalog_content_cleanup")
          return Response.json([
            {
              id: "a".repeat(64),
              bytes: 100,
              token: "00000000-0000-4000-8000-000000000001",
            },
          ])
        if (path === "job-catalog-content-v1")
          return fail
            ? Response.json({ message: "storage unavailable" }, { status: 500 })
            : Response.json([])
        if (path === "finish_catalog_content_cleanup") return Response.json(1)
        throw new Error(path)
      },
    },
  })
  await assert.rejects(cleanupCatalog(db))
  assert.ok(!events.includes("finish_catalog_content_cleanup"))
  fail = false
  events.length = 0
  const report = await cleanupCatalog(db)
  assert.equal(report.deletedJobs, 2)
  assert.equal(report.deletedPacks, 1)
  assert.equal(report.deletedObjectBytes, 100)
  assert.ok(
    events.indexOf("finish_catalog_content_cleanup") >
      events.indexOf("job-catalog-content-v1")
  )
})
