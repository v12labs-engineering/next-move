import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import { boardIdentity } from "@/lib/server/catalog/source-identity"
import { validateCandidate } from "@/lib/server/catalog/discovery/validate"

const description =
  "Build reliable software services and maintain distributed systems with engineers. ".repeat(
    3
  )

test("Zoho source facts keep other professions and unknown fields, excluding unpublished jobs", async () => {
  const source = {
    ...boardIdentity("zohorecruit", "example.zohorecruit.in"),
    company: "Example",
  }
  const payload = [
    {
      id: "1",
      Posting_Title: "Software Engineer",
      Job_Description: description,
      Country: "India",
      Publish: true,
    },
    { id: "2", Posting_Title: "Accountant", Publish: true },
    { id: "3", Posting_Title: "Accountant", Publish: false },
  ]
  const options = {
    fetch: async () =>
      new Response(
        `<meta property="og:site_name" content="Example"><input id="jobs" value="${JSON.stringify(payload).replaceAll('"', "&#34;")}">`
      ),
  }
  const raw = await fetchSourcePage(source, 1, options)
  assert.deepEqual(
    raw.postings.map((job) => job.title),
    ["Software Engineer", "Accountant"]
  )
  assert.equal(raw.postings[1].description, "")
  assert.deepEqual(raw.postings[1].countries, [])
  assert.equal(raw.postings[1].postedAt, null)
  const catalog = await fetchCatalogPage(source, 1, options)
  assert.deepEqual(
    catalog.jobs.map((job) => job.title),
    ["Software Engineer"]
  )
})

test("Workable source facts retain incomplete source evidence without weakening catalog checks", async () => {
  const source = { ...boardIdentity("workable", "example"), company: "Example" }
  const options = {
    fetch: async () =>
      Response.json({
        name: "Example",
        jobs: [
          {
            shortcode: "ABCDEF1234",
            title: "Software Engineer",
            description: "",
            url: "https://apply.workable.com/j/ABCDEF1234",
          },
          {
            shortcode: "ABCDEF1235",
            title: "Accountant",
            description: "Accounting",
            url: "https://apply.workable.com/j/ABCDEF1235",
            country: "India",
            city: "Pune",
          },
        ],
      }),
  }
  const raw = await fetchSourcePage(source, 1, options)
  assert.equal(raw.postings.length, 2)
  assert.deepEqual(raw.postings[0].countries, [])
  assert.equal(raw.postings[0].postedAt, null)
  await assert.rejects(
    fetchCatalogPage(source, 1, options),
    /description is incomplete/
  )
})

test("raw source reads retain board, page, and response identity checks", async () => {
  const source = { ...boardIdentity("workable", "example"), company: "Example" }
  const noFetch = {
    fetch: async () => assert.fail("invalid sources must not fetch"),
  }
  await assert.rejects(
    fetchSourcePage({ ...source, id: "workable:another" }, 1, noFetch),
    /Invalid employer board/
  )
  await assert.rejects(fetchSourcePage(source, 0, noFetch), /Invalid page/)
  await assert.rejects(
    fetchSourcePage(source, 1, {
      fetch: async () =>
        Response.json({ name: "Different employer", jobs: [] }),
    }),
    /employer changed/
  )
})

test("EU Lever validation keeps identity and collection on the same regional host", async () => {
  const candidate = {
    ...boardIdentity("lever", "example"),
    expected_company: "Example",
    historical_checked_at: null,
    evidence_url: "https://jobs.eu.lever.co/example",
  }
  const seen: string[] = []
  const result = await validateCandidate(
    candidate,
    async (url, format) => {
      seen.push(url)
      if (format === "html")
        return '<title>Example</title><meta property="og:title" content="Example Jobs"><meta property="og:url" content="https://jobs.eu.lever.co/example">'
      return [
        {
          text: "Software Engineer",
          hostedUrl: "https://jobs.eu.lever.co/example/1",
          descriptionPlain: description,
          country: "IN",
          categories: { location: "Pune" },
        },
      ]
    },
    new Date(),
    undefined,
    { config: { region: "eu" } }
  )
  assert.equal(result.status, "verified")
  assert.deepEqual(
    seen.map((url) => new URL(url).hostname),
    ["jobs.eu.lever.co", "api.eu.lever.co"]
  )
})
