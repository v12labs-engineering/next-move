import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchAdzunaPage,
  fetchJobtechPage,
} from "@/lib/server/catalog/connectors/country-feeds"
import { validSourceId } from "@/lib/server/catalog/source-identity"

const description =
  "Build reliable software services with TypeScript and PostgreSQL. Work with other software engineers to design, implement and test customer-facing applications."
const posted = new Date(Date.now() - 3600000).toISOString()
const respond = (body: unknown, seen: string[]) =>
  (async (url: string | URL) => {
    seen.push(String(url))
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch

test("adzuna maps a country window into catalog rows and pages while full", async () => {
  process.env.ADZUNA_APP_ID = "id"
  process.env.ADZUNA_APP_KEY = "key"
  const job = (i: number, title = "Senior Software Engineer") => ({
    id: i,
    title,
    description,
    redirect_url: `https://www.adzuna.co.uk/jobs/details/${i}`,
    created: posted,
    company: { display_name: "Acme" },
    location: { display_name: "London, UK" },
  })
  const seen: string[] = []
  const results = [
    ...Array.from({ length: 49 }, (_, i) => job(i)),
    job(99, "Warehouse Operative"),
  ]
  const page = await fetchAdzunaPage(
    { id: "adzuna:gb", kind: "adzuna", company: "Adzuna GB", board: "gb" },
    1,
    { fetch: respond({ results }, seen) }
  )
  assert.equal(page.fetched, 50)
  assert.equal(page.jobs.length, 49)
  assert.equal(page.rejected, 1)
  assert.equal(page.nextPage, 2)
  assert.equal(page.jobs[0].country, "United Kingdom")
  assert.equal(page.jobs[0].source, "adzuna:gb")
  assert.match(seen[0], /\/jobs\/gb\/search\/1\?/)

  const last = await fetchAdzunaPage(
    { id: "adzuna:gb", kind: "adzuna", company: "Adzuna GB", board: "gb" },
    2,
    { fetch: respond({ results: [job(1)] }, []) }
  )
  assert.equal(last.nextPage, null)
})

test("adzuna rejects unknown countries", async () => {
  await assert.rejects(
    fetchAdzunaPage(
      { id: "adzuna:xx", kind: "adzuna", company: "x", board: "xx" },
      1,
      { fetch: respond({ results: [] }, []) }
    )
  )
})

test("jobtech prefers the employer's https apply link", async () => {
  const page = await fetchJobtechPage(
    { id: "jobtech:se", kind: "jobtech", company: "AF", board: "se" },
    1,
    {
      fetch: respond(
        {
          hits: [
            {
              id: "1",
              headline: "Backend Developer",
              webpage_url:
                "https://arbetsformedlingen.se/platsbanken/annonser/1",
              publication_date: posted,
              description: { text: description },
              employer: { name: "Acme AB" },
              workplace_address: { municipality: "Stockholm" },
              application_details: { url: "https://acme.se/jobs/1" },
            },
          ],
        },
        []
      ),
    }
  )
  assert.equal(page.jobs.length, 1)
  assert.equal(page.jobs[0].url, "https://acme.se/jobs/1")
  assert.equal(page.jobs[0].country, "Sweden")
  assert.equal(page.nextPage, null)
})

test("country feed source ids are canonical", () => {
  assert.ok(validSourceId("adzuna:in"))
  assert.ok(validSourceId("jobtech:se"))
  assert.ok(!validSourceId("adzuna:xx"))
})
