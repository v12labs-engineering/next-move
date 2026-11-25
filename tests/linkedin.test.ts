import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchLinkedInPage,
  linkedinJobId,
  parseLinkedInSearch,
  parseLinkedInDetail,
} from "@/lib/server/catalog/connectors/linkedin"
import {
  fetchCatalogPage,
  CatalogSourceError,
  type CatalogSource,
} from "@/lib/server/catalog/feeds"
import { dueSources } from "@/lib/server/catalog/directory"

const source: CatalogSource = {
  id: "linkedin",
  kind: "linkedin",
  company: "LinkedIn public jobs",
  board: null,
  config: {
    queries: [
      {
        keywords: "Software Engineer",
        location: "Hyderabad, India",
        country: "India",
      },
    ],
  },
}
function cards(id = "1234567890", title = "Software Engineer") {
  return `<li><div class="job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
  <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/role-at-example-${id}?tracking=x"></a>
  <h3 class="base-search-card__title">${title}</h3><h4 class="base-search-card__subtitle">Example</h4>
  <span class="job-search-card__location">Hyderabad, Telangana, India</span><time datetime="2026-10-30">2 days ago</time></div></li>`
}
function detail(id = "1234567890", title = "Software Engineer") {
  return `<section class="top-card-layout" data-entity-urn="urn:li:jobPosting:${id}"><h1 class="top-card-layout__title">${title}</h1><a class="topcard__org-name-link">Example</a></section>
  <div class="show-more-less-html__markup"><p>Build TypeScript services and maintain reliable production software with our engineering team.</p><p>Collaborate on design, delivery and support of customer applications.</p><script>bad()</script></div>`
}
const response = (html: string) =>
  new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } })
const noPause = async () => {}

test("LinkedIn cards retain observed identity, company, location and exact dates while stripping tracking URLs", () => {
  const parsed = parseLinkedInSearch(cards() + cards())
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, "1234567890")
  const job = parseLinkedInDetail(parsed[0], detail())
  assert.equal(job.url, "https://www.linkedin.com/jobs/view/1234567890/")
  assert.equal(job.source, "linkedin")
  assert.equal(job.country, "India")
  assert.equal(job.city, "Hyderabad, Telangana")
  assert.equal(job.company, "Example")
  assert.equal(job.posted_at, "2026-10-30T00:00:00.000Z")
  assert.equal(job.work_mode, "unknown")
  assert.ok(job.description.includes("production software"))
  assert.ok(!job.description.includes("bad()"))
  assert.equal(job.sponsor_verified, false)
  assert.equal(
    parseLinkedInDetail({ ...parsed[0], postedAt: "yesterday" }, detail())
      .posted_at,
    null
  )
})

test("LinkedIn parsing rejects login walls, markup drift, mismatched identities and ungrounded countries", () => {
  assert.deepEqual(parseLinkedInSearch("\n"), [])
  assert.deepEqual(
    parseLinkedInSearch(
      '<div class="jobs-search-no-results-banner">No results</div>'
    ),
    []
  )
  for (const html of [
    "<html>Sign in</html>",
    "<form action='/checkpoint'>Verify</form>",
    "<html>New search layout</html>",
  ])
    assert.throws(() => parseLinkedInSearch(html), /login\/challenge|markup/)
  assert.throws(
    () =>
      parseLinkedInSearch(
        cards().replace(
          "urn:li:jobPosting:1234567890",
          "urn:li:jobPosting:9999999999"
        )
      ),
    /identity/
  )
  const card = parseLinkedInSearch(cards())[0]
  assert.throws(
    () => parseLinkedInDetail(card, detail("9999999999")),
    /identity/
  )
  assert.throws(
    () => parseLinkedInDetail(card, detail(undefined, "Different Role")),
    /differs/
  )
  assert.throws(
    () => parseLinkedInDetail({ ...card, location: "Hyderabad" }, detail()),
    /country/
  )
  assert.throws(
    () => parseLinkedInDetail(card, "<html>Sign in</html>"),
    /identity/
  )
  for (const url of [
    "https://www.linkedin.com.evil.test/jobs/view/1234567890",
    "http://www.linkedin.com/jobs/view/1234567890",
    "https://user:pass@www.linkedin.com/jobs/view/1234567890",
    "https://www.linkedin.com/jobs/view/../private",
  ])
    assert.equal(linkedinJobId(url), null)
})

test("LinkedIn guest collection reconstructs trusted requests, fetches descriptions, and checkpoints actual returned-card offsets", async () => {
  const seen: string[] = []
  const first = await fetchLinkedInPage(
    source,
    1,
    {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        seen.push(url.href)
        assert.equal(url.origin, "https://www.linkedin.com")
        assert.equal(init?.redirect, "error")
        assert.equal(new Headers(init?.headers).has("Cookie"), false)
        assert.equal(new Headers(init?.headers).has("Authorization"), false)
        if (url.pathname.endsWith("/search")) {
          assert.equal(url.searchParams.get("start"), "0")
          assert.equal(url.searchParams.get("f_TPR"), "r604800")
          assert.equal(url.searchParams.get("keywords"), "Software Engineer")
          return response(cards())
        }
        return response(detail())
      },
    },
    noPause
  )
  assert.equal(first.jobs.length, 1)
  assert.equal(first.requests, 3)
  assert.equal(first.nextPage, 2)
  assert.equal(seen[0], "https://www.linkedin.com/robots.txt")
  assert.equal(
    seen[2],
    "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1234567890"
  )
  const end = await fetchLinkedInPage(
    source,
    first.nextPage!,
    {
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname === "/robots.txt") return response("")
        assert.equal(url.searchParams.get("start"), "1")
        return response("")
      },
    },
    noPause
  )
  assert.equal(end.nextPage, null)
  assert.deepEqual(end.jobs, [])
})

