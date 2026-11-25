import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchPersonioPage } from "@/lib/server/catalog/connectors/personio"
import type {
  CatalogSource,
  RawSourcePosting,
} from "@/lib/server/catalog/feeds"

const source: CatalogSource = {
  id: "personio:acme.jobs.personio.com",
  kind: "personio",
  board: "acme.jobs.personio.com",
  company: "Acme",
}
const origin = "https://acme.jobs.personio.com"
const description =
  "Build distributed software services and production APIs, maintain automated tests, and improve reliability with a team of software engineers."
const published = new Date(Date.now() - 86_400_000).toISOString()
const position = (
  id = "7",
  title = "Software Engineer",
  office = "Bengaluru",
  content = description
) =>
  `<position><id>${id}</id><subcompany>Acme India</subcompany><office>${office}</office><name>${title}</name><jobDescriptions><jobDescription><name>Your role</name><value><![CDATA[<p>${content}</p>]]></value></jobDescription></jobDescriptions><createdAt>2010-01-01T00:00:00Z</createdAt></position>`
const feed = (body = position()) => `<workzag-jobs>${body}</workzag-jobs>`
const detail = (id = "7", fields: Record<string, unknown> = {}) =>
  `<link rel="canonical" href="${origin}/job/${id}?language=en"><script type="application/ld+json">${JSON.stringify(
    {
      "@type": "JobPosting",
      title: "Software Engineer",
      identifier: { value: `${id}-123` },
      hiringOrganization: { name: "Acme" },
      datePosted: published,
      jobLocation: [
        { address: { addressCountry: "IN", addressLocality: "Bengaluru" } },
        { address: { addressCountry: "IN", addressLocality: "Pune" } },
        { address: { addressCountry: "DE", addressLocality: "Berlin" } },
      ],
      ...fields,
    }
  )}</script>`
function transport(xml = feed(), body = detail()) {
  const seen: string[] = []
  return {
    seen,
    fetch: async (input: string | URL | Request) => {
      const url = String(input)
      seen.push(url)
      if (url === `${origin}/xml?language=en`) return new Response(xml)
      if (url === `${origin}/?language=en`)
        return new Response(
          `<title>Jobs at Acme</title><link rel="canonical" href="${origin}/?language=en">`
        )
      return new Response(body)
    },
  }
}

test("Personio reads published detail facts and preserves each country's cities", async () => {
  const read = transport()
  const observations: RawSourcePosting[] = []
  let requests = 0
  const page = await fetchPersonioPage(source, 1, {
    fetch: read.fetch,
    observePosting: (posting) => observations.push(posting),
    onRequest: () => requests++,
  })
  assert.equal(page.employer, "Acme")
  assert.equal(page.fetched, 1)
  assert.equal(page.rejected, 0)
  assert.equal(page.nextPage, null)
  assert.equal(page.requests, 3)
  assert.equal(requests, 3)
  assert.deepEqual(
    page.jobs.map((job) => [job.country, job.city, job.company, job.posted_at]),
    [
      ["India", "Bengaluru; Pune", "Acme India", published],
      ["Germany", "Berlin", "Acme India", published],
    ]
  )
  assert.deepEqual(observations[0].countries, ["India", "Germany"])
  assert.equal(page.jobs[0].url, `${origin}/job/7`)
})

test("Personio keeps unknown dates and locations, and observes other professions", async () => {
  const read = transport(
    feed(position("7", "Account Executive", "Atlanta, GA")),
    detail("7", {
      title: "Account Executive",
      datePosted: undefined,
      jobLocation: undefined,
    })
  )
  const observations: RawSourcePosting[] = []
  const page = await fetchPersonioPage(source, 1, {
    fetch: read.fetch,
    observePosting: (p) => observations.push(p),
  })
  assert.deepEqual(page.jobs, [])
  assert.equal(page.rejected, 1)
  assert.equal(observations[0].title, "Account Executive")
  assert.deepEqual(observations[0].locations, ["Atlanta, GA"])
  assert.deepEqual(observations[0].countries, [])
  assert.equal(
    observations[0].postedAt,
    null,
    "XML createdAt is not the publication date"
  )
})

