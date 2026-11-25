import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import { deloitteIndiaSource } from "@/lib/server/catalog/connectors/successfactors"
import { validSourceId } from "@/lib/server/catalog/source-identity"
import { jobCategoryIds } from "@/lib/jobs/categories"
import { CatalogSourceError } from "@/lib/server/catalog/feeds"

const origin = "https://southasiacareers.deloitte.com"
const snapshotStartedAt = new Date().toISOString()
const recent = new Date(Date.now() - 86400000)
const date = recent.toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})
const posted = `${recent.toISOString().slice(0, 10)}T02:00:00Z`
const description =
  "Design and develop production software services, distributed APIs and automated tests. Collaborate with software engineering teams and deliver reliable cloud applications."
function row(index: number, title = "Software Engineer") {
  return {
    id: String(1000 + index),
    title,
    location: "Bengaluru, IN",
    date,
    posted,
    description,
  }
}
type Row = ReturnType<typeof row>
function url(job: Row) {
  return `${origin}/job/Bengaluru-Role/${job.id}/`
}
function listing(rows: Row[], offset: number, total: number) {
  return `<h1>Deloitte India</h1><span class="paginationLabel">Results ${offset + 1} – ${Math.min(offset + 25, total)} of ${total}</span><a class="current-page">${offset / 25 + 1}</a><table id="searchresults"><tbody>${rows.map((job) => `<tr class="data-row"><td><a class="jobTitle-link" href="${url(job)}">${job.title}</a></td><td class="colLocation">${job.location}</td><td class="colDate">${job.date}</td></tr>`).join("")}</tbody></table>`
}
function detail(job: Row) {
  return `<link rel="canonical" href="${url(job)}"><meta itemprop="hiringOrganization" content="deloitte"><meta itemprop="datePosted" content="${job.posted}"><meta itemprop="streetAddress" content="${job.location}"><h1 itemprop="title">${job.title}</h1><span class="jobdescription"><p>${job.description}</p></span><a class="apply" href="/talentcommunity/apply/${job.id}/?locale=en_US">Apply</a>`
}
function transport(rows: Row[], alter?: (body: string, url: string) => string) {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const target = String(input)
    calls.push(target)
    let body: string
    if (target.endsWith("/robots.txt"))
      body = "User-agent: *\nDisallow: /services/\nDisallow: /talentcommunity/"
    else if (target.includes("/go/")) {
      assert.ok(
        target.endsWith("?q=&sortColumn=referencedate&sortDirection=desc")
      )
      const offset = Number(
        new URL(target).pathname.match(/718244\/(\d+)\//)?.[1] ?? 0
      )
      body = listing(rows.slice(offset, offset + 25), offset, rows.length)
    } else {
      const job = rows.find((job) => url(job) === target)
      assert.ok(job, "only observed job pages may be requested")
      body = detail(job)
    }
    return new Response(alter?.(body, target) ?? body)
  }
  return { fetch, calls }
}

test("Deloitte completes exact HTML pagination with full India details and canonical identities", async () => {
  const rows = Array.from({ length: 27 }, (_, index) => row(index))
  const mock = transport(rows)
  const options = {
    fetch: mock.fetch,
    snapshotStartedAt,
    jobCategories: jobCategoryIds,
  }
  const first = await fetchCatalogPage(deloitteIndiaSource, 1, options)
  const last = await fetchCatalogPage(deloitteIndiaSource, 2, options)
  assert.equal(first.nextPage, 2)
  assert.equal(last.nextPage, null)
  assert.equal(first.jobs.length + last.jobs.length, 27)
  assert.equal(
    new Set([...first.jobs, ...last.jobs].map((job) => job.id)).size,
    27
  )
  assert.ok(
    [...first.jobs, ...last.jobs].every(
      (job) =>
        job.country === "India" &&
        job.description === description &&
        job.posted_at === new Date(posted).toISOString()
    )
  )
  assert.ok(validSourceId(deloitteIndiaSource.id))
  assert.ok(!validSourceId("successfactors:unknown"))
  assert.ok(
    mock.calls.every(
      (url) => !url.includes("/services/") && !url.includes("/talentcommunity/")
    )
  )
})

