import assert from "node:assert/strict"
import test from "node:test"
import {
  measureCatalogRollout,
  type CatalogRolloutRow,
} from "../scripts/lib/catalog-rollout-measurement.mjs"

const asOf = new Date("2026-11-17T12:00:00.000Z")
const row = (
  id: string,
  patch: Partial<CatalogRolloutRow> = {}
): CatalogRolloutRow => ({
  id,
  url: `https://careers.acme.com/jobs/${id}`,
  source: "employer:acme",
  title: `Software Engineer ${id}`,
  company: "Acme",
  country: "India",
  city: "Bengaluru",
  posted_at: "2026-11-16T12:00:00.000Z",
  is_active: true,
  discovered_at: "2026-11-16T12:00:00.000Z",
  last_checked_at: "2026-11-16T12:00:00.000Z",
  ...patch,
})

test("rollout distinguishes net-new, India coverage, reactivation, refresh and removals", () => {
  const before = [
    row("continuing"),
    row("inactive", { is_active: false }),
    row("germany", { country: "Germany" }),
    row("removed"),
  ]
  const after = [
    row("continuing", { last_checked_at: asOf.toISOString() }),
    row("inactive"),
    row("germany", { country: "Germany" }),
    row("india-variant", { url: before[2].url }),
    row("new"),
  ]
  const result = measureCatalogRollout(before, after, asOf)
  assert.equal(result.before.unique, 2)
  assert.equal(result.after.unique, 4)
  assert.equal(result.newCanonicalIndiaJobs, 1)
  assert.equal(result.newCanonicalIndiaJobsByDate.fresh30d, 1)
  assert.equal(result.newToIndiaExistingGlobalJobs, 1)
  assert.equal(result.reactivatedIndiaJobs, 1)
  assert.equal(result.refreshedExistingIndiaJobs, 1)
  assert.equal(result.removedActiveIndiaJobs, 1)
  assert.equal(result.netActiveIndiaUniqueChange, 2)
  assert.equal(result.insertedActiveIndiaRows, 2)
  assert.equal(result.insertedRowsForKnownCanonicalIdentities, 1)
  assert.deepEqual(
    result.newJobs.map((job) => job.rowIds),
    [["new"]]
  )
})

test("same URL source and city variants count once and tracking changes are not new", () => {
  const baseline = row("a", {
    url: "https://careers.acme.com/jobs/123/?utm_source=old#apply",
  })
  const result = measureCatalogRollout(
    [baseline],
    [
      {
        ...baseline,
        url: "https://careers.acme.com/jobs/123?utm_campaign=new",
      },
      row("copy", {
        url: "https://careers.acme.com/jobs/123",
        city: "Pune",
        source: "board:mirror",
      }),
      row("new-a", { url: "https://careers.acme.com/jobs/456" }),
      row("new-b", {
        url: "https://careers.acme.com/jobs/456?gclid=123",
        city: "Pune",
      }),
    ],
    asOf
  )
  assert.equal(result.after.unique, 2)
  assert.equal(result.newCanonicalIndiaJobs, 1)
  assert.equal(result.after.duplicateOrLocationVariantRows, 2)
  assert.equal(result.insertedRowsForKnownCanonicalIdentities, 1)
  assert.equal(result.additionalLocationOrSourceRowsForNewIdentities, 1)
  assert.deepEqual(result.newJobs[0].cities, ["Bengaluru", "Pune"])
})

test("Greenhouse embedding and hosted job links share an existing canonical identity", () => {
  const result = measureCatalogRollout(
    [
      row("hosted", {
        url: "https://job-boards.greenhouse.io/acme/jobs/123456",
        country: "Canada",
      }),
    ],
    [
      row("embedded", {
        url: "https://acme.com/careers/?gh_jid=123456&utm_source=feed",
        source: "greenhouse:acme",
      }),
    ],
    asOf
  )
  assert.equal(result.newCanonicalIndiaJobs, 0)
  assert.equal(result.newToIndiaExistingGlobalJobs, 1)
})

