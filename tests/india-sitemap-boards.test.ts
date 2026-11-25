import test from "node:test"
import assert from "node:assert/strict"
import { gzipSync } from "node:zlib"
import { fetchCatalogPage } from "../lib/server/catalog/connectors"
import {
  indiaJobBoards,
  type IndiaJobBoard,
} from "../lib/jobs/india-job-boards"

const now = Date.now()
const iso = new Date(now).toISOString()
const recent = new Date(now - 86_400_000).toISOString()
const stale = new Date(now - 60 * 86_400_000).toISOString()
const description =
  "Design distributed software services and document the architecture. Build and test production TypeScript APIs with the engineering team."
const title = "Senior Software Engineer"
const company = "Example Engineering"
const firecrawl = "http://127.0.0.1:13983"

function source(board: IndiaJobBoard) {
  return {
    id: `indiaboard:${board}`,
    kind: "indiaboard" as const,
    board,
    company: indiaJobBoards[board].name,
  }
}

const jobPage = (url: string, posted: string) =>
  `<html><body><h1>${title}</h1><script type="application/ld+json">{"@type":"JobPosting","url":"${url}","title":"${title}","description":"${description}","datePosted":"${posted}","hiringOrganization":{"name":"${company}"},"jobLocation":{"address":{"addressLocality":"Pune","addressCountry":"IN"}}}</script></body></html>`

const urlset = (entries: [string, string][]) =>
  `<urlset>${entries
    .map(
      ([loc, mod]) => `<url><loc>${loc}</loc><lastmod>${mod}</lastmod></url>`
    )
    .join("")}</urlset>`

async function withFirecrawl<T>(run: () => Promise<T>) {
  const before = process.env.CATALOG_FIRECRAWL_LOCAL_URL
  process.env.CATALOG_FIRECRAWL_LOCAL_URL = firecrawl
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env.CATALOG_FIRECRAWL_LOCAL_URL
    else process.env.CATALOG_FIRECRAWL_LOCAL_URL = before
  }
}

function boardFetch(
  robots: string,
  sitemap: (url: string) => Response | null,
  page: (target: string) => string,
  rendered: string[]
): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    if (url.endsWith("/robots.txt")) return new Response(robots)
    if (url === `${firecrawl}/v2/scrape`) {
      const target = JSON.parse(String(init?.body)).url
      rendered.push(target)
      return Response.json({
        success: true,
        data: {
          rawHtml: page(target),
          metadata: { sourceURL: target, statusCode: 200 },
        },
      })
    }
    return sitemap(url) ?? new Response("missing", { status: 404 })
  }
}

test("sitemap boards read recent, robots-allowed details with JobPosting data", async () => {
  const fresh =
    "https://www.shine.com/jobs/senior-software-engineer/example/20000001"
  const blocked = "https://www.shine.com/jobs/1-blocked/example/20000002"
  const old = "https://www.shine.com/jobs/old-role/example/20000003"
  const rendered: string[] = []
  const fetcher = boardFetch(
    "User-agent: *\nDisallow: /jobs/1*",
    (url) =>
      url.endsWith("all_jd_sitemap.xml")
        ? new Response(
            urlset([
              [fresh, recent],
              [blocked, recent],
              [old, stale],
              ["https://www.shine.com/myshine/", recent],
            ])
          )
        : null,
    (target) => jobPage(target, recent),
    rendered
  )
  const result = await withFirecrawl(() =>
    fetchCatalogPage(source("shine"), 1, {
      fetch: fetcher,
      snapshotStartedAt: iso,
    })
  )
  assert.deepEqual(rendered, [fresh])
  assert.equal(result.nextPage, null)
  assert.deepEqual(
    result.jobs.map(({ url, country }) => ({ url, country })),
    [{ url: fresh, country: "India" }]
  )
})

