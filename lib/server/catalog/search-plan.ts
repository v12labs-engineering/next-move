import { relevantJobTitle } from "@/lib/matching"

export const MAX_SEARCH_SOURCES = 96

export type SearchSource = {
  id: string
  titles: string[]
  countries: string[]
  estimated_records: number
  last_success_at: string | null
  cursor?: number
}

/** SQL only prefilters; the same title gate used by matching decides relevance. */
export function jobSearchPatterns(roles: readonly string[]) {
  const patterns = new Set<string>()
  for (const role of roles) {
    const words =
      role
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    if (words.length) patterns.add(`%${words.join("%")}%`)
    if (
      /\b(software|full.?stack|front.?end|back.?end|web|mobile|application)\b/i.test(
        role
      )
    )
      for (const term of [
        "software",
        "full%stack",
        "frontend",
        "front%end",
        "backend",
        "back%end",
        "web",
        "mobile",
        "application",
        "developer",
        "sde",
        "technical%staff",
        "platform%engineer",
      ])
        patterns.add(`%${term}%`)
  }
  return [...patterns].slice(0, 90)
}

export function selectSearchSources(
  pool: SearchSource[],
  roles: readonly string[],
  countries: readonly string[],
  rotation = 0
) {
  const eligible = pool.filter(
    (source) =>
      !source.id.startsWith("alexandria:") &&
      source.estimated_records >= 1 &&
      source.countries.some((country) => countries.includes(country))
  )
  const known = eligible.filter((source) =>
    source.titles.some((title) => relevantJobTitle(title, roles))
  )
  const exploration = eligible.filter((source) => !source.titles.length)
  const picked: SearchSource[] = []
  function add(source: SearchSource | undefined) {
    if (
      source &&
      picked.length < MAX_SEARCH_SOURCES &&
      !picked.some((row) => row.id === source.id)
    )
      picked.push(source)
  }
  // Give destinations a turn before filling the remaining bounded slots.
  const start = countries.length ? rotation % countries.length : 0
  for (const country of [
    ...countries.slice(start),
    ...countries.slice(0, start),
  ])
    add(
      known.find(
        (source) =>
          source.countries.includes(country) && !picked.includes(source)
      )
    )
  for (const source of known) {
    if (picked.length >= MAX_SEARCH_SOURCES / 3) break
    add(source)
  }
  for (const source of exploration.slice(0, 64)) add(source)
  for (const source of known) add(source)
  return picked.map((source) => source.id)
}
