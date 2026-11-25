import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  type CatalogSource,
} from "@/lib/server/catalog/feeds"
import { fetchSourcePage } from "@/lib/server/catalog/connectors"
import { jobCategoryIds } from "@/lib/jobs/categories"

const source: CatalogSource = {
  id: "oracle:oracle-india",
  kind: "oracle",
  board: "oracle-india",
  company: "Oracle",
  config: {},
}
const snapshotStartedAt = "2026-11-17T12:00:00Z"
const description =
  "Design, implement and maintain software services and production APIs. Collaborate with engineering teams and improve reliability across the platform."
const listings = [
  { Id: "101", Title: "Senior Software Engineer" },
  { Id: "102", Title: "Product Manager" },
  { Id: "103", Title: "Technical Support Analyst" },
  { Id: "104", Title: "Marketing Manager" },
]

type DetailChange = Record<string, unknown>
function transport(
  calls: string[],
  change: DetailChange = {},
  listChange: Record<string, unknown> = {}
): typeof fetch {
  return async (input) => {
    const url = new URL(String(input))
    assert.equal(url.origin, "https://eeho.fa.us2.oraclecloud.com")
    if (url.pathname === "/robots.txt") return new Response("")
    const finder = url.searchParams.get("finder") ?? ""
    if (url.pathname.endsWith("recruitingCEJobRequisitionDetails")) {
      const id = finder.replace("ById;Id=", "")
      calls.push(id)
      const item = listings.find((row) => row.Id === id)!
      return Response.json({
        items: [
          {
            ...item,
            PrimaryLocation: "Bengaluru, Karnataka, India",
            PrimaryLocationCountry: "IN",
            ExternalPostedStartDate: "2026-11-15T09:00:00Z",
            ExternalDescriptionStr: description,
            WorkplaceType: "Hybrid",
            ...change,
          },
        ],
      })
    }
    assert.match(finder, /siteNumber=CX_45001,limit=10,offset=0/)
    assert.match(finder, /location=India/)
    assert.match(finder, /postingStartDate=2026-10-17T12:00:00.000Z/)
    return Response.json({
      items: [
        {
          Location: "India",
          SiteNumber: "CX_45001",
          Offset: 0,
          Limit: 10,
          TotalJobsCount: listings.length,
          PostingStartDate: "2026-10-17T12:00:00.000Z",
          requisitionList: listings.map((item) => ({
            ...item,
            PostedDate: "2026-11-15",
            PrimaryLocation: "Bengaluru, Karnataka, India",
            PrimaryLocationCountry: "IN",
            ShortDescriptionStr: "Summary must not replace full description",
          })),
          ...listChange,
        },
      ],
    })
  }
}

test("Oracle India catalog reads full details and preserves software-only default", async () => {
  const calls: string[] = []
  const page = await fetchCatalogPage(source, 1, {
    snapshotStartedAt,
    fetch: transport(calls),
  })
  assert.deepEqual(calls, ["101"])
  assert.equal(page.jobs.length, 1)
  assert.equal(page.jobs[0].description, description)
  assert.equal(
    page.jobs[0].url,
    "https://careers.oracle.com/en/sites/jobsearch/job/101"
  )
  assert.equal(page.jobs[0].posted_at, "2026-11-15T09:00:00.000Z")
  assert.equal(page.jobs[0].work_mode, "hybrid")
  assert.equal(page.nextPage, null)
})

test("Oracle India expands selected categories through the full-detail catalog path", async () => {
  const calls: string[] = []
  const page = await fetchCatalogPage(source, 1, {
    snapshotStartedAt,
    jobCategories: jobCategoryIds,
    fetch: transport(calls),
  })
  assert.deepEqual(calls, ["101", "102", "103", "104"])
  assert.equal(page.jobs.length, 4)
  assert.ok(
    page.jobs.every(
      (job) => job.description === description && job.country === "India"
    )
  )
})

test("Oracle India refuses mismatched pagination, tenant and detail identity", async () => {
  for (const listChange of [
    { Offset: 10 },
    { SiteNumber: "OTHER" },
    { TotalJobsCount: 5 },
    { PostingStartDate: null },
  ])
    await assert.rejects(
      fetchCatalogPage(source, 1, {
        snapshotStartedAt,
        fetch: transport([], {}, listChange),
      }),
      /incomplete or mismatched/
    )
  for (const change of [{ Id: "999" }, { PrimaryLocationCountry: "US" }])
    await assert.rejects(
      fetchCatalogPage(source, 1, {
        snapshotStartedAt,
        fetch: transport([], change),
      }),
      /detail identity mismatch/
    )
})

test("Oracle India excludes closed and future-dated details and rejects incomplete selected jobs", async () => {
  for (const change of [
    { ExternalPostedEndDate: "2026-11-16T23:59:59Z" },
    { ExternalPostedStartDate: "2026-11-18T00:00:00Z" },
    { ExternalPostedStartDate: "2026-10-18T11:59:59Z" },
  ]) {
    const page = await fetchCatalogPage(source, 1, {
      snapshotStartedAt,
      fetch: transport([], change),
    })
    assert.deepEqual(page.jobs, [])
  }
  await assert.rejects(
    fetchCatalogPage(source, 1, {
      snapshotStartedAt,
      fetch: transport([], { ExternalDescriptionStr: "Too short" }),
    }),
    /posting is incomplete/
  )
})

test("Oracle India raw summary mode remains distinct and is never accepted as a catalog source", async () => {
  const raw: CatalogSource = {
    ...source,
    config: { scope: "india", detail: "summary" },
  }
  await assert.rejects(
    fetchCatalogPage(raw, 1, { fetch: () => assert.fail("must not fetch") }),
    /Unsupported Oracle Recruiting scope/
  )
  const result = await fetchSourcePage(raw, 1, {
    snapshotStartedAt,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/robots.txt") return new Response("")
      assert.ok(url.pathname.endsWith("recruitingCEJobRequisitions"))
      return Response.json({
        items: [
          {
            Location: "India",
            SiteNumber: "CX_45001",
            Offset: 0,
            Limit: 20,
            TotalJobsCount: 1,
            requisitionList: [
              {
                Id: "999",
                Title: "Finance Analyst",
                PrimaryLocationCountry: "IN",
                PrimaryLocation: "Delhi, India",
                PostedDate: "2026-09-01",
                ShortDescriptionStr: "Short source fact",
              },
            ],
          },
        ],
      })
    },
  })
  assert.equal(result.postings.length, 1)
  assert.equal(result.postings[0].description, "Short source fact")
})