test("Personio applies the selected job categories after observing provider facts", async () => {
  const read = transport(
    feed(position("7", "Account Executive")),
    detail("7", { title: "Account Executive" })
  )
  const observations: RawSourcePosting[] = []
  const page = await fetchPersonioPage(source, 1, {
    fetch: read.fetch,
    jobCategories: ["sales"],
    observePosting: (posting) => observations.push(posting),
  })
  assert.equal(observations.length, 1)
  assert.equal(page.jobs.length, 2)
  assert.equal(page.jobs[0].title, "Account Executive")
  const excluded = await fetchPersonioPage(source, 1, {
    fetch: read.fetch,
    jobCategories: ["design"],
  })
  assert.deepEqual(excluded.jobs, [])
})

test("Personio honors remote applicant-country restrictions over office locations", async () => {
  const page = await fetchPersonioPage(source, 1, {
    fetch: transport(
      feed(),
      detail("7", {
        jobLocationType: "TELECOMMUTE",
        applicantLocationRequirements: { "@type": "Country", name: "Germany" },
      })
    ).fetch,
  })
  assert.deepEqual(
    page.jobs.map((job) => [job.country, job.city, job.work_mode]),
    [["Germany", "Berlin", "remote"]]
  )
})

test("Personio pages detail requests in stable ID order", async () => {
  const read = transport(
    feed(
      Array.from({ length: 11 }, (_, i) => position(String(11 - i))).join("")
    )
  )
  const custom = async (input: string | URL | Request) => {
    const url = new URL(String(input))
    return url.pathname.startsWith("/job/")
      ? new Response(detail(url.pathname.split("/")[2]))
      : read.fetch(input)
  }
  const first = await fetchPersonioPage(source, 1, { fetch: custom })
  const second = await fetchPersonioPage(source, 2, { fetch: custom })
  assert.equal(first.fetched, 10)
  assert.equal(first.nextPage, 2)
  assert.equal(first.requests, 12)
  assert.equal(second.fetched, 1)
  assert.equal(second.nextPage, null)
  assert.equal(second.requests, 3)
  assert.equal(
    new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size,
    22
  )
  await assert.rejects(
    fetchPersonioPage(source, 3, { fetch: custom }),
    /page.*inventory/i
  )
})

test("Personio refuses malformed, duplicate, oversized and unexpected inventories", async () => {
  for (const xml of [
    "<workzag-jobs><position>",
    "<html><body>Access denied</body></html>",
    "<!DOCTYPE workzag-jobs [<!ENTITY x SYSTEM 'https://private.invalid/'>]><workzag-jobs/>",
    feed(position() + position()),
    feed(position().replace("<id>7</id>", "<id>7</id><id>8</id>")),
    feed("<unexpected/>"),
    feed(
      Array.from({ length: 5001 }, (_, i) => position(String(i + 1))).join("")
    ),
  ]) {
    const read = transport(xml)
    await assert.rejects(fetchPersonioPage(source, 1, { fetch: read.fetch }))
    assert.equal(
      read.seen.some((url) => url.includes("/job/")),
      false
    )
  }
})

test("Personio refuses wrong detail identity, unsafe canonical links and changed employers", async () => {
  for (const body of [
    detail("8"),
    detail().replace(`${origin}/job/7?language=en`, "https://evil.test/job/7"),
    detail().replace(
      `${origin}/job/7?language=en`,
      `${origin.replace("https://", "https://user:pass@")}/job/7`
    ),
    detail("7", { identifier: { value: "8-123" } }),
    detail("7", { title: "Other position" }),
  ]) {
    await assert.rejects(
      fetchPersonioPage(source, 1, { fetch: transport(feed(), body).fetch }),
      /Personio/
    )
  }
  await assert.rejects(
    fetchPersonioPage({ ...source, company: "Other employer" }, 1, {
      fetch: transport().fetch,
    }),
    /employer changed/i
  )
})

