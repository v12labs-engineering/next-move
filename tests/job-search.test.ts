import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  jobSearchPatterns,
  selectSearchSources,
  type SearchSource,
} from "@/lib/server/catalog/search-plan"
import { jobSearchMessage, searchMatchesReady } from "@/lib/jobs/search"

test("an unchanged ready match generation finishes search reporting even when its assessment predates the search", () => {
  const search = { updatedAt: "2026-11-01T00:52:14Z" }
  const assessedAt = "2026-11-01T00:33:28Z"
  assert.equal(
    searchMatchesReady(search, assessedAt, { status: "ready", stale: false }),
    true
  )
  assert.equal(
    searchMatchesReady(search, assessedAt, { status: "running", stale: true }),
    false
  )
  assert.equal(
    searchMatchesReady(search, "2026-11-01T01:00:00Z", {
      status: "ready",
      stale: true,
    }),
    false
  )
  assert.equal(
    searchMatchesReady(null, assessedAt, { status: "ready", stale: false }),
    false
  )
  assert.equal(searchMatchesReady(search, assessedAt), false)
  assert.equal(searchMatchesReady(search, "2026-11-01T01:00:00Z"), true)
})

test("source selection uses actual role titles, shares destination slots and bounds unmeasured exploration", () => {
  const source = (
    id: string,
    titles: string[],
    countries: string[],
    last_success_at: string | null = "2026-10-29"
  ): SearchSource => ({
    id,
    titles,
    countries,
    last_success_at,
    estimated_records: 3,
  })
  const pool = [
    source("alexandria:workable", ["Nurse"], ["India"]),
    source("civil", ["Civil Engineer"], ["India"]),
    source("nurse", ["Registered Nurse"], ["India"]),
    source("other-country", ["Registered Nurse"], ["Canada"]),
    source("uk", ["Nurse"], ["United Kingdom"]),
    ...Array.from({ length: 8 }, (_, i) =>
      source(`india-${i}`, ["Nurse"], ["India"])
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      source(`explore-${i}`, [], ["India"], null)
    ),
  ]
  const selected = selectSearchSources(
    pool,
    ["Nurse"],
    ["India", "United Kingdom"]
  )
  assert.equal(selected.length, 18)
  assert.ok(!selected.includes("alexandria:workable"))
  assert.ok(selected.includes("uk"))
  assert.ok(!selected.includes("civil") && !selected.includes("other-country"))
  assert.equal(selected.filter((id) => id.startsWith("explore")).length, 8)
  assert.deepEqual(
    selectSearchSources(
      [source("civil", ["Civil Engineer"], ["India"])],
      ["Software Engineer"],
      ["India"]
    ),
    []
  )
  assert.ok(jobSearchPatterns(["Software Engineer"]).includes("%backend%"))
  assert.deepEqual(jobSearchPatterns(["Nurse_100%"]), ["%nurse%100%"])
  const destinations = [
    "India",
    "Canada",
    "France",
    "Germany",
    "Australia",
    "Japan",
    "Brazil",
    "Singapore",
  ]
  const worldwide = destinations.map((country, index) =>
    source(`country-${index}`, ["Nurse"], [country])
  )
  const rotated = selectSearchSources(worldwide, ["Nurse"], destinations, 6)
  assert.ok(rotated.includes("country-6") && rotated.includes("country-7"))
  assert.equal(rotated.length, 8)
  assert.ok(
    jobSearchMessage({ search: null, blocked: "account_daily_limit" }).includes(
      "existing matches"
    )
  )
})

