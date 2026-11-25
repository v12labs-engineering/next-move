import assert from "node:assert/strict"
import test from "node:test"
import { jobCategoryIds } from "@/lib/jobs/categories"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import type { CatalogSource } from "@/lib/server/catalog/feeds"
import { advanceCollection } from "@/lib/server/catalog/source-worker"
import { sourceWorkerDatabase } from "./helpers/source-worker-database"
import { taskOperations } from "./helpers/source-task-database"

const description =
  "Work with colleagues to deliver high quality outcomes for customers, maintain clear documentation, and communicate progress across the organisation."
const titles = [
  "Software Engineer",
  "Data Analyst",
  "Product Manager",
  "Product Designer",
  "Marketing Manager",
  "Account Executive",
  "Customer Success Manager",
  "Technical Support Engineer",
  "Accountant",
]
const published = new Date(Date.now() - 86_400_000).toISOString()

const boardFixtures: { source: CatalogSource; payload: unknown }[] = [
  {
    source: { id: "ashby:acme", kind: "ashby", company: "Acme", board: "acme" },
    payload: {
      jobs: titles.map((title, index) => ({
        title,
        jobUrl: `https://jobs.ashbyhq.com/acme/${index}`,
        isListed: true,
        location: "Pune, India",
        address: { addressCountry: "IN", addressLocality: "Pune" },
        publishedAt: published,
        descriptionPlain: description,
      })),
    },
  },
  {
    source: {
      id: "greenhouse:acme",
      kind: "greenhouse",
      company: "Acme",
      board: "acme",
    },
    payload: {
      jobs: titles.map((title, id) => ({
        id,
        title,
        absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
        location: { name: "Pune, India" },
        content: description,
        first_published: published,
      })),
    },
  },
  {
    source: { id: "lever:acme", kind: "lever", company: "Acme", board: "acme" },
    payload: titles.map((text, id) => ({
      text,
      hostedUrl: `https://jobs.lever.co/acme/${id}`,
      country: "IN",
      categories: { location: "Pune, India" },
      descriptionPlain: description,
      createdAt: Date.parse(published),
    })),
  },
  {
    source: {
      id: "arbeitnow",
      kind: "arbeitnow",
      company: "Arbeitnow",
      board: null,
    },
    payload: {
      data: titles.map((title, id) => ({
        slug: String(id),
        title,
        company_name: "Acme",
        url: `https://acme.example/jobs/${id}`,
        location: "Pune, India",
        description,
        created_at: Math.floor(Date.parse(published) / 1000),
      })),
      links: { next: null },
    },
  },
]

for (const { source, payload } of boardFixtures)
  test(`${source.kind} respects selected catalog categories while raw facts stay broad`, async () => {
    const fetch = async () => Response.json(payload)
    const baseline = await fetchCatalogPage(source, 1, { fetch })
    assert.deepEqual(
      baseline.jobs.map((job) => job.title),
      ["Software Engineer"]
    )
    const marketing = await fetchCatalogPage(source, 1, {
      fetch,
      jobCategories: ["marketing"],
    })
    assert.deepEqual(
      marketing.jobs.map((job) => job.title),
      ["Marketing Manager"]
    )
    const expanded = await fetchCatalogPage(source, 1, {
      fetch,
      jobCategories: jobCategoryIds,
    })
    assert.deepEqual(
      expanded.jobs.map((job) => job.title),
      titles.slice(0, 8)
    )
    assert.equal(expanded.fetched, 9)
    assert.equal(expanded.rejected, 1)
    const raw = await fetchSourcePage(source, 1, {
      fetch,
      jobCategories: ["marketing"],
    })
    assert.deepEqual(
      raw.postings.map((job) => job.title),
      titles
    )
    const empty = await fetchCatalogPage(source, 1, {
      fetch,
      jobCategories: [],
    })
    assert.equal(empty.jobs.length, 0)
  })

