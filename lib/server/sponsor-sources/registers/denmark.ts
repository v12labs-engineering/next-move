import * as cheerio from "cheerio"

import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"
import { fetchSourceHtml } from "@/lib/server/sponsor-sources/fetch"

export const SIRI_REGISTER_URL =
  "https://www.nyidanmark.dk/uk-UA/Words-and-concepts/SIRI/Certified-companies"

/**
 * Denmark — SIRI Fast-track certified companies.
 *
 * Structure (verified live): table rows of
 *   <tr><td>Company name</td><td>CVR number</td></tr>
 * ~1,000 rows. Fails loudly if too few rows parse.
 */
export async function fetchSiriCertified(): Promise<SponsorSeed[]> {
  const html = await fetchSourceHtml(SIRI_REGISTER_URL)
  const $ = cheerio.load(html)

  const seeds: SponsorSeed[] = []
  $("table tr").each((_, row) => {
    const cells = $(row).find("td")
    if (cells.length < 1) return
    const name = decode($(cells[0]).text())
    const cvr = cells.length > 1 ? decode($(cells[1]).text()) : ""
    if (!name || /name of company|company name/i.test(name)) return
    seeds.push({
      name,
      registryId: cvr.replace(/\s+/g, "") || undefined,
      city: "Denmark",
      note: "SIRI Fast-track certified",
    })
  })

  if (seeds.length < 50) {
    throw new Error(
      `SIRI register parse returned only ${seeds.length} companies — layout likely changed at ${SIRI_REGISTER_URL}`
    )
  }
  return seeds
}

function decode(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
