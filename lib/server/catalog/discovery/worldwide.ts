import { countryName, countryOptions } from "@/lib/location/countries"

// A geographically varied starting order, not inferred candidate demand or a
// claim about market size. Every remaining selectable destination follows once.
const startingCodes = [
  "US",
  "DE",
  "BR",
  "ZA",
  "JP",
  "AU",
  "CA",
  "AE",
  "NG",
  "MX",
  "FR",
  "ID",
  "GB",
  "CO",
  "KE",
  "KR",
  "NZ",
  "NL",
  "AR",
  "EG",
  "PH",
  "SA",
  "CH",
  "MY",
  "IN",
  "SG",
  "ES",
  "CL",
  "GH",
  "TW",
  "TH",
  "SE",
  "PL",
  "TR",
  "IL",
  "MA",
]

export function countryDiscoveryQueries(country: string, variation = 0) {
  const term = country === "UAE" ? "United Arab Emirates" : country
  const roles = [
    "(software OR developer OR DevOps)",
    '("data engineer" OR "machine learning")',
    '(software OR DevOps OR "engineering manager")',
  ][variation % 3]
  return [
    `${variation % 2 === 0 ? "(site:recruitee.com OR site:apply.workable.com)" : "(site:myworkdayjobs.com OR site:jobs.smartrecruiters.com)"} ${roles} "${term}"`,
    `(site:jobs.ashbyhq.com OR site:job-boards.greenhouse.io OR site:jobs.lever.co) software "${term}"`,
  ]
}

export function worldwideDiscoveryBatch(index: number) {
  const first = startingCodes.map((code) => {
    const name = countryName(code)
    if (!name) throw new Error("Worldwide discovery country is not selectable")
    return name
  })
  const ordered = [...new Set([...first, ...countryOptions])]
  const countriesPerBatch = 12,
    batchCount = Math.ceil(ordered.length / countriesPerBatch)
  if (!Number.isSafeInteger(index) || index < 0 || index >= batchCount)
    throw new Error(`Worldwide batch must be 0–${batchCount - 1}`)
  const countries = ordered.slice(
    index * countriesPerBatch,
    (index + 1) * countriesPerBatch
  )
  const queries = countries.flatMap((country) =>
    countryDiscoveryQueries(country).map((query) => ({ country, query }))
  )
  return {
    kind: "worldwide" as const,
    batch: index,
    batchCount,
    totalCountries: ordered.length,
    countries,
    queries,
    maxUrlsPerQuery: 2,
    nextBatch: index + 1 < batchCount ? index + 1 : null,
    note: "Search scope only. Locations, posting dates and sponsorship require current source evidence; this is not worldwide market coverage.",
  }
}
