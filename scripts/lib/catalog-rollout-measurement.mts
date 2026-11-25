import { createHash } from "node:crypto"
import { classifyJobCategory, type JobCategory } from "@/lib/jobs/categories"
import { normalizedPosting } from "./registry-job-postings.mjs"

export type CatalogRolloutRow = {
  id: string
  url: string
  source: string
  title: string
  company: string
  country: string
  city: string | null
  posted_at: string | null
  is_active: boolean
  discovered_at: string
  last_checked_at: string | null
  description?: string
  description_ref?: unknown
}

type Entry = { key: string; url: string; row: CatalogRolloutRow }
type Groups = Map<string, Entry[]>
type DateStatus = "fresh30d" | "stale" | "unknown" | "future"

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compare)
const timestamp = (value: string | null) => Date.parse(value ?? "")
const words = (value: string) =>
  value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ")

function fingerprint(row: CatalogRolloutRow) {
  return [row.company, row.title, row.country, row.city ?? ""]
    .map(words)
    .join("\n")
}

function entries(rows: CatalogRolloutRow[]) {
  const seen = new Set<string>()
  const invalidUrlRows: string[] = []
  const observations: Entry[] = []
  for (const row of rows) {
    if (!row.id || seen.has(row.id))
      throw new Error("Snapshot has duplicate or missing row IDs")
    seen.add(row.id)
    // This normalizer's key depends only on the application URL when no inline
    // identifier is supplied. Neutral labels prevent legacy generic titles from
    // changing whether an otherwise valid URL can be compared.
    const normalized = normalizedPosting({
      title: "Catalog posting",
      company: "Catalog measurement",
      url: row.url,
      countries: [],
      location: null,
      postedAt: null,
      description: "",
      evidence: row.url,
      method: "structured_data",
    })
    if (!normalized) {
      invalidUrlRows.push(row.id)
      continue
    }
    observations.push({ key: normalized.key, url: normalized.url, row })
  }
  return { observations, invalidUrlRows: sorted(invalidUrlRows) }
}

function group(
  entries: Entry[],
  keep: (row: CatalogRolloutRow) => boolean = () => true
): Groups {
  const result: Groups = new Map()
  for (const entry of entries) {
    if (!keep(entry.row)) continue
    const rows = result.get(entry.key) ?? []
    rows.push(entry)
    result.set(entry.key, rows)
  }
  return result
}

/** Pure before/after comparison: no database, network, wall-clock reads or writes.
 * A canonical posting is not a claim that all cross-site vacancies are deduped. */