test("Hirist reads its gzip sitemap newest id first and day-first post dates", async () => {
  const older = "https://www.hirist.tech/j/backend-engineer-1600000"
  const newest = "https://www.hirist.tech/j/senior-software-engineer-1684621"
  const rendered: string[] = []
  const day = new Date(now - 86_400_000 + 5.5 * 3_600_000)
    .toISOString()
    .slice(0, 10)
    .split("-")
    .reverse()
    .join("-")
  const fetcher = boardFetch(
    "User-agent: *\nDisallow: /admin/",
    (url) =>
      url.endsWith("new_sitemap-j-1.xml.gz")
        ? new Response(
            gzipSync(
              urlset([
                [older, iso],
                [newest, recent],
              ])
            )
          )
        : null,
    (target) => jobPage(target, day),
    rendered
  )
  const result = await withFirecrawl(() =>
    fetchCatalogPage(source("hirist"), 1, {
      fetch: fetcher,
      snapshotStartedAt: iso,
    })
  )
  assert.deepEqual(rendered, [newest, older])
  assert.equal(result.jobs.length, 2)
  assert.equal(result.jobs[0]?.url, newest)
  assert.ok(Date.parse(result.jobs[0]?.posted_at ?? "") <= now)
})

test("4 Day Week keeps India locations and their work arrangement", async () => {
  const job = (
    city: string,
    country: string,
    mode: string,
    posted = recent
  ) => ({
    title,
    description,
    url: `https://4dayweek.io/job/${city.toLowerCase()}`,
    posted_at: posted,
    work_arrangement: mode,
    locations: [{ city, country, work_arrangement: mode }],
    company: { name: company },
  })
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.get("country"), "India")
    return Response.json({
      page: 1,
      has_more: false,
      data: [
        job("Bengaluru", "India", "hybrid"),
        job("London", "United Kingdom", "remote"),
        job("Pune", "India", "onsite", stale),
      ],
    })
  }
  const result = await fetchCatalogPage(source("4dayweek"), 1, {
    fetch: fetcher,
    snapshotStartedAt: iso,
  })
  assert.equal(result.nextPage, null)
  assert.deepEqual(
    result.jobs.map(({ city, work_mode }) => ({ city, work_mode })),
    [{ city: "Bengaluru", work_mode: "hybrid" }]
  )
})

test("Talent.com follows its sitemap index and query-string detail URLs", async () => {
  const job = "https://in.talent.com/view?id=638801393889907090"
  const unread = "https://in.talent.com/view?id=111"
  const rendered: string[] = []
  const fetcher = boardFetch(
    "User-agent: *\nDisallow: /api/",
    (url) => {
      if (url.endsWith("/view-en/sitemap.xml"))
        return new Response(
          `<sitemapindex>${[1, 2, 3, 4]
            .map(
              (n) =>
                `<sitemap><loc>https://in.talent.com/sitemaps/view-en-${n}/sitemap.xml</loc></sitemap>`
            )
            .join("")}</sitemapindex>`
        )
      if (url.endsWith("/view-en-1/sitemap.xml"))
        return new Response(urlset([[job.replaceAll("&", "&amp;"), recent]]))
      if (url.endsWith("/view-en-4/sitemap.xml"))
        return new Response(urlset([[unread, iso]]))
      if (/view-en-[23]\/sitemap\.xml$/.test(url)) return new Response(urlset([]))
      return null
    },
    (target) => jobPage(target, recent),
    rendered
  )
  const result = await withFirecrawl(() =>
    fetchCatalogPage(source("talent"), 1, {
      fetch: fetcher,
      snapshotStartedAt: iso,
    })
  )
  assert.deepEqual(rendered, [job])
  assert.equal(result.jobs[0]?.url, job)
})

test("Hacker News Who is hiring keeps India-located top-level posts", async () => {
  const comment = (id: number, head: string, parent = 900) => ({
    objectID: String(id),
    created_at: recent,
    parent_id: parent,
    comment_text: `${head}<p>${description}</p>`,
  })
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("search_by_date"))
      return Response.json({
        hits: [
          { objectID: "901", title: "Ask HN: Who wants to be hired?" },
          { objectID: "900", title: "Ask HN: Who is hiring? (November 2026)" },
        ],
      })
    assert.equal(url.searchParams.get("tags"), "comment,story_900")
    return Response.json({
      hits: [
        comment(1, `${company} | ${title} | Bengaluru, India | ONSITE`),
        comment(2, `${company} | ${title} | REMOTE (US only)`),
        comment(3, `${company} | ${title} | Pune, India`, 1),
      ],
    })
  }
  const result = await fetchCatalogPage(source("hn-hiring"), 1, {
    fetch: fetcher,
    snapshotStartedAt: iso,
  })
  assert.deepEqual(
    result.jobs.map(({ url, city }) => ({ url, city })),
    [
      {
        url: "https://news.ycombinator.com/item?id=1",
        city: "Bengaluru, India | ONSITE",
      },
    ]
  )
})
