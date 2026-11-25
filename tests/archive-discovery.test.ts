import assert from "node:assert/strict"
import test from "node:test"
import { CandidateStore } from "@/lib/server/catalog/discovery/store"
import { automaticDiscoveryDatabase } from "./helpers/automatic-discovery-database"
import {
  archiveResume,
  ArchiveHttpError,
  discoverArchivePage,
  latestArchiveIndex,
  parseArchivePage,
  type ArchiveCursor,
} from "@/lib/server/catalog/discovery/archive"

const cursor: ArchiveCursor = {
  index: "CC-MAIN-2026-43",
  partition: "ashby",
  page: 0,
}

test("archive index discovery honors provider retry-after before any page request", async () => {
  await assert.rejects(
    latestArchiveIndex(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "7200" } })
    ),
    (error: unknown) => {
      assert.ok(error instanceof ArchiveHttpError)
      assert.equal(error.status, 429)
      assert.ok(Date.parse(error.retryAt!) >= Date.now() + 7190000)
      return true
    }
  )
})
function capture(url: string, status = "200") {
  return JSON.stringify({ url, timestamp: "20261005100000", status })
}

test("archive intake deduplicates employer boards without asserting company identity or freshness", () => {
  const result = parseArchivePage(
    [
      capture("https://jobs.ashbyhq.com/Example/one"),
      capture("https://jobs.ashbyhq.com/example/two"),
      capture("https://jobs.ashbyhq.com/"),
      capture("https://jobs.ashbyhq.com/closed", "404"),
      capture("https://jobs.ashbyhq.com.evil.example/private"),
      capture("https://jobs.lever.co/example"),
      capture("https://user:pass@jobs.ashbyhq.com/private"),
      capture("http://jobs.ashbyhq.com/insecure"),
      capture("not a URL"),
    ].join("\n"),
    cursor
  )
  assert.equal(result.rows, 9)
  assert.equal(result.rejected, 7)
  assert.deepEqual(result.candidates, [
    {
      id: "ashby:example",
      kind: "ashby",
      board: "example",
      expected_company: null,
      historical_checked_at: null,
      evidence_url: "https://jobs.ashbyhq.com/Example/one",
    },
  ])
  assert.equal(
    parseArchivePage(capture("https://jobs.eu.lever.co/example"), {
      ...cursor,
      partition: "lever",
    }).candidates.length,
    0
  )
  assert.equal(
    parseArchivePage(
      capture("https://tenant.wd5.myworkdayjobs.com/en-US/External/job/role"),
      {
        ...cursor,
        partition: "workday",
      }
    ).candidates[0].id,
    "workday:tenant.wd5.myworkdayjobs.com~External"
  )
})

test("archive pagination pins the collection and reads complete blocks with reproducible provenance", async () => {
  const seen: URL[] = []
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    seen.push(url)
    assert.equal(url.origin, "https://index.commoncrawl.org")
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).has("authorization"), false)
    if (url.pathname === "/collinfo.json")
      return Response.json([
        { id: "CC-MAIN-2025-51", "cdx-api": "https://evil.example/index" },
        { id: "CC-MAIN-2026-43" },
        { id: "CC-MAIN-2012" },
      ])
    assert.equal(url.pathname, "/CC-MAIN-2026-43-index")
    assert.equal(url.searchParams.get("pageSize"), "1")
    assert.equal(url.searchParams.has("limit"), false)
    if (url.searchParams.has("showNumPages"))
      return Response.json({ pages: 2, pageSize: 1 })
    return new Response(
      capture(
        `https://jobs.ashbyhq.com/employer${url.searchParams.get("page")}`
      )
    )
  }
  const first = await discoverArchivePage(
    { partition: "ashby" },
    { fetch: transport }
  )
  assert.deepEqual(first.cursor, cursor)
  assert.deepEqual(first.nextCursor, { ...cursor, page: 1 })
  assert.equal(seen.length, 3)
  assert.equal(first.origin.sha256.length, 64)
  assert.equal(first.origin.revision.length, 40)
  const repeated = await discoverArchivePage(cursor, { fetch: transport })
  assert.deepEqual(repeated.origin, first.origin)
  assert.equal(
    seen.filter((url) => url.pathname === "/collinfo.json").length,
    1
  )
  const second = await discoverArchivePage(first.nextCursor!, {
    fetch: transport,
  })
  assert.equal(second.nextCursor, null)
  assert.equal(second.candidates[0].id, "ashby:employer1")
  assert.notEqual(second.origin.id, first.origin.id)
})

