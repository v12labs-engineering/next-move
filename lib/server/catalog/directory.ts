import { boardFromUrl } from "./source-identity"
import type { CatalogPosting, CatalogSource } from "./feeds"

/** Recognizable ATS links become disabled candidates for operator review. */
export function discoveredBoards(jobs: CatalogPosting[]) {
  const boards = new Map<
    string,
    CatalogSource & { enabled: false; discovered_url: string }
  >()
  for (const job of jobs) {
    const identity = boardFromUrl(job.url)
    if (!identity) continue
    const { id, kind, board } = identity
    boards.set(id, {
      id,
      kind,
      board,
      company: job.company,
      enabled: false,
      discovered_url: job.url,
    })
  }
  return [...boards.values()]
}

export function prioritizeSources(
  sources: CatalogSource[],
  states: { id: string; last_started_at: string | null }[],
  demand: { source: string; demand: number }[],
  limit: number
) {
  const age = new Map(
    states.map((s) => [s.id, Date.parse(s.last_started_at ?? "") || 0])
  )
  const weights = new Map(demand.map((d) => [d.source, Number(d.demand)]))
  const oldest = [...sources].sort(
    (a, b) =>
      (age.get(a.id) ?? 0) - (age.get(b.id) ?? 0) || a.id.localeCompare(b.id)
  )
  const priority = [...oldest].sort(
    (a, b) => (weights.get(b.id) ?? 0) - (weights.get(a.id) ?? 0)
  )
  const picked: CatalogSource[] = [],
    seen = new Set<string>()
  while (picked.length < Math.min(limit, sources.length)) {
    const queue = picked.length % 3 === 2 ? oldest : priority
    const next = queue.find((s) => !seen.has(s.id))!
    picked.push(next)
    seen.add(next.id)
  }
  return picked
}

export function catalogSourceFreshnessMs(
  configured = process.env.CATALOG_SOURCE_FRESHNESS_MINUTES
) {
  const minutes = Number(configured ?? 330)
  const milliseconds = minutes * 60_000
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 1 ||
    !Number.isSafeInteger(milliseconds)
  )
    throw new Error("Invalid catalogue source freshness window")
  return milliseconds
}

/** Fresh sources cannot consume the bounded slots needed by due/new sources. */
export function dueSources<T extends { id: string }>(
  sources: T[],
  states: {
    id: string
    last_success_at: string | null
    complete: boolean | null
    failed: boolean
    pending: boolean
  }[],
  now = Date.now(),
  freshnessMs = catalogSourceFreshnessMs()
) {
  const health = new Map(states.map((state) => [state.id, state]))
  return sources.filter((source) => {
    if (source.id.startsWith("alexandria:")) return false
    const state = health.get(source.id)
    return (
      !state ||
      !state.last_success_at ||
      (state.complete !== true && source.id !== "linkedin") ||
      state.failed ||
      state.pending ||
      now - Date.parse(state.last_success_at) >= freshnessMs
    )
  })
}

/** Refresh published supply before spending the cycle on catalogue growth. */
export function refreshOrder<
  T extends { id: string; last_success_at: string | null },
>(sources: T[]) {
  return [...sources].sort(
    (a, b) =>
      Number(Boolean(b.last_success_at)) - Number(Boolean(a.last_success_at)) ||
      (Date.parse(a.last_success_at ?? "") || 0) -
        (Date.parse(b.last_success_at ?? "") || 0) ||
      a.id.localeCompare(b.id)
  )
}
