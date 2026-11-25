import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"

test("matching pages preserve RLS and snapshot filters, omit descriptions and traverse beyond transport row caps", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table job_catalog(id text primary key,title text default 'Engineer',company text default 'Example',country text default 'United States',city text,url text default 'https://example.invalid/job',work_mode text default 'onsite',visa_signal text default 'possible',sponsorship_evidence text default '',sponsor_verified boolean default false,source text default 'fixture',posted_at timestamptz,last_checked_at timestamptz default '2026-10-30T07:00:00Z',discovered_at timestamptz default '2026-10-29T00:00:00Z',is_active boolean default true,description text default 'Full description is intentionally excluded');
      alter table job_catalog enable row level security;
      grant select on job_catalog to authenticated,service_role;
      create policy visible on job_catalog for select to authenticated using(country<>'Hidden');
      insert into job_catalog(id) select lpad(n::text,5,'0') from generate_series(1,5101) n;
      insert into job_catalog(id,country) values('hidden','Hidden'),('other','India');
      insert into job_catalog(id,is_active) values('inactive',false);
      insert into job_catalog(id,last_checked_at) values('stale','2026-10-01');
      insert into job_catalog(id,discovered_at) values('future','2026-10-30T08:01:00Z');`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610300015_catalog_matching_pages.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610300020_matching_batch_continuation.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610310012_matching_query_plan.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610310013_matching_indexed_keys.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec("set role anon")
    await assert.rejects(
      db.query(
        "select catalog_matching_page(array['United States'],'2026-10-30T08:00:00Z')"
      ),
      /permission denied/
    )
    await assert.rejects(
      db.query(
        "select catalog_matching_batch(array['United States'],'2026-10-30T08:00:00Z')"
      ),
      /permission denied/
    )
    await db.exec("reset role; set role authenticated")
    const page = async (
      countries: string[],
      after: string | null = null,
      limit = 5000
    ) =>
      (
        await db.query<{ items: { id: string; description?: string }[] }>(
          "select catalog_matching_page($1,$2,$3,$4) as items",
          [countries, "2026-10-30T08:00:00Z", after, limit]
        )
      ).rows[0].items
    const first = await page(["United States"])
    assert.equal(first.length, 5000)
    assert.ok(first.every((row) => !("description" in row)))
    const second = await page(["United States"], first.at(-1)!.id)
    assert.equal(second.length, 101)
    assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 5101)
    assert.deepEqual(await page(["United States"], second.at(-1)!.id), [])
    assert.deepEqual(await page(["Hidden"]), [])
    assert.equal((await page(["United States"], null, 100000)).length, 5000)
    assert.deepEqual(await page([]), [])
    const batch = async (
      countries: string[],
      after: string | null = null,
      limit = 5000
    ) =>
      (
        await db.query<{
          batch: {
            items: { id: string; description?: string }[]
            hasMore: boolean
          }
        }>("select catalog_matching_batch($1,$2,$3,$4) as batch", [
          countries,
          "2026-10-30T08:00:00Z",
          after,
          limit,
        ])
      ).rows[0].batch
    const batch1 = await batch(["United States"])
    assert.deepEqual(batch1.items, first)
    assert.equal(batch1.hasMore, true)
    const batch2 = await batch(["United States"], batch1.items.at(-1)!.id)
    assert.deepEqual(batch2.items, second)
    assert.equal(batch2.hasMore, false)
    assert.deepEqual(await batch(["Hidden"]), { items: [], hasMore: false })
    assert.deepEqual(await batch([]), { items: [], hasMore: false })
    assert.equal(
      (await batch(["United States"], null, 100000)).items.length,
      5000
    )
    assert.equal((await batch(["India"], null, 1)).hasMore, false)
    const combined = await batch(
      ["United States", "India", "United States"],
      first.at(-1)!.id
    )
    assert.equal(combined.items.length, 102)
    assert.equal(new Set(combined.items.map((item) => item.id)).size, 102)
    assert.equal(combined.items.at(-1)?.id, "other")
    assert.equal(combined.hasMore, false)
    // Alternate dense, sparse and empty scopes across repeated calls. Changing
    // plans must preserve complete pagination, filtering and invoker RLS.
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.deepEqual(await batch(["India"], null, 1), {
        items: await page(["India"], null, 1),
        hasMore: false,
      })
      assert.deepEqual(await batch(["Hidden", "Missing"]), {
        items: [],
        hasMore: false,
      })
      assert.deepEqual(
        (await batch(["United States"], first.at(-1)!.id)).items,
        second
      )
    }
  } finally {
    await db.close()
  }
})
