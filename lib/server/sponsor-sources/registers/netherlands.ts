import * as cheerio from "cheerio"

import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"
import { fetchSourceHtml } from "@/lib/server/sponsor-sources/fetch"

export const IND_REGISTER_URL =
  "https://ind.nl/en/public-register-recognised-sponsors/public-register-work"

/**
 * Netherlands — IND public register of recognised sponsors (work).
 *
 * Structure (verified live): one <table> whose body rows are
 *   <tr><th scope="row">Company name</th><td>KvK number</td></tr>
 * ~12,000 rows. Note the company name is in a <th>, not a <td>.
 *
 * Fails loudly if the table or rows can't be found (layout changed).
 */
export async function fetchIndSponsors(): Promise<SponsorSeed[]> {
  const html = await fetchSourceHtml(IND_REGISTER_URL)
  const $ = cheerio.load(html)

  const seeds: SponsorSeed[] = []
  $("table tbody tr, table tr").each((_, row) => {
    const name = $(row).find('th[scope="row"]').first().text()
    const kvk = $(row).find("td").first().text()
    const cleaned = cleanName(name)
    if (!cleaned) return
    seeds.push({
      name: cleaned,
      registryId: kvk.replace(/\s+/g, "").trim() || undefined,
      city: "Netherlands",
      note: "IND recognised sponsor (work)",
    })
  })

  if (seeds.length < 100) {
    throw new Error(
      `IND register parse returned only ${seeds.length} sponsors — layout likely changed at ${IND_REGISTER_URL}`
    )
  }
  return seeds
}

function cleanName(raw: string): string {
  // The register wraps some abbreviations in doubled quotes, e.g.
  // `""Aa-Dee"" Machinefabriek`. Collapse the doubled quotes everywhere.
  return raw
    .replace(/\s+/g, " ")
    .replace(/""+/g, "")
    .replace(/^["\s]+|["\s]+$/g, "")
    .trim()
}
