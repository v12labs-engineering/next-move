import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import { qualcommIndiaSource } from "@/lib/server/catalog/connectors/eightfold"
import { validSourceId } from "@/lib/server/catalog/source-identity"
import { jobCategoryIds } from "@/lib/jobs/categories"
import { CatalogSourceError } from "@/lib/server/catalog/feeds"

const origin = "https://careers.qualcomm.com"
const snapshotStartedAt = new Date().toISOString()
const recent = Math.floor(Date.now() / 1000) - 86400
const description =
  "Design and build production software services, distributed APIs and automated tests. Collaborate with engineering teams to deliver reliable cloud applications."
function row(index = 0, fields: Record<string, unknown> = {}) {
  return {
    id: 446721896000 + index,
    displayJobId: String(3098000 + index),
    name: "Software Engineer",
    locations: ["Hyderabad, Telangana, India"],
    standardizedLocations: ["Hyderabad, TS, IN"],
    postedTs: recent,
    positionUrl: `/careers/job/${446721896000 + index}`,
    ...fields,
  }
}
function transport(
  rows = [row()],
  alter?: (body: Record<string, unknown>, url: URL) => void
) {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push(url.href)
    assert.equal(url.origin, origin)
    assert.equal(init?.redirect, "error")
    if (url.pathname === "/robots.txt")
      return new Response(
        "User-agent: *\nDisallow: /\nAllow: /api/pcsx\nAllow: /careers"
      )
    assert.equal(url.searchParams.get("domain"), "qualcomm.com")
    let data: Record<string, unknown>
    if (url.pathname.endsWith("/search")) {
      assert.equal(url.searchParams.get("location"), "India")
      assert.equal(url.searchParams.get("sort_by"), "timestamp")
      const start = Number(url.searchParams.get("start"))
      data = {
        positions: rows.slice(start, start + 10),
        count: rows.length,
        sortBy: "timestamp",
        resultsMetaData: { usedFuzzSearch: false },
      }
    } else {
      assert.equal(url.pathname, "/api/pcsx/position_details")
      const found = rows.find(
        (row) => row.id === Number(url.searchParams.get("position_id"))
      )
      assert.ok(found, "only observed IDs may be fetched")
      data = {
        ...found,
        publicUrl: `${origin}${found.positionUrl}`,
        jobDescription: `<p>${description}</p>`,
        creationTs: recent - 86400 * 100,
      }
    }
    alter?.(data, url)
    return Response.json({
      status: 200,
      error: { message: "", body: "" },
      data,
    })
  }
  return { calls, fetch }
}

test("Qualcomm registry uses verified India details, posted date and complete pagination", async () => {
  const mock = transport(Array.from({ length: 13 }, (_, index) => row(index)))
  const options = {
    fetch: mock.fetch,
    snapshotStartedAt,
    jobCategories: jobCategoryIds,
  }
  const first = await fetchCatalogPage(qualcommIndiaSource, 1, options)
  const last = await fetchCatalogPage(qualcommIndiaSource, 2, options)
  assert.equal(first.nextPage, 2)
  assert.equal(last.nextPage, null)
  assert.equal(first.jobs.length + last.jobs.length, 13)
  assert.equal(
    new Set([...first.jobs, ...last.jobs].map((job) => job.id)).size,
    13
  )
  assert.ok(
    [...first.jobs, ...last.jobs].every(
      (job) =>
        job.country === "India" &&
        job.company === "Qualcomm" &&
        job.description === description &&
        job.posted_at === new Date(recent * 1000).toISOString()
    )
  )
  assert.ok(validSourceId(qualcommIndiaSource.id))
  assert.ok(!validSourceId("eightfold:microsoft-india"))
})

test("Qualcomm preserves raw professions but projects current profile categories and exact freshness", async () => {
  const mock = transport([
    row(),
    row(1, { name: "Marketing Manager" }),
    row(2, { name: "Hardware Technician" }),
    row(3, { name: "Software Engineer Intern" }),
    row(4, { postedTs: recent - 86400 * 31 }),
  ])
  const options = {
    fetch: mock.fetch,
    snapshotStartedAt,
    jobCategories: jobCategoryIds,
  }
  const raw = await fetchSourcePage(qualcommIndiaSource, 1, options)
  assert.equal(raw.postings.length, 4)
  const all = await fetchCatalogPage(qualcommIndiaSource, 1, options)
  assert.deepEqual(
    all.jobs.map((job) => job.title),
    ["Software Engineer", "Marketing Manager"]
  )
  const marketing = await fetchCatalogPage(qualcommIndiaSource, 1, {
    ...options,
    jobCategories: ["marketing"],
  })
  assert.deepEqual(
    marketing.jobs.map((job) => job.title),
    ["Marketing Manager"]
  )
  assert.equal(all.nextPage, null)
  const future = transport([row(0, { postedTs: recent + 86400 * 2 })])
  assert.equal(
    (
      await fetchCatalogPage(qualcommIndiaSource, 1, {
        fetch: future.fetch,
        snapshotStartedAt,
      })
    ).jobs.length,
    0
  )
  assert.equal(future.calls.length, 2)
})

