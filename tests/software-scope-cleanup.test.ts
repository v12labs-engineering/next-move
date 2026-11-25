import assert from "node:assert/strict"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { softwareScopeCleanupSql } from "../scripts/lib/software-scope-cleanup.mjs"

test("physical scope cleanup deletes only unchanged excluded observations and preserves linked history", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create table job_catalog(id text primary key,title text,description text,description_ref jsonb,url text);
      create table account_job_states(job_id text references job_catalog(id),status text);
      create table resume_drafts(job_id text references job_catalog(id));
      create table application_runs(job_id text references job_catalog(id),target_url text);
      create table job_catalog_run_items(run_id uuid,id text,data jsonb,primary key(run_id,id));`)
    const entries = [
      "delete",
      "changed",
      "saved",
      "draft",
      "application",
      "url-reference",
      "quote",
      "archive",
      "archive-changed",
    ].map((id) => ({
      id,
      title: id === "quote" ? "Manager's Office" : "Accountant",
      description: "Original posting",
      description_ref: id.startsWith("archive")
        ? { pack: "original", offset: 1 }
        : null,
      url: `https://example.com/${id}`,
    }))
    for (const row of entries)
      await db.query("insert into job_catalog values($1,$2,$3,$4,$5)", [
        row.id,
        row.title,
        row.description,
        row.description_ref,
        row.url,
      ])
    await db.exec(`update job_catalog set title='Software Engineer' where id='changed';
      update job_catalog set description_ref='{"pack":"updated","offset":1}' where id='archive-changed';
      insert into account_job_states values('saved','interested');
      insert into resume_drafts values('draft');
      insert into application_runs values('application','https://example.com/application'),(null,'https://example.com/url-reference');`)
    await db.exec(softwareScopeCleanupSql(entries))
    assert.deepEqual(
      (
        await db.query<{ id: string }>("select id from job_catalog order by id")
      ).rows.map((r) => r.id),
      [
        "application",
        "archive-changed",
        "changed",
        "draft",
        "saved",
        "url-reference",
      ]
    )
    const staged = [
      {
        run_id: "00000000-0000-4000-8000-000000000001",
        id: "shared",
        data: entries[0],
      },
      {
        run_id: "00000000-0000-4000-8000-000000000002",
        id: "shared",
        data: entries[0],
      },
    ]
    for (const row of staged)
      await db.query("insert into job_catalog_run_items values($1,$2,$3)", [
        row.run_id,
        row.id,
        row.data,
      ])
    await db.exec(softwareScopeCleanupSql([staged[0]], true))
    assert.equal(
      (
        await db.query<{ run_id: string }>(
          "select run_id from job_catalog_run_items"
        )
      ).rows[0].run_id,
      staged[1].run_id
    )
  } finally {
    await db.close()
  }
})