test("Deloitte retains raw professions and enforces category, early-career and snapshot date policy", async () => {
  const rows = [
    row(0),
    row(1, "Product Manager"),
    row(2, "Sales Executive"),
    row(3, "Accountant"),
    row(4, "Software Engineering Intern"),
  ]
  const mock = transport(rows)
  const catalog = await fetchCatalogPage(deloitteIndiaSource, 1, {
    fetch: mock.fetch,
    snapshotStartedAt,
    jobCategories: jobCategoryIds,
  })
  assert.deepEqual(
    catalog.jobs.map((job) => job.title),
    ["Software Engineer", "Product Manager", "Sales Executive"]
  )
  const raw = await fetchSourcePage(deloitteIndiaSource, 1, {
    fetch: mock.fetch,
    snapshotStartedAt,
  })
  assert.equal(raw.postings.length, 5)
  const future = transport([row(0)], (body) =>
    body.replace(posted, new Date(Date.now() + 86400000).toISOString())
  )
  await assert.rejects(
    fetchCatalogPage(deloitteIndiaSource, 1, {
      fetch: future.fetch,
      snapshotStartedAt,
    }),
    /date.*changed/
  )
  const old = new Date(Date.now() - 31 * 86400000)
  const historical = transport([
    {
      ...row(0),
      date: old.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
      posted: old.toISOString(),
    },
  ])
  const result = await fetchCatalogPage(deloitteIndiaSource, 1, {
    fetch: historical.fetch,
    snapshotStartedAt,
  })
  assert.equal(result.jobs.length, 0)
  assert.equal(result.nextPage, null)
  assert.equal(historical.calls.length, 2)
})

test("Deloitte keeps its public session cookie for consistent adjacent-page reads", async () => {
  const mock = transport(Array.from({ length: 27 }, (_, index) => row(index)))
  let listingReads = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const target = String(input)
    if (!target.endsWith("/robots.txt")) {
      if (listingReads)
        assert.equal(
          new Headers(init?.headers).get("Cookie"),
          "JSESSIONID=w2~PUBLIC-SESSION"
        )
      listingReads++
    }
    const response = await mock.fetch(input, init)
    if (target.includes("/go/"))
      response.headers.set(
        "Set-Cookie",
        "JSESSIONID=w2~PUBLIC-SESSION; Path=/; Secure; HttpOnly"
      )
    return response
  }
  const result = await fetchCatalogPage(deloitteIndiaSource, 2, {
    fetch,
    snapshotStartedAt,
  })
  assert.equal(result.jobs.length, 2)
  assert.equal(result.nextPage, null)
})

test("Deloitte rejects incomplete, duplicate, foreign, changed and robots-blocked inventories", async () => {
  for (const [pattern, replacement, error] of [
    ["of 1", "of 2", /pagination/],
    ["Bengaluru, IN", "Bengaluru, US", /India/],
    ["Deloitte India", "Different Employer", /employer identity/],
  ] as const) {
    const mock = transport([row(0)], (body) =>
      body.replace(pattern, replacement)
    )
    await assert.rejects(
      fetchCatalogPage(deloitteIndiaSource, 1, {
        fetch: mock.fetch,
        snapshotStartedAt,
      }),
      error
    )
  }
  for (const [match, replacement, error] of [
    ['content="deloitte"', 'content="different"', /identity/],
    [description, "Short", /incomplete/],
    ['itemprop="datePosted"', 'itemprop="missing"', /date/],
    ["/job/Bengaluru-Role/1000/", "/job/Bengaluru-Role/9999/", /identity/],
  ] as const) {
    const mock = transport([row(0)], (body, target) =>
      target.includes("/job/") ? body.replace(match, replacement) : body
    )
    await assert.rejects(
      fetchCatalogPage(deloitteIndiaSource, 1, {
        fetch: mock.fetch,
        snapshotStartedAt,
      }),
      error
    )
  }
  const duplicate = transport([row(0), row(0)])
  await assert.rejects(
    fetchCatalogPage(deloitteIndiaSource, 1, { fetch: duplicate.fetch }),
    /duplicate/
  )
  const blocked = transport([row(0)], (body, url) =>
    url.endsWith("/robots.txt") ? "User-agent: *\nDisallow: /go/" : body
  )
  await assert.rejects(
    fetchCatalogPage(deloitteIndiaSource, 1, { fetch: blocked.fetch }),
    /robots/
  )
  assert.equal(blocked.calls.length, 1)
  await assert.rejects(
    fetchCatalogPage(
      { ...deloitteIndiaSource, config: { url: "https://evil.test" } },
      1,
      { fetch: () => assert.fail("must not fetch") }
    )
  )
})

