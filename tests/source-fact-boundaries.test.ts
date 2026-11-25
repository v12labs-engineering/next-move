import assert from "node:assert/strict"
import { test } from "node:test"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import { boardIdentity } from "@/lib/server/catalog/source-identity"

test("raw ATS reads retain absent descriptions and locations while catalog reads remain strict", async () => {
  for (const kind of ["workday", "smartrecruiters", "workable"] as const) {
    const source = {
      ...boardIdentity(
        kind,
        kind === "workday" ? "acme.wd5.myworkdayjobs.com~Careers" : "acme"
      ),
      company: "Acme",
    }
    for (const missing of [undefined, null]) {
      const transport =
        (malformed = false): typeof fetch =>
        async (input) => {
          const url = String(input)
          const value = malformed ? 123 : missing
          if (kind === "workable")
            return Response.json({
              name: "Acme",
              jobs: [
                {
                  shortcode: "ABCDEF1234",
                  title: "Software Engineer",
                  url: "https://apply.workable.com/j/ABCDEF1234",
                  description: value,
                },
              ],
            })
          if (kind === "smartrecruiters") {
            const job = {
              id: "7",
              name: "Software Engineer",
              company: { identifier: "acme", name: "Acme" },
              active: true,
              visibility: "PUBLIC",
              location:
                missing === null ? { country: null, city: null } : missing,
              jobAd: malformed
                ? { sections: { description: { text: value } } }
                : missing,
            }
            return Response.json(
              url.includes("?")
                ? { offset: 0, totalFound: 1, content: [job] }
                : job
            )
          }
          const path = "/job/Pune/Software-Engineer_R7"
          return Response.json(
            url.endsWith("/jobs")
              ? {
                  total: 1,
                  jobPostings: [
                    { title: "Software Engineer", externalPath: path },
                  ],
                }
              : {
                  hiringOrganization: { name: "Acme" },
                  jobPostingInfo: {
                    title: "Software Engineer",
                    jobPostingSiteId: "Careers",
                    externalUrl:
                      "https://acme.wd5.myworkdayjobs.com/Careers" + path,
                    posted: true,
                    canApply: true,
                    location: missing,
                    country: missing,
                    jobDescription: value,
                  },
                }
          )
        }
      const raw = await fetchSourcePage(source, 1, { fetch: transport() })
      assert.equal(raw.nextPage, null)
      assert.equal(raw.postings.length, 1, kind)
      assert.equal(raw.postings[0].description, "", kind)
      assert.deepEqual(raw.postings[0].locations, [], kind)
      assert.deepEqual(raw.postings[0].countries, [], kind)
      await assert.rejects(
        fetchCatalogPage(source, 1, { fetch: transport() }),
        `${kind} catalog must reject incomplete records`
      )
      await assert.rejects(
        fetchSourcePage(source, 1, { fetch: transport(true) }),
        `${kind} raw mode must reject non-string descriptions`
      )
    }
  }
})

test("Recruitee raw XML preserves missing description without weakening catalog completeness", async () => {
  const source = { ...boardIdentity("recruitee", "acme"), company: "Acme" }
  const fetch = async () =>
    new Response(
      `<offers><offer><id>7</id><slug>engineer</slug><title>Software Engineer</title><status>published</status><company_name>Acme</company_name><careers_url>https://acme.recruitee.com/o/engineer</careers_url><country_code>IN</country_code><city>Pune</city></offer></offers>`
    )
  const raw = await fetchSourcePage(source, 1, { fetch })
  assert.equal(raw.postings[0].description, "")
  assert.deepEqual(raw.postings[0].countries, ["India"])
  await assert.rejects(
    fetchCatalogPage(source, 1, { fetch }),
    /description is incomplete/
  )
})
