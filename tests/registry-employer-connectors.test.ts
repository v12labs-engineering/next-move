import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import {
  registryBoardKey,
  scrapeRegistryBoard,
} from "../scripts/lib/registry-job-ats.mjs"

const snapshotStartedAt = "2026-11-16T12:00:00Z"
const amazonUrl = new URL(
  "https://www.amazon.jobs/en/search?normalized_country_code[]=IND"
)
const ibsUrl = new URL(
  "https://fa-etbm-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs"
)
const oracleUrl = new URL(
  "https://careers.oracle.com/en/sites/jobsearch/jobs?location=India"
)
const summary = {
  Id: "123",
  Title: "Customer Support Associate",
  PostedDate: "2026-09-01",
  PrimaryLocation: "London, United Kingdom",
  PrimaryLocationCountry: "GB",
  ShortDescriptionStr: "<p>Answer customer questions.</p>",
}

test("Amazon research uses shared raw collection without a software category filter", async () => {
  const result = await scrapeRegistryBoard(amazonUrl, "Amazon", {
    fetch: async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, "https://www.amazon.jobs")
      if (url.pathname === "/robots.txt") return new Response("")
      assert.equal(url.pathname, "/en/search.json")
      assert.deepEqual(url.searchParams.getAll("category[]"), [])
      assert.equal(url.searchParams.get("normalized_country_code[]"), "IND")
      return Response.json({
        error: null,
        hits: 1,
        jobs: [
          {
            id_icims: "123",
            title: "Customer Support Associate",
            country_code: "IND",
            job_category: "Customer Service",
            city: "Hyderabad",
          },
        ],
      })
    },
  })
  assert.equal(result.complete, true)
  assert.equal(result.method, "amazon:india:")
  assert.equal(result.jobs[0].title, summary.Title)
  assert.equal(result.jobs[0].description, "")
  assert.equal(result.jobs[0].postedAt, null)
})

test("Amazon raw categories retain canonical keys and cannot change the scheduled catalog scope", async () => {
  const url = new URL(amazonUrl)
  url.searchParams.append("category[]", "customer-service")
  url.searchParams.append("category[]", "administrative-support")
  assert.equal(
    registryBoardKey(url),
    "amazon:india:administrative-support,customer-service"
  )
  const result = await scrapeRegistryBoard(url, "Amazon", {
    fetch: async (input) => {
      if (new URL(String(input)).pathname === "/robots.txt")
        return new Response("")
      assert.deepEqual(
        new URL(String(input)).searchParams.getAll("category[]"),
        ["administrative-support", "customer-service"]
      )
      return Response.json({ error: null, hits: 0, jobs: [] })
    },
  })
  assert.equal(result.complete, true)
  await assert.rejects(
    fetchCatalogPage(
      {
        id: "amazon:india:",
        kind: "amazon",
        board: "india",
        company: "Amazon",
        config: { categories: [] },
      },
      1,
      {
        fetch: () => assert.fail("raw scope must not enter catalog collection"),
      }
    ),
    /Invalid Amazon India source/
  )
  await assert.rejects(
    fetchCatalogPage(
      {
        id: "amazon:india-software",
        kind: "amazon",
        board: "india-software",
        company: "Amazon",
      },
      1,
      {
        fetch: async (input) => {
          if (new URL(String(input)).pathname === "/robots.txt")
            return new Response("")
          assert.deepEqual(
            new URL(String(input)).searchParams.getAll("category[]"),
            ["software-development"]
          )
          return Response.json({
            error: null,
            hits: 1,
            jobs: [
              {
                id_icims: "123",
                title: summary.Title,
                country_code: "IND",
                job_category: "Customer Service",
                description: "Short description",
                posted_date: "November 16, 2026",
              },
            ],
          })
        },
      }
    ),
    /Software Development/
  )
})

