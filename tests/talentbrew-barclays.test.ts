import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import { barclaysIndiaSource } from "@/lib/server/catalog/connectors/talentbrew"
import { qualcommIndiaSource } from "@/lib/server/catalog/connectors/eightfold"
import { validSourceId } from "@/lib/server/catalog/source-identity"
import { jobCategoryIds } from "@/lib/jobs/categories"
import { CatalogSourceError } from "@/lib/server/catalog/feeds"

const origin = "https://search.jobs.barclays"
const path = "/location/india-jobs/13015/1269750/2/"
const snapshotStartedAt = new Date().toISOString()
const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const description =
  "Design and build production software services, distributed APIs and automated tests. Collaborate with software engineering teams and deliver reliable cloud applications."
function row(index = 0, fields: Record<string, unknown> = {}) {
  return {
    id: String(98454849300 + index),
    title: "Software Engineer",
    date,
    location: "Pune",
    country: "India",
    description,
    ...fields,
  }
}
type Row = ReturnType<typeof row>
function url(row: Row) {
  return `${origin}/job/pune/software-engineer/13015/${row.id}`
}
function listing(rows: Row[], page: number, total: number) {
  return `<div id="search-results" data-total-results="${total}" data-current-page="${page}" data-records-per-page="16" data-total-pages="${Math.max(1, Math.ceil(total / 16))}" data-organization-ids="13015"><div id="search-results-list">${rows.map((row) => `<div class="list-item"><a class="job-title--link" data-job-id="${row.id}" href="${new URL(url(row)).pathname}">${row.title}</a><div class="job-location">${row.location}, ${row.country}</div><div class="job-date">1 Jan</div></div>`).join("")}</div><nav id="pagination-bottom">${page * 16 < total ? `<a class="next" href="${path}${page + 1}">Next</a>` : '<a class="next disabled">Next</a>'}</nav></div>`
}
function detail(row: Row) {
  return `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: row.title, url: url(row), datePosted: row.date, description: row.description, identifier: { value: `JR-${row.id}` }, hiringOrganization: { name: "Barclays" }, jobLocation: [{ address: { addressLocality: row.location, addressCountry: row.country } }] })}</script>`
}
function transport(rows: Row[], alter?: (body: string, url: string) => string) {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const target = String(input)
    calls.push(target)
    assert.equal(new URL(target).origin, origin)
    assert.equal(init?.redirect, "error")
    let body: string
    if (target.endsWith("robots.txt")) body = "User-agent: *\n"
    else if (target.includes(path)) {
      const page = Number(target.slice(target.lastIndexOf("/") + 1))
      body = listing(rows.slice((page - 1) * 16, page * 16), page, rows.length)
    } else {
      const found = rows.find((row) => url(row) === target)
      assert.ok(found, "only observed posting URLs are requested")
      body = detail(found)
    }
    return new Response(alter?.(body, target) ?? body)
  }
  return { fetch, calls }
}

test("Barclays completes exact public HTML pagination with authoritative India details", async () => {
  const mock = transport(Array.from({ length: 18 }, (_, index) => row(index)))
  const options = {
    fetch: mock.fetch,
    snapshotStartedAt,
    jobCategories: jobCategoryIds,
  }
  const first = await fetchCatalogPage(barclaysIndiaSource, 1, options)
  const second = await fetchCatalogPage(barclaysIndiaSource, 2, options)
  assert.equal(first.nextPage, 2)
  assert.equal(second.nextPage, null)
  assert.equal(first.jobs.length + second.jobs.length, 18)
  assert.equal(
    new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size,
    18
  )
  assert.ok(
    first.jobs.every(
      (job) =>
        job.country === "India" &&
        job.description === description &&
        job.posted_at === `${date}T00:00:00.000Z`
    )
  )
  assert.ok(validSourceId(barclaysIndiaSource.id))
  assert.ok(!validSourceId("talentbrew:unknown"))
})

test("Barclays filters current categories, early careers and exact dates without trusting card dates", async () => {
  const mock = transport([
    row(),
    row(1, { title: "Product Manager" }),
    row(2, { title: "Marketing Manager" }),
    row(3, { title: "Software Engineer Intern" }),
    row(4, {
      date: new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10),
    }),
    row(5, {
      date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    }),
  ])
  const options = {
    fetch: mock.fetch,
    snapshotStartedAt,
    jobCategories: jobCategoryIds,
  }
  const raw = await fetchSourcePage(barclaysIndiaSource, 1, options)
  assert.equal(raw.postings.length, 4)
  assert.equal(
    (await fetchCatalogPage(barclaysIndiaSource, 1, options)).jobs.length,
    3
  )
  const marketing = await fetchCatalogPage(barclaysIndiaSource, 1, {
    ...options,
    jobCategories: ["marketing"],
  })
  assert.deepEqual(
    marketing.jobs.map((job) => job.title),
    ["Marketing Manager"]
  )
})

test("Barclays accepts verified numeric legacy requisitions without weakening dates or URLs", async () => {
  const rows = [row(), row(1, { date: "2024-07-25" })]
  const legacy = transport(rows, (body, target) =>
    target.includes("/job/") ? body.replace(/JR-[0-9]+/g, "90390427") : body
  )
  const result = await fetchCatalogPage(barclaysIndiaSource, 1, {
    fetch: legacy.fetch,
    snapshotStartedAt,
  })
  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].url, url(rows[0]))
  assert.equal(result.jobs[0].posted_at, `${date}T00:00:00.000Z`)
  const invalid = transport([row()], (body, target) =>
    target.includes("/job/")
      ? body.replace(/JR-[0-9]+/g, "90390427-invalid")
      : body
  )
  await assert.rejects(
    fetchCatalogPage(barclaysIndiaSource, 1, { fetch: invalid.fetch })
  )
})

