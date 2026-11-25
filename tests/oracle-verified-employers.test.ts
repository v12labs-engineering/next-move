import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import {
  fetchCatalogPage,
  type CatalogSource,
} from "@/lib/server/catalog/feeds"
import { validSourceId } from "@/lib/server/catalog/source-identity"
import { jobCategoryIds } from "@/lib/jobs/categories"

const started = "2026-11-17T12:00:00Z"
const windowStart = "2026-10-17T12:00:00.000Z"
const description =
  "Design and maintain reliable production software services and APIs. Collaborate with engineering teams, review code and improve platform performance."
const tenants = [
  ["jpmorgan-chase", "jpmc.fa.oraclecloud.com", "CX_1001"],
  ["honeywell", "ibqbjb.fa.ocs.oraclecloud.com", "Honeywell"],
  ["nokia", "fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com", "CX_1"],
  ["emerson", "hdjq.fa.us2.oraclecloud.com", "CX_1"],
] as const

const source = (board: string): CatalogSource => ({
  id: `oracle:${board}`,
  kind: "oracle",
  board,
  company: board,
  config: {},
})

test("verified Oracle employers paginate a pinned India date window and hydrate full details", async () => {
  for (const [board, host, site] of tenants) {
    const offsets: number[] = []
    const transport: typeof fetch = async (input) => {
      const url = new URL(String(input))
      assert.equal(url.hostname, host)
      if (url.pathname === "/robots.txt")
        return new Response("", {
          status: board === "jpmorgan-chase" ? 403 : 404,
        })
      const finder = url.searchParams.get("finder") ?? ""
      if (url.pathname.endsWith("recruitingCEJobRequisitionDetails")) {
        return Response.json({
          items: [
            {
              Id: finder.replace("ById;Id=", ""),
              Title: "Software Engineer",
              PrimaryLocation: "Bengaluru, Karnataka, India",
              PrimaryLocationCountry: "IN",
              ExternalPostedStartDate: "2026-11-16T09:00:00Z",
              ExternalDescriptionStr: description,
            },
          ],
        })
      }
      assert.ok(finder.includes(`siteNumber=${site},limit=10,`))
      assert.ok(finder.includes(",location=India"))
      assert.ok(finder.includes(`,postingStartDate=${windowStart}`))
      const offset = Number(finder.match(/offset=(\d+)/)?.[1])
      offsets.push(offset)
      const length = Math.min(10, 12 - offset)
      return Response.json({
        items: [
          {
            Location: "India",
            SiteNumber: site,
            Offset: offset,
            Limit: 10,
            TotalJobsCount: 12,
            PostingStartDate: windowStart,
            requisitionList: Array.from({ length }, (_, index) => ({
              Id: String(offset + index + 1),
              Title: "Software Engineer",
              PostedDate: "2026-11-16",
              PrimaryLocationCountry: "IN",
              PrimaryLocation: "Bengaluru, India",
            })),
          },
        ],
      })
    }
    const first = await fetchCatalogPage(source(board), 1, {
      fetch: transport,
      snapshotStartedAt: started,
      jobCategories: jobCategoryIds,
    })
    assert.equal(first.nextPage, 2)
    const second = await fetchCatalogPage(source(board), 2, {
      fetch: transport,
      snapshotStartedAt: started,
      jobCategories: jobCategoryIds,
    })
    assert.equal(second.nextPage, null)
    assert.deepEqual(offsets, [0, 10])
    const jobs = [...first.jobs, ...second.jobs]
    assert.equal(jobs.length, 12)
    assert.equal(new Set(jobs.map((job) => job.url)).size, 12)
    assert.ok(
      jobs.every(
        (job) => job.country === "India" && job.description === description
      )
    )
    assert.ok(
      jobs.every((job) =>
        job.url.startsWith(
          board === "nokia"
            ? "https://jobs.nokia.com/en/sites/CX_1/job/"
            : `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/`
        )
      )
    )
    assert.ok(validSourceId(source(board).id))
  }
})

test("Oracle robots 4xx policy never ignores actual job authorization failures or robots throttling", async () => {
  for (const status of [401, 403]) {
    let requests = 0
    await assert.rejects(
      fetchCatalogPage(source("jpmorgan-chase"), 1, {
        snapshotStartedAt: started,
        fetch: async (input) => {
          requests++
          return new Response("", {
            status:
              new URL(String(input)).pathname === "/robots.txt" ? 403 : status,
          })
        },
      }),
      new RegExp(`Source HTTP ${status}`)
    )
    assert.equal(requests, 2)
  }
  for (const status of [429, 503]) {
    let requests = 0
    await assert.rejects(
      fetchCatalogPage(source("jpmorgan-chase"), 1, {
        fetch: async () => {
          requests++
          return new Response("", {
            status,
            headers: { "Retry-After": "3600" },
          })
        },
      }),
      new RegExp(`Source HTTP ${status}`)
    )
    assert.equal(requests, 1)
  }
  await assert.rejects(
    fetchCatalogPage(source("honeywell"), 1, {
      fetch: async (input) => {
        assert.equal(new URL(String(input)).pathname, "/robots.txt")
        return new Response("User-agent: *\nDisallow: /hcmRestApi/")
      },
    }),
    /excluded by robots/
  )
})

test("Oracle employer migration only widens verified tenant admission and enables no sources", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create table job_source_directory(kind text,board text,enabled boolean default false,
      constraint job_source_directory_regional_scope check((kind<>'infopark' or board='kerala') and
      (kind<>'oracle' or board in ('bny','ibs-software','oracle-india'))));`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611170084_verified_oracle_employers.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    assert.equal(
      (await db.query("select * from job_source_directory")).rows.length,
      0
    )
    for (const [board] of tenants)
      await db.query(
        "insert into job_source_directory(kind,board) values('oracle',$1)",
        [board]
      )
    assert.equal(
      (await db.query("select * from job_source_directory where enabled")).rows
        .length,
      0
    )
    await assert.rejects(
      db.exec(
        "insert into job_source_directory(kind,board) values('oracle','unverified-tenant')"
      ),
      /check constraint/
    )
    await assert.rejects(
      db.exec(
        "insert into job_source_directory(kind,board) values('infopark','unverified-park')"
      ),
      /check constraint/
    )
  } finally {
    await db.close()
  }
})
