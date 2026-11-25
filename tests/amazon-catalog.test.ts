import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  type CatalogSource,
} from "@/lib/server/catalog/feeds"

const source: CatalogSource = {
  id: "amazon:india-software",
  kind: "amazon",
  board: "india-software",
  company: "Amazon",
}
const posting = {
  id_icims: "10604005",
  title: "Software Development Engineer",
  country_code: "IND",
  job_category: "Software Development",
  city: "Hyderabad",
  locations: [
    { normalizedCountryCode: "IND", city: "Hyderabad" },
    '{"normalizedCountryCode":"IND","city":"Bengaluru"}',
    { normalizedCountryCode: "USA", city: "Seattle" },
  ],
  posted_date: "October 22, 2026",
  description:
    "Build well-tested services for a distributed software platform. Work with engineering teams to operate these services in production.",
  basic_qualifications: "2+ years of software engineering experience",
}

test("Amazon India collects employer dates and uses one requisition for multiple India cities", async () => {
  const result = await fetchCatalogPage(source, 2, {
    fetch: async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, "https://www.amazon.jobs")
      if (url.pathname === "/robots.txt") return new Response("")
      assert.equal(url.searchParams.get("normalized_country_code[]"), "IND")
      assert.equal(url.searchParams.get("offset"), "100")
      return Response.json({
        error: null,
        hits: 102,
        jobs: [posting, { ...posting, id_icims: "2", is_intern: true }],
      })
    },
  })
  assert.equal(result.nextPage, null)
  assert.equal(result.rejected, 1)
  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].url, "https://www.amazon.jobs/en/jobs/10604005")
  assert.equal(result.jobs[0].city, "Hyderabad; Bengaluru")
  assert.equal(result.jobs[0].posted_at, "2026-10-22T00:00:00.000Z")
  assert.match(result.jobs[0].description, /Basic qualifications:\n2\+ years/)
})

test("Amazon India refuses to publish a truncated inventory page", async () => {
  await assert.rejects(
    fetchCatalogPage(source, 1, {
      fetch: async () =>
        Response.json({ error: null, hits: 2, jobs: [posting] }),
    }),
    /incomplete inventory page/
  )
})

test("Amazon general India source collects all native categories but defaults to software projection", async () => {
  const general: CatalogSource = {
    id: "amazon:india",
    kind: "amazon",
    board: "india",
    company: "Amazon",
    config: {},
  }
  const sales = {
    ...posting,
    id_icims: "1234",
    title: "Account Manager",
    job_category: "Sales, Advertising, & Account Management",
  }
  const customerService = {
    ...posting,
    id_icims: "SF260123206",
    title: "Customer Service Associate",
    job_category: "Customer Service",
  }
  const options = {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/robots.txt") return new Response("")
      assert.deepEqual(url.searchParams.getAll("category[]"), [])
      assert.equal(url.searchParams.get("normalized_country_code[]"), "IND")
      return Response.json({
        error: null,
        hits: 3,
        jobs: [posting, sales, customerService],
      })
    },
  }
  const defaultPage = await fetchCatalogPage(general, 1, options)
  assert.equal(defaultPage.jobs.length, 1)
  assert.equal(defaultPage.jobs[0].title, posting.title)
  const expanded = await fetchCatalogPage(general, 1, {
    ...options,
    jobCategories: ["software", "sales"],
  })
  assert.deepEqual(
    expanded.jobs.map((job) => job.title),
    [posting.title, sales.title]
  )
  assert.equal(expanded.nextPage, null)
  assert.equal(expanded.fetched, 3)
})

test("Amazon general India source preserves early-career exclusion and rejects unsafe identities", async () => {
  const general: CatalogSource = {
    id: "amazon:india",
    kind: "amazon",
    board: "india",
    company: "Amazon",
  }
  const result = await fetchCatalogPage(general, 1, {
    jobCategories: ["software", "sales"],
    fetch: async () =>
      Response.json({
        error: null,
        hits: 1,
        jobs: [{ ...posting, is_intern: true }],
      }),
  })
  assert.deepEqual(result.jobs, [])
  await assert.rejects(
    fetchCatalogPage(general, 1, {
      fetch: async () =>
        Response.json({
          error: null,
          hits: 1,
          jobs: [{ ...posting, id_icims: "../other" }],
        }),
    }),
    /Invalid string/
  )
  await assert.rejects(
    fetchCatalogPage({ ...general, config: { categories: ["sales"] } }, 1, {
      fetch: () =>
        assert.fail("unsupported configuration must fail before fetch"),
    }),
    /Unrecognized key/
  )
})
