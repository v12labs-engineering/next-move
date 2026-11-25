import assert from "node:assert/strict"
import test from "node:test"
import { registryFirecrawlPosting } from "../scripts/lib/registry-firecrawl-publication.mjs"
import { normalizedPosting } from "../scripts/lib/registry-job-postings.mjs"
import { makeRegistryJobScraper } from "../scripts/lib/registry-job-scraper.mjs"

const origin = "https://careers.employer.com"
const source = { url: `${origin}/careers/`, company: "Example Employer" }
const mapEndpoint = new URL("http://127.0.0.1:13982")

test("only projects a verified, dated India job detail into the catalog", () => {
  const now = Date.parse("2026-11-19T10:00:00Z")
  const url = `${origin}/job/software-engineer/42/`
  const job = normalizedPosting({
    url,
    title: "Software Engineer",
    company: "Example Employer",
    location: "Pune, IN",
    countries: ["India"],
    postedAt: "2026-11-18T08:00:00Z",
    description:
      "Build and maintain distributed Java services for a global software platform. Design APIs, write automated tests, and review production code.",
    evidence: url,
    method: "structured_data",
  })!
  const posting = registryFirecrawlPosting(job, now)
  assert.equal(posting?.source, "firecrawl:registry")
  assert.equal(posting?.city, "Pune")
  assert.equal(posting?.country, "India")
  assert.equal(posting?.posted_at, "2026-11-18T08:00:00.000Z")
  for (const override of [
    { postedAt: null },
    { postedAt: "2026-09-19T10:00:00Z" },
    { postedAt: "2026-11-20T10:00:00Z" },
    { countries: [] },
    { countries: ["India", "United States"] },
    { evidence: source.url },
    { method: "job_detail" as const },
  ])
    assert.equal(registryFirecrawlPosting({ ...job, ...override }, now), null)
})

function jobPage(url: string, validThrough?: string) {
  const posting = {
    "@type": "JobPosting",
    title: "Software Engineer",
    url,
    description: "Build and maintain distributed systems.",
    validThrough,
  }
  return new Response(
    `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
    { headers: { "Content-Type": "text/html" } }
  )
}

function mapFixture({
  candidates,
  robots = "User-agent: *",
  detail,
}: {
  candidates: string[]
  robots?: string
  detail: (url: URL) => Response
}) {
  const visited: string[] = []
  const scrape = makeRegistryJobScraper({
    mapEndpoint,
    guard: async (url) => {
      assert.equal(new URL(url).origin, origin)
    },
    fetcher: async (input, init) => {
      const url = new URL(String(input))
      visited.push(url.href)
      if (url.origin === mapEndpoint.origin) {
        assert.equal(url.pathname, "/v2/map")
        assert.equal(init?.redirect, "error")
        assert.deepEqual(JSON.parse(String(init?.body)), {
          url: source.url,
          sitemap: "only",
          includeSubdomains: false,
          limit: 1000,
        })
        return Response.json({
          success: true,
          links: candidates.map((url) => ({ url })),
        })
      }
      assert.equal(url.origin, origin)
      if (url.pathname === "/robots.txt") return new Response(robots)
      return detail(url)
    },
  })
  return { scrape, visited }
}

test("maps employer leads and saves deduplicated verified detail with an unknown posting date", async () => {
  const canonical = `${origin}/job/software-engineer/42/`
  const alias = `${origin}/job/software-engineer/42`
  const expired = `${origin}/job/expired/99/`
  const forbidden = `${origin}/job/private/7/`
  const externalRedirect = `${origin}/job/external/8/`
  const { scrape, visited } = mapFixture({
    candidates: [
      "https://other-employer.com/job/engineer/24",
      `${origin}/about`,
      alias,
      alias,
      canonical,
      expired,
      forbidden,
      externalRedirect,
    ],
    robots: "User-agent: *\nDisallow: /job/private/",
    detail: (url) => {
      if (url.href === alias) return Response.redirect(canonical, 302)
      if (url.href === canonical) return jobPage(canonical)
      if (url.href === expired) return jobPage(expired, "2001-01-01")
      assert.equal(url.href, externalRedirect)
      return Response.redirect("https://other-employer.com/job/engineer/9", 302)
    },
  })
  const result = await scrape(source)
  assert.equal(result.outcome, "partial")
  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].evidence, canonical)
  assert.equal(result.jobs[0].postedAt, null)
  assert.deepEqual(visited, [
    `${origin}/robots.txt`,
    `${mapEndpoint.origin}/v2/map`,
    alias,
    canonical,
    canonical,
    expired,
    externalRedirect,
  ])
})

test("stops detail verification when the employer asks for backoff", async () => {
  const first = `${origin}/job/engineer/1`
  const second = `${origin}/job/engineer/2`
  const { scrape, visited } = mapFixture({
    candidates: [first, second],
    detail: () => new Response(null, { status: 429 }),
  })
  const result = await scrape(source)
  assert.equal(result.outcome, "retry_due")
  assert.equal(result.jobs.length, 0)
  assert.ok(visited.includes(first))
  assert.ok(!visited.includes(second))
})

test("fails on a Firecrawl service error so the map phase can be rerun", async () => {
  const scrape = makeRegistryJobScraper({
    mapEndpoint,
    guard: async () => {},
    fetcher: async (input) =>
      new URL(String(input)).origin === origin
        ? new Response("User-agent: *")
        : new Response(null, { status: 503 }),
  })
  await assert.rejects(
    () => scrape(source),
    /Firecrawl Map failed with HTTP 503/
  )
})

test("prioritizes jobs linked from the current careers page and verifies structured dates and country", async () => {
  const url = `${origin}/job/software-engineer/42/`
  const postedAt = new Date().toISOString()
  const visited: string[] = []
  const scrape = makeRegistryJobScraper({
    mapEndpoint,
    preferCareerLinks: true,
    guard: async () => {},
    fetcher: async (input, init) => {
      const target = new URL(String(input))
      if (target.origin === mapEndpoint.origin) {
        const { sitemap } = JSON.parse(String(init?.body))
        visited.push(sitemap)
        return Response.json({
          success: true,
          links: sitemap === "skip" ? [{ url: url.slice(0, -1) }] : [],
        })
      }
      if (target.pathname === "/robots.txt")
        return new Response("User-agent: *")
      assert.equal(target.href, url)
      return new Response(
        `
        <link rel="canonical" href="${url}">
        <div class="jobDisplayShell" itemtype="http://schema.org/JobPosting" itemscope>
          <span itemprop="title">Software Engineer</span>
          <meta itemprop="hiringOrganization" content="Example Employer">
          <meta itemprop="streetAddress" content="Pune, IN">
          <meta itemprop="datePosted" content="${postedAt}">
          <div class="jobdescription"><p>Build distributed services in Java and review production code for fault tolerance and reliability.</p></div>
          <a class="apply" href="/talentcommunity/apply/42/?locale=en_US">Apply now</a>
        </div>`,
        { headers: { "Content-Type": "text/html" } }
      )
    },
  })
  const jobs = (await scrape({ ...source, careerJobLinks: [url] })).jobs
  assert.deepEqual(visited, ["skip"])
  assert.deepEqual(
    jobs.map((job) => [job.postedAt, job.countries]),
    [[postedAt, ["India"]]]
  )
})
