import test from "node:test"
import assert from "node:assert/strict"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "../lib/server/catalog/connectors"
import {
  indiaJobBoards,
  indiaJobBoardCredit,
  type IndiaJobBoard,
} from "../lib/jobs/india-job-boards"
import type { BoardIndexRefresh } from "../lib/server/catalog/connectors/board-index"

const now = new Date()
const iso = now.toISOString()
const recent = new Date(+now - 60_000).toISOString()
const future = new Date(+now + 86_400_000).toISOString()
const seconds = (value: string) => Math.floor(Date.parse(value) / 1000)
const description =
  "Design distributed software services and document the architecture. Build and test production TypeScript APIs with the engineering team."
const title = "Senior Software Engineer"
const company = "Example Engineering"

function source(board: IndiaJobBoard) {
  return {
    id: `indiaboard:${board}`,
    kind: "indiaboard" as const,
    board,
    company: indiaJobBoards[board].name,
  }
}

function response(body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body))
}

test("specialist remote boards admit dated India jobs and assign shared IDs once", async () => {
  const indiaJob = {
    id: "cmwo46lti0gvs3q0utnm8vdjv",
    title,
    author: company,
    isoDate: recent,
    location: "Bengaluru",
    geoLabel: "India",
    sites: ",frontend,backend,java,",
    contentSnippet: description,
  }
  const requested: string[] = []
  const options: Parameters<typeof fetchCatalogPage>[2] = {
    snapshotStartedAt: iso,
    async fetch(input) {
      const url = new URL(String(input))
      assert.equal(url.origin, "https://www.remotebackendjobs.com")
      assert.equal(url.searchParams.get("regions"), "asia")
      requested.push(url.searchParams.get("board") ?? "")
      return response([
        indiaJob,
        { ...indiaJob, geoLabel: "Singapore", location: "Singapore" },
        { ...indiaJob, isoDate: "2000-01-01" },
      ])
    },
  }
  const backend = await fetchCatalogPage(
    source("remote-backend-jobs"),
    1,
    options
  )
  const frontend = await fetchCatalogPage(
    source("remote-frontend-jobs"),
    1,
    options
  )
  const java = await fetchCatalogPage(source("remote-java-jobs"), 1, options)
  assert.deepEqual(requested, ["backend", "frontend", "java"])
  assert.equal(backend.jobs.length, 0)
  assert.equal(frontend.jobs.length, 0)
  assert.deepEqual(
    java.jobs.map(({ country, url, work_mode }) => ({
      country,
      url,
      work_mode,
    })),
    [
      {
        country: "India",
        url: `https://www.remotejavajobs.com/${indiaJob.id}`,
        work_mode: "remote",
      },
    ]
  )
  assert.equal(java.nextPage, null)
})

function trackBoardChanges(): BoardIndexRefresh {
  const checks = new Map<string, string>()
  return {
    async select(leads) {
      return new Set(
        leads
          .filter((lead) => checks.get(lead.url) !== lead.fingerprint)
          .map(({ url }) => url)
      )
    },
    checked({ url, fingerprint }) {
      checks.set(url, fingerprint)
    },
  }
}