export function measureCatalogRollout(
  beforeRows: CatalogRolloutRow[],
  afterRows: CatalogRolloutRow[],
  asOf: Date
) {
  const end = asOf.getTime()
  if (!Number.isFinite(end)) throw new Error("Invalid measurement time")
  const start = end - 30 * 86_400_000
  const before = entries(beforeRows)
  const after = entries(afterRows)
  const allBefore = group(before.observations)
  const indiaBefore = group(
    before.observations,
    (row) => row.country === "India"
  )
  const indiaActive = (row: CatalogRolloutRow) =>
    row.country === "India" && row.is_active
  const activeBefore = group(before.observations, indiaActive)
  const activeAfter = group(after.observations, indiaActive)

  function dates(rows: Entry[]): DateStatus {
    const times = rows
      .map(({ row }) => timestamp(row.posted_at))
      .filter(Number.isFinite)
    if (times.some((value) => value >= start && value <= end)) return "fresh30d"
    if (times.some((value) => value < start)) return "stale"
    return times.length ? "future" : "unknown"
  }
  function inventory(groups: Groups) {
    const result = {
      rows: 0,
      unique: groups.size,
      fresh30d: 0,
      stale: 0,
      unknown: 0,
      future: 0,
      duplicateOrLocationVariantRows: 0,
    }
    for (const rows of groups.values()) {
      result.rows += rows.length
      result[dates(rows)]++
    }
    result.duplicateOrLocationVariantRows = result.rows - result.unique
    return result
  }
  const newKeys = sorted(
    [...activeAfter.keys()].filter((key) => !allBefore.has(key))
  )
  const newToIndia = sorted(
    [...activeAfter.keys()].filter(
      (key) => allBefore.has(key) && !indiaBefore.has(key)
    )
  )
  const reactivated = sorted(
    [...activeAfter.keys()].filter(
      (key) => indiaBefore.has(key) && !activeBefore.has(key)
    )
  )
  const continuing = sorted(
    [...activeAfter.keys()].filter((key) => activeBefore.has(key))
  )
  const refreshed = continuing.filter((key) => {
    const latest = (rows: Entry[]) =>
      Math.max(
        -Infinity,
        ...rows
          .map(({ row }) => timestamp(row.last_checked_at))
          .filter(Number.isFinite)
      )
    return latest(activeAfter.get(key)!) > latest(activeBefore.get(key)!)
  })
  const removed = sorted(
    [...activeBefore.keys()].filter((key) => !activeAfter.has(key))
  )

  const categoryBreakdown: Record<
    string,
    { unique: number; fresh30d: number }
  > = {}
  const newJobs = newKeys.map((key) => {
    const rows = activeAfter.get(key)!
    const ordered = [...rows].sort((a, b) => compare(a.row.id, b.row.id))
    const categoryCandidates = sorted(
      rows.flatMap(({ row }) => {
        const category = classifyJobCategory(row.title, row.description ?? "")
        return category ? [category] : []
      })
    ) as JobCategory[]
    const category =
      categoryCandidates.length === 1 ? categoryCandidates[0] : null
    const bucket =
      category ?? (categoryCandidates.length ? "conflicting" : "unclassified")
    const dateStatus = dates(rows)
    const count = categoryBreakdown[bucket] ?? { unique: 0, fresh30d: 0 }
    count.unique++
    if (dateStatus === "fresh30d") count.fresh30d++
    categoryBreakdown[bucket] = count
    return {
      canonicalIdentity: key,
      url: ordered[0].url,
      title: ordered[0].row.title,
      company: ordered[0].row.company,
      category,
      categoryCandidates,
      categoryEvidence: rows.some(({ row }) => row.description?.trim())
        ? "title_and_inline_description"
        : "title_only",
      dateStatus,
      postedDates: sorted(
        rows.flatMap(({ row }) => (row.posted_at ? [row.posted_at] : []))
      ),
      cities: sorted(rows.flatMap(({ row }) => (row.city ? [row.city] : []))),
      sources: sorted(rows.map(({ row }) => row.source)),
      rowIds: sorted(rows.map(({ row }) => row.id)),
    }
  })

  // Heuristic only: the app suppresses identical company/title/country/city
  // labels. Different requisitions can legitimately share those labels. Treat
  // the result as a conservative alternative estimate, never exact identity.
  const roleGroups = new Map<string, Set<string>>()
  for (const { key, row } of [
    ...before.observations,
    ...after.observations.filter(({ row }) => indiaActive(row)),
  ]) {
    if (row.country !== "India") continue
    const role = fingerprint(row)
    const keys = roleGroups.get(role) ?? new Set<string>()
    keys.add(key)
    roleGroups.set(role, keys)
  }
  const parents = new Map<string, string>()
  function root(key: string): string {
    const parent = parents.get(key)
    if (!parent || parent === key) return key
    const result = root(parent)
    parents.set(key, result)
    return result
  }
  const newSet = new Set(newKeys)
  const potentialDuplicateGroups = [...roleGroups.entries()]
    .filter(
      ([, keys]) => keys.size > 1 && [...keys].some((key) => newSet.has(key))
    )
    .sort(([a], [b]) => compare(a, b))
    .map(([role, keys]) => {
      const identities = sorted(keys)
      const first = root(identities[0])
      for (const key of identities.slice(1)) parents.set(root(key), first)
      return {
        roleFingerprint: createHash("sha256").update(role).digest("hex"),
        labels: role.split("\n"),
        identities,
        baselineIdentities: identities.filter((key) => allBefore.has(key)),
        newIdentities: identities.filter((key) => newSet.has(key)),
      }
    })
  const knownComponents = new Set([...allBefore.keys()].map(root))
  const estimate = new Set(
    newKeys.map(root).filter((key) => !knownComponents.has(key))
  )
  const freshEstimate = new Set(
    newJobs
      .filter((job) => job.dateStatus === "fresh30d")
      .map((job) => root(job.canonicalIdentity))
      .filter((key) => !knownComponents.has(key))
  )
  const beforeIds = new Set(beforeRows.map((row) => row.id))
  const insertedIndiaRows = after.observations.filter(
    ({ row }) => indiaActive(row) && !beforeIds.has(row.id)
  )
  const beforeInventory = inventory(activeBefore)
  const afterInventory = inventory(activeAfter)
  const newDateCounts = { fresh30d: 0, stale: 0, unknown: 0, future: 0 }
  for (const job of newJobs) newDateCounts[job.dateStatus]++

  return {
    asOf: asOf.toISOString(),
    freshWindowStart: new Date(start).toISOString(),
    identityMethod:
      "normalizedPosting application URL key; tracking parameters removed, Greenhouse job IDs unified",
    freshnessMethod:
      "At least one active India row states a date inside the fixed inclusive 30-day window; dates are not inferred from discovery or refresh times",
    before: beforeInventory,
    after: afterInventory,
    netActiveIndiaUniqueChange: afterInventory.unique - beforeInventory.unique,
    netFreshIndiaUniqueChange:
      afterInventory.fresh30d - beforeInventory.fresh30d,
    newCanonicalIndiaJobs: newKeys.length,
    newCanonicalIndiaJobsByDate: newDateCounts,
    newToIndiaExistingGlobalJobs: newToIndia.length,
    reactivatedIndiaJobs: reactivated.length,
    refreshedExistingIndiaJobs: refreshed.length,
    unchangedContinuingIndiaJobs: continuing.length - refreshed.length,
    removedActiveIndiaJobs: removed.length,
    insertedActiveIndiaRows: insertedIndiaRows.length,
    insertedRowsForKnownCanonicalIdentities: insertedIndiaRows.filter(
      ({ key }) => allBefore.has(key)
    ).length,
    additionalLocationOrSourceRowsForNewIdentities: [...activeAfter.entries()]
      .filter(([key]) => newSet.has(key))
      .reduce((total, [, rows]) => total + rows.length - 1, 0),
    categoryBreakdown,
    categoryCaveat:
      "Categories use titles and available inline descriptions. Archived descriptions are not fetched, so ambiguous titles can remain unclassified.",
    invalidCanonicalUrlRows: {
      before: before.invalidUrlRows,
      after: after.invalidUrlRows,
    },
    potentialDuplicateGroups,
    heuristicConservativeNewUniqueEstimate: estimate.size,
    heuristicConservativeFreshNewUniqueEstimate: freshEstimate.size,
    heuristicCaveat:
      "Collapses matching normalized company/title/country/city across distinct application URLs and excludes collisions with baseline jobs. This may merge distinct requisitions and is not a proven vacancy count or guaranteed lower bound.",
    newJobs,
    existingIdentityChanges: { newToIndia, reactivated, refreshed, removed },
  }
}