test("Barclays rejects partial, repeated, foreign, malformed or untrusted inventories", async () => {
  for (const [before, after] of [
    ['data-total-results="1"', 'data-total-results="2"'],
    ['data-current-page="1"', 'data-current-page="2"'],
    ['data-organization-ids="13015"', 'data-organization-ids="1"'],
    ["Pune, India", "Paris, France"],
  ]) {
    const mock = transport([row()], (body) => body.replace(before, after))
    await assert.rejects(
      fetchCatalogPage(barclaysIndiaSource, 1, { fetch: mock.fetch })
    )
  }
  for (const [before, after] of [
    ['"name":"Barclays"', '"name":"Different"'],
    ['"addressCountry":"India"', '"addressCountry":"France"'],
    [description, "Short"],
    ['"datePosted"', '"missingDate"'],
    [date, "2026-02-30"],
    [
      url(row()),
      "https://evil.test/job/pune/software-engineer/13015/98454849300",
    ],
  ]) {
    const mock = transport([row()], (body, target) =>
      target.includes("/job/") ? body.replace(before, after) : body
    )
    await assert.rejects(
      fetchCatalogPage(barclaysIndiaSource, 1, { fetch: mock.fetch })
    )
  }
  const duplicate = transport([row(), row()])
  await assert.rejects(
    fetchCatalogPage(barclaysIndiaSource, 1, { fetch: duplicate.fetch }),
    /duplicate/
  )
  const rows = Array.from({ length: 18 }, (_, index) => row(index))
  const repeated = transport(rows, (body, target) =>
    target.endsWith(`${path}2`) ? listing(rows.slice(0, 2), 2, 18) : body
  )
  await assert.rejects(
    fetchCatalogPage(barclaysIndiaSource, 2, { fetch: repeated.fetch }),
    /page boundary/
  )
  const next = transport(rows, (body) =>
    body.replace(`${path}2`, "https://evil.test/page/2")
  )
  await assert.rejects(
    fetchCatalogPage(barclaysIndiaSource, 1, { fetch: next.fetch }),
    /next-page/
  )
})

test("Barclays respects robots exclusions, backoff and fixed source scope", async () => {
  await assert.rejects(
    fetchCatalogPage(barclaysIndiaSource, 1, {
      fetch: async () =>
        new Response("<!doctype html><html>Access denied</html>"),
    }),
    /robots resource returned HTML/
  )
  let calls = 0
  await assert.rejects(
    fetchCatalogPage(barclaysIndiaSource, 1, {
      fetch: async () => {
        calls++
        return new Response("User-agent: *\nDisallow: /")
      },
    }),
    /robots/
  )
  assert.equal(calls, 1)
  for (const status of [403, 429]) {
    calls = 0
    await assert.rejects(
      fetchCatalogPage(barclaysIndiaSource, 1, {
        fetch: async () => {
          calls++
          return new Response("Blocked", {
            status,
            headers: { "retry-after": "600" },
          })
        },
      }),
      (error) =>
        error instanceof CatalogSourceError &&
        Date.parse(error.retryAt) >= Date.now() + 590000
    )
    assert.equal(calls, 1)
  }
  await assert.rejects(
    fetchCatalogPage(
      { ...barclaysIndiaSource, config: { url: "https://evil.test" } },
      1,
      { fetch: () => assert.fail("must not fetch") }
    )
  )
})

test("Barclays migration preserves both preceding connectors and enables no sources", async () => {
  const db = new PGlite()
  try {
    await db.exec(
      `create table public.job_source_directory (id text, kind text, board text, company text, config jsonb, constraint job_source_directory_kind_check check(kind in ('ibm'))); create function public.job_search_source_pool(uuid,text[]) returns boolean language sql as $$ select 'ibm' in ('oracle','accenture','ibm') $$;`
    )
    for (const name of [
      "202611180086_qualcomm_eightfold_source",
      "202611180087_successfactors_deloitte",
      "202611180088_barclays_talentbrew_source",
    ])
      await db.exec(await readFile(`supabase/migrations/${name}.sql`, "utf8"))
    assert.equal(
      (await db.query("select * from public.job_source_directory")).rows.length,
      0
    )
    for (const source of [
      barclaysIndiaSource,
      qualcommIndiaSource,
      {
        id: "successfactors:deloitte-india",
        kind: "successfactors",
        board: "deloitte-india",
        company: "Deloitte",
      },
    ])
      await db.query(
        "insert into public.job_source_directory values ($1,$2,$3,$4,$5)",
        [source.id, source.kind, source.board, source.company, "{}"]
      )
    await assert.rejects(
      db.exec(
        "insert into public.job_source_directory values ('talentbrew:unknown','talentbrew','unknown','Unknown','{}')"
      )
    )
    const result = await db.query<{ definition: string }>(
      "select pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure) as definition"
    )
    for (const kind of ["eightfold", "successfactors", "talentbrew"])
      assert.ok(result.rows[0].definition.includes(kind))
  } finally {
    await db.close()
  }
})
