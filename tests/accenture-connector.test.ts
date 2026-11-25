import assert from "node:assert/strict"
import { test } from "node:test"
import {
  accentureSource,
  fetchAccenturePage,
} from "@/lib/server/catalog/connectors/accenture"
import type { RawSourcePosting } from "@/lib/server/catalog/feeds"

const source = accentureSource("Software Engineering")
const origin = "https://www.accenture.com"
const endpoint = `${origin}/api/accenture/elastic/findjobs`
const published = new Date(Date.now() - 86_400_000).toISOString()
const description =
  "Build distributed software services and production APIs, maintain automated tests, and improve reliability with a team of software engineers."
function job(index = 0, fields: Record<string, unknown> = {}) {
  const requisitionId = `ATCI-5229392-S${index}`
  return {
    requisitionId,
    guid: `${requisitionId}_en`,
    title: "Custom Software Engineer",
    country: "India",
    areaOfInterest: ["software-engineering", "technology"],
    location: ["Hyderabad"],
    feedCity: "Hyderabad",
    updateDate: new Date(Date.parse(published) - index * 1000).toISOString(),
    jobDetailUrl: `${origin}/{0}/careers/jobdetails?id=${requisitionId}_en&title=Custom+Software+Engineer`,
    jobDescription: `<p>${description}</p>`,
    qualification: "<p>Experience building production Java services.</p>",
    ...fields,
  }
}
function transport(
  jobs = [job()],
  options: {
    robots?: string
    total?: number
    capped?: string
    mutate?: (data: ReturnType<typeof job>[], offset: number) => unknown
  } = {}
) {
  const calls: { url: string; form?: Record<string, FormDataEntryValue> }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === `${origin}/robots.txt`) {
      calls.push({ url })
      return new Response(options.robots ?? "User-agent: *\nAllow: /\n")
    }
    assert.equal(url, endpoint)
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.cache, "no-store")
    assert.ok(init?.body instanceof FormData)
    const form = Object.fromEntries(init.body.entries())
    calls.push({ url, form })
    const offset = Number(form.startIndex)
    const size = Number(form.maxResultSize)
    const data = jobs.slice(offset, offset + size)
    return Response.json({
      data: options.mutate?.(data, offset) ?? data,
      totalHits: {
        total: options.total ?? jobs.length,
        overMaxHits: options.capped ?? "False",
      },
    })
  }
  return { fetch, calls }
}

test("Accenture uses the official bounded India/family API and stable requisition URL", async () => {
  const read = transport()
  const observations: RawSourcePosting[] = []
  let requests = 0
  const page = await fetchAccenturePage(source, 1, {
    fetch: read.fetch,
    onRequest: () => requests++,
    observePosting: (posting) => observations.push(posting),
  })
  assert.equal(page.jobs.length, 1)
  assert.equal(page.jobs[0].posted_at, published)
  assert.equal(
    page.jobs[0].url,
    `${origin}/in-en/careers/jobdetails?id=ATCI-5229392-S0_en`
  )
  assert.equal(page.jobs[0].company, "Accenture")
  assert.equal(page.jobs[0].country, "India")
  assert.equal(page.jobs[0].city, "Hyderabad")
  assert.match(page.jobs[0].description, /production Java services/)
  assert.equal(page.requests, 2)
  assert.equal(requests, 2)
  assert.equal(page.nextPage, null)
  assert.equal(page.fetched, 1)
  assert.equal(page.rejected, 0)
  assert.equal(observations.length, 1)
  assert.equal(read.calls[1].form?.maxResultSize, "100")
  assert.equal(read.calls[1].form?.sortBy, "1")
  assert.equal(read.calls[1].form?.jobCountry, "India")
  assert.equal(read.calls[1].form?.jobLanguage, "en")
  assert.deepEqual(JSON.parse(String(read.calls[1].form?.jobFilters)), [
    {
      fieldName: "areaOfInterestTitle.keyword",
      items: ["Software Engineering"],
      multiSelect: false,
    },
  ])
})