const cases = {
  himalayas: {
    url: "https://himalayas.app/jobs/apply/example",
    payload: {
      offset: 0,
      totalCount: 3,
      jobs: [
        {
          title,
          companyName: company,
          description,
          locationRestrictions: ["India"],
          timezoneRestrictions: ["+05:30"],
          pubDate: seconds(recent),
          expiryDate: seconds(future),
          applicationLink: "https://himalayas.app/jobs/apply/example",
          guid: "https://himalayas.app/jobs/example",
        },
        {
          title,
          companyName: company,
          description,
          locationRestrictions: ["India"],
          timezoneRestrictions: ["+01:00"],
          pubDate: seconds(recent),
          expiryDate: seconds(future),
          applicationLink: "https://himalayas.app/jobs/apply/excluded",
          guid: "https://himalayas.app/jobs/excluded",
        },
        {
          title: `${title} (U.S. Based, Remote Contractor)`,
          companyName: company,
          description,
          locationRestrictions: [],
          timezoneRestrictions: ["+05:30"],
          pubDate: seconds(recent),
          expiryDate: seconds(future),
          applicationLink: "https://himalayas.app/jobs/apply/usa-only",
          guid: "https://himalayas.app/jobs/usa-only",
        },
      ],
    },
  },
  jobicy: {
    url: "https://jobicy.com/jobs/100-example",
    payload: {
      jobs: [
        {
          jobTitle: title,
          companyName: company,
          jobDescription: description,
          jobGeo: "Worldwide",
          pubDate: recent,
          url: "https://jobicy.com/jobs/100-example",
        },
        {
          jobTitle: title,
          companyName: company,
          jobDescription: `${description} Candidates must be based in Canada.`,
          jobGeo: "Worldwide",
          pubDate: recent,
          url: "https://jobicy.com/jobs/101-example",
        },
      ],
    },
  },
  "remote-ok": {
    url: "https://remoteok.com/remote-jobs/example",
    payload: [
      { legal: "API attribution" },
      {
        position: title,
        company,
        description,
        location: "Worldwide",
        date: recent,
        url: "https://remoteok.com/remote-jobs/example",
      },
      {
        position: title,
        company,
        description,
        location: "",
        date: recent,
        url: "https://remoteok.com/remote-jobs/unknown",
      },
    ],
  },
  "we-work-remotely": {
    url: "https://weworkremotely.com/remote-jobs/example",
    payload: `<rss><channel><item><title>${company}: ${title}</title><link>https://weworkremotely.com/remote-jobs/example</link><region>Anywhere in the World</region><description>${description}</description><pubDate>${recent}</pubDate></item></channel></rss>`,
  },
  hasjob: {
    url: "https://hasjob.co/example.com/abcd",
    payload: `<feed><entry><title>${title} - ${company}</title><link href="https://hasjob.co/example.com/abcd"/><location>Bangalore</location><content>${description}</content><published>${recent}</published></entry></feed>`,
  },
  "foss-united": {
    url: "https://fossunited.org/jobs/4ddi25osto",
    payload: `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>${title} at ${company}</title><dc:creator>${company}</dc:creator><link>https://fossunited.org/jobs/4ddi25osto</link><description><![CDATA[<p><strong>Location:</strong> Pune, India</p><p>${description}</p>]]></description><pubDate>${recent}</pubDate></item></channel></rss>`,
  },
} as const

for (const [board, fixture] of Object.entries(cases)) {
  test(`${board} preserves publisher links and imports only proven India eligibility`, async () => {
    const catalogSource = source(board as keyof typeof cases)
    const options = {
      snapshotStartedAt: iso,
      fetch: async () => response(fixture.payload),
    }
    const { jobs, requests, nextPage } = await fetchCatalogPage(
      catalogSource,
      1,
      options
    )
    assert.equal(requests, 1)
    assert.equal(nextPage, null)
    assert.deepEqual(
      jobs.map(({ country, url }) => ({ country, url })),
      [{ country: "India", url: fixture.url }]
    )
    assert.equal(
      indiaJobBoardCredit(catalogSource.id, fixture.url)?.name,
      catalogSource.company
    )
    assert.equal(
      (await fetchSourcePage(catalogSource, 1, options)).postings.length,
      board === "himalayas" ? 3 : typeof fixture.payload === "string" ? 1 : 2
    )
  })
}

const htmlCases = {
  shipmates: "/jobs/abc-senior-software-engineer",
  e2ehiring: "/jobs/detail/senior-software-engineer-123456",
  cyberpark: "/job/senior-software-engineer-kozhikode/",
} as const

