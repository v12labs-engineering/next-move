import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  type CatalogSource,
} from "@/lib/server/catalog/feeds"

const snapshotStartedAt = "2026-11-16T12:00:00Z"
const park: CatalogSource = {
  id: "infopark:kerala",
  kind: "infopark",
  board: "kerala",
  company: "Infoparks Kerala",
}
const oracle: CatalogSource = {
  id: "oracle:bny",
  kind: "oracle",
  board: "bny",
  company: "BNY",
}
const description =
  "Design and build reliable software and production APIs. You must have 3+ years of professional software development experience."

function parkTable() {
  const row = (id: number, title: string, expiry: string) =>
    `<tr><td>16-11-2026</td><td>${title}</td><td>Tenant Technologies</td><td>${expiry}</td><td><a href="/company-jobs/details/42/${id}">Details</a></td></tr>`
  return `<table><tr><th>Date of Posting</th><th>Job Title</th><th>Company Name</th><th>Last Date to Apply</th><th></th></tr>${row(100, "Software Engineer", "16 Nov 2026")}${row(101, "Software Engineer", "15 Nov 2026")}${row(102, "Software Intern", "30 Nov 2026")}</table>`
}

test("Infopark keeps the stable requisition URL and skips expired and internship rows", async () => {
  const urls: string[] = []
  const result = await fetchCatalogPage(park, 1, {
    snapshotStartedAt,
    fetch: async (input) => {
      const url = new URL(String(input))
      urls.push(url.pathname)
      if (url.pathname === "/robots.txt")
        return new Response("User-agent: *\nDisallow:")
      if (url.pathname === "/companies-job") return new Response(parkTable())
      if (url.pathname === "/company-jobs/details/42/100")
        return new Response(null, {
          status: 302,
          headers: { location: "/jobs/tenant-technologies/software-engineer" },
        })
      return new Response(
        `<div class="logo-con"><h4>Tenant Technologies</h4></div><div class="deatil-box"><h4>Software Engineer</h4><p>Location: Cochin</p><p>${description}</p></div>`
      )
    },
  })
  assert.deepEqual(urls, [
    "/robots.txt",
    "/companies-job",
    "/company-jobs/details/42/100",
    "/jobs/tenant-technologies/software-engineer",
  ])
  assert.equal(result.requests, 4)
  assert.equal(result.rejected, 2)
  assert.equal(result.jobs[0].city, "Kochi")
  assert.equal(
    result.jobs[0].url,
    "https://infopark.in/company-jobs/details/42/100"
  )
  assert.equal(result.jobs[0].posted_at, "2026-11-16T00:00:00.000Z")
})

test("Oracle Recruiting enforces the India scope and the provider's expected page size", async () => {
  const result = (Location: string, TotalJobsCount: number) =>
    fetchCatalogPage(oracle, 1, {
      snapshotStartedAt,
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname === "/robots.txt")
          return new Response("", { status: 404 })
        if (url.pathname.endsWith("recruitingCEJobRequisitionDetails")) {
          assert.equal(url.searchParams.get("finder"), "ById;Id=123")
          return Response.json({
            items: [
              {
                Id: "123",
                Title: "Senior Software Engineer",
                PrimaryLocation: "Pune, MH, India",
                PrimaryLocationCountry: "IN",
                ExternalPostedStartDate: "2026-11-16T09:23:00Z",
                ExternalDescriptionStr: description,
              },
            ],
          })
        }
        assert.match(
          url.searchParams.get("finder") ?? "",
          /siteNumber=BNY-Careers.*location=India/
        )
        assert.equal(url.searchParams.get("expand"), "requisitionList")
        return Response.json({
          items: [
            {
              Location,
              TotalJobsCount,
              SiteNumber: "BNY-Careers",
              Offset: 0,
              Limit: 10,
              requisitionList: [
                {
                  Id: "123",
                  Title: "Senior Software Engineer",
                  PostedDate: "2026-11-16",
                  PrimaryLocation: "Pune, MH, India",
                  PrimaryLocationCountry: "IN",
                },
              ],
            },
          ],
        })
      },
    })
  await assert.rejects(result("United States", 1), /Invalid input/)
  await assert.rejects(result("India", 2), /incomplete or mismatched/)
  const snapshot = await result("India", 1)
  assert.equal(snapshot.nextPage, null)
  assert.equal(snapshot.jobs[0].city, "Pune")
  assert.equal(snapshot.jobs[0].posted_at, "2026-11-16T09:23:00.000Z")
  assert.match(snapshot.jobs[0].url, /\/BNY-Careers\/job\/123$/)
})