test("Accenture preserves raw professions and projects selected profile categories", async () => {
  const read = transport([job(0, { title: "Account Executive" })])
  const observations: RawSourcePosting[] = []
  const software = await fetchAccenturePage(source, 1, {
    fetch: read.fetch,
    observePosting: (posting) => observations.push(posting),
  })
  assert.equal(software.jobs.length, 0)
  assert.equal(observations[0].title, "Account Executive")
  const sales = await fetchAccenturePage(source, 1, {
    fetch: read.fetch,
    jobCategories: ["sales"],
  })
  assert.equal(sales.jobs.length, 1)
  assert.equal(sales.jobs[0].title, "Account Executive")
})

test("Accenture preserves early-career source facts without widening the employer-site catalog policy", async () => {
  for (const title of [
    "Software Engineering Intern",
    "Graduate Software Engineer",
  ]) {
    const observations: RawSourcePosting[] = []
    const page = await fetchAccenturePage(source, 1, {
      fetch: transport([job(0, { title })]).fetch,
      observePosting: (posting) => observations.push(posting),
    })
    assert.equal(observations[0].title, title)
    assert.deepEqual(page.jobs, [])
    assert.equal(page.rejected, 1)
  }
})

test("Accenture follows full inventory pagination including old vacancies", async () => {
  const rows = Array.from({ length: 102 }, (_, index) => job(index))
  rows[101] = job(101, { updateDate: "2024-01-01T00:00:00Z" })
  const read = transport(rows)
  const first = await fetchAccenturePage(source, 1, { fetch: read.fetch })
  const second = await fetchAccenturePage(source, 2, { fetch: read.fetch })
  assert.equal(first.fetched, 100)
  assert.equal(first.nextPage, 2)
  assert.equal(second.fetched, 2)
  assert.equal(second.nextPage, null)
  assert.equal(second.requests, 3)
  assert.equal(second.jobs[1].posted_at, "2024-01-01T00:00:00.000Z")
  assert.equal(
    new Set([...first.jobs, ...second.jobs].map((row) => row.id)).size,
    102
  )
  assert.deepEqual(
    read.calls
      .filter((call) => call.form)
      .map((call) => [call.form?.startIndex, call.form?.maxResultSize]),
    [
      ["0", "100"],
      ["100", "100"],
      ["99", "1"],
    ]
  )
  await assert.rejects(
    fetchAccenturePage(source, 3, { fetch: read.fetch }),
    /incomplete inventory/
  )
})

test("Accenture keeps unknown and invalid or future dates unknown", async () => {
  for (const updateDate of [
    undefined,
    null,
    "not a date",
    new Date(Date.now() + 7 * 86_400_000).toISOString(),
  ]) {
    const read = transport([job(0, { updateDate })])
    const page = await fetchAccenturePage(source, 1, { fetch: read.fetch })
    assert.equal(page.jobs[0].posted_at, null)
  }
})

test("Accenture rejects capped, duplicate, incomplete and incorrectly sorted pages before observations", async () => {
  const reads = [
    transport([job()], { total: 10000, capped: "True" }),
    transport([job()], { total: 10001 }),
    transport([job(), job()]),
    transport([job()], { total: 2 }),
    transport([job(1), job(0)]),
  ]
  for (const read of reads) {
    const observations: RawSourcePosting[] = []
    await assert.rejects(
      fetchAccenturePage(source, 1, {
        fetch: read.fetch,
        observePosting: (row) => observations.push(row),
      })
    )
    assert.deepEqual(observations, [])
  }
})

test("Accenture verifies sorting and overlap across a resumed page boundary", async () => {
  for (const replacement of [job(99), job(100, { updateDate: published })]) {
    const rows = Array.from({ length: 101 }, (_, index) => job(index))
    rows[100] = replacement
    const read = transport(rows)
    await assert.rejects(
      fetchAccenturePage(source, 2, { fetch: read.fetch }),
      /boundary|sorted newest/
    )
  }
})