test("Deloitte rejects a repeated adjacent page and preserves provider retry timing", async () => {
  const rows = Array.from({ length: 27 }, (_, index) => row(index))
  const repeated = transport(rows, (body, target) =>
    target.includes("/718244/25/")
      ? listing(rows.slice(0, 2), 25, rows.length)
      : body
  )
  await assert.rejects(
    fetchCatalogPage(deloitteIndiaSource, 2, { fetch: repeated.fetch }),
    /repeated a page boundary/
  )
  let calls = 0
  await assert.rejects(
    fetchCatalogPage(deloitteIndiaSource, 1, {
      fetch: async () => {
        calls++
        return new Response("Throttled", {
          status: 429,
          headers: { "Retry-After": "3600" },
        })
      },
    }),
    (error: unknown) =>
      error instanceof CatalogSourceError &&
      error.retryAt !== null &&
      Date.parse(error.retryAt) > Date.now() + 3500_000
  )
  assert.equal(calls, 1)
})

test("Deloitte accepts only consistent partial duplicate index entries across distinct pages", async () => {
  const rows = Array.from({ length: 27 }, (_, index) => row(index))
  const duplicateRows = [rows[24], rows[26]]
  const partial = transport(rows, (body, target) =>
    target.includes("/718244/25/")
      ? listing(duplicateRows, 25, rows.length)
      : body
  )
  const result = await fetchCatalogPage(deloitteIndiaSource, 2, {
    fetch: partial.fetch,
  })
  assert.equal(result.jobs.length, 2)
  assert.equal(result.nextPage, null)
  const conflict = transport(rows, (body, target) =>
    target.includes("/718244/25/")
      ? listing(
          [{ ...rows[24], title: "Different title" }, rows[26]],
          25,
          rows.length
        )
      : body
  )
  await assert.rejects(
    fetchCatalogPage(deloitteIndiaSource, 2, { fetch: conflict.fetch }),
    /repeated a page boundary/
  )
})

test("Deloitte migration only admits the reviewed fixed source and updates scoped search", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create table job_source_directory(id text,kind text,company text,board text,config jsonb default '{}',enabled boolean default false,
      constraint job_source_directory_kind_check check(kind in ('oracle','ibm')));
      create function public.job_search_source_pool(uuid,text[]) returns jsonb language sql stable as $$
        select coalesce(jsonb_agg(id order by id),'[]') from job_source_directory where enabled and kind in ('oracle','accenture','ibm'); $$;`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611180086_qualcomm_eightfold_source.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const preserved = (
      await db.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname='job_source_directory_eightfold_scope'"
      )
    ).rows[0].definition
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611180087_successfactors_deloitte.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    assert.equal(
      (await db.query("select * from job_source_directory")).rows.length,
      0
    )
    assert.equal(
      (
        await db.query<{ definition: string }>(
          "select pg_get_constraintdef(oid) as definition from pg_constraint where conname='job_source_directory_eightfold_scope'"
        )
      ).rows[0].definition,
      preserved
    )
    await db.exec(
      "insert into job_source_directory(id,kind,company,board,enabled) values('eightfold:qualcomm-india','eightfold','Qualcomm','qualcomm-india',true)"
    )
    await db.exec(
      "insert into job_source_directory(id,kind,company,board,enabled) values('successfactors:deloitte-india','successfactors','Deloitte','deloitte-india',true)"
    )
    assert.deepEqual(
      (
        await db.query<{ pool: string[] }>(
          "select job_search_source_pool(null,null) as pool"
        )
      ).rows[0].pool,
      ["eightfold:qualcomm-india", "successfactors:deloitte-india"]
    )
    await assert.rejects(
      db.exec(
        "insert into job_source_directory(id,kind,company,board) values('successfactors:unknown','successfactors','Deloitte','unknown')"
      ),
      /check constraint/
    )
    await assert.rejects(
      db.exec(
        'update job_source_directory set config=\'{"url":"https://evil.test"}\''
      ),
      /check constraint/
    )
  } finally {
    await db.close()
  }
})
