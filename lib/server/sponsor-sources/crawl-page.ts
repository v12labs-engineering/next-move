import * as cheerio from "cheerio"

export type CrawlerPage = {
  url: string
  finalUrl: string
  status: number | null
  html: string
  title: string
  links: string[]
}

/**
 * Minimal direct-fetch page crawler — no Playwright/Firecrawl/Crawl4AI.
 * Always resolves (never throws) so callers that don't `.catch()` still get a
 * well-formed object back on network failure.
 */
export async function crawlPage(url: string): Promise<CrawlerPage> {
  const empty = (status: number | null, finalUrl: string): CrawlerPage => ({
    url,
    finalUrl,
    status,
    html: "",
    title: "",
    links: [],
  })

  let res: Response
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "job-search-crawler/1.0" },
      signal: AbortSignal.timeout(20000),
    })
  } catch {
    return empty(null, url)
  }

  if (!res.ok) {
    return empty(res.status, res.url || url)
  }

  let html: string
  try {
    html = await res.text()
  } catch {
    return empty(res.status, res.url || url)
  }

  const finalUrl = res.url || url
  const $ = cheerio.load(html)
  const title = $("title").first().text().trim()

  const links: string[] = []
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? ""
    try {
      links.push(new URL(href, finalUrl).toString())
    } catch {
      // skip unparseable hrefs
    }
  })

  return { url, finalUrl, status: res.status, html, title, links }
}