for (const [name, path] of Object.entries(htmlCases)) {
  test(`${name} hourly checks skip relative age changes and fetch edited cards`, async () => {
    const board = name as keyof typeof htmlCases
    const listing = new URL(indiaJobBoards[board].url)
    const detail = new URL(path, listing)
    const before = process.env.CATALOG_FIRECRAWL_LOCAL_URL
    process.env.CATALOG_FIRECRAWL_LOCAL_URL = "http://127.0.0.1:13983"
    let cardTitle = title,
      age = "1h",
      detailCalls = 0
    const options = {
      boardIndexRefresh: trackBoardChanges(),
      fetch: (async (input, init) => {
        if (String(input).endsWith("/robots.txt"))
          return response("User-agent: *\nAllow: /")
        const target = JSON.parse(String(init?.body)).url
        const card =
          board === "cyberpark"
            ? `<li class="job_listing"><a href="${detail.pathname}">${cardTitle} <time datetime="${recent}">${age}</time></a></li>`
            : `<article><a href="${detail.pathname}" class="${board === "shipmates" ? "ui-row" : "jobs_cardSelect__x"}">${cardTitle} <time datetime="${recent}">${age}</time></a></article>`
        const posting = {
          "@type": "JobPosting",
          url: detail.href,
          title: cardTitle,
          description,
          datePosted: recent,
          hiringOrganization: { name: company },
          jobLocation: {
            address:
              board === "cyberpark"
                ? "Govt Cyber Park Calicut"
                : { addressCountry: "IN" },
          },
        }
        if (target === detail.href) detailCalls++
        return response({
          success: true,
          data: {
            rawHtml:
              target === detail.href
                ? `<script type="application/ld+json">${JSON.stringify(posting)}</script>`
                : card,
            links: [detail.href],
            metadata: { sourceURL: target, statusCode: 200 },
          },
        })
      }) as typeof fetch,
    }
    try {
      assert.equal(
        (await fetchCatalogPage(source(board), 1, options)).jobs.length,
        1
      )
      age = "2h"
      const unchanged = await fetchCatalogPage(source(board), 1, options)
      assert.equal(unchanged.jobs.length, 0)
      assert.equal(unchanged.rejected, 0)
      assert.equal(detailCalls, 1)
      cardTitle = "Senior Platform Software Engineer"
      assert.equal(
        (await fetchCatalogPage(source(board), 1, options)).jobs[0]?.title,
        cardTitle
      )
      assert.equal(detailCalls, 2)
    } finally {
      if (before === undefined) delete process.env.CATALOG_FIRECRAWL_LOCAL_URL
      else process.env.CATALOG_FIRECRAWL_LOCAL_URL = before
    }
  })
}

for (const [board, path] of Object.entries(htmlCases)) {
  test(`${board} publishes only a fresh, verified same-board Firecrawl detail`, async () => {
    const key = board as keyof typeof htmlCases
    const listing = new URL(indiaJobBoards[key].url)
    const detail = new URL(path, listing)
    const before = process.env.CATALOG_FIRECRAWL_LOCAL_URL
    process.env.CATALOG_FIRECRAWL_LOCAL_URL = "http://127.0.0.1:13983"
    const calls: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const request = new URL(String(input))
      if (request.pathname === "/robots.txt")
        return response("User-agent: *\nDisallow: /admin")
      assert.equal(request.href, "http://127.0.0.1:13983/v2/scrape")
      const target = JSON.parse(String(init?.body)).url
      calls.push(target)
      const rawHtml =
        target === listing.href
          ? "<h1>Jobs</h1>"
          : `<script type="application/ld+json">${JSON.stringify({
              "@type": "JobPosting",
              url: detail.href,
              title,
              description,
              datePosted: recent,
              validThrough: future,
              hiringOrganization: { name: company },
              jobLocation: {
                address: { addressLocality: "Bengaluru", addressCountry: "IN" },
              },
            })}</script>`
      return response({
        success: true,
        data: {
          rawHtml,
          links: [detail.href, `https://other.example${detail.pathname}`],
          metadata: { sourceURL: target, statusCode: 200 },
        },
      })
    }
    try {
      const result = await fetchCatalogPage(source(key), 1, {
        fetch: fetcher,
        snapshotStartedAt: iso,
      })
      assert.deepEqual(calls, [listing.href, detail.href])
      assert.equal(result.fetched, 1)
      assert.equal(result.jobs[0]?.url, detail.href)
      assert.equal(result.jobs[0]?.country, "India")
      await assert.rejects(
        fetchCatalogPage(source(key), 1, {
          fetch: async () =>
            response(`User-agent: *\nDisallow: ${listing.pathname}`),
        }),
        /excluded by robots/
      )
    } finally {
      if (before === undefined) delete process.env.CATALOG_FIRECRAWL_LOCAL_URL
      else process.env.CATALOG_FIRECRAWL_LOCAL_URL = before
    }
  })
}