test("live search widens across up to 96 boards without admitting unrelated jobs or excluding large employers", () => {
  const pool: SearchSource[] = Array.from({ length: 120 }, (_, index) => ({
    id: `board-${index}`,
    titles: [index === 0 ? "Civil Engineer" : "Software Engineer"],
    countries: ["India"],
    estimated_records: 2000,
    last_success_at: "2026-10-29",
  }))
  const selected = selectSearchSources(pool, ["Software Engineer"], ["India"])
  assert.equal(selected.length, 96)
  assert.equal(new Set(selected).size, 96)
  assert.ok(!selected.includes("board-0"))
  assert.match(
    jobSearchMessage({ search: null, blocked: "storage_limit" }),
    /storage/i
  )
  assert.doesNotMatch(
    jobSearchMessage({ search: null, blocked: "storage_limit" }),
    /cooldown/i
  )
})

test("on-demand admission, ownership, shared quotas and worker fencing execute in Postgres", async (t) => {
  const db = new PGlite()
  const users = [1, 2, 3, 4, 5].map(
    (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  )
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth,public to anon,authenticated,service_role;
   create type visa_confidence as enum('confirmed','possible','no');
   create table job_catalog(id text primary key,title text not null,company text not null,country text not null,city text,url text not null,description text not null,work_mode text not null,visa_signal visa_confidence,sponsorship_evidence text,sponsor_verified boolean,source text,posted_at timestamptz,discovered_at timestamptz default now());
   create table account_profiles(user_id uuid primary key,data jsonb);
   create table account_countries(user_id uuid,country text,primary key(user_id,country));
   grant all on job_catalog,account_profiles,account_countries to service_role;`)
    for (const file of [
      "202610290002_live_catalog.sql",
      "202610290006_catalog_collection.sql",
      "202610290007_catalog_backoff.sql",
      "202610300003_source_discovery.sql",
      "202610300016_on_demand_job_search.sql",
      "202610300017_scoped_catalog_collection.sql",
      "202610310005_catalog_description_objects.sql",
      "202610310006_profile_discovery.sql",
      "202611010035_extended_ats_discovery.sql",
      "202611010036_extended_ats_search.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${file}`, import.meta.url),
          "utf8"
        )
      )
    await db.exec(`
      create table account_job_states(user_id uuid,job_id text references job_catalog on delete cascade,status text);
      create table resume_drafts(job_id text references job_catalog);
      create table application_runs(job_id text references job_catalog,target_url text);
      create table account_match_jobs(job_id text references job_catalog on delete cascade);
      alter function checkpoint_catalog_page(uuid,uuid,integer,integer,jsonb,integer,integer,integer) rename to checkpoint_catalog_page_without_capacity;
    `)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610310016_catalog_retention.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611010037_linkedin_collection.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    for (const [index, id] of users.entries()) {
      await db.query("insert into auth.users values($1)", [id])
      await db.query("insert into account_profiles values($1,$2)", [
        id,
        {
          targetRoles: index === 2 ? ["Accountant"] : [" Nurse ", "NURSE"],
          resumeText: "Private resume must never enter shared work",
          fullName: "Private Person",
        },
      ])
      await db.query("insert into account_countries values($1,'India')", [id])
    }
    const asUser = async (index: number) => {
      await db.exec("reset role")
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        users[index],
      ])
      await db.exec("set role authenticated")
    }
    const operator = () => db.exec("reset role;set role service_role")
    const request = async () =>
      (
        await db.query<{
          result: { search: { id: string }; blocked?: string }
        }>("select request_job_search() result")
      ).rows[0].result
    const status = async () =>
      (
        await db.query<{
          result: {
            id: string
            status: string
            version: number
            publishedRecords: number
          } | null
        }>("select read_job_search() result")
      ).rows[0].result
    let id: string, token: string
    await t.test(
      "anonymous and customers cannot access operator state or progress mutation",
      async () => {
        await db.exec("set role anon")
        await assert.rejects(
          db.query("select request_job_search()"),
          /permission denied/
        )
        await asUser(0)
        for (const table of [
          "job_search_runs",
          "account_job_searches",
          "job_search_requests",
          "job_search_steps",
          "job_search_control",
          "job_search_source_checks",
          "job_search_provider_backoff",
        ])
          await assert.rejects(
            db.query(`select * from ${table}`),
            /permission denied/
          )
        await assert.rejects(
          db.query("select claim_job_search_dispatch(gen_random_uuid())"),
          /permission denied/
        )
        await assert.rejects(
          db.query("select catalog_collection_sources(array['ashby:nurse'])"),
          /permission denied/
        )
        assert.equal(await status(), null)
      }
    )
    await t.test(
      "canonical scopes coalesce concurrent requests and reveal only the caller status",
      async () => {
        await asUser(0)
        const requests = await Promise.all([request(), request()])
        id = requests[0].search.id
        assert.equal(requests[1].search.id, id)
        await asUser(1)
        assert.equal(await status(), null)
        assert.equal((await request()).search.id, id)
        await asUser(2)
        assert.equal((await request()).blocked, "busy")
        assert.equal(await status(), null)
        await operator()
        assert.equal(
          (await db.query("select * from job_search_runs")).rows.length,
          1
        )
        assert.equal(
          (await db.query("select * from job_search_requests")).rows.length,
          2
        )
        const row = (
          await db.query<{ roles: string[]; countries: string[] }>(
            "select * from job_search_runs"
          )
        ).rows[0]
        assert.deepEqual(row.roles, ["nurse"])
        assert.deepEqual(row.countries, ["India"])
        assert.ok(!JSON.stringify(row).includes("Private"))
      }
    )
    await t.test(
      "dispatch is single-owner, expired claims recover, and progress replay is idempotent",
      async () => {
        await operator()
        const claim = async () =>
          (
            await db.query<{ token: string | null }>(
              "select claim_job_search_dispatch($1) token",
              [id]
            )
          ).rows[0].token
        const old = await claim()
        assert.ok(old)
        assert.equal(await claim(), null)
        await db.query(
          "update job_search_runs set dispatch_until=now()-interval '1 second' where id=$1",
          [id]
        )
        token = (await claim())!
        assert.notEqual(token, old)
        await db.query(
          "update job_search_runs set status='running',sources='[\"ashby:nurse\",\"lever:nurse\"]' where id=$1",
          [id]
        )
        const args = [
          id,
          old,
          "pair-0",
          { "ashby:nurse": { status: "published", records: 2 } },
        ]
        await assert.rejects(
          db.query("select record_job_search_step($1,$2,$3,$4)", args),
          /lease lost/
        )
        args[1] = token
        await db.query("select record_job_search_step($1,$2,$3,$4)", args)
        await db.query("select record_job_search_step($1,$2,$3,$4)", args)
        await asUser(0)
        assert.equal((await status())!.version, 1)
        assert.equal((await status())!.publishedRecords, 2)
        await operator()
        await assert.rejects(
          db.query("select record_job_search_step($1,$2,$3,$4)", [
            id,
            token,
            "bad",
            { "ashby:unplanned": { status: "published", records: 2 } },
          ]),
          /Invalid search progress/
        )
      }
    )
    await t.test(
      "saved profile changes cannot display an old scope; per-account limits are atomic",
      async () => {
        await operator()
        await db.query(
          "update account_profiles set data=jsonb_set(data,'{targetRoles}','[\"Accountant\"]') where user_id=$1",
          [users[1]]
        )
        await asUser(1)
        assert.equal(await status(), null)
        assert.equal((await request()).blocked, "account_cooldown")
        await operator()
        await db.query(
          "update job_search_runs set status='completed' where id=$1",
          [id]
        )
        await db.query(
          "update account_job_searches set requested_at=now()-interval '2 hours' where user_id=$1",
          [users[1]]
        )
        await db.exec("update job_search_control set account_daily_requests=1")
        await asUser(1)
        assert.equal((await request()).blocked, "account_daily_limit")
      }
    )
    await t.test(
      "shared daily limit blocks new work while equivalent scopes still reuse completed work",
      async () => {
        await operator()
        await db.exec("update job_search_control set daily_runs=1")
        await asUser(2)
        assert.equal((await request()).blocked, "shared_daily_limit")
        await asUser(3)
        assert.equal((await request()).search.id, id)
        await operator()
        assert.equal(
          (await db.query("select * from job_search_runs")).rows.length,
          1
        )
      }
    )
    await t.test(
      "discovery pool includes large/fresh employers while excluding disabled boards",
      async () => {
        await operator()
        for (const [board, count, fresh, enabled] of [
          ["nurse", 3, false, true],
          ["fresh", 3, true, true],
          ["big", 101, false, true],
          ["disabled", 3, false, false],
        ] as const) {
          await db.query(
            "insert into job_source_directory(id,kind,company,board,enabled,countries) values($1,'ashby','Example',$2,$3,array['India'])",
            [`ashby:${board}`, board, enabled]
          )
          await db.query(
            "insert into job_catalog_sources(id,last_success_at,published_count) values($1,now()-($2::text)::interval,$3)",
            [`ashby:${board}`, fresh ? "10 minutes" : "2 hours", count]
          )
          await db.query(
            "insert into job_catalog(id,title,company,country,url,description,work_mode,source) values($1,'Registered Nurse','Example','India','https://example.invalid/job','Description','onsite',$2)",
            [board, `ashby:${board}`]
          )
        }
        const pool = (
          await db.query<{ pool: SearchSource[] }>(
            "select job_search_source_pool($1,$2) pool",
            [id, ["%nurse%"]]
          )
        ).rows[0].pool
        assert.deepEqual(pool.map((row) => row.id).sort(), [
          "ashby:big",
          "ashby:fresh",
          "ashby:nurse",
        ])
        assert.deepEqual(pool[0].titles, ["Registered Nurse"])
        const scoped = (
          await db.query<{ rows: SearchSource[] }>(
            "select catalog_collection_sources($1) rows",
            [["ashby:nurse", "ashby:disabled", "missing"]]
          )
        ).rows[0].rows
        assert.deepEqual(
          scoped.map((row) => row.id),
          ["ashby:nurse"]
        )
        assert.deepEqual(
          (
            await db.query<{ rows: unknown[] }>(
              "select catalog_collection_sources($1) rows",
              [[]]
            )
          ).rows[0].rows,
          []
        )
      }
    )
    await t.test(
      "profile discovery publishes only observations, preserves other jobs, fences workers and replays atomically",
      async () => {
        await operator()
        await db.exec(
          "reset role;begin;create table catalog_capacity_control(singleton boolean default true,budget_bytes bigint);insert into catalog_capacity_control(budget_bytes) values(419430400);grant select on catalog_capacity_control to service_role;set role service_role;"
        )
        try {
          const run = (
            await db.query<{ id: string; dispatch_token: string }>(
              "insert into job_search_runs(scope_key,roles,countries,status,dispatch_token,sources) values('observation-test',array['nurse'],array['India'],'running',gen_random_uuid(),'[\"ashby:nurse\",\"ashby:fresh\"]') returning id,dispatch_token"
            )
          ).rows[0]
          const job = {
            id: "observed-new",
            title: "Registered Nurse",
            company: "Example",
            country: "India",
            city: null,
            url: "https://example.com/new",
            description: "Current patient-care position",
            work_mode: "onsite",
            visa_signal: "possible",
            sponsorship_evidence: "Unknown",
            sponsor_verified: false,
            source: "ashby:nurse",
            posted_at: null,
          }
          const publish = (
            source: string,
            jobs: unknown[],
            token = run.dispatch_token
          ) =>
            db.query<{
              result: { newRecords: number; records: number; status: string }
            }>(
              "select publish_job_search_source($1,$2,$3,$4,false,null,1) result",
              [run.id, token, source, JSON.stringify(jobs)]
            )
          const rejected = async (
            call: () => Promise<unknown>,
            reason: RegExp
          ) => {
            await db.exec("savepoint rejected_call")
            try {
              await assert.rejects(call(), reason)
            } finally {
              await db.exec("rollback to savepoint rejected_call")
            }
          }
          await rejected(
            () => publish("ashby:nurse", [job], users[0]),
            /lease lost/
          )
          await rejected(() => publish("ashby:unplanned", [job]), /outside/)
          await rejected(
            () => publish("ashby:nurse", [{ ...job, country: "Canada" }]),
            /scope/
          )
          const result = (
            await publish("ashby:nurse", [
              job,
              {
                ...job,
                id: "expired-scoped",
                posted_at: new Date(Date.now() - 60 * 86400000).toISOString(),
              },
            ])
          ).rows[0].result
          assert.equal(result.newRecords, 1)
          assert.equal(result.records, 1)
          assert.equal(
            (
              await db.query(
                "select id from job_catalog where id='expired-scoped'"
              )
            ).rows.length,
            0
          )
          assert.equal(
            (await publish("ashby:nurse", [job])).rows[0].result.newRecords,
            1
          )
          assert.equal(
            (
              await db.query(
                "select id from job_catalog where id='nurse' and is_active"
              )
            ).rows.length,
            1,
            "Unseen jobs cannot be expired by a filtered discovery"
          )
          assert.equal(
            (
              await db.query(
                "select id from job_catalog where id='observed-new'"
              )
            ).rows.length,
            1
          )
          assert.equal(
            (
              await db.query<{ published_count: number }>(
                "select published_count from job_catalog_sources where id='ashby:nurse'"
              )
            ).rows[0].published_count,
            3,
            "Discovery cannot replace full-board health"
          )
          const status = (
            await db.query<{ result: { newRecords: number } }>(
              "select job_search_status_json($1) result",
              [run.id]
            )
          ).rows[0].result
          assert.equal(status.newRecords, 1)
          await db.exec(
            "update job_catalog_sources set lease_until=now()+interval '1 minute' where id='ashby:fresh'"
          )
          assert.equal(
            (
              await publish("ashby:fresh", [
                { ...job, id: "leased-job", source: "ashby:fresh" },
              ])
            ).rows[0].result.status,
            "deferred"
          )
          assert.equal(
            (await db.query("select id from job_catalog where id='leased-job'"))
              .rows.length,
            0
          )
        } finally {
          await db.exec("rollback")
        }
      }
    )
    await t.test(
      "new ATS families enter the scoped source pool after activation",
      async () => {
        await operator()
        await db.exec("begin")
        try {
          for (const [kind, board] of [
            ["smartrecruiters", "example"],
            ["workday", "example.wd5.myworkdayjobs.com~ExternalCareers"],
          ]) {
            const source = `${kind}:${board}`
            await db.query(
              "insert into job_source_directory(id,kind,company,board,enabled,countries) values($1,$2,'Example',$3,true,array['India'])",
              [source, kind, board]
            )
            await db.query(
              "insert into source_candidates(id,kind,board,status,validation) values($1,$2,$3,'activated',$4)",
              [source, kind, board, JSON.stringify({ accepted_count: 5 })]
            )
          }
          const pool = (
            await db.query<{ pool: SearchSource[] }>(
              "select job_search_source_pool($1,$2) pool",
              [id, ["%nurse%"]]
            )
          ).rows[0].pool
          assert.ok(
            pool.some((source) => source.id === "smartrecruiters:example")
          )
          assert.ok(
            pool.some(
              (source) =>
                source.id ===
                "workday:example.wd5.myworkdayjobs.com~ExternalCareers"
            )
          )
        } finally {
          await db.exec("rollback")
        }
      }
    )
    await t.test(
      "LinkedIn configuration is operator-only and observation windows cannot expire unseen jobs",
      async () => {
        await db.exec("reset role;begin")
        try {
          for (const role of ["anon", "authenticated"]) {
            await db.exec(`set role ${role};savepoint rejected`)
            await assert.rejects(
              db.query("select configure_linkedin_source($1)", [
                { keywords: "Nurse", location: "India", country: "India" },
              ]),
              /permission denied/
            )
            await db.exec("rollback to savepoint rejected;reset role")
          }
          await operator()
          await db.exec("savepoint invalid")
          await assert.rejects(
            db.query("select configure_linkedin_source($1)", [
              { keywords: "Nurse" },
            ]),
            /Invalid/
          )
          await db.exec("rollback to savepoint invalid")
          const query = {
            keywords: "Nurse",
            location: "India",
            country: "India",
          }
          const configure = () =>
            db.query<{ source: { config: { queries: unknown[] } } }>(
              "select configure_linkedin_source($1) source",
              [query]
            )
          await configure()
          assert.equal(
            (await configure()).rows[0].source.config.queries.length,
            1
          )
          const pool = (
            await db.query<{ pool: SearchSource[] }>(
              "select job_search_source_pool($1,$2) pool",
              [id, ["%nurse%"]]
            )
          ).rows[0].pool
          assert.ok(pool.some((row) => row.id === "linkedin"))
          const selected = (
            await db.query<{ sources: { id: string; config: unknown }[] }>(
              "select catalog_collection_sources(array['linkedin']) sources"
            )
          ).rows[0].sources
          assert.deepEqual(selected[0].config, { queries: [query] })
          const job = {
            id: "linkedin-observed",
            title: "Registered Nurse",
            company: "Example Hospital",
            country: "India",
            city: "Hyderabad",
            url: "https://www.linkedin.com/jobs/view/1234567890/",
            description:
              "Provide patient care and maintain accurate clinical records. ".repeat(
                5
              ),
            work_mode: "unknown",
            visa_signal: "possible",
            sponsorship_evidence: "Unknown",
            sponsor_verified: false,
            source: "linkedin",
            posted_at: new Date().toISOString(),
          }
          async function publish(jobs: unknown[]) {
            const run = (
              await db.query<{ run: { id: string; token: string } }>(
                "select begin_catalog_run('linkedin') run"
              )
            ).rows[0].run
            await db.query(
              "select checkpoint_catalog_page_without_capacity($1,$2,1,null,$3,1,0,2)",
              [run.id, run.token, jobs]
            )
            return (
              await db.query<{
                result: { expired_count: number; new_count: number }
              }>("select finish_catalog_run_without_capacity($1,$2) result", [
                run.id,
                run.token,
              ])
            ).rows[0].result
          }
          assert.equal((await publish([job])).new_count, 1)
          assert.equal(
            (await publish([job])).new_count,
            0,
            "overlapping searches reuse the same canonical LinkedIn job"
          )
          assert.equal((await publish([])).expired_count, 0)
          assert.equal(
            (
              await db.query(
                "select id from job_catalog where id='linkedin-observed' and is_active"
              )
            ).rows.length,
            1
          )
          assert.equal(
            (
              await db.query<{ complete: boolean }>(
                "select last_complete complete from job_catalog_sources where id='linkedin'"
              )
            ).rows[0].complete,
            false
          )
        } finally {
          await db.exec("reset role;rollback")
        }
      }
    )
    await t.test(
      "expired runs stop reporting active and release admission without deleting catalogue data",
      async () => {
        await operator()
        await db.query(
          "update job_search_runs set status='running',created_at=now()-interval '11 minutes' where id=$1",
          [id]
        )
        await asUser(0)
        assert.equal((await status())!.status, "partial")
        await operator()
        assert.equal(
          (await db.query("select * from job_catalog")).rows.length,
          4
        )
      }
    )
  } finally {
    await db.close()
  }
})