test("Personio preserves feed facts when structured data is absent without inventing freshness", async () => {
  const body = `<link rel="canonical" href="${origin}/job/7?language=en">`
  const observations: RawSourcePosting[] = []
  const page = await fetchPersonioPage(source, 1, {
    fetch: transport(
      feed(
        position("7", "Software Engineer", "Pune, India").replace(
          "</position>",
          "<additionalOffices><office>London, United Kingdom</office><office>Zurich</office></additionalOffices></position>"
        )
      ),
      body
    ).fetch,
    observePosting: (p) => observations.push(p),
  })
  assert.equal(observations[0].postedAt, null)
  assert.deepEqual(observations[0].countries, ["India", "United Kingdom"])
  assert.deepEqual(observations[0].locations, [
    "Pune, India",
    "London, United Kingdom",
    "Zurich",
  ])
  assert.equal(page.jobs[0].posted_at, null)
})

test("Personio handles empty inventories and rejects invalid pages before network access", async () => {
  const read = transport(feed(""))
  const page = await fetchPersonioPage(source, 1, { fetch: read.fetch })
  assert.equal(page.fetched, 0)
  assert.deepEqual(page.jobs, [])
  assert.equal(page.nextPage, null)
  for (const number of [0, -1, 1.5, NaN]) {
    await assert.rejects(
      fetchPersonioPage(source, number, {
        fetch: async () => {
          throw new Error("Network must not run")
        },
      }),
      /Invalid Personio/
    )
  }
})

test("Personio refuses incomplete selected inventories while preserving raw unknowns", async () => {
  for (const title of ["Software Engineer", "UI Engineer"]) {
    const fetch = transport(
      feed(position("7", title, "Bengaluru", "")),
      detail("7", { title })
    ).fetch
    await assert.rejects(
      fetchPersonioPage(source, 1, { fetch }),
      /description is incomplete/
    )
    const observations: RawSourcePosting[] = []
    const raw = await fetchPersonioPage(source, 1, {
      fetch,
      observePosting: (posting) => observations.push(posting),
    })
    assert.equal(observations[0].description, "Your role")
    assert.deepEqual(raw.jobs, [])
  }
  const fetch = transport(
    feed(position("7", "Account Executive")),
    detail("7", { title: "Account Executive", jobLocation: undefined })
  ).fetch
  await assert.rejects(
    fetchPersonioPage(source, 1, { fetch, jobCategories: ["sales"] }),
    /lacks country evidence/
  )
  const observations: RawSourcePosting[] = []
  const raw = await fetchPersonioPage(source, 1, {
    fetch,
    jobCategories: ["sales"],
    observePosting: (posting) => observations.push(posting),
  })
  assert.deepEqual(observations[0].countries, [])
  assert.deepEqual(raw.jobs, [])
  const absentStructuredData = transport(
    feed(),
    `<link rel="canonical" href="${origin}/job/7">`
  ).fetch
  await assert.rejects(
    fetchPersonioPage(source, 1, { fetch: absentStructuredData }),
    /lacks country evidence/
  )
  const excluded = await fetchPersonioPage(source, 1, {
    fetch: transport(
      feed(position("7", "Accountant", "", "")),
      detail("7", { title: "Accountant", jobLocation: undefined })
    ).fetch,
  })
  assert.deepEqual(excluded.jobs, [])
  assert.equal(excluded.nextPage, null)
})

test("Personio explicit expiry safely removes a job even when required facts are missing", async () => {
  const page = await fetchPersonioPage(source, 1, {
    fetch: transport(
      feed(position("7", "Software Engineer", "", "")),
      detail("7", {
        jobLocation: undefined,
        validThrough: new Date(Date.now() - 86_400_000).toISOString(),
      })
    ).fetch,
  })
  assert.deepEqual(page.jobs, [])
  assert.equal(page.fetched, 1)
  assert.equal(page.nextPage, null)
})
