import assert from "node:assert/strict"
import { test } from "node:test"
import { connectors, fetchCatalogPage } from "@/lib/server/catalog/connectors"
import type {
  CatalogSource,
  RawSourcePosting,
} from "@/lib/server/catalog/feeds"
import {
  probeClient,
  validateCandidate,
} from "@/lib/server/catalog/discovery/validate"
import {
  boardFromUrl,
  boardIdentity,
  boardKinds,
} from "@/lib/server/catalog/source-identity"

test("every ATS board kind has a board-validated connector", () => {
  for (const kind of boardKinds) {
    assert.equal(connectors[kind].family, "ats")
    assert.equal(connectors[kind].board, true)
  }
})

test("unknown and retired connectors are rejected before any fetch", async () => {
  const fetch = () => assert.fail("must not fetch")
  const source = (kind: string) =>
    ({ id: `${kind}:x`, kind, company: "X", board: "x" }) as CatalogSource
  await assert.rejects(
    fetchCatalogPage(source("toString"), 1, { fetch }),
    /Unknown source connector/
  )
  await assert.rejects(
    fetchCatalogPage(source("alexandria"), 1, { fetch }),
    /retired/
  )
})

test("board connectors reject sources whose id does not match the board", async () => {
  const fetch = () => assert.fail("must not fetch")
  await assert.rejects(
    fetchCatalogPage(
      { id: "greenhouse:other", kind: "greenhouse", company: "X", board: "x" },
      1,
      { fetch }
    ),
    /Invalid employer board/
  )
})

const description =
  "Build and maintain distributed software systems, write TypeScript services and automated tests, and collaborate with engineers on reliable customer-facing applications."
const published = new Date(Date.now() - 86400000).toISOString()
const guid = "685d8736-d012-4881-b6b1-ae16b4745feb"

test("Keka and Zoho Recruit career URLs map to canonical sources", () => {
  assert.equal(
    boardFromUrl("https://kickdrum.keka.com/careers/jobdetails/13982")?.id,
    "keka:kickdrum"
  )
  assert.equal(
    boardFromUrl("https://acme.zohorecruit.in/jobs/Careers/1/Role")?.id,
    "zohorecruit:acme.zohorecruit.in"
  )
  for (const url of [
    "https://www.keka.com/careers",
    "https://kickdrum.keka.com/login",
    "https://acme.zohorecruit.in/recruit/Portal.na",
    "https://acme.zohorecruit.evil.com/jobs/Careers",
  ])
    assert.equal(boardFromUrl(url), null, url)
})

test("Keka reads the portal GUID, employer and active jobs per country", async () => {
  const seen: string[] = []
  const observations: RawSourcePosting[] = []
  const result = await fetchCatalogPage(
    { ...boardIdentity("keka", "acme"), company: "" },
    1,
    {
      observePosting: (posting) => observations.push(posting),
      fetch: async (input) => {
        const url = String(input)
        seen.push(url)
        if (url === "https://acme.keka.com/careers/")
          return new Response(
            `<script>fetch('/ats/documents/${guid}/careerportal/x.html')</script>`
          )
        if (url.endsWith("/careerportalinfo"))
          return Response.json({ name: "Acme Technologies" })
        return Response.json([
          {
            id: "7",
            title: "Senior Software Engineer",
            description: `<p>${description}</p>`,
            jobLocations: [
              { city: "Bengaluru", countryCode: "IN" },
              { city: "Pune", countryCode: "IN" },
              { city: "Pune", countryCode: "IN" },
              { city: "Austin", countryCode: "US" },
            ],
            publishedOn: published,
          },
          {
            id: "8",
            title: "Account Executive",
            description,
            jobLocations: [],
          },
        ])
      },
    }
  )
  assert.equal(
    seen[2],
    `https://acme.keka.com/careers/api/embedjobs/default/active/${guid}`
  )
  assert.deepEqual(
    result.jobs.map((j) => [j.country, j.city, j.company, j.url]),
    [
      [
        "India",
        "Bengaluru; Pune",
        "Acme Technologies",
        "https://acme.keka.com/careers/jobdetails/7",
      ],
      [
        "United States",
        "Austin",
        "Acme Technologies",
        "https://acme.keka.com/careers/jobdetails/7",
      ],
    ]
  )
  assert.equal(result.fetched, 2)
  assert.equal(result.rejected, 1)
  assert.equal(observations.length, 2)
  assert.deepEqual(observations[0].countries, ["India", "United States"])
  assert.ok(observations[0].locations.includes("Pune, IN"))
  assert.equal(observations[1].title, "Account Executive")
  assert.deepEqual(observations[1].countries, [])
})

test("Keka fails loudly when the portal identifier is missing", async () => {
  await assert.rejects(
    fetchCatalogPage({ ...boardIdentity("keka", "acme"), company: "" }, 1, {
      fetch: async () => new Response("<html></html>"),
    }),
    /identifier not found/
  )
})

test("Zoho Recruit reads the embedded jobs inventory", async () => {
  const jobs = [
    {
      id: "45488000020874044",
      Posting_Title: "Backend Engineer (Java)",
      Job_Description: description,
      City: "Noida",
      Country: "India",
      Remote_Job: true,
      Publish: true,
      Date_Opened: published.slice(0, 10),
    },
    {
      id: "2",
      Posting_Title: "Sales Manager",
      Job_Description: description,
      Country: "India",
      Publish: true,
    },
    {
      id: "3",
      Posting_Title: "Platform Engineer",
      Job_Description: description,
      Country: "India",
      Publish: false,
    },
  ]
  const html = `<meta property="og:site_name" content="Acme Ltd."><input type="hidden" value="${JSON.stringify(jobs).replace(/"/g, "&#34;")}" id="jobs">`
  const result = await fetchCatalogPage(
    { ...boardIdentity("zohorecruit", "acme.zohorecruit.in"), company: "" },
    1,
    {
      fetch: async (input) => {
        assert.equal(String(input), "https://acme.zohorecruit.in/jobs/Careers")
        return new Response(html)
      },
    }
  )
  assert.deepEqual(
    result.jobs.map((j) => [j.title, j.company, j.city, j.work_mode, j.url]),
    [
      [
        "Backend Engineer (Java)",
        "Acme Ltd.",
        "Noida",
        "remote",
        "https://acme.zohorecruit.in/jobs/Careers/45488000020874044/Backend-Engineer-Java",
      ],
    ]
  )
  assert.equal(result.fetched, 3)
})