test("Accenture refuses country, query family, requisition and URL identity mismatches", async () => {
  for (const fields of [
    { country: "Argentina" },
    { areaOfInterest: ["cloud"] },
    { guid: "OTHER_en" },
    {
      jobDetailUrl:
        "https://evil.test/in-en/careers/jobdetails?id=ATCI-5229392-S0_en",
    },
    { jobDetailUrl: `${origin}/in-en/careers/jobdetails?id=OTHER_en` },
    {
      jobDetailUrl: `${origin.replace("https://", "https://user:pass@")}/in-en/careers/jobdetails?id=ATCI-5229392-S0_en`,
    },
  ]) {
    await assert.rejects(
      fetchAccenturePage(source, 1, {
        fetch: transport([job(0, fields)]).fetch,
      })
    )
  }
})

test("Accenture preserves provider location facts but rejects contradictory and unverified cities", async () => {
  for (const location of [
    [],
    ["Buenos Aires"],
    ["Hyderabad", "Buenos Aires"],
    ["New unverified city"],
  ]) {
    const observations: RawSourcePosting[] = []
    const page = await fetchAccenturePage(source, 1, {
      fetch: transport([job(0, { location, feedCity: null })]).fetch,
      observePosting: (row) => observations.push(row),
    })
    assert.equal(page.jobs.length, 0)
    assert.equal(page.rejected, 1)
    assert.deepEqual(observations[0].locations, location)
    assert.deepEqual(observations[0].countries, ["India"])
  }
})

test("Accenture respects robots exclusions before accessing search", async () => {
  const read = transport([job()], {
    robots: "User-agent: *\nDisallow: /api/\n",
  })
  await assert.rejects(
    fetchAccenturePage(source, 1, { fetch: read.fetch }),
    /robots/
  )
  assert.equal(read.calls.length, 1)
})

test("Accenture uses exact official whitespace-sensitive family labels", async () => {
  const read = transport([
    job(0, { areaOfInterest: ["sales-account-management"] }),
  ])
  await fetchAccenturePage(accentureSource("Sales & Account Management"), 1, {
    fetch: read.fetch,
  })
  assert.equal(
    read.calls[1].form?.jobFilters,
    JSON.stringify([
      {
        fieldName: "areaOfInterestTitle.keyword",
        items: ["Sales & Account Management "],
        multiSelect: false,
      },
    ])
  )
})

test("Accenture rejects unsupported source identities and pages before network access", async () => {
  const fetch: typeof globalThis.fetch = async () => {
    throw new Error("Network must not run")
  }
  for (const invalid of [
    { ...source, id: "accenture:india" },
    { ...source, company: "Different employer" },
    { ...source, board: "india" },
    { ...source, config: { family: "Technology" } },
    {
      ...source,
      config: { family: "Software Engineering", url: "https://evil.test" },
    },
  ])
    await assert.rejects(
      fetchAccenturePage(invalid, 1, { fetch }),
      /Accenture|Unrecognized/
    )
  for (const page of [0, -1, 1.5, NaN, 101])
    await assert.rejects(
      fetchAccenturePage(source, page, { fetch }),
      /Invalid Accenture/
    )
})

test("Accenture handles empty inventories without inventing jobs", async () => {
  const page = await fetchAccenturePage(source, 1, {
    fetch: transport([]).fetch,
  })
  assert.equal(page.fetched, 0)
  assert.equal(page.nextPage, null)
  assert.deepEqual(page.jobs, [])
})

test("Accenture fails selected truncated descriptions but retains unknown raw facts", async () => {
  const read = transport([
    job(0, { jobDescription: null, qualification: null }),
  ])
  await assert.rejects(
    fetchAccenturePage(source, 1, { fetch: read.fetch }),
    /description is incomplete/
  )
  const observations: RawSourcePosting[] = []
  const page = await fetchAccenturePage(source, 1, {
    fetch: read.fetch,
    observePosting: (row) => observations.push(row),
  })
  assert.equal(observations[0].description, "")
  assert.deepEqual(page.jobs, [])
})