test("fixed freshness window never substitutes observation dates for publication dates", () => {
  const result = measureCatalogRollout(
    [],
    [
      row("start", { posted_at: "2026-10-18T12:00:00.000Z" }),
      row("end", { posted_at: asOf.toISOString() }),
      row("old", {
        posted_at: "2026-10-18T11:59:59.999Z",
        discovered_at: asOf.toISOString(),
      }),
      row("future", { posted_at: "2026-11-17T12:00:00.001Z" }),
      row("unknown", { posted_at: null, last_checked_at: asOf.toISOString() }),
      row("invalid-date", { posted_at: "bad date" }),
    ],
    asOf
  )
  assert.deepEqual(result.newCanonicalIndiaJobsByDate, {
    fresh30d: 2,
    stale: 1,
    unknown: 2,
    future: 1,
  })
  assert.equal(result.netFreshIndiaUniqueChange, 2)
  assert.equal(result.freshWindowStart, "2026-10-18T12:00:00.000Z")
})

test("both inventories use the same asOf so clock aging does not fabricate a loss", () => {
  const existing = row("a", { posted_at: "2026-10-18T12:00:00.000Z" })
  const result = measureCatalogRollout(
    [existing],
    [existing],
    new Date(asOf.getTime() + 1)
  )
  assert.equal(result.before.fresh30d, 0)
  assert.equal(result.after.fresh30d, 0)
  assert.equal(result.netFreshIndiaUniqueChange, 0)
  assert.equal(result.unchangedContinuingIndiaJobs, 1)
})

test("heuristic collisions are explicit and do not alter exact canonical counts", () => {
  const before = [row("known", { title: "Senior Software Engineer" })]
  const result = measureCatalogRollout(
    before,
    [
      ...before,
      row("possibly-known", {
        company: " ACME ",
        title: "senior  SOFTWARE Engineer",
      }),
      row("new-a", { title: "Marketing Manager" }),
      row("new-b", { title: "Marketing Manager", source: "board:other" }),
      row("different-city", { title: "Marketing Manager", city: "Pune" }),
    ],
    asOf
  )
  assert.equal(result.newCanonicalIndiaJobs, 4)
  assert.equal(result.potentialDuplicateGroups.length, 2)
  assert.equal(result.heuristicConservativeNewUniqueEstimate, 2)
  assert.equal(result.heuristicConservativeFreshNewUniqueEstimate, 2)
  assert.match(result.heuristicCaveat, /not a proven vacancy count/)
  assert.deepEqual(result.categoryBreakdown.marketing, {
    unique: 3,
    fresh30d: 3,
  })
})

test("archived descriptions remain unfetched and ambiguous categories stay unknown", () => {
  const result = measureCatalogRollout(
    [],
    [
      row("cto", { title: "CTO", description_ref: { pack: "private-pack" } }),
      row("explained", {
        title: "CTO",
        description: "Lead software engineering teams and production software.",
      }),
      row("sales", { title: "Account Executive" }),
    ],
    asOf
  )
  assert.equal(
    result.newJobs.find((job) => job.rowIds[0] === "cto")?.category,
    null
  )
  assert.equal(
    result.newJobs.find((job) => job.rowIds[0] === "cto")?.categoryEvidence,
    "title_only"
  )
  assert.equal(
    result.newJobs.find((job) => job.rowIds[0] === "explained")?.category,
    "software"
  )
  assert.deepEqual(result.categoryBreakdown.sales, { unique: 1, fresh30d: 1 })
})

test("invalid URLs cannot inflate canonical counts and bad snapshots fail", () => {
  const result = measureCatalogRollout(
    [],
    [row("unsafe", { url: "https://user:password@acme.com/job" })],
    asOf
  )
  assert.equal(result.newCanonicalIndiaJobs, 0)
  assert.deepEqual(result.invalidCanonicalUrlRows.after, ["unsafe"])
  assert.throws(
    () => measureCatalogRollout([row("a"), row("a")], [], asOf),
    /duplicate/
  )
  assert.throws(
    () => measureCatalogRollout([], [], new Date("bad")),
    /measurement time/
  )
})

test("output is deterministic under snapshot ordering and never mutates inputs", () => {
  const before = [row("existing-a"), row("existing-b", { is_active: false })]
  const after = [...before, row("new-a"), row("new-b")]
  const saved = JSON.stringify({ before, after })
  const forward = measureCatalogRollout(before, after, asOf)
  const backward = measureCatalogRollout(
    [...before].reverse(),
    [...after].reverse(),
    asOf
  )
  assert.deepEqual(forward, backward)
  assert.equal(JSON.stringify({ before, after }), saved)
})
