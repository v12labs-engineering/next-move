import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import { boardIdentity } from "@/lib/server/catalog/source-identity"
import { scrapeRegistryBoard } from "../scripts/lib/registry-job-ats.mjs"

const description =
  "Design and build reliable software systems, maintain TypeScript services, and collaborate with engineers to develop tested production applications."
const date = "2026-01-02T09:00:00Z"

test("Greenhouse research uses shared source facts without losing professions or unknown fields", async () => {
  const jobs = [
    {
      id: 1,
      title: "Software Engineer",
      content: description,
      location: { name: "Pune, India" },
    },
    {
      id: 2,
      title: "Accountant",
      content: "",
      location: { name: "Location not stated" },
    },
  ].map((job) => ({
    ...job,
    absolute_url: `https://boards.greenhouse.io/example/jobs/${job.id}`,
    first_published: null,
  }))
  const options = { fetch: async () => Response.json({ jobs }) }
  const result = await scrapeRegistryBoard(
    new URL("https://boards.greenhouse.io/example"),
    "Example",
    options
  )
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.jobs.map((job) => job.title),
    ["Software Engineer", "Accountant"]
  )
  assert.equal(result.jobs[1].description, "")
  assert.equal(result.jobs[1].postedAt, null)
  assert.deepEqual(result.jobs[1].countries, [])
  const catalog = await fetchCatalogPage(
    { ...boardIdentity("greenhouse", "example"), company: "Example" },
    1,
    options
  )
  assert.deepEqual(
    catalog.jobs.map((job) => job.title),
    ["Software Engineer"]
  )
})

test("Ashby research retains every stated city and country for one requisition", async () => {
  const result = await scrapeRegistryBoard(
    new URL("https://jobs.ashbyhq.com/example"),
    "Example",
    {
      fetch: async () =>
        Response.json({
          jobs: [
            {
              title: "Accountant",
              jobUrl: "https://jobs.ashbyhq.com/example/job-1",
              isListed: true,
              location: "Bengaluru",
              address: {
                postalAddress: {
                  addressCountry: "IN",
                  addressLocality: "Bengaluru",
                },
              },
              secondaryLocations: [
                {
                  location: "Pune",
                  address: { addressCountry: "IN", addressLocality: "Pune" },
                },
                {
                  location: "London",
                  address: { addressCountry: "GB", addressLocality: "London" },
                },
              ],
              descriptionPlain: "Accounting",
              publishedAt: date,
            },
          ],
        }),
    }
  )
  assert.equal(result.complete, true)
  assert.equal(result.jobs.length, 1)
  assert.deepEqual(result.jobs[0].countries, ["India", "United Kingdom"])
  assert.equal(result.jobs[0].location, "Bengaluru; Pune; London")
})

test("regional Greenhouse and Lever boards keep their EU transport", async () => {
  for (const [url, host, payload] of [
    [
      "https://job-boards.eu.greenhouse.io/example",
      "boards-api.eu.greenhouse.io",
      { jobs: [] },
    ],
    ["https://jobs.eu.lever.co/example", "api.eu.lever.co", []],
  ] as const) {
    let requests = 0
    const result = await scrapeRegistryBoard(new URL(url), "Example", {
      fetch: async (input) => {
        assert.equal(new URL(String(input)).hostname, host)
        requests++
        return Response.json(payload)
      },
    })
    assert.equal(result.complete, true)
    assert.equal(requests, 1)
  }
})

test("Lever research preserves all locations and retains a completed page after later failure", async () => {
  const jobs = Array.from({ length: 100 }, (_, id) => ({
    text: "Accountant",
    hostedUrl: `https://jobs.lever.co/example/${id}`,
    country: "IN",
    categories: { location: "Pune", allLocations: ["Bengaluru", "Hyderabad"] },
    descriptionPlain: "",
    createdAt: Date.parse(date),
  }))
  let requests = 0
  const result = await scrapeRegistryBoard(
    new URL("https://jobs.lever.co/example"),
    "Example",
    {
      fetch: async (input) => {
        requests++
        return Response.json(
          new URL(String(input)).searchParams.get("skip") === "0"
            ? jobs
            : { error: "invalid listing" }
        )
      },
    }
  )
  assert.equal(result.complete, false)
  assert.equal(result.jobs.length, 100)
  assert.equal(result.jobs[0].location, "Pune; Bengaluru; Hyderabad")
  assert.equal(requests, 2)
})