test("Workday hydrates newly selected categories before projecting them", async () => {
  const source: CatalogSource = {
    id: "workday:acme.wd5.myworkdayjobs.com~External",
    kind: "workday",
    company: "Acme",
    board: "acme.wd5.myworkdayjobs.com~External",
  }
  const path = "/job/India/Marketing-Manager_R123"
  const requested: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    return Response.json(
      url.endsWith("/jobs")
        ? {
            total: 1,
            jobPostings: [{ title: "Marketing Manager", externalPath: path }],
          }
        : {
            hiringOrganization: { name: "Acme" },
            jobPostingInfo: {
              title: "Marketing Manager",
              jobDescription: description,
              jobPostingSiteId: "External",
              externalUrl: `https://acme.wd5.myworkdayjobs.com/External${path}`,
              startDate: published.slice(0, 10),
              location: "Pune, India",
              country: { descriptor: "India" },
              canApply: true,
              posted: true,
            },
          }
    )
  }
  const baseline = await fetchCatalogPage(source, 1, { fetch })
  assert.equal(baseline.jobs.length, 0)
  assert.equal(requested.length, 1)
  requested.length = 0
  const selected = await fetchCatalogPage(source, 1, {
    fetch,
    jobCategories: ["marketing"],
  })
  assert.equal(requested.length, 2)
  assert.deepEqual(
    selected.jobs.map((job) => job.title),
    ["Marketing Manager"]
  )
})

test("India SmartRecruiters title prefilter admits a selected non-software category", async () => {
  const source: CatalogSource = {
    id: "smartrecruiters:acme",
    kind: "smartrecruiters",
    company: "Acme",
    board: "acme",
    config: { country: "IN" },
  }
  const job = {
    id: "123",
    name: "Data Analyst",
    company: { identifier: "acme", name: "Acme" },
    active: true,
    visibility: "PUBLIC",
    releasedDate: published,
    location: { country: "IN", city: "Pune" },
    jobAd: { sections: { description: { text: description } } },
  }
  let requests = 0
  const fetch: typeof globalThis.fetch = async (input) => {
    requests++
    return Response.json(
      String(input).includes("?")
        ? { offset: 0, totalFound: 1, content: [job] }
        : job
    )
  }
  assert.equal((await fetchCatalogPage(source, 1, { fetch })).jobs.length, 0)
  assert.equal(requests, 1)
  requests = 0
  const selected = await fetchCatalogPage(source, 1, {
    fetch,
    jobCategories: ["data"],
  })
  assert.equal(requests, 2)
  assert.deepEqual(
    selected.jobs.map((row) => row.title),
    ["Data Analyst"]
  )
})

test("Workable applies selected categories at both prefilter and catalog projection", async () => {
  const source: CatalogSource = {
    id: "workable:acme",
    kind: "workable",
    company: "Acme",
    board: "acme",
  }
  const fetch = async () =>
    Response.json({
      name: "Acme",
      jobs: [
        {
          shortcode: "ABCDEF1234",
          title: "Customer Success Manager",
          url: "https://apply.workable.com/j/ABCDEF1234",
          country: "IN",
          city: "Pune",
          description,
          published_on: published,
        },
      ],
    })
  assert.equal((await fetchCatalogPage(source, 1, { fetch })).jobs.length, 0)
  const selected = await fetchCatalogPage(source, 1, {
    fetch,
    jobCategories: ["customer_success"],
  })
  assert.deepEqual(
    selected.jobs.map((job) => job.title),
    ["Customer Success Manager"]
  )
})

test("durable shared collection publishes all configured categories without broadening raw exclusions", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db)
    const task = await tasks.request("category-worker", "arbeitnow")
    const result = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      {
        database,
        fetch: async () => Response.json(boardFixtures[3].payload),
      }
    )
    assert.equal(result.status, "completed", JSON.stringify(result))
    const rows = await db.query<{ title: string }>(
      "select title from job_catalog where is_active order by title"
    )
    assert.deepEqual(
      rows.rows.map((row) => row.title),
      titles.slice(0, 8).sort()
    )
    const replay = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      {
        database,
        fetch: async () => assert.fail("completed task must not re-fetch"),
      }
    )
    assert.equal(replay.status, "completed")
    assert.equal((await db.query("select id from job_catalog")).rows.length, 8)
  } finally {
    await db.close()
  }
})