test("failed or oversized archive pages cannot advance a cursor or expose partial candidates", async () => {
  for (const body of [
    "{truncated",
    '{"url":"https://jobs.ashbyhq.com/example"}',
    "x".repeat(2_000_001),
  ])
    assert.throws(() => parseArchivePage(body, cursor))
  assert.throws(
    () =>
      parseArchivePage(
        (capture("https://jobs.ashbyhq.com/example") + "\n").repeat(5_001),
        cursor
      ),
    /row limit/
  )
  for (const status of [429, 503, 504, 404]) {
    let calls = 0
    await assert.rejects(
      discoverArchivePage(cursor, {
        fetch: async () => {
          calls++
          return calls === 1
            ? Response.json({ pages: 2, pageSize: 1 })
            : new Response(null, { status })
        },
      }),
      new RegExp(`Archive HTTP ${status}`)
    )
    assert.equal(calls, 2) // No immediate retry loop on throttling/unavailability.
  }
  let calls = 0
  await assert.rejects(
    discoverArchivePage(cursor, {
      fetch: async () => {
        calls++
        return calls === 1
          ? Response.json({ pages: 2, pageSize: 1 })
          : new Response("", { headers: { "content-length": "2000001" } })
      },
    }),
    /size/
  )
  await assert.rejects(
    discoverArchivePage(cursor, {
      fetch: async () => Response.json({ pages: 2, pageSize: 5 }),
    })
  )
})

test("invalid cursors never fetch, and applying a continuation cannot skip an unimported preview", async () => {
  const never: typeof fetch = async () => {
    assert.fail("must not fetch")
  }
  for (const bad of [
    { ...cursor, index: "../../private" },
    { ...cursor, partition: "https://evil.example" },
    { ...cursor, page: -1 },
    { ...cursor, page: 0.5 },
    { partition: "ashby", page: 1 },
  ])
    await assert.rejects(discoverArchivePage(bad, { fetch: never }))
  const receipt = {
    command: "archive",
    applied: true,
    nextCursor: { ...cursor, page: 1 },
  }
  assert.deepEqual(archiveResume(receipt, true), receipt.nextCursor)
  assert.throws(
    () => archiveResume({ ...receipt, applied: false }, true),
    /previewed page/
  )
  assert.throws(
    () => archiveResume({ ...receipt, nextCursor: null }, true),
    /complete/
  )
  assert.throws(() => archiveResume({ ...receipt, command: "import" }, true))
})

test("archive imports survive a lost chunk receipt without duplicates and cannot activate unvalidated sources", async () => {
  let loseReceipt = true
  const db = await automaticDiscoveryDatabase((name) => {
    if (name === "import_source_candidates" && loseReceipt) {
      loseReceipt = false
      throw new Error("Import committed but receipt was lost")
    }
  })
  try {
    const page = await discoverArchivePage(cursor, {
      fetch: async (input) =>
        String(input).includes("showNumPages")
          ? Response.json({ pages: 1, pageSize: 1 })
          : new Response(
              Array.from({ length: 501 }, (_, i) =>
                capture(`https://jobs.ashbyhq.com/archive-fixture-${i}`)
              ).join("\n")
            ),
    })
    const store = new CandidateStore(db.database)
    const counts = async () =>
      (
        await db.sql.query(
          "select (select count(*) from job_source_directory) sources, (select count(*) from job_catalog) jobs"
        )
      ).rows
    const before = await counts()
    await assert.rejects(store.import(page.origin, page.candidates))
    assert.deepEqual(await store.import(page.origin, page.candidates), {
      newCandidates: 1,
      newObservations: 1,
    })
    assert.deepEqual(await store.import(page.origin, page.candidates), {
      newCandidates: 0,
      newObservations: 0,
    })
    assert.equal(
      (
        await db.sql.query(
          "select * from source_candidates where status='imported'"
        )
      ).rows.length,
      501
    )
    assert.equal(
      (
        await db.sql.query(
          "select * from source_candidate_observations where historical_checked_at is null"
        )
      ).rows.length,
      501
    )
    await assert.rejects(
      store.activate(
        [page.candidates[0].id],
        "Archive evidence alone is insufficient"
      )
    )
    assert.deepEqual(await counts(), before)
  } finally {
    await db.sql.close()
  }
})