test("eGig checks employer-posted jobs from its API and verifies changed details with Firecrawl", async () => {
  const url = "https://egig.in/jobs/senior-software-engineer-salem-10000"
  const before = process.env.CATALOG_FIRECRAWL_LOCAL_URL
  process.env.CATALOG_FIRECRAWL_LOCAL_URL = "http://127.0.0.1:13983"
  let currentTitle = title
  const details: string[] = []
  const options: Parameters<typeof fetchCatalogPage>[2] = {
    snapshotStartedAt: iso,
    boardIndexRefresh: trackBoardChanges(),
    async fetch(input, init) {
      const request = new URL(String(input))
      if (request.pathname === "/robots.txt")
        return response("User-agent: *\nDisallow: /api/\nAllow: /api/open/")
      if (request.href === "https://egig.in/api/open/jobs?limit=20") {
        const direct = {
          title: currentTitle,
          company,
          location: "Salem",
          posted: recent,
          remote: false,
          listed_by: "eGig",
          url,
        }
        return response({
          jobs: [
            direct,
            { ...direct, listed_by: "Another board", url: url + "1" },
            { ...direct, company: "Not named", url: url + "2" },
          ],
        })
      }
      assert.equal(request.href, "http://127.0.0.1:13983/v2/scrape")
      const target = JSON.parse(String(init?.body)).url
      details.push(target)
      const posting = {
        "@type": "JobPosting",
        title: currentTitle,
        hiringOrganization: { name: company },
        description,
        url,
        datePosted: recent,
        jobLocation: {
          address: { addressLocality: "Salem", addressCountry: "IN" },
        },
      }
      return response({
        success: true,
        data: {
          rawHtml: `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
          metadata: { sourceURL: target, statusCode: 200 },
        },
      })
    },
  }
  try {
    const first = await fetchCatalogPage(source("egig"), 1, options)
    assert.equal(first.jobs[0]?.country, "India")
    assert.deepEqual(details, [url])
    const unchanged = await fetchCatalogPage(source("egig"), 1, options)
    assert.equal(unchanged.jobs.length, 0)
    assert.deepEqual(details, [url])
    currentTitle = "Senior Platform Software Engineer"
    const changed = await fetchCatalogPage(source("egig"), 1, options)
    assert.equal(changed.jobs[0]?.title, currentTitle)
    assert.deepEqual(details, [url, url])
  } finally {
    if (before === undefined) delete process.env.CATALOG_FIRECRAWL_LOCAL_URL
    else process.env.CATALOG_FIRECRAWL_LOCAL_URL = before
  }
})

test("Technopark verifies the public inventory and closes out expired detail leads", async () => {
  const before = process.env.CATALOG_FIRECRAWL_LOCAL_URL
  process.env.CATALOG_FIRECRAWL_LOCAL_URL = "http://127.0.0.1:13983"
  const entry = {
    id: 123,
    job_title: title,
    posted_date: recent.slice(0, 10),
    closing_date: future.slice(0, 10),
  }
  const expired = { ...entry, id: 456, closing_date: "2020-01-01" }
  const target = "https://technopark.in/job-details/123"
  const requests: string[] = []
  let revision = recent
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push(url.pathname)
    if (url.pathname === "/robots.txt")
      return response("User-agent: *\nAllow: /")
    if (url.pathname === "/api/paginated-jobs")
      return response({
        current_page: 1,
        last_page: 1,
        per_page: 20,
        data: [{ ...entry, updated_at: revision }, expired],
      })
    assert.equal(JSON.parse(String(init?.body)).url, target)
    const data = {
      component: "JobListing/JobDetailPage",
      props: {
        jobListing: {
          ...entry,
          status: "APPROVED",
          job_description: `<p>${description}</p>`,
          company: { company, address: "Technopark, Thiruvananthapuram" },
        },
      },
    }
    const rawHtml = `<div data-page='${JSON.stringify(data)}'></div>`
    return response({
      success: true,
      data: { rawHtml, metadata: { sourceURL: target, statusCode: 200 } },
    })
  }
  try {
    const options = {
      fetch: fetcher,
      snapshotStartedAt: iso,
      boardIndexRefresh: trackBoardChanges(),
    }
    const result = await fetchCatalogPage(source("technopark"), 1, options)
    assert.deepEqual(requests, [
      "/robots.txt",
      "/api/paginated-jobs",
      "/v2/scrape",
    ])
    assert.equal(result.fetched, 2)
    assert.equal(result.nextPage, null)
    assert.deepEqual(
      result.jobs.map(({ city, country, url }) => ({ city, country, url })),
      [{ city: "Thiruvananthapuram", country: "India", url: target }]
    )
    assert.equal(
      (await fetchCatalogPage(source("technopark"), 1, options)).jobs.length,
      0
    )
    assert.equal(requests.filter((route) => route === "/v2/scrape").length, 1)
    revision = iso
    assert.equal(
      (await fetchCatalogPage(source("technopark"), 1, options)).jobs[0]?.url,
      target
    )
    assert.equal(requests.filter((route) => route === "/v2/scrape").length, 2)
  } finally {
    if (before === undefined) delete process.env.CATALOG_FIRECRAWL_LOCAL_URL
    else process.env.CATALOG_FIRECRAWL_LOCAL_URL = before
  }
})

test("4 Day Week keeps verified India locations and removes expired or off-board links", async () => {
  const origin = "https://4dayweek.io"
  const posting = {
    title,
    description,
    url: `${origin}/job/senior-engineer`,
    posted_at: recent,
    expires_at: future,
    work_arrangement: "hybrid",
    locations: [
      { country: "Singapore" },
      { country: "India", city: "Bengaluru" },
    ],
    company: { name: company },
  }
  const result = await fetchCatalogPage(source("4dayweek"), 1, {
    snapshotStartedAt: iso,
    fetch: async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, origin)
      assert.equal(url.searchParams.get("country"), "India")
      assert.equal(url.searchParams.get("posted_after"), "30")
      return response({
        page: 1,
        has_more: false,
        data: [
          posting,
          { ...posting, url: `${origin}/job/closed`, expires_at: recent },
          {
            ...posting,
            url: "https://off-board.example/job/software-engineer",
          },
          {
            ...posting,
            url: `${origin}/job/missing-employer`,
            company: undefined,
          },
        ],
      })
    },
  })
  assert.equal(result.fetched, 4)
  assert.deepEqual(
    result.jobs.map(({ url, country, work_mode }) => ({
      url,
      country,
      work_mode,
    })),
    [{ url: posting.url, country: "India", work_mode: "hybrid" }]
  )
  assert.equal(
    indiaJobBoardCredit("indiaboard:4dayweek", posting.url)?.url,
    `${origin}/`
  )
})

test("Shine verifies permitted sitemap leads through Firecrawl Local", async () => {
  const before = process.env.CATALOG_FIRECRAWL_LOCAL_URL
  process.env.CATALOG_FIRECRAWL_LOCAL_URL = "http://127.0.0.1:13983"
  const detail =
    "https://www.shine.com/jobs/senior-software-engineer/example/123456"
  const excluded = "https://www.shine.com/jobs/private/example/7890"
  let lastmod = recent
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/robots.txt")
      return response("User-agent: *\nDisallow: /jobs/private/")
    if (url.pathname.endsWith(".xml"))
      return response(
        `<urlset><url><loc>${detail}</loc><lastmod>${lastmod}</lastmod></url><url><loc>${excluded}</loc></url></urlset>`
      )
    assert.equal(url.href, "http://127.0.0.1:13983/v2/scrape")
    assert.equal(JSON.parse(String(init?.body)).url, detail)
    const structured = {
      "@type": "JobPosting",
      url: detail,
      title,
      description,
      datePosted: recent,
      hiringOrganization: { name: company },
      jobLocation: { address: { addressCountry: "IN" } },
    }
    return response({
      success: true,
      data: {
        rawHtml: `<script type="application/ld+json">${JSON.stringify(structured)}</script>`,
        metadata: { sourceURL: detail, statusCode: 200 },
      },
    })
  }
  try {
    const options = {
      fetch: fetcher,
      snapshotStartedAt: iso,
      boardIndexRefresh: trackBoardChanges(),
    }
    const result = await fetchCatalogPage(source("shine"), 1, options)
    assert.equal(result.requests, 3)
    assert.equal(result.fetched, 1)
    assert.equal(result.jobs[0]?.url, detail)
    const unchanged = await fetchCatalogPage(source("shine"), 1, {
      ...options,
      snapshotStartedAt: new Date(+now + 1).toISOString(),
    })
    assert.equal(unchanged.jobs.length, 0)
    assert.equal(unchanged.requests, 2)
    lastmod = iso
    const changed = await fetchCatalogPage(source("shine"), 1, {
      ...options,
      snapshotStartedAt: new Date(+now + 2).toISOString(),
    })
    assert.equal(changed.jobs[0]?.url, detail)
    assert.equal(changed.requests, 3)
  } finally {
    if (before === undefined) delete process.env.CATALOG_FIRECRAWL_LOCAL_URL
    else process.env.CATALOG_FIRECRAWL_LOCAL_URL = before
  }
})
