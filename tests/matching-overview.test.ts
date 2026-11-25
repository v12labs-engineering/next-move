import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import type { CatalogSourceHealth } from "@/lib/jobs/coverage"

test("matching overview returns complete scoped health and global counts without exposing operator errors", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table job_catalog(id text primary key,is_active boolean);
      create table job_source_directory(id text primary key,countries text[],enabled boolean);
      create table job_catalog_sources(id text primary key,last_success_at timestamptz,last_started_at timestamptz,last_error text,last_complete boolean,current_run uuid);
      create table job_catalog_runs(id uuid primary key,status text);
      insert into job_catalog values('active',true),('closed',false);
      insert into job_source_directory select lpad(n::text,5,'0'),array['Germany'],true from generate_series(1,1201) n;
      insert into job_source_directory values('other',array['India'],true),('disabled',array['Germany'],false);
      insert into job_catalog_sources values('00001','2026-10-30','2026-10-30',null,true,null),('other',null,null,'PRIVATE OPERATOR DIAGNOSTIC',false,'00000000-0000-4000-8000-000000000001');
      insert into job_catalog_runs values('00000000-0000-4000-8000-000000000001','paused');`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610300019_matching_overview.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec("set role anon")
    await assert.rejects(
      db.query("select catalog_matching_overview(array['Germany'])"),
      /permission denied/
    )
    await db.exec("reset role; set role authenticated")
    // Callers cannot read the underlying operator tables.
    await assert.rejects(
      db.query("select * from job_catalog_sources"),
      /permission denied/
    )
    const query = async (countries: string[]) =>
      (
        await db.query<{
          result: {
            totalJobs: number
            sources: number
            failedSources: number
            lastUpdatedAt: string
            health: CatalogSourceHealth[]
          }
        }>("select catalog_matching_overview($1) as result", [countries])
      ).rows[0].result
    const germany = await query(["Germany"])
    assert.equal(germany.totalJobs, 1)
    assert.equal(germany.sources, 1)
    assert.equal(germany.failedSources, 1)
    assert.equal(germany.health.length, 1201)
    assert.ok(
      germany.health.every(
        (source) => source.enabled && source.countries.includes("Germany")
      )
    )
    const india = await query(["India"])
    assert.equal(india.health.length, 1)
    assert.equal(india.health[0].failed, true)
    assert.equal(india.health[0].pending, true)
    assert.equal(india.health[0].complete, false)
    assert.ok(!JSON.stringify(india).includes("PRIVATE OPERATOR"))
    assert.deepEqual((await query([])).health, [])
  } finally {
    await db.close()
  }
})
