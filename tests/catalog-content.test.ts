import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@supabase/supabase-js"
import {
  archiveCatalogDescriptions,
  hydrateCatalogDescriptions,
  packDescriptions,
  unpackDescription,
} from "@/lib/server/catalog/content"

test("packed descriptions preserve Unicode exactly and reject corrupt, truncated and oversized references", () => {
  const rows = [
    {
      id: "a",
      description: "Software engineer — Hyderabad. हिंदी 日本語.\n".repeat(100),
    },
    { id: "b", description: "Nurse\nClinical handovers and patient care." },
  ]
  const [pack] = packDescriptions(rows)
  for (const row of rows) {
    const ref = pack.refs.get(row.id)!
    const body = pack.body.subarray(ref.offset, ref.offset + ref.length)
    assert.equal(unpackDescription(body, ref), row.description)
    assert.throws(() => unpackDescription(body.subarray(1), ref), /truncated/)
    assert.throws(
      () => unpackDescription(body, { ...ref, sha256: "0".repeat(64) }),
      /checksum/
    )
    assert.throws(() => unpackDescription(body, { ...ref, bytes: 1_000_000 }))
  }
})

test("archive readback must succeed before text is cleared; range hydration returns the original source text", async () => {
  const description =
    "Independent public listing fixture — no candidate information.\n".repeat(
      50
    )
  const events: string[] = [],
    objects = new Map<string, Buffer>()
  let corrupt = false
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.includes("/bucket/"))
      return Response.json({
        id: "job-catalog-content-v1",
        name: "job-catalog-content-v1",
        public: true,
      })
    if (url.pathname.endsWith("/job_catalog")) return Response.json([])
    if (url.pathname.endsWith("/reserve_catalog_content")) {
      events.push("reserve")
      return Response.json(null)
    }
    if (url.pathname.endsWith("/confirm_catalog_content")) {
      events.push("confirm")
      return Response.json(null)
    }
    if (url.pathname.includes("/object/")) {
      const key = url.pathname.split("/v1/").at(-1)!
      if (init?.method === "POST") {
        events.push("upload")
        objects.set(key, Buffer.from(init.body as Uint8Array))
        return Response.json({ Key: key })
      }
      events.push("readback")
      return new Response(
        new Uint8Array(corrupt ? Buffer.from("bad") : objects.get(key)!)
      )
    }
    throw Error(`Unexpected fixture endpoint: ${url.pathname}`)
  }
  const db = createClient(
    "https://content-fixture.example",
    "operator-fixture",
    { global: { fetch: transport } }
  )
  const original = [{ id: "fixture", description }]
  corrupt = true
  await assert.rejects(
    archiveCatalogDescriptions(db, original),
    /verification failed/
  )
  assert.equal(original[0].description, description)
  assert.ok(!events.includes("confirm"))
  corrupt = false
  events.length = 0
  const stored = await archiveCatalogDescriptions(db, original)
  assert.equal(stored[0].description, "")
  assert.ok("description_ref" in stored[0])
  assert.deepEqual(events, ["reserve", "upload", "readback", "confirm"])
  const restored = await hydrateCatalogDescriptions(
    db,
    stored,
    async (input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), null)
      assert.equal(init?.redirect, "error")
      const bytes = objects.get(
        new URL(String(input)).pathname.split("/v1/").at(-1)!
      )!
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(
        new Headers(init?.headers).get("range")!
      )!
      return new Response(
        new Uint8Array(bytes.subarray(Number(first), Number(last) + 1)),
        {
          status: 206,
          headers: {
            "Content-Range": `bytes ${first}-${last}/${bytes.length}`,
          },
        }
      )
    }
  )
  assert.equal(restored[0].description, description)
})