const validationFixtures = [
  {
    identity: boardIdentity("keka", "acme"),
    origin: "https://acme.keka.com",
    path: "/careers/",
    responses: new Map<string, string | object>([
      [
        "/careers/",
        `<script>fetch('/ats/documents/${guid}/careerportal/x.html')</script>`,
      ],
      ["/careers/api/organization/default/careerportalinfo", { name: "Acme" }],
      [
        `/careers/api/embedjobs/default/active/${guid}`,
        [
          {
            id: "7",
            title: "Software Engineer",
            description,
            jobLocations: [{ city: "Pune", countryCode: "IN" }],
            publishedOn: published,
          },
        ],
      ],
    ]),
  },
  {
    identity: boardIdentity("zohorecruit", "acme.zohorecruit.in"),
    origin: "https://acme.zohorecruit.in",
    path: "/jobs/Careers",
    responses: new Map<string, string | object>([
      [
        "/jobs/Careers",
        `<meta property="og:site_name" content="Acme"><input id="jobs" value="${JSON.stringify(
          [
            {
              id: "7",
              Posting_Title: "Software Engineer",
              Job_Description: description,
              City: "Pune",
              Country: "India",
              Publish: true,
              Date_Opened: published,
            },
          ]
        ).replace(/"/g, "&#34;")}">`,
      ],
    ]),
  },
]

test("Keka and Zoho validation use trusted probes, robots and live employer evidence", async () => {
  for (const fixture of validationFixtures) {
    const seen: string[] = []
    const result = await validateCandidate(
      {
        ...fixture.identity,
        expected_company: "Acme",
        historical_checked_at: null,
        evidence_url: fixture.origin + fixture.path,
      },
      probeClient(async (input, init) => {
        const url = new URL(String(input))
        seen.push(url.pathname)
        assert.equal(url.origin, fixture.origin)
        assert.equal(init?.redirect, "error")
        assert.equal(init?.cache, "no-store")
        if (url.pathname === "/robots.txt")
          return new Response("User-agent: *\nAllow: /")
        const response = fixture.responses.get(url.pathname)
        assert.notEqual(response, undefined, url.href)
        return typeof response === "string"
          ? new Response(response)
          : Response.json(response)
      })
    )
    assert.equal(result.status, "verified", result.reason)
    assert.equal(result.company, "Acme")
    assert.deepEqual(result.countries, ["India"])
    assert.equal(result.fresh_count, 1)
    assert.equal(result.complete, true)
    assert.deepEqual(seen, ["/robots.txt", ...fixture.responses.keys()])
  }
})

test("Keka and Zoho probes preserve robots exclusions and provider failures", async () => {
  for (const fixture of validationFixtures) {
    const candidate = {
      ...fixture.identity,
      expected_company: null,
      historical_checked_at: null,
      evidence_url: fixture.origin + fixture.path,
    }
    let calls = 0
    const blocked = await validateCandidate(
      candidate,
      probeClient(async (input) => {
        calls++
        assert.equal(String(input), `${fixture.origin}/robots.txt`)
        return new Response("User-agent: *\nDisallow: /")
      })
    )
    assert.equal(blocked.status, "needs_review")
    assert.match(blocked.reason, /robots/)
    assert.equal(calls, 1)
    for (const [status, expected] of [
      [403, "needs_review"],
      [429, "deferred"],
    ] as const) {
      const failed = await validateCandidate(
        candidate,
        probeClient(async (input) =>
          String(input).endsWith("/robots.txt")
            ? new Response("", { status: 404 })
            : new Response(null, { status, headers: { "retry-after": "3600" } })
        )
      )
      assert.equal(failed.status, expected)
      assert.equal(failed.accepted_count, 0)
    }
  }
})

test("provider trust rejects lookalike and reserved Keka and Zoho hosts", async () => {
  const read = probeClient(async () =>
    assert.fail("untrusted hosts must not fetch")
  )
  for (const host of [
    "acme.keka.com.evil.test",
    "keka.com",
    "www.keka.com",
    "api.keka.com",
    "acme.zohorecruit.in.evil.test",
    "acme.zohorecruit.test",
    "api.zohorecruit.com",
    "api.eu.lever.co.evil.test",
    "boards-api.eu.greenhouse.io.evil.test",
  ])
    await assert.rejects(
      read(`https://${host}/careers`, "html"),
      /Untrusted provider endpoint/
    )
})

test("European Greenhouse and Lever endpoints pass the same bounded probe", async () => {
  for (const url of [
    "https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs",
    "https://job-boards.eu.greenhouse.io/acme",
    "https://boards.eu.greenhouse.io/acme",
    "https://api.eu.lever.co/v0/postings/acme",
    "https://jobs.eu.lever.co/acme",
  ]) {
    const seen: string[] = []
    const read = probeClient(async (input) => {
      seen.push(String(input))
      return String(input).endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /")
        : new Response("public provider body")
    })
    assert.equal(await read(url, "html"), "public provider body")
    assert.deepEqual(seen, [new URL("/robots.txt", url).href, url])
  }
})