test("a single LinkedIn identity deduplicates overlapping query results and advances bounded query windows", async () => {
  const config = {
    queries: [
      { keywords: "Software Engineer", country: "India", location: "India" },
      { keywords: "Backend Engineer", country: "India", location: "India" },
    ],
  }
  const fetcher = async (input: RequestInfo | URL) =>
    response(String(input).includes("/search?") ? cards() : detail())
  const a = await fetchLinkedInPage(
    { ...source, config },
    1,
    { fetch: fetcher },
    noPause
  )
  const b = await fetchLinkedInPage(
    { ...source, config },
    1001,
    { fetch: fetcher },
    noPause
  )
  assert.equal(a.jobs[0].id, b.jobs[0].id)
  const boundary = await fetchLinkedInPage(
    { ...source, config },
    75,
    { fetch: fetcher },
    noPause
  )
  assert.equal(boundary.nextPage, 1001)
  await assert.rejects(
    fetchLinkedInPage(source, 76, { fetch: fetcher }, noPause),
    /continuation/
  )
})

test("LinkedIn HTTP access controls and throttles pause immediately without retries, bypasses or empty-success results", async () => {
  for (const status of [401, 403, 429, 999]) {
    let calls = 0
    await assert.rejects(
      fetchLinkedInPage(
        source,
        1,
        {
          fetch: async () => {
            calls++
            const result = new Response(null, {
              status: status === 999 ? 503 : status,
              headers: { "retry-after": "120" },
            })
            if (status === 999)
              Object.defineProperty(result, "status", { value: 999 })
            return result
          },
        },
        noPause
      ),
      (error: unknown) => {
        assert.ok(error instanceof CatalogSourceError)
        assert.match(error.message, new RegExp(String(status)))
        assert.ok(Date.parse(error.retryAt) >= Date.now() + 100000)
        return true
      }
    )
    assert.equal(calls, 1)
  }
  await assert.rejects(
    fetchLinkedInPage(
      source,
      1,
      { fetch: async () => response("<html>Verify you are human</html>") },
      noPause
    ),
    /login\/challenge/
  )
  await assert.rejects(
    fetchLinkedInPage(
      source,
      1,
      { maxResponseBytes: 10, fetch: async () => response(cards()) },
      noPause
    ),
    /size/
  )
})

test("failed LinkedIn detail hydration never produces a publishable partial page", async () => {
  await assert.rejects(
    fetchLinkedInPage(
      source,
      1,
      {
        fetch: async (input) =>
          String(input).includes("/search?")
            ? response(cards())
            : new Response(null, { status: 403 }),
      },
      noPause
    ),
    /403/
  )
})

test("LinkedIn is integrated as a search-observation source with normal refresh cadence", async () => {
  const result = await fetchCatalogPage(source, 1, {
    fetch: async () => response(""),
  })
  assert.equal(result.nextPage, null)
  const health = {
    id: "linkedin",
    last_success_at: new Date().toISOString(),
    complete: false,
    failed: false,
    pending: false,
  }
  assert.equal(dueSources([source], [health]).length, 0)
  assert.equal(dueSources([source], [{ ...health, failed: true }]).length, 1)
  assert.equal(dueSources([source], [{ ...health, pending: true }]).length, 1)
  assert.equal(
    dueSources(
      [source],
      [
        {
          ...health,
          last_success_at: new Date(Date.now() - 8 * 3600000).toISOString(),
        },
      ]
    ).length,
    1
  )
})

test("unusable LinkedIn postings are rejected individually, duplicate cards advance pagination and detail location is real evidence", async () => {
  const result = await fetchLinkedInPage(
    source,
    1,
    {
      fetch: async (input) =>
        response(
          String(input).includes("/search?")
            ? cards().replace("Hyderabad, Telangana, India", "Hyderabad") +
                cards().replace("Hyderabad, Telangana, India", "Hyderabad")
            : detail()
        ),
    },
    noPause
  )
  assert.equal(result.jobs.length, 0)
  assert.equal(result.fetched, 2)
  assert.equal(result.rejected, 2)
  assert.equal(result.nextPage, 3)
  const card = parseLinkedInSearch(cards())[0]
  const withLocation = detail().replace(
    "</section>",
    '<span class="topcard__flavor--bullet">Hyderabad, Telangana, India</span></section>'
  )
  assert.equal(
    parseLinkedInDetail({ ...card, location: "Hyderabad" }, withLocation)
      .country,
    "India"
  )
  assert.throws(
    () =>
      parseLinkedInDetail({ ...card, location: "Atlanta, Georgia" }, detail()),
    /country/
  )
  assert.throws(
    () => parseLinkedInDetail({ ...card, location: "Atlanta, GA" }, detail()),
    /country/
  )
  assert.equal(
    parseLinkedInDetail(
      { ...card, location: "Atlanta, Georgia, United States" },
      detail()
    ).country,
    "United States"
  )
  assert.equal(
    parseLinkedInDetail({ ...card, postedAt: "2026-02-31" }, detail())
      .posted_at,
    null
  )
})

test("LinkedIn collection stops when robots rules exclude guest job paths", async () => {
  let calls = 0
  await assert.rejects(
    fetchLinkedInPage(
      source,
      1,
      {
        fetch: async () => {
          calls++
          return new Response("User-agent: *\nDisallow: /\n")
        },
      },
      noPause
    ),
    (error: unknown) =>
      error instanceof CatalogSourceError && /robots/.test(error.message)
  )
  assert.equal(calls, 1)
})
