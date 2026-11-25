import assert from "node:assert/strict"
import { test } from "node:test"
import {
  fetchIbmPage,
  ibmIndiaSource,
} from "@/lib/server/catalog/connectors/ibm"
import { fetchCatalogPage } from "@/lib/server/catalog/connectors"
import { validSourceId } from "@/lib/server/catalog/source-identity"
import {
  CatalogSourceError,
  type RawSourcePosting,
} from "@/lib/server/catalog/feeds"

const endpoint = "https://www-api.ibm.com/search/api/v2"
const snapshotStartedAt = new Date().toISOString()
const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const body =
  "Design and build production software services, distributed APIs and automated tests. Collaborate with engineering teams to maintain reliable cloud applications."
function job(index = 0, fields: Record<string, unknown> = {}) {
  return {
    title: "Software Engineer",
    url: `https://careers.ibm.com/careers/JobDetail?jobId=${140000 + index}`,
    body,
    dcdate: date,
    field_keyword_05: "India",
    field_keyword_08: "Software Engineering",
    field_keyword_17: "Hybrid",
    field_keyword_18: "Professional",
    field_keyword_19: "Bangalore, IN",
    ...fields,
  }
}
function transport(
  rows = [job()],
  options: {
    robots?: string
    robotsRedirect?: string
    robotsStatus?: number
    total?: number
    relation?: string
    timeout?: boolean
    failedShards?: number
    mutate?: (
      rows: ReturnType<typeof job>[],
      offset: number
    ) => ReturnType<typeof job>[]
  } = {}
) {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url !== endpoint) {
      calls.push({ url })
      assert.equal(init?.redirect, "manual")
      if (
        url === "https://www-api.ibm.com/robots.txt" &&
        options.robotsRedirect
      )
        return new Response(null, {
          status: 301,
          headers: { location: options.robotsRedirect },
        })
      if (options.robotsStatus)
        return new Response("Unavailable", {
          status: options.robotsStatus,
          headers: { "Retry-After": "60" },
        })
      return new Response(options.robots ?? "User-agent: *\nAllow: /\n")
    }
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.cache, "no-store")
    const query = JSON.parse(String(init.body))
    calls.push({ url, body: query })
    const offset = Number(query.from)
    const selected = rows.slice(offset, offset + Number(query.size))
    return Response.json({
      timed_out: options.timeout ?? false,
      _shards: { failed: options.failedShards ?? 0 },
      hits: {
        total: {
          value: options.total ?? rows.length,
          relation: options.relation ?? "eq",
        },
        hits: (options.mutate?.(selected, offset) ?? selected).map(
          (row: ReturnType<typeof job>) => ({
            _id: Number(String(row.url).match(/jobId=(\d+)/)?.[1] ?? 0)
              .toString(16)
              .padStart(64, "0"),
            _source: row,
          })
        ),
      },
    })
  }
  return { fetch, calls }
}

test("IBM registry dispatch uses fixed identity, full body, exact India and snapshot dates", async () => {
  assert.equal(validSourceId("ibm:india"), true)
  assert.equal(validSourceId("ibm:other"), false)
  const read = transport()
  const observed: RawSourcePosting[] = []
  const page = await fetchCatalogPage(ibmIndiaSource, 1, {
    fetch: read.fetch,
    snapshotStartedAt,
    observePosting: (row) => observed.push(row),
  })
  assert.equal(page.jobs.length, 1)
  assert.equal(page.jobs[0].country, "India")
  assert.equal(page.jobs[0].company, "IBM")
  assert.equal(page.jobs[0].city, "Bangalore")
  assert.equal(page.jobs[0].work_mode, "hybrid")
  assert.equal(page.jobs[0].description, body)
  assert.equal(page.jobs[0].posted_at, `${date}T00:00:00.000Z`)
  assert.equal(page.jobs[0].url, job().url)
  assert.equal(page.requests, 2)
  assert.equal(page.nextPage, null)
  assert.equal(observed.length, 1)
  const query = read.calls[1].body!
  assert.equal(query.appId, "careers")
  assert.deepEqual(query.scopes, ["careers2"])
  assert.equal(query.size, 100)
  assert.deepEqual(query.sort, [{ dcdate: "desc" }, { _id: "asc" }])
  assert.deepEqual(query.query, {
    bool: {
      must: [{ term: { field_keyword_05: "India" } }],
      filter: [
        {
          range: {
            dcdate: {
              gte: new Date(
                Date.parse(snapshotStartedAt) - 30 * 86_400_000
              ).toISOString(),
              lte: snapshotStartedAt,
            },
          },
        },
      ],
    },
  })
  assert.ok(Array.isArray(query._source) && query._source.includes("body"))
})