test("Qualcomm rejects foreign, ambiguous, incomplete and mismatched source evidence", async () => {
  for (const fields of [
    { locations: ["San Diego, California, United States"] },
    { standardizedLocations: ["Hyderabad, TS, US"] },
    { locations: ["Remote"] },
    { positionUrl: "https://evil.test/careers/job/446721896000" },
  ]) {
    const mock = transport([row(0, fields)])
    await assert.rejects(
      fetchCatalogPage(qualcommIndiaSource, 1, { fetch: mock.fetch }),
      /India|identity/
    )
    assert.equal(mock.calls.length, 2)
  }
  for (const fields of [
    { jobDescription: "<p>Missing</p>" },
    { name: "Different role" },
    { postedTs: recent - 1 },
    { id: 9000 },
    { publicUrl: "https://evil.test/careers/job/446721896000" },
  ]) {
    const mock = transport([row()], (body, url) => {
      if (url.pathname.endsWith("position_details")) Object.assign(body, fields)
    })
    await assert.rejects(
      fetchCatalogPage(qualcommIndiaSource, 1, { fetch: mock.fetch })
    )
  }
})

test("Qualcomm rejects repeated, changed, truncated and wrongly sorted pages", async () => {
  const rows = Array.from({ length: 13 }, (_, index) => row(index))
  for (const alter of [
    (data: Record<string, unknown>, url: URL) => {
      if (url.searchParams.get("start") === "10")
        data.positions = rows.slice(0, 3)
    },
    (data: Record<string, unknown>, url: URL) => {
      if (url.searchParams.get("start") === "10") data.count = 14
    },
    (data: Record<string, unknown>, url: URL) => {
      if (url.searchParams.get("start") === "10")
        data.positions = rows.slice(10, 12)
    },
  ]) {
    const mock = transport(rows, alter)
    await assert.rejects(
      fetchCatalogPage(qualcommIndiaSource, 2, { fetch: mock.fetch }),
      /page/
    )
  }
  for (const invalid of [
    [row(), row()],
    [row(), row(1, { postedTs: recent + 1 })],
  ]) {
    const mock = transport(invalid)
    await assert.rejects(
      fetchCatalogPage(qualcommIndiaSource, 1, { fetch: mock.fetch }),
      /duplicate|sorted/
    )
  }
  const fuzzy = transport([row()], (data, url) => {
    if (url.pathname.endsWith("search"))
      data.resultsMetaData = { usedFuzzSearch: true }
  })
  await assert.rejects(
    fetchCatalogPage(qualcommIndiaSource, 1, { fetch: fuzzy.fetch })
  )
})

test("Qualcomm honors robots, provider backoff and fixed source configuration", async () => {
  await assert.rejects(
    fetchCatalogPage(qualcommIndiaSource, 1, {
      fetch: async () =>
        new Response("<!doctype html><html>Access denied</html>"),
    }),
    /robots resource returned HTML/
  )
  let calls = 0
  await assert.rejects(
    fetchCatalogPage(qualcommIndiaSource, 1, {
      fetch: async () => {
        calls++
        return new Response("User-agent: *\nDisallow: /api/pcsx")
      },
    }),
    /robots/
  )
  assert.equal(calls, 1)
  for (const status of [403, 429]) {
    calls = 0
    await assert.rejects(
      fetchCatalogPage(qualcommIndiaSource, 1, {
        fetch: async () => {
          calls++
          return new Response("Blocked", {
            status,
            headers: { "retry-after": "600" },
          })
        },
      }),
      (error: unknown) =>
        error instanceof CatalogSourceError &&
        Date.parse(error.retryAt) >= Date.now() + 590000
    )
    assert.equal(calls, 1)
  }
  await assert.rejects(
    fetchCatalogPage(
      { ...qualcommIndiaSource, config: { domain: "evil.test" } },
      1,
      { fetch: () => assert.fail("must not fetch") }
    )
  )
})

test("Qualcomm migration registers only the reviewed source and preserves later Deloitte scope", async () => {
  const db = new PGlite()
  try {
    await db.exec(
      `create table public.job_source_directory (id text, kind text, board text, company text, config jsonb, constraint job_source_directory_kind_check check(kind in ('ibm'))); create function public.job_search_source_pool(uuid,text[]) returns boolean language sql as $$ select 'ibm' in ('oracle','accenture','ibm') $$;`
    )
    await db.exec(
      await readFile(
        "supabase/migrations/202611180086_qualcomm_eightfold_source.sql",
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        "supabase/migrations/202611180087_successfactors_deloitte.sql",
        "utf8"
      )
    )
    assert.equal(
      (await db.query("select * from public.job_source_directory")).rows.length,
      0
    )
    await db.query(
      "insert into public.job_source_directory values ($1,$2,$3,$4,$5)",
      [
        qualcommIndiaSource.id,
        qualcommIndiaSource.kind,
        qualcommIndiaSource.board,
        qualcommIndiaSource.company,
        "{}",
      ]
    )
    await assert.rejects(
      db.exec(
        "insert into public.job_source_directory values ('eightfold:unknown','eightfold','unknown','Unknown','{}')"
      )
    )
    await assert.rejects(
      db.exec(
        "insert into public.job_source_directory values ('eightfold:qualcomm-india','eightfold','qualcomm-india','Qualcomm','{\"domain\":\"evil.test\"}')"
      )
    )
    const result = await db.query<{ definition: string }>(
      "select pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure) as definition"
    )
    assert.match(result.rows[0].definition, /eightfold/)
    assert.match(result.rows[0].definition, /successfactors/)
  } finally {
    await db.close()
  }
})