test("SmartRecruiters research reads all professions in the explicit India scope", async () => {
  const row = {
    id: "1",
    name: "Accountant",
    company: { identifier: "example", name: "Example" },
    active: true,
    visibility: "PUBLIC",
    releasedDate: date,
    location: { country: "in", city: "Pune" },
    jobAd: { sections: { description: { text: "Accounting" } } },
  }
  const result = await scrapeRegistryBoard(
    new URL("https://careers.smartrecruiters.com/example/india"),
    "Example",
    {
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.search) {
          assert.equal(url.searchParams.get("country"), "in")
          assert.equal(url.searchParams.has("releasedAfter"), false)
          return Response.json({ offset: 0, totalFound: 1, content: [row] })
        }
        return Response.json(row)
      },
    }
  )
  assert.equal(result.complete, true)
  assert.equal(result.jobs[0].title, "Accountant")
  assert.equal(result.jobs[0].postedAt, "2026-01-02T09:00:00.000Z")
  assert.deepEqual(result.jobs[0].countries, ["India"])
})

test("Workday research reads non-software details through the shared connector", async () => {
  const path = "/job/India/Accountant_R1"
  const result = await scrapeRegistryBoard(
    new URL("https://example.wd5.myworkdayjobs.com/Careers"),
    "Example",
    {
      fetch: async (input) =>
        Response.json(
          String(input).endsWith("/jobs")
            ? {
                total: 1,
                jobPostings: [{ externalPath: path, title: "Accountant" }],
              }
            : {
                hiringOrganization: { name: "Example" },
                jobPostingInfo: {
                  title: "Accountant",
                  jobPostingSiteId: "Careers",
                  externalUrl:
                    "https://example.wd5.myworkdayjobs.com/Careers" + path,
                  jobDescription: "Accounting",
                  posted: true,
                  canApply: true,
                  location: "Pune, India",
                  additionalLocations: ["London, United Kingdom"],
                  country: { descriptor: "India" },
                },
              }
        ),
    }
  )
  assert.equal(result.complete, true)
  assert.equal(result.jobs[0].title, "Accountant")
  assert.deepEqual(result.jobs[0].countries, ["India", "United Kingdom"])
  assert.equal(result.jobs[0].postedAt, null)
})

test("source facts do not make rejected roles eligible for catalog publication", async () => {
  const source = { ...boardIdentity("lever", "example"), company: "Example" }
  const options = {
    fetch: async () =>
      Response.json([
        {
          text: "Accountant",
          hostedUrl: "https://jobs.lever.co/example/1",
          categories: { location: "Pune, India" },
          descriptionPlain: description,
        },
      ]),
  }
  const raw = await fetchSourcePage(source, 1, options)
  const catalog = await fetchCatalogPage(source, 1, options)
  assert.equal(raw.postings.length, 1)
  assert.equal(catalog.jobs.length, 0)
})

test("Arbeitnow source facts preserve non-software roles without inventing a country", async () => {
  const result = await fetchSourcePage(
    { id: "arbeitnow", kind: "arbeitnow", board: null, company: "Arbeitnow" },
    1,
    {
      fetch: async () =>
        Response.json({
          data: [
            {
              slug: "accountant",
              title: "Accountant",
              company_name: "Example",
              description: "Accounting",
              location: "Location not stated",
              url: "https://example.com/jobs/accountant",
            },
          ],
          links: { next: null },
        }),
    }
  )
  assert.equal(result.postings.length, 1)
  assert.deepEqual(result.postings[0].countries, [])
  assert.equal(result.postings[0].postedAt, null)
})