test("IBM preserves all source professions and uses user category projection", async () => {
  const read = transport([
    job(0, {
      title: "Account Executive",
      field_keyword_08: "Sales",
      field_keyword_19: "Multiple Cities",
    }),
  ])
  const observed: RawSourcePosting[] = []
  const software = await fetchIbmPage(ibmIndiaSource, 1, {
    fetch: read.fetch,
    observePosting: (row) => observed.push(row),
  })
  assert.equal(software.jobs.length, 0)
  assert.equal(observed[0].title, "Account Executive")
  const sales = await fetchIbmPage(ibmIndiaSource, 1, {
    fetch: read.fetch,
    jobCategories: ["sales"],
  })
  assert.equal(sales.jobs.length, 1)
  assert.equal(sales.jobs[0].city, null)
})

test("IBM paginates the entire fixed fresh inventory and checks resumed boundaries", async () => {
  const rows = Array.from({ length: 102 }, (_, index) => job(index))
  const read = transport(rows)
  const first = await fetchIbmPage(ibmIndiaSource, 1, {
    fetch: read.fetch,
    snapshotStartedAt,
  })
  const last = await fetchIbmPage(ibmIndiaSource, 2, {
    fetch: read.fetch,
    snapshotStartedAt,
  })
  assert.equal(first.nextPage, 2)
  assert.equal(last.nextPage, null)
  assert.equal(first.jobs.length, 100)
  assert.equal(last.jobs.length, 2)
  assert.equal(last.requests, 3)
  assert.equal(
    new Set([...first.jobs, ...last.jobs].map((row) => row.url)).size,
    102
  )
  assert.deepEqual(
    read.calls
      .filter((call) => call.body)
      .map((call) => [call.body?.from, call.body?.size]),
    [
      [0, 100],
      [100, 100],
      [99, 1],
    ]
  )
  await assert.rejects(
    fetchIbmPage(ibmIndiaSource, 3, { fetch: read.fetch }),
    /incomplete/
  )
  const overlap = transport(rows, {
    mutate: (selected, offset) =>
      offset === 100 ? [job(99), selected[1]] : selected,
  })
  await assert.rejects(
    fetchIbmPage(ibmIndiaSource, 2, { fetch: overlap.fetch }),
    /boundary/
  )
})

test("IBM refuses partial search, result caps, duplicate rows and missing pages before observations", async () => {
  for (const read of [
    transport([job()], { total: 2 }),
    transport([job()], { total: 10_001 }),
    transport([job()], { relation: "gte" }),
    transport([job()], { timeout: true }),
    transport([job()], { failedShards: 1 }),
    transport([job(), job()]),
    transport([job(1), job(0)]),
  ]) {
    const observed: RawSourcePosting[] = []
    await assert.rejects(
      fetchIbmPage(ibmIndiaSource, 1, {
        fetch: read.fetch,
        observePosting: (row) => observed.push(row),
      })
    )
    assert.deepEqual(observed, [])
  }
})

