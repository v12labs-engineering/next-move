import assert from "node:assert/strict"
import test from "node:test"
import {
  catalogSourceFreshnessMs,
  prioritizeSources,
  discoveredBoards,
  dueSources,
  refreshOrder,
} from "@/lib/server/catalog/directory"
import { catalogSources, type CatalogPosting } from "@/lib/server/catalog/feeds"

test("due published sources refresh oldest first before unmeasured catalogue growth", () => {
  const sources = [
    { id: "new-b", last_success_at: null },
    { id: "recent", last_success_at: "2026-10-30T01:00:00Z" },
    { id: "old", last_success_at: "2026-10-29T01:00:00Z" },
    { id: "new-a", last_success_at: null },
  ]
  assert.deepEqual(
    refreshOrder(sources).map((s) => s.id),
    ["old", "recent", "new-a", "new-b"]
  )
  assert.equal(sources[0].id, "new-b")
})

test("fresh high-demand sources cannot consume the slots for new sources", () => {
  const sources = [...catalogSources]
  const now = Date.now()
  const due = dueSources(
    sources,
    [
      {
        id: sources[0].id,
        last_success_at: new Date(now).toISOString(),
        complete: true,
        failed: false,
        pending: false,
      },
    ],
    now
  )
  assert.equal(
    due.some((source) => source.id === sources[0].id),
    false
  )
  assert.equal(due.length, sources.length - 1)
})

test("an hourly deployment can revisit feeds checked on the previous hourly run", () => {
  const now = Date.parse("2026-11-16T11:00:00Z")
  const sources = [{ id: "elapsed" }, { id: "recent" }]
  const states = sources.map(({ id }, index) => ({
    id,
    last_success_at: new Date(now - (60 - index * 6) * 60_000).toISOString(),
    complete: true,
    failed: false,
    pending: false,
  }))

  assert.deepEqual(
    dueSources(sources, states, now, catalogSourceFreshnessMs("330")),
    []
  )
  assert.deepEqual(
    dueSources(sources, states, now, catalogSourceFreshnessMs("55")),
    [sources[0]]
  )
  assert.throws(() => catalogSourceFreshnessMs("0"), /freshness window/)
})

test("candidate demand gets priority while the oldest unrequested source still gets a turn", () => {
  const sources = catalogSources.slice(0, 4)
  const order = prioritizeSources(
    [...sources],
    [
      { id: sources[0].id, last_started_at: "2026-10-29T00:00:00Z" },
      { id: sources[1].id, last_started_at: "2026-10-29T00:00:00Z" },
      { id: sources[2].id, last_started_at: "2026-10-20T00:00:00Z" },
      { id: sources[3].id, last_started_at: "2026-10-29T00:00:00Z" },
    ],
    [
      { source: sources[0].id, demand: 20 },
      { source: sources[1].id, demand: 10 },
      { source: sources[3].id, demand: 5 },
    ],
    3
  )
  assert.deepEqual(
    order.map((source) => source.id),
    [sources[0].id, sources[1].id, sources[2].id]
  )
})

test("employer discovery requires an exact known ATS host and retains provenance without enabling collection", () => {
  const listing: CatalogPosting = {
    id: "1",
    title: "Accountant",
    company: "Example",
    country: "India",
    city: null,
    description: "Accounting",
    url: "https://jobs.lever.co/example/123",
    work_mode: "unknown",
    visa_signal: "possible",
    sponsorship_evidence: "Unknown",
    sponsor_verified: false,
    source: "feed",
    posted_at: null,
  }
  const discovered = discoveredBoards([
    listing,
    { ...listing, url: "https://jobs.lever.co.evil.example/example/123" },
  ])
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].id, "lever:example")
  assert.equal(discovered[0].enabled, false)
  assert.equal(discovered[0].discovered_url, listing.url)
})
