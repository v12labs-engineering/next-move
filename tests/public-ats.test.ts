import assert from "node:assert/strict"
import test from "node:test"
import { fetchPublicAtsPage } from "@/lib/server/catalog/connectors/public-ats"
import { fetchCatalogPage } from "@/lib/server/catalog/feeds"
import {
  boardFromUrl,
  boardIdentity,
  boardKinds,
} from "@/lib/server/catalog/source-identity"
import {
  probeClient,
  validateCandidate,
} from "@/lib/server/catalog/discovery/validate"
import { CandidateStore } from "@/lib/server/catalog/discovery/store"

const description =
  "Build and maintain distributed software systems, write TypeScript services and automated tests, and collaborate with engineers on reliable customer-facing applications."
const published = new Date(Date.now() - 86400000).toISOString()
function offer(fields = {}) {
  return {
    id: 123,
    slug: "software-engineer",
    title: "Software Engineer",
    status: "published",
    company_name: "Example",
    careers_url: "https://example.recruitee.com/o/software-engineer",
    description: `<p>${description}</p>`,
    requirements: null,
    country_code: "GB",
    city: "London",
    published_at: published,
    remote: true,
    hybrid: true,
    ...fields,
  }
}
function workable(fields = {}) {
  return {
    shortcode: "ABCDEF1234",
    title: "Software Engineer",
    url: "https://apply.workable.com/j/ABCDEF1234",
    description,
    country: "United Kingdom",
    city: "London",
    telecommuting: true,
    published_on: published.slice(0, 10),
    ...fields,
  }
}
const source = (kind: "recruitee" | "workable") => ({
  ...boardIdentity(kind, "example"),
  company: "Example",
})
function response(data: unknown) {
  if (data && typeof data === "object" && "offers" in data) {
    const escape = (text: unknown) =>
      String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
    const xml = (obj: Record<string, unknown>): string =>
      Object.entries(obj)
        .map(([key, value]) =>
          Array.isArray(value)
            ? `<${key}>${value.map((row) => `<location>${xml(row)}</location>`).join("")}</${key}>`
            : `<${key}>${escape(value)}</${key}>`
        )
        .join("")
    return new Response(
      `<offers>${(data.offers as Record<string, unknown>[]).map((row) => `<offer>${xml(row)}</offer>`).join("")}</offers>`
    )
  }
  return Response.json(data)
}
const transport =
  (data: unknown): typeof fetch =>
  async () =>
    response(data)

test("public ATS discovery accepts observed employer links and rejects unscoped or lookalike URLs", () => {
  for (const [url, id] of [
    ["https://example.recruitee.com/o/software-engineer", "recruitee:example"],
    ["https://apply.workable.com/example/j/ABCDEF1234/", "workable:example"],
    ["https://apply.workable.com/example", "workable:example"],
  ])
    assert.equal(boardFromUrl(url)?.id, id)
  for (const url of [
    "https://apply.workable.com/j/ABCDEF1234",
    "https://apply.workable.com/api/accounts/example",
    "https://example.recruitee.com.evil.example/o/job",
    "https://docs.recruitee.com/",
    "https://user:pass@example.recruitee.com/",
    "http://example.recruitee.com/",
  ])
    assert.equal(boardFromUrl(url), null)
  assert.throws(() => boardIdentity("recruitee", "example.example"))
})

test("Recruitee complete feeds keep explicit dates, employer identity and countries, excluding closed and unpublished jobs", async () => {
  const data = {
    offers: [
      offer({
        published_at: "2026-11-03 14:32:09 UTC",
        locations: [
          { country_code: "GB", city: "London" },
          { country_code: "GB", city: "Bristol" },
          { country_code: "DE", city: "Berlin" },
        ],
      }),
      offer({ id: 124, status: "draft" }),
      offer({ id: 125, close_at: "2000-01-01 00:00:00 UTC" }),
    ],
  }
  const result = await fetchPublicAtsPage(source("recruitee"), 1, {
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        "https://example.recruitee.com/api/feeds/offers.xml"
      )
      assert.equal(init?.redirect, "error")
      return response(data)
    },
  })
  assert.equal(result.fetched, 3)
  assert.equal(result.nextPage, null)
  assert.equal(result.jobs.length, 2)
  assert.equal(result.rejected, 2)
  assert.deepEqual(
    result.jobs.map((job) => job.country),
    ["United Kingdom", "Germany"]
  )
  assert.equal(result.jobs[0].posted_at, "2026-11-03T14:32:09.000Z")
  assert.equal(result.jobs[0].work_mode, "hybrid")
  assert.equal(result.jobs[0].company, "Example")
  assert.ok(!result.jobs[0].description.includes("<p>"))
})

test("Workable collection uses the public widget feed, counts all rows and never substitutes creation date", async () => {
  const result = await fetchCatalogPage(source("workable"), 1, {
    fetch: async (url) => {
      assert.equal(
        String(url),
        "https://apply.workable.com/api/v1/widget/accounts/example?details=true"
      )
      return Response.json({
        name: "Example",
        jobs: [
          workable({
            published_on: null,
            created_at: published,
            state: "California",
            locations: [{ countryCode: "US", city: "Los Angeles" }],
          }),
          workable({
            shortcode: "BBBBBB1234",
            url: "https://apply.workable.com/example/j/BBBBBB1234/",
            title: "Accountant",
            description: "Manage accounting, tax and finance.",
          }),
        ],
      })
    },
  })
  assert.equal(result.fetched, 2)
  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].posted_at, null)
  assert.equal(result.jobs[0].country, "United States")
  assert.equal(result.jobs[0].work_mode, "remote")
})