test("Postgres archives with compare-and-swap, protects operator state, and compares logical content across storage formats", async () => {
  const db = new PGlite()
  try {
    await db.exec(
      "create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role;create type visa_confidence as enum('confirmed','possible','no');create table job_catalog(id text primary key,title text not null,company text not null,country text not null,city text,url text not null,description text not null,work_mode text not null,visa_signal visa_confidence,sponsorship_evidence text,sponsor_verified boolean,source text,posted_at timestamptz,discovered_at timestamptz default now());grant all on job_catalog to service_role;create table account_countries(user_id uuid,country text);"
    )
    for (const file of [
      "202610290002_live_catalog.sql",
      "202610290006_catalog_collection.sql",
      "202610290007_catalog_backoff.sql",
      "202610310005_catalog_description_objects.sql",
      "202610310007_catalog_archive_queue.sql",
      "202610310008_catalog_archive_pagination.sql",
      "202610310009_catalog_archive_query_plan.sql",
      "202610310010_catalog_archive_indexed_attachment.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${file}`, import.meta.url),
          "utf8"
        )
      )
    await db.exec("set role authenticated")
    for (const query of [
      "select reserve_catalog_content(repeat('a',64),1)",
      "select archive_catalog_description_batch()",
      "select attach_catalog_description_refs('[]')",
      "select * from catalog_content_packs",
    ])
      await assert.rejects(db.query(query), /permission denied/)
    await db.exec("reset role;set role service_role")
    const description = "Verified source description — Δ 日本語"
    const posting = {
      id: "content-job",
      title: "Software Engineer",
      company: "Example",
      country: "India",
      city: "Hyderabad",
      url: "https://example.com/job",
      description,
      work_mode: "hybrid",
      visa_signal: "possible",
      sponsorship_evidence: "Unknown",
      sponsor_verified: false,
      source: "ashby:n8n",
      posted_at: null,
    }
    await db.query(
      "insert into job_catalog select x.* from jsonb_populate_record(null::job_catalog,$1) x",
      [
        JSON.stringify({
          ...posting,
          discovered_at: new Date().toISOString(),
          is_active: true,
        }),
      ]
    )
    const [pack] = packDescriptions([{ id: posting.id, description }]),
      ref = pack.refs.get(posting.id)!
    await db.query("select reserve_catalog_content($1,$2)", [
      pack.id,
      pack.body.length,
    ])
    await assert.rejects(
      db.query("select attach_catalog_description_refs($1)", [
        JSON.stringify([{ id: posting.id, description_ref: ref }]),
      ]),
      /Unverified/
    )
    await db.query("select confirm_catalog_content($1,$2)", [
      pack.id,
      pack.body.length,
    ])
    const attach = async (reference: typeof ref) =>
      (
        await db.query<{ n: number }>(
          "select attach_catalog_description_refs($1) n",
          [JSON.stringify([{ id: posting.id, description_ref: reference }])]
        )
      ).rows[0].n
    assert.equal(await attach({ ...ref, sha256: "0".repeat(64) }), 0)
    assert.equal(await attach(ref), 1)
    assert.equal(await attach(ref), 0)
    assert.equal(
      (
        await db.query<{ description: string }>(
          "select description from job_catalog"
        )
      ).rows[0].description,
      ""
    )
    const run = (
      await db.query<{ r: { id: string; token: string } }>(
        "select begin_catalog_run('ashby:n8n') r"
      )
    ).rows[0].r
    await db.query("select checkpoint_catalog_page($1,$2,1,null,$3,1,0,1)", [
      run.id,
      run.token,
      JSON.stringify([posting]),
    ])
    const finished = (
      await db.query<{ r: { updated_count: number; new_count: number } }>(
        "select finish_catalog_run_without_capacity($1,$2) r",
        [run.id, run.token]
      )
    ).rows[0].r
    assert.equal(
      finished.updated_count,
      0,
      "A storage-format change is not a content change"
    )
    assert.equal(finished.new_count, 0)
    await db.query(
      "update job_catalog set description='A changed legacy-source description' where id=$1",
      [posting.id]
    )
    assert.equal(
      (
        await db.query<{ description_ref: unknown }>(
          "select description_ref from job_catalog"
        )
      ).rows[0].description_ref,
      null
    )
  } finally {
    await db.close()
  }
})

test("adjacent public description blocks share a bounded range read, including simultaneous callers", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `coalesced-${i}`,
    description: `Coalesced unique public description ${i} — original UTF-8 evidence.`,
  }))
  const [pack] = packDescriptions(rows)
  const stored = rows.map((row) => ({
    id: row.id,
    description: "",
    description_ref: pack.refs.get(row.id)!,
  }))
  const db = createClient("https://coalesced.example", "fixture-key")
  let requests = 0
  const fetcher: typeof fetch = async (_input, init) => {
    requests++
    // Both callers enter hydration before the first request settles.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(
      new Headers(init?.headers).get("range")!
    )!
    return new Response(new Uint8Array(pack.body.subarray(+a, +b + 1)), {
      status: 206,
      headers: { "Content-Range": `bytes ${a}-${b}/${pack.body.length}` },
    })
  }
  const [a, b] = await Promise.all([
    hydrateCatalogDescriptions(db, stored, fetcher),
    hydrateCatalogDescriptions(db, stored, fetcher),
  ])
  assert.deepEqual(
    a.map((r) => r.description),
    rows.map((r) => r.description)
  )
  assert.deepEqual(b, a)
  assert.equal(
    requests,
    1,
    "40 block requests collapse into one shared adjacent range"
  )
})
