import * as cheerio from "cheerio"

import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"
import { fetchSourceHtml } from "@/lib/server/sponsor-sources/fetch"

const JETRO_ORIGIN = "https://www.jetro.go.jp"
export const JETRO_OFP_URL = `${JETRO_ORIGIN}/en/hrportal/company/`

function pageUrl(page: number): string {
  return `${JETRO_ORIGIN}/en/hrportal/company.html?page=${page}&region=all`
}

/**
 * Japan — JETRO "Open for Professionals" list of companies interested in
 * global talent.
 *
 * Structure (verified live): paginated table (~283 companies, 20/page over
 * 15 pages). Each row: <th scope="row"><a href="/detail/N.html">Name</a></th>.
 * We page until a page yields no new companies (max 25 pages as a guard).
 */
export async function fetchJetroOfp(): Promise<SponsorSeed[]> {
  const seeds: SponsorSeed[] = []
  const seen = new Set<string>()

  // page 1 lives at the directory URL; the rest at the .html?page= URLs.
  for (let page = 1; page <= 25; page++) {
    const url = page === 1 ? JETRO_OFP_URL : pageUrl(page)
    const html = await fetchSourceHtml(url)
    const found = parsePage(html)
    if (found.length === 0) break
    let added = 0
    for (const seed of found) {
      const key = seed.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      seeds.push(seed)
      added++
    }
    if (added === 0) break
  }

  if (seeds.length < 20) {
    throw new Error(
      `JETRO OFP parse returned only ${seeds.length} companies — layout likely changed at ${JETRO_OFP_URL}`
    )
  }
  return seeds
}

function parsePage(html: string): SponsorSeed[] {
  const $ = cheerio.load(html)
  const seeds: SponsorSeed[] = []
  $('table tr th[scope="row"]').each((_, th) => {
    const anchor = $(th).find('a[href*="/detail/"]').first()
    const name = anchor.text().replace(/\s+/g, " ").trim()
    if (!name) return
    const href = anchor.attr("href") ?? ""
    const detailUrl = href ? new URL(href, JETRO_ORIGIN).toString() : ""
    seeds.push({
      name,
      city: "Japan",
      note: detailUrl
        ? `JETRO Open-for-Professionals — ${detailUrl}`
        : "JETRO Open-for-Professionals (interested in global talent)",
    })
  })
  return seeds
}