test("invalid or incomplete public inventories fail before publication", async () => {
  for (const data of [
    {
      offers: [
        offer({
          careers_url: "https://other.recruitee.com/o/software-engineer",
        }),
      ],
    },
    { offers: [offer({ country_code: null, country: "Remote" })] },
    { offers: [offer({ description: "Short" })] },
    { offers: [offer(), offer()] },
    { offers: [offer({ company_name: "Different company" })] },
    { offers: Array.from({ length: 5001 }, () => offer()) },
  ])
    await assert.rejects(
      fetchPublicAtsPage(source("recruitee"), 1, { fetch: transport(data) })
    )
  for (const url of [
    "https://evil.example/j/ABCDEF1234",
    "https://apply.workable.com/other/j/ABCDEF1234",
    "https://apply.workable.com/j/BBBBBB1234",
  ])
    await assert.rejects(
      fetchPublicAtsPage(source("workable"), 1, {
        fetch: transport({ name: "Example", jobs: [workable({ url })] }),
      })
    )
  await assert.rejects(
    fetchPublicAtsPage(source("workable"), 2, {
      fetch: async () => {
        assert.fail("must not request a non-existent page")
      },
    })
  )
})

test("public API validation needs live identity and recent dated software evidence and preserves provider failures", async () => {
  for (const kind of ["recruitee", "workable"] as const) {
    const candidate = {
      ...source(kind),
      expected_company: null,
      historical_checked_at: null,
      evidence_url: "https://example.recruitee.com",
    }
    let calls = 0
    const read = probeClient(async (input) => {
      calls++
      assert.ok(!String(input).includes("robots.txt"))
      return response(
        kind === "recruitee"
          ? { offers: [offer()] }
          : { name: "Example", jobs: [workable()] }
      )
    })
    const result = await validateCandidate(candidate, read)
    assert.equal(result.status, "verified")
    assert.equal(result.fresh_count, 1)
    assert.equal(result.complete, true)
    assert.equal(calls, 1)
    for (const [status, expected] of [
      [404, "missing"],
      [403, "needs_review"],
      [429, "deferred"],
    ] as const) {
      const failed = await validateCandidate(
        candidate,
        probeClient(
          async () =>
            new Response(null, { status, headers: { "retry-after": "3600" } })
        )
      )
      assert.equal(failed.status, expected)
      assert.equal(failed.accepted_count, 0)
    }
  }
})

test("bounded candidate batches rotate their first provider across scheduled cycles", async () => {
  const store = new CandidateStore({} as never)
  store.list = async ({ kind }) => [
    {
      ...boardIdentity(
        kind as (typeof boardKinds)[number],
        kind === "workday"
          ? "example.wd1.myworkdayjobs.com~External"
          : kind === "zohorecruit"
            ? "example.zohorecruit.in"
            : kind === "personio"
              ? "example.jobs.personio.com"
              : kind === "teamtailor"
                ? "example.teamtailor.com"
                : "example"
      ),
      expected_company: null,
      historical_checked_at: null,
      evidence_url: "https://example.recruitee.com",
      status: "imported",
      validation: null,
      validated_at: null,
    },
  ]
  const first = []
  for (let cycle = 0; cycle < boardKinds.length; cycle++)
    first.push((await store.fairBatch(1, cycle * 6 * 3600000))[0].kind)
  assert.deepEqual(first, [...boardKinds])
})

test("Recruitee XML rejects truncation and DTDs, and preserves employer-declared custom career links", async () => {
  for (const body of [
    "<offers><offer></offers>",
    "<offers>",
    '<!DOCTYPE offers [<!ENTITY test "x">]><offers/>',
    "<offers/><offers/>",
  ])
    await assert.rejects(
      fetchPublicAtsPage(source("recruitee"), 1, {
        fetch: async () => new Response(body),
      })
    )
  const custom = await fetchPublicAtsPage(source("recruitee"), 1, {
    fetch: transport({
      offers: [
        offer({
          careers_url: "https://careers.example.com/o/software-engineer",
        }),
      ],
    }),
  })
  assert.equal(
    custom.jobs[0].url,
    "https://careers.example.com/o/software-engineer"
  )
})

test("Workable repeats merge location variants, while conflicting posting content fails", async () => {
  const rows = [
    workable(),
    workable({ country: "Germany", city: "Berlin" }),
    workable(),
  ]
  const result = await fetchPublicAtsPage(source("workable"), 1, {
    fetch: transport({ name: "Example", jobs: rows }),
  })
  assert.equal(result.jobs.length, 2)
  assert.equal(result.rejected, 0)
  assert.deepEqual(
    result.jobs.map((job) => job.country),
    ["United Kingdom", "Germany"]
  )
  rows[1].title = "Software Engineering Manager"
  await assert.rejects(
    fetchPublicAtsPage(source("workable"), 1, {
      fetch: transport({ name: "Example", jobs: rows }),
    }),
    /Conflicting/
  )
})
