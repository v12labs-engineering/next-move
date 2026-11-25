import assert from "node:assert/strict"
import test from "node:test"
import { fetchTeamtailorPage } from "@/lib/server/catalog/connectors/teamtailor"
import type {
  CatalogSource,
  RawSourcePosting,
} from "@/lib/server/catalog/feeds"

const source: CatalogSource = {
  id: "teamtailor:acme.teamtailor.com",
  kind: "teamtailor",
  board: "acme.teamtailor.com",
  company: "Acme",
}
const description =
  "Build reliable software services with TypeScript and PostgreSQL. Work with other software engineers to design, implement and test customer-facing applications."
const published = new Date(Date.now() - 86400000).toUTCString()
const location = (city: string, country: string, name = city) =>
  `<tt:location><tt:name>${name}</tt:name><tt:city>${city}</tt:city><tt:country>${country}</tt:country></tt:location>`
function item(
  id: number,
  input: {
    title?: string
    locations?: string
    content?: string
    date?: string
    remote?: string
    url?: string
  } = {}
) {
  return `<item><title>${input.title ?? "Software Engineer"}</title>
    <description><![CDATA[${input.content ?? `<p>${description}</p>`}]]></description>
    <pubDate>${input.date ?? published}</pubDate>
    <link>${input.url ?? `https://acme.teamtailor.com/jobs/${id}-software-engineer`}</link>
    <guid>00000000-0000-4000-8000-${String(id).padStart(12, "0")}</guid>
    <remoteStatus>${input.remote ?? "hybrid"}</remoteStatus>
    <tt:locations>${input.locations ?? location("Bengaluru", "India")}</tt:locations>
  </item>`
}
const feed = (items: string, employer = "Acme") =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>${employer}</title><description>Current job openings</description><link>https://acme.teamtailor.com/jobs</link>${items}</channel></rss>`
const fullPage = (start = 1) =>
  feed(Array.from({ length: 100 }, (_, index) => item(start + index)).join(""))

test("Teamtailor exposes source facts and projects software jobs with all stated cities", async () => {
  const observations: RawSourcePosting[] = []
  const requests: string[] = []
  let counted = 0
  const body = feed(
    item(1, {
      locations:
        location("Bengaluru", "India") +
        location("Pune", "India") +
        location("Pune", "India") +
        location("London", "United Kingdom"),
      remote: "fully",
    }) +
      item(2, { title: "Accountant", locations: "", content: "", date: "" }) +
      item(3, { locations: location("Atlantis", ""), date: "invalid" })
  )
  const result = await fetchTeamtailorPage(source, 1, {
    fetch: async (url) => {
      requests.push(String(url))
      return new Response(body)
    },
    onRequest: () => counted++,
    observePosting: (posting) => observations.push(posting),
  })
  assert.deepEqual(requests, [
    "https://acme.teamtailor.com/jobs.rss?offset=0&per_page=100",
  ])
  assert.equal(counted, 1)
  assert.equal(result.requests, 1)
  assert.equal(result.employer, "Acme")
  assert.equal(result.employerUrl, requests[0])
  assert.equal(result.listingUrl, requests[0])
  assert.equal(result.fetched, 3)
  assert.equal(result.rejected, 2)
  assert.equal(result.nextPage, null)
  assert.deepEqual(
    result.jobs.map((job) => [job.country, job.city, job.work_mode]),
    [
      ["India", "Bengaluru; Pune", "remote"],
      ["United Kingdom", "London", "remote"],
    ]
  )
  assert.equal(observations.length, 3)
  assert.equal(observations[1].title, "Accountant")
  assert.equal(observations[1].description, "")
  assert.equal(observations[1].postedAt, null)
  assert.deepEqual(observations[1].countries, [])
  assert.deepEqual(observations[2].locations, ["Atlantis"])
  assert.deepEqual(observations[2].countries, [])
  assert.equal(observations[2].postedAt, null)
  const replay = await fetchTeamtailorPage(source, 1, {
    fetch: async () => new Response(body),
    observePosting: () => {},
  })
  assert.deepEqual(
    replay.jobs.map((job) => job.id),
    result.jobs.map((job) => job.id)
  )
})

test("Teamtailor follows documented offset pages and confirms continuation boundaries", async () => {
  const first = await fetchTeamtailorPage(source, 1, {
    fetch: async () => new Response(fullPage()),
  })
  assert.equal(first.nextPage, 2)
  const urls: string[] = []
  const second = await fetchTeamtailorPage(source, 2, {
    fetch: async (input) => {
      const url = new URL(String(input))
      urls.push(url.href)
      return new Response(
        url.searchParams.get("offset") === "100" ? feed(item(101)) : fullPage()
      )
    },
  })
  assert.equal(second.nextPage, null)
  assert.equal(second.fetched, 1)
  assert.equal(second.requests, 2)
  assert.deepEqual(urls, [
    "https://acme.teamtailor.com/jobs.rss?offset=100&per_page=100",
    "https://acme.teamtailor.com/jobs.rss?offset=0&per_page=100",
  ])
})

test("Teamtailor requires an empty terminal page at the exact inventory cap", async () => {
  const empty = await fetchTeamtailorPage(source, 51, {
    fetch: async (input) =>
      new Response(
        new URL(String(input)).searchParams.get("offset") === "5000"
          ? feed("")
          : fullPage(4901)
      ),
  })
  assert.equal(empty.nextPage, null)
  assert.equal(empty.fetched, 0)
  await assert.rejects(
    fetchTeamtailorPage(source, 51, {
      fetch: async () => new Response(feed(item(5001))),
    }),
    /safety limit/
  )
})

test("Teamtailor rejects repeated, overlapping, and inconsistent continuation pages", async () => {
  await assert.rejects(
    fetchTeamtailorPage(source, 2, {
      fetch: async () => new Response(fullPage()),
    }),
    /pagination did not advance/
  )
  await assert.rejects(
    fetchTeamtailorPage(source, 2, {
      fetch: async (input) =>
        new Response(
          new URL(String(input)).searchParams.get("offset") === "100"
            ? feed(item(100))
            : fullPage()
        ),
    }),
    /pagination did not advance/
  )
  await assert.rejects(
    fetchTeamtailorPage(source, 2, {
      fetch: async () => new Response(feed("")),
    }),
    /pagination did not advance/
  )
})

test("Teamtailor rejects malformed or ambiguous inventories instead of publishing emptiness", async () => {
  const badBodies = [
    "<html><body>Challenge</body></html>",
    feed("<error>Temporarily unavailable</error>"),
    feed(item(1)).slice(0, -10),
    '<!DOCTYPE rss [<!ENTITY x "foo">]>' +
      feed(item(1)).replace('<?xml version="1.0"?>', ""),
    feed(item(1)).replace(
      "https://teamtailor.com/locations",
      "https://example.com/locations"
    ),
    feed(item(1) + item(1)),
    feed(item(1)).replace("<guid>", "<guid>invalid"),
    feed(item(1)).replace(
      "<title>Software Engineer</title>",
      "<title>Software Engineer</title><title>Accountant</title>"
    ),
    feed(item(1)).replace(
      "<tt:city>Bengaluru</tt:city>",
      "<tt:city>Bengaluru</tt:city><tt:city>Pune</tt:city>"
    ),
    feed(item(1)).replace(
      "https://acme.teamtailor.com/jobs</link>",
      "https://other.teamtailor.com/jobs</link>"
    ),
    feed(Array.from({ length: 101 }, (_, index) => item(index + 1)).join("")),
  ]
  for (const body of badBodies)
    await assert.rejects(
      fetchTeamtailorPage(source, 1, { fetch: async () => new Response(body) })
    )
  await assert.rejects(
    fetchTeamtailorPage(source, 1, {
      fetch: async () => new Response(feed(item(1), "Other company")),
    }),
    /employer changed/
  )
})

test("Teamtailor refuses off-board, credentialed, and malformed job URLs", async () => {
  for (const url of [
    "https://evil.example/jobs/1-software-engineer",
    "https://other.teamtailor.com/jobs/1-software-engineer",
    "https://user:secret@acme.teamtailor.com/jobs/1-software-engineer",
    "http://acme.teamtailor.com/jobs/1-software-engineer",
    "https://acme.teamtailor.com:1234/jobs/1-software-engineer",
    "https://acme.teamtailor.com/jobs/1-software-engineer?source=evil",
    "https://acme.teamtailor.com/jobs/1-software-engineer#apply",
    "https://acme.teamtailor.com/jobs/1/../../admin",
  ])
    await assert.rejects(
      fetchTeamtailorPage(source, 1, {
        fetch: async () => new Response(feed(item(1, { url }))),
      }),
      /posting identity/,
      url
    )
})

test("Teamtailor refuses invalid sources and pages without fetching", async () => {
  const fetch = () => assert.fail("must not fetch")
  for (const page of [0, -1, 1.5, 52, Number.NaN])
    await assert.rejects(
      fetchTeamtailorPage(source, page, { fetch }),
      /Invalid Teamtailor/
    )
  await assert.rejects(
    fetchTeamtailorPage(
      { ...source, id: "teamtailor:other.teamtailor.com" },
      1,
      { fetch }
    )
  )
  await assert.rejects(
    fetchTeamtailorPage(
      { ...source, board: "acme.teamtailor.com.evil.test" },
      1,
      { fetch }
    )
  )
})

test("Teamtailor preserves unknown remote status and empty inventories", async () => {
  const result = await fetchTeamtailorPage(source, 1, {
    fetch: async () => new Response(feed(item(1, { remote: "none" }))),
  })
  assert.equal(result.jobs[0].work_mode, "unknown")
  const empty = await fetchTeamtailorPage(source, 1, {
    fetch: async () => new Response(feed("")),
  })
  assert.equal(empty.fetched, 0)
  assert.equal(empty.nextPage, null)
})

test("Teamtailor catalog collection uses the caller's category selection", async () => {
  const fetch = async () =>
    new Response(feed(item(1, { title: "Product Manager" })))
  assert.equal((await fetchTeamtailorPage(source, 1, { fetch })).jobs.length, 0)
  const selected = await fetchTeamtailorPage(source, 1, {
    fetch,
    jobCategories: ["product"],
  })
  assert.deepEqual(
    selected.jobs.map((job) => job.title),
    ["Product Manager"]
  )
})

test("Teamtailor refuses incomplete selected inventories while preserving raw unknowns", async () => {
  for (const title of ["Software Engineer", "UI Engineer"]) {
    const fetch = async () =>
      new Response(feed(item(1, { title, content: "" })))
    await assert.rejects(
      fetchTeamtailorPage(source, 1, { fetch }),
      /description is incomplete/
    )
    const observations: RawSourcePosting[] = []
    const raw = await fetchTeamtailorPage(source, 1, {
      fetch,
      observePosting: (posting) => observations.push(posting),
    })
    assert.equal(observations[0].description, "")
    assert.deepEqual(raw.jobs, [])
  }
  const fetch = async () =>
    new Response(feed(item(1, { title: "Product Manager", locations: "" })))
  await assert.rejects(
    fetchTeamtailorPage(source, 1, { fetch, jobCategories: ["product"] }),
    /lacks country evidence/
  )
  const observations: RawSourcePosting[] = []
  const raw = await fetchTeamtailorPage(source, 1, {
    fetch,
    jobCategories: ["product"],
    observePosting: (posting) => observations.push(posting),
  })
  assert.deepEqual(observations[0].countries, [])
  assert.deepEqual(raw.jobs, [])
  const excluded = await fetchTeamtailorPage(source, 1, {
    fetch: async () =>
      new Response(
        feed(item(1, { title: "Accountant", content: "", locations: "" }))
      ),
  })
  assert.deepEqual(excluded.jobs, [])
  assert.equal(excluded.nextPage, null)
})
