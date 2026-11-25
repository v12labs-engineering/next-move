import { Resolver } from "node:dns/promises"
import { load } from "cheerio"
import { isPublicAddress } from "@/lib/server/applications/network"
import { discoverEmployerLinks } from "@/lib/server/catalog/discovery/links"

type Match = {
  name: string
  website: string
  evidenceUrl: string
  source: string
}

function words(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b\(p\)(?=\s)/g, " private ")
    .replace(/\bp\.?\s*v\.?\s*t\.?\b/g, "private")
    .replace(/\bltd\b/g, "limited")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

const ending = /(?:\s+(?:private|limited|llp|inc|incorporated|llc|plc))+$/u
const country = /\bindia\b|\+91(?:\s|[-(])*\d{2,}/i

function candidateHosts(company: string) {
  const name = words(company).replace(ending, "")
  const keys = [...new Set([name, name.replace(/\s+india$/u, "")])]
    .map((value) => value.replace(/\s+/g, ""))
    .filter((value) => /^[a-z0-9]{5,48}$/u.test(value))
  return keys.flatMap((key) =>
    ["com", "in", "co.in", "io"].map((tld) => `${key}.${tld}`)
  )
}

function confirmsEmployer(html: string, company: string) {
  const $ = load(html)
  const legalName = words(company)
  const brand = legalName.replace(ending, "")
  if (
    !brand ||
    /domain (?:is )?for sale|buy this domain|domain parking|just a moment|403 forbidden/i.test(
      $("title").text()
    )
  )
    return false
  const names = $("title, meta[property='og:site_name'], h1, header img[alt]")
    .toArray()
    .map((el) =>
      words($(el).attr("content") ?? $(el).attr("alt") ?? $(el).text())
    )
  const brandShown = names.some(
    (name) =>
      name === brand || name.startsWith(`${brand} `) || name === legalName
  )
  const footer = $(
    "footer, address, [id*='footer'], [class*='footer'], [itemprop='address']"
  )
    .text()
    .slice(0, 20_000)
  if (ending.test(legalName))
    return (
      brandShown &&
      ` ${words(footer)} `.includes(` ${legalName} `) &&
      !/developed and managed by\s*indiamart/i.test(footer)
    )
  const siteName = words(
    $("meta[property='og:site_name']").attr("content") ?? ""
  )
  return (
    siteName === brand &&
    brand.replace(/\s/g, "").length >= 9 &&
    country.test(footer)
  )
}

const resolver = new Resolver({ timeout: 1250, tries: 1 })
async function publicHost(host: string) {
  try {
    const addresses = await Promise.any([
      resolver.resolve4(host),
      resolver.resolve6(host),
    ])
    return addresses.length > 0 && addresses.every(isPublicAddress)
  } catch {
    return false
  }
}

export async function probeEmployerSites(company: string) {
  const matches: Match[] = []
  const hosts = await Promise.all(
    candidateHosts(company).map(async (host) =>
      (await publicHost(host)) ? host : null
    )
  )
  for (const host of hosts) {
    if (!host) continue
    await discoverEmployerLinks([`https://${host}/`], {
      maxMs: 4_000,
      maxPages: 1,
      sameSiteRedirects: true,
      inspectPage(page, html) {
        if (confirmsEmployer(html, company))
          matches.push({
            name: company,
            website: page.href,
            evidenceUrl: page.href,
            source: "Company website identity verified from published page",
          })
      },
    })
  }
  return matches
}
