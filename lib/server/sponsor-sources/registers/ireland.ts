import { readSheet } from "read-excel-file/node"

import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"
import { fetchSourceBuffer } from "@/lib/server/sponsor-sources/fetch"

const BASE =
  "https://enterprise.gov.ie/en/publications/publication-files/employment-permits-issued-to-companies"

export function irelandPermitsUrl(year: number): string {
  return `${BASE}-${year}.xlsx`
}

/**
 * Ireland — employment permits issued to companies (DETE XLSX export).
 *
 * Structure (verified live): one "Export" sheet, header `Employer Name` in
 * column 0 followed by monthly permit counts. ~4,900 employers.
 *
 * The publication is per-year; we try the current year and fall back to the
 * previous one so the source URL doesn't silently rot in January.
 */
export async function fetchIrelandPermits(
  year: number
): Promise<SponsorSeed[]> {
  let buf: Buffer | null = null
  let usedYear = year
  for (const candidate of [year, year - 1]) {
    try {
      buf = await fetchSourceBuffer(irelandPermitsUrl(candidate))
      usedYear = candidate
      break
    } catch {
      // try previous year
    }
  }
  if (!buf) {
    throw new Error(
      `Ireland permits XLSX not found for ${year} or ${year - 1} at ${BASE}-<year>.xlsx`
    )
  }

  const rows = await readSheet(buf)

  const seeds: SponsorSeed[] = []
  for (const row of rows.slice(1)) {
    const name = String(row[0] ?? "").trim()
    if (!name || /employer name/i.test(name)) continue
    seeds.push({
      name,
      city: "Ireland",
      note: `Issued an Irish employment permit (${usedYear})`,
    })
  }

  if (seeds.length < 50) {
    throw new Error(
      `Ireland permits parse returned only ${seeds.length} employers — layout likely changed`
    )
  }
  return seeds
}