test("IBM refuses foreign locations, guessed dates, truncated bodies and unsafe posting URLs", async () => {
  for (const fields of [
    { field_keyword_05: "United States" },
    { field_keyword_19: "New York, US" },
    { dcdate: "2024-01-01" },
    { dcdate: "2026-02-30" },
    {
      dcdate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    },
    { dcdate: null },
    { body: "A short search teaser..." },
    { body: "<p></p>".repeat(30) },
    { url: "https://evil.test/careers/JobDetail?jobId=140000" },
    { url: "https://user:pass@careers.ibm.com/careers/JobDetail?jobId=140000" },
    {
      url: "https://careers.ibm.com/careers/JobDetail?jobId=140000&jobId=140001",
    },
  ])
    await assert.rejects(
      fetchIbmPage(ibmIndiaSource, 1, {
        fetch: transport([job(0, fields)]).fetch,
      })
    )
})

test("IBM respects robots exclusions, bounded official redirects, unavailable robots and throttling", async () => {
  const excluded = transport([job()], {
    robots: "User-agent: *\nDisallow: /search/\n",
  })
  await assert.rejects(
    fetchIbmPage(ibmIndiaSource, 1, { fetch: excluded.fetch }),
    /robots/
  )
  assert.equal(excluded.calls.length, 1)
  const unavailable = transport([job()], {
    robotsRedirect: "https://www.ibm.com/",
    robotsStatus: 404,
  })
  assert.equal(
    (await fetchIbmPage(ibmIndiaSource, 1, { fetch: unavailable.fetch })).jobs
      .length,
    1
  )
  const unsafe = transport([job()], { robotsRedirect: "https://evil.test/" })
  await assert.rejects(
    fetchIbmPage(ibmIndiaSource, 1, { fetch: unsafe.fetch }),
    /Untrusted IBM/
  )
  assert.ok(
    unsafe.calls.every(
      (call) => call.url === "https://www-api.ibm.com/robots.txt"
    )
  )
  const throttle = transport([job()], { robotsStatus: 429 })
  await assert.rejects(
    fetchIbmPage(ibmIndiaSource, 1, { fetch: throttle.fetch }),
    CatalogSourceError
  )
  assert.equal(throttle.calls.length, 1)
})

test("IBM handles empty inventories and preserves early-career facts without publishing them", async () => {
  const empty = await fetchIbmPage(ibmIndiaSource, 1, {
    fetch: transport([]).fetch,
  })
  assert.equal(empty.nextPage, null)
  assert.deepEqual(empty.jobs, [])
  const observed: RawSourcePosting[] = []
  const early = await fetchIbmPage(ibmIndiaSource, 1, {
    fetch: transport([job(0, { title: "Software Engineering Intern" })]).fetch,
    observePosting: (row) => observed.push(row),
  })
  assert.equal(observed.length, 1)
  assert.deepEqual(early.jobs, [])
})

test("IBM preserves missing optional category, mode and experience metadata as unknown", async () => {
  const page = await fetchIbmPage(ibmIndiaSource, 1, {
    fetch: transport([
      job(0, {
        field_keyword_08: null,
        field_keyword_17: null,
        field_keyword_18: null,
      }),
    ]).fetch,
  })
  assert.equal(page.jobs.length, 1)
  assert.equal(page.jobs[0].work_mode, "unknown")
})

test("IBM rejects unknown source configuration and invalid pages before requests", async () => {
  const fetch: typeof globalThis.fetch = async () => {
    throw new Error("Network must not run")
  }
  for (const source of [
    { ...ibmIndiaSource, id: "ibm:other" },
    { ...ibmIndiaSource, board: "other" },
    { ...ibmIndiaSource, company: "Other" },
    { ...ibmIndiaSource, config: { country: "US" } },
  ])
    await assert.rejects(fetchIbmPage(source, 1, { fetch }), /IBM|Unrecognized/)
  for (const page of [0, -1, 1.5, NaN, 101])
    await assert.rejects(
      fetchIbmPage(ibmIndiaSource, page, { fetch }),
      /Invalid IBM/
    )
})
