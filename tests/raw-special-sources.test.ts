import assert from "node:assert/strict"
import test from "node:test"
import { fetchAmazonIndiaPage } from "@/lib/server/catalog/connectors/amazon"
import { fetchInfoparkPage } from "@/lib/server/catalog/connectors/infopark"
import { parseLinkedInDetail } from "@/lib/server/catalog/connectors/linkedin"
import { fetchOracleRecruitingPage } from "@/lib/server/catalog/connectors/oracle-recruiting"
import type { RawSourcePosting } from "@/lib/server/catalog/feeds"

const snapshotStartedAt = "2026-11-16T12:00:00Z"
const description =
  "Provide responsive customer support and maintain clear records, work with the operations team, and communicate regularly with customers about their requests."

test("Amazon exposes internship facts before catalog eligibility", async () => {
  const observed: RawSourcePosting[] = []
  const result = await fetchAmazonIndiaPage(
    {
      id: "amazon:india-software",
      kind: "amazon",
      board: "india-software",
      company: "Amazon",
    },
    1,
    {
      observePosting: (posting) => observed.push(posting),
      fetch: async () =>
        Response.json({
          error: null,
          hits: 1,
          jobs: [
            {
              id_icims: "123",
              title: "Software Development Intern",
              is_intern: true,
              country_code: "IND",
              job_category: "Software Development",
              city: "Hyderabad",
              locations: [{ normalizedCountryCode: "IND", city: "Bengaluru" }],
              posted_date: "November 16, 2026",
              description: "Build and test software services.",
            },
          ],
        }),
    }
  )
  assert.deepEqual(result.jobs, [])
  assert.equal(result.rejected, 1)
  assert.equal(observed.length, 1)
  assert.equal(observed[0].title, "Software Development Intern")
  assert.deepEqual(observed[0].locations, ["Hyderabad", "Bengaluru"])
  assert.deepEqual(observed[0].countries, ["India"])
})

test("Oracle exposes older non-software jobs while retaining catalog policy", async () => {
  const observed: RawSourcePosting[] = []
  const result = await fetchOracleRecruitingPage(
    { id: "oracle:bny", kind: "oracle", board: "bny", company: "BNY" },
    1,
    {
      snapshotStartedAt,
      observePosting: (posting) => observed.push(posting),
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname === "/robots.txt") return new Response("")
        if (url.pathname.endsWith("recruitingCEJobRequisitionDetails"))
          return Response.json({
            items: [
              {
                Id: "123",
                Title: "Customer Support Associate",
                PrimaryLocation: "Pune, MH, India",
                PrimaryLocationCountry: "IN",
                ExternalPostedStartDate: "2026-09-01",
                ExternalDescriptionStr: description,
              },
            ],
          })
        return Response.json({
          items: [
            {
              Location: "India",
              SiteNumber: "BNY-Careers",
              Offset: 0,
              Limit: 10,
              TotalJobsCount: 1,
              requisitionList: [
                {
                  Id: "123",
                  Title: "Customer Support Associate",
                  PostedDate: "2026-09-01",
                  PrimaryLocation: "Pune, MH, India",
                  PrimaryLocationCountry: "IN",
                },
              ],
            },
          ],
        })
      },
    }
  )
  assert.deepEqual(result.jobs, [])
  assert.equal(result.rejected, 1)
  assert.equal(observed.length, 1)
  assert.equal(observed[0].title, "Customer Support Associate")
  assert.equal(observed[0].postedAt, "2026-09-01T00:00:00.000Z")
  assert.equal(observed[0].description, description)
})

test("Infopark reads non-software facts without publishing them to the catalog", async () => {
  const observed: RawSourcePosting[] = []
  const result = await fetchInfoparkPage(
    {
      id: "infopark:kerala",
      kind: "infopark",
      board: "kerala",
      company: "Infoparks Kerala",
    },
    1,
    {
      snapshotStartedAt,
      observePosting: (posting) => observed.push(posting),
      fetch: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === "/robots.txt") return new Response("")
        if (path === "/companies-job")
          return new Response(
            '<table><tr><th>Date of Posting</th><th>Job Title</th><th>Company Name</th><th>Last Date to Apply</th><th></th></tr><tr><td>16-11-2026</td><td>Customer Support Associate</td><td>Tenant Ltd</td><td>30 Nov 2026</td><td><a href="/company-jobs/details/42/123">Details</a></td></tr></table>'
          )
        assert.equal(path, "/company-jobs/details/42/123")
        return new Response(
          `<div class="logo-con"><h4>Tenant Ltd</h4></div><div class="deatil-box"><h4>Customer Support Associate</h4><p>Location: Cochin</p><p>${description}</p></div>`
        )
      },
    }
  )
  assert.deepEqual(result.jobs, [])
  assert.equal(result.rejected, 1)
  assert.equal(observed.length, 1)
  assert.equal(observed[0].company, "Tenant Ltd")
  assert.deepEqual(observed[0].locations, ["Kochi"])
})

test("LinkedIn preserves source facts with unknown countries before catalog rejection", () => {
  const observed: RawSourcePosting[] = []
  const card = {
    id: "12345678",
    title: "Customer Support Associate",
    company: "Example Inc",
    location: "Hyderabad",
    postedAt: "2026-11-16",
  }
  const html = `<link rel="canonical" href="https://www.linkedin.com/jobs/view/12345678/"><h1 class="top-card-layout__title">${card.title}</h1><a class="topcard__org-name-link">Example Inc</a><div class="show-more-less-html__markup">${description}</div>`
  assert.throws(
    () => parseLinkedInDetail(card, html, (posting) => observed.push(posting)),
    /no explicit country/
  )
  assert.equal(observed.length, 1)
  assert.equal(observed[0].title, card.title)
  assert.deepEqual(observed[0].countries, [])
  assert.deepEqual(observed[0].locations, ["Hyderabad"])
  assert.equal(observed[0].postedAt, "2026-11-16T00:00:00.000Z")
})
