import assert from "node:assert/strict"
import test from "node:test"
import { fetchKekaPage } from "../lib/server/catalog/connectors/keka"
import { boardIdentity } from "../lib/server/catalog/source-identity"

// The default markup and API shapes follow the public POP / Inxite-out portals
// and cdn.keka.com/careers/v/2026/scripts/app/app.min.js observed on 2026-11-17.
const html = `<base href="/careers/" id="baseHref"><meta name="portalName">
<div id="kh-jobs-section"></div>
<script src="https://cdn.keka.com/careers/v/2026/scripts/app/app.min.js"></script>`
const source = { ...boardIdentity("keka", "acme"), company: "" }
const description =
  "Build and maintain production software services, APIs, automated tests and cloud infrastructure with the engineering team."
const posting = {
  id: 7,
  title: "Senior Software Engineer",
  description,
  jobLocations: [
    { city: "Bengaluru", countryCode: "IN", countryName: "India" },
  ],
  publishedOn: "2026-11-16T12:00:00Z",
}

function fixture(
  options: {
    html?: string
    domain?: string
    inventory?: unknown
    refusal?: number
  } = {}
) {
  const requests: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === "https://acme.keka.com/careers/")
      return new Response(options.html ?? html)
    if (url.endsWith("/careerportalinfo"))
      return Response.json({
        name: "Acme Technologies",
        careersPortalDomain: options.domain ?? "acme.keka.com",
      })
    assert.equal(url, "https://acme.keka.com/careers/api/jobs/default/active")
    if (options.refusal)
      return new Response("Unavailable", { status: options.refusal })
    return Response.json(options.inventory ?? [posting])
  }
  return { requests, fetch }
}

test("Keka default portals collect the entire active array with verified employer identity", async () => {
  const f = fixture({
    inventory: Array.from({ length: 125 }, (_, index) => ({
      ...posting,
      id: index + 1,
    })),
  })
  const result = await fetchKekaPage(source, 1, { fetch: f.fetch })
  assert.equal(result.fetched, 125)
  assert.equal(result.jobs.length, 125)
  assert.equal(result.total, 125)
  assert.equal(result.nextPage, null)
  assert.equal(result.requests, 3)
  assert.equal(result.employer, "Acme Technologies")
  assert.equal(
    result.jobs[124].url,
    "https://acme.keka.com/careers/jobdetails/125"
  )
  assert.equal(result.jobs[124].country, "India")
  assert.equal(result.jobs[124].posted_at, "2026-11-16T12:00:00.000Z")
})

test("a default portal with another organization's domain fails before reading jobs", async () => {
  const f = fixture({ domain: "different.keka.com" })
  await assert.rejects(
    fetchKekaPage(source, 1, { fetch: f.fetch }),
    /employer domain does not match source/
  )
  assert.equal(f.requests.length, 2)
})

test("default API fallback requires complete default-portal evidence", async () => {
  for (const invalid of [
    html.replace('<meta name="portalName">', ""),
    html.replace(
      '<meta name="portalName">',
      '<meta name="portalName" content="other">'
    ),
    html.replace("/careers/", "/another/"),
    html.replace("kh-jobs-section", "unknown-widget"),
    html.replace("cdn.keka.com", "cdn.keka.com.example.com"),
  ]) {
    const f = fixture({ html: invalid })
    await assert.rejects(
      fetchKekaPage(source, 1, { fetch: f.fetch }),
      /identifier not found/
    )
    assert.equal(f.requests.length, 1)
  }
})

test("default inventory rejects duplicate IDs and pagination wrappers instead of publishing a partial array", async () => {
  for (const inventory of [
    [posting, { ...posting, id: "7" }],
    { jobs: [posting], total: 250, nextPage: 2 },
  ]) {
    const f = fixture({ inventory })
    await assert.rejects(fetchKekaPage(source, 1, { fetch: f.fetch }))
  }
})

test("a provider refusal never switches Keka endpoints or returns an empty success", async () => {
  for (const refusal of [403, 429, 503]) {
    const f = fixture({ refusal })
    await assert.rejects(fetchKekaPage(source, 1, { fetch: f.fetch }))
    // The shared transport may retry the same URL on transient refusals.
    assert.equal(new Set(f.requests).size, 3)
    assert.ok(
      f.requests
        .slice(2)
        .every((url) => url.endsWith("/api/jobs/default/active"))
    )
  }
})