test("IBS research reads global summaries through the Oracle connector", async () => {
  const seen: string[] = []
  const result = await scrapeRegistryBoard(ibsUrl, "IBS Software", {
    snapshotStartedAt,
    fetch: async (input) => {
      const url = new URL(String(input))
      seen.push(url.pathname)
      if (url.pathname === "/robots.txt") return new Response("")
      assert.equal(url.origin, ibsUrl.origin)
      assert.match(
        url.searchParams.get("finder") ?? "",
        /siteNumber=CX_1,limit=20,offset=0/
      )
      assert.doesNotMatch(
        url.searchParams.get("finder") ?? "",
        /location=India/
      )
      return Response.json({
        items: [
          {
            SiteNumber: "CX_1",
            Offset: 0,
            Limit: 20,
            TotalJobsCount: 1,
            requisitionList: [summary],
          },
        ],
      })
    },
  })
  assert.equal(result.complete, true)
  assert.equal(result.method, "oracle:ibs-software")
  assert.deepEqual(result.jobs[0].countries, ["United Kingdom"])
  assert.equal(result.jobs[0].title, summary.Title)
  assert.equal(result.jobs[0].description, "Answer customer questions.")
  assert.equal(seen.length, 2)
  assert.match(result.jobs[0].url, /\/sites\/CX_1\/job\/123$/)
})

test("Oracle India research preserves the observed public URL and fixed tenant", async () => {
  const result = await scrapeRegistryBoard(oracleUrl, "Oracle", {
    snapshotStartedAt,
    fetch: async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, "https://eeho.fa.us2.oraclecloud.com")
      if (url.pathname === "/robots.txt")
        return new Response("", { status: 404 })
      assert.match(
        url.searchParams.get("finder") ?? "",
        /siteNumber=CX_45001.*location=India/
      )
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
                ...summary,
                PrimaryLocation: "Mumbai, India",
                PrimaryLocationCountry: "IN",
              },
            ],
          },
        ],
      })
    },
  })
  assert.equal(result.complete, true)
  assert.equal(result.method, "oracle:oracle-india")
  assert.equal(
    result.jobs[0].url,
    "https://careers.oracle.com/en/sites/jobsearch/job/123"
  )
  assert.deepEqual(result.jobs[0].countries, ["India"])
})

test("Oracle partial collection retains prior page facts after a malformed page", async () => {
  const result = await scrapeRegistryBoard(ibsUrl, "IBS Software", {
    snapshotStartedAt,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/robots.txt") return new Response("")
      const second = url.searchParams.get("finder")?.includes("offset=20")
      return Response.json({
        items: [
          {
            SiteNumber: "CX_1",
            Offset: second ? 20 : 0,
            Limit: 20,
            TotalJobsCount: 21,
            requisitionList: second
              ? []
              : Array.from({ length: 20 }, (_, i) => ({
                  ...summary,
                  Id: String(i + 1),
                })),
          },
        ],
      })
    },
  })
  assert.equal(result.complete, false)
  assert.equal(result.jobs.length, 20)
  assert.match(result.reason ?? "", /incomplete or mismatched/)
})

test("raw source config retains URL, tenant and robots safeguards", async () => {
  for (const href of [
    "http://www.amazon.jobs/en/search?normalized_country_code[]=IND",
    "https://u:p@careers.oracle.com/en/sites/jobsearch/jobs?location=India",
    "https://careers.oracle.com:8443/en/sites/jobsearch/jobs?location=India",
  ])
    assert.equal(registryBoardKey(new URL(href)), null)
  await assert.rejects(
    scrapeRegistryBoard(ibsUrl, "IBS Software", {
      fetch: async (input) => {
        assert.equal(new URL(String(input)).pathname, "/robots.txt")
        return new Response("User-agent: *\nDisallow: /hcmRestApi/")
      },
    }),
    /excluded by robots/
  )
  await assert.rejects(
    fetchSourcePage(
      {
        id: "oracle:oracle-india",
        kind: "oracle",
        board: "oracle-india",
        company: "Oracle",
        config: { scope: "global", detail: "summary" },
      },
      1,
      {
        fetch: () => assert.fail("unsupported tenant scope must not fetch"),
      }
    ),
    /Unsupported Oracle Recruiting scope/
  )
  await assert.rejects(
    fetchSourcePage(
      {
        id: "amazon:india:bad",
        kind: "amazon",
        board: "india",
        company: "Amazon",
        config: { categories: ["bad&offset=0"] },
      },
      1,
      {
        fetch: () => assert.fail("malformed category must not fetch"),
      }
    ),
    /Invalid string/
  )
})
