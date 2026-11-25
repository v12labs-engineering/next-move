import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  type CatalogSource,
} from "@/lib/server/catalog/feeds"
import {
  boardFromUrl,
  boardIdentity,
  validSourceId,
} from "@/lib/server/catalog/source-identity"
import {
  discoverEmployerLinks,
  linkDiscoveryOrigin,
} from "@/lib/server/catalog/discovery/links"
import {
  probeClient,
  validateCandidate,
} from "@/lib/server/catalog/discovery/validate"
import { discoverProfileSource } from "@/lib/server/catalog/discovery-search"

const description =
  "<p>Build and operate production software. Work with engineering teams and maintain reliable services.</p>".repeat(
    3
  )
const smart: CatalogSource = {
  ...boardIdentity("smartrecruiters", "Example"),
  company: "Example",
}
const workday: CatalogSource = {
  ...boardIdentity("workday", "example.wd5.myworkdayjobs.com~ExternalCareers"),
  company: "Example",
}
function smartJob(id = "123") {
  return {
    id,
    name: "Software Engineer",
    company: { identifier: "Example", name: "Example" },
    active: true,
    visibility: "PUBLIC",
    releasedDate: "2026-10-01T12:00:00Z",
    location: { country: "in", city: "Hyderabad", remote: true },
    jobAd: { sections: { jobDescription: { text: description } } },
  }
}
function workdayJob() {
  return {
    hiringOrganization: { name: "Example" },
    jobPostingInfo: {
      title: "Software Engineer",
      jobPostingSiteId: "ExternalCareers",
      externalUrl:
        "https://example.wd5.myworkdayjobs.com/ExternalCareers/job/India-Hyderabad/Software-Engineer_R123",
      jobDescription: description,
      startDate: "2026-10-01",
      posted: true,
      canApply: true,
      location: "India, Hyderabad",
      additionalLocations: [
        "India, Bengaluru",
        "Toronto, Canada",
        "Location not stated",
      ],
      country: { descriptor: "India" },
    },
  }
}

test("mixed SmartRecruiters boards skip non-software roles without failing the complete inventory", async () => {
  const jobs = ["CTO", "Junior Software Engineer", "Accountant"].map(
    (name, index) => ({
      ...smartJob(String(index + 1)),
      name,
    })
  )
  const result = await fetchCatalogPage(smart, 1, {
    fetch: async (input) => {
      const url = String(input)
      return Response.json(
        url.includes("?")
          ? { offset: 0, totalFound: jobs.length, content: jobs }
          : jobs.find((job) => url.endsWith(`/${job.id}`))
      )
    },
  })
  assert.deepEqual(
    result.jobs.map((job) => job.title),
    ["CTO", "Junior Software Engineer"]
  )
  assert.equal(result.fetched, 3)
  assert.equal(result.nextPage, null)
})

test("India SmartRecruiters snapshots keep their release window across pages and skip irrelevant details", async () => {
  const source = { ...smart, config: { country: "IN" } }
  const software = smartJob("123")
  const accountant = { ...smartJob("124"), name: "Accountant" }
  const intern = { ...smartJob("125"), name: "Software Engineer Intern" }
  const requests: URL[] = []
  const result = await fetchCatalogPage(source, 2, {
    snapshotStartedAt: "2026-11-16T12:00:00Z",
    fetch: async (input) => {
      const url = new URL(String(input))
      requests.push(url)
      return Response.json(
        url.search
          ? {
              offset: 20,
              totalFound: 23,
              content: [software, accountant, intern],
            }
          : software
      )
    },
  })
  assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
    limit: "20",
    offset: "20",
    country: "in",
    destination: "PUBLIC",
    releasedAfter: "2026-10-17T12:00:00.000Z",
  })
  assert.equal(requests.length, 2)
  assert.equal(requests[1].pathname, "/v1/companies/example/postings/123")
  assert.deepEqual(
    result.jobs.map((job) => job.country),
    ["India"]
  )
  assert.equal(result.nextPage, null)
})
const workdayPath = "/job/India-Hyderabad/Software-Engineer_R123"

test("SmartRecruiters video sections do not block textual job descriptions or complete pages", async () => {
  const job = smartJob()
  const result = await fetchCatalogPage(smart, 1, {
    fetch: async (input) =>
      Response.json(
        String(input).includes("?")
          ? { offset: 0, totalFound: 1, content: [job] }
          : {
              ...job,
              jobAd: {
                sections: {
                  ...job.jobAd.sections,
                  videos: {
                    title: "Videos To Watch",
                    urls: ["https://www.youtube.com/watch?v=example"],
                  },
                },
              },
            }
      ),
  })
  assert.equal(result.fetched, 1)
  assert.equal(result.nextPage, null)
  assert.equal(result.jobs.length, 1)
  assert.match(
    result.jobs[0].description,
    /Build and operate production software/
  )
  assert.doesNotMatch(
    result.jobs[0].description,
    /undefined|youtube|Videos To Watch/
  )

  await assert.rejects(
    fetchCatalogPage(smart, 1, {
      fetch: async (input) =>
        Response.json(
          String(input).includes("?")
            ? { offset: 0, totalFound: 1, content: [job] }
            : {
                ...job,
                jobAd: {
                  sections: { jobDescription: { title: "Description" } },
                },
              }
        ),
    }),
    /text/
  )
})

test("Workday accepts job paths without a location segment and preserves site identity", async () => {
  const externalPath = "/job/Software-Engineer_R123"
  const calls: string[] = []
  const result = await fetchCatalogPage(workday, 1, {
    fetch: async (input) => {
      calls.push(String(input))
      if (String(input).endsWith("/jobs"))
        return Response.json({
          total: 1,
          jobPostings: [{ title: "Software Engineer", externalPath }],
        })
      const detail = workdayJob()
      detail.jobPostingInfo.externalUrl = `https://example.wd5.myworkdayjobs.com/ExternalCareers${externalPath}`
      return Response.json(detail)
    },
  })
  assert.equal(result.fetched, 1)
  assert.equal(result.nextPage, null)
  assert.equal(result.jobs.length, 3)
  assert.ok(result.jobs.every((job) => job.url.endsWith(externalPath)))
  assert.equal(
    calls[1],
    `https://example.wd5.myworkdayjobs.com/wday/cxs/example/ExternalCareers${externalPath}`
  )
})

test("Workday inventory counts excluded titles without hydrating their malformed irrelevant details", async () => {
  const excludedPath = "/job/India-Hyderabad/Account-Executive_R124"
  const details: string[] = []
  const result = await fetchCatalogPage(workday, 1, {
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith("/jobs"))
        return Response.json({
          total: 2,
          jobPostings: [
            { title: "Account Executive", externalPath: excludedPath },
            { title: "Software Engineer", externalPath: workdayPath },
          ],
        })
      details.push(url)
      const job = workdayJob()
      return Response.json(
        url.endsWith(excludedPath)
          ? {
              ...job,
              hiringOrganization: { name: "" },
              jobPostingInfo: {
                ...job.jobPostingInfo,
                title: "Account Executive",
              },
            }
          : job
      )
    },
  })
  assert.equal(result.fetched, 2)
  assert.equal(result.rejected, 1)
  assert.equal(result.nextPage, null)
  assert.equal(new Set(result.jobs.map((j) => j.url)).size, 1)
  assert.deepEqual(details, [
    `https://example.wd5.myworkdayjobs.com/wday/cxs/example/ExternalCareers${workdayPath}`,
  ])
})

test("Workday software and ambiguous titles still hydrate details and enforce employer metadata", async () => {
  for (const title of ["Software Engineer", "Engineering Manager"]) {
    let calls = 0
    await assert.rejects(
      fetchCatalogPage(workday, 1, {
        fetch: async (input) => {
          calls++
          if (String(input).endsWith("/jobs"))
            return Response.json({
              total: 1,
              jobPostings: [{ title, externalPath: workdayPath }],
            })
          return Response.json({
            ...workdayJob(),
            hiringOrganization: { name: "" },
          })
        },
      }),
      /hiringOrganization/
    )
    assert.equal(calls, 2)
  }
})

test("observed ATS links canonicalize company/tenant identities without accepting lookalikes or losing Workday site case", () => {
  assert.equal(
    boardFromUrl("https://jobs.smartrecruiters.com/Example/123-role")?.id,
    smart.id
  )
  assert.equal(
    boardFromUrl(
      "https://example.wd5.myworkdayjobs.com/en-US/ExternalCareers/job/a/b"
    )?.id,
    workday.id
  )
  for (const value of [
    "https://example.wd5.myworkdayjobs.com.evil.test/ExternalCareers",
    "https://jobs.smartrecruiters.com.evil.test/Example",
    "https://user:pass@jobs.smartrecruiters.com/Example",
    "http://jobs.smartrecruiters.com/Example",
    "https://example.wd5.myworkdayjobs.com:444/ExternalCareers",
  ])
    assert.equal(boardFromUrl(value), null)
  assert.equal(validSourceId(workday.id), true)
  assert.equal(validSourceId("workday:127.0.0.1~External"), false)
})

test("SmartRecruiters hydrates descriptions from reconstructed detail URLs and checkpoints real pagination", async () => {
  const seen: string[] = []
  const result = await fetchCatalogPage(smart, 2, {
    fetch: async (input, init) => {
      const url = String(input)
      seen.push(url)
      assert.equal(init?.redirect, "error")
      if (url.includes("?"))
        return Response.json({
          offset: 5,
          totalFound: 6,
          content: [{ ...smartJob(), ref: "https://127.0.0.1/private" }],
        })
      return Response.json(smartJob())
    },
  })
  assert.equal(result.nextPage, null)
  assert.equal(result.requests, 2)
  assert.deepEqual(seen, [
    "https://api.smartrecruiters.com/v1/companies/example/postings?limit=5&offset=5",
    "https://api.smartrecruiters.com/v1/companies/example/postings/123",
  ])
  assert.equal(result.jobs[0].country, "India")
  assert.equal(result.jobs[0].city, "Hyderabad")
  assert.equal(result.jobs[0].work_mode, "remote")
  assert.equal(result.jobs[0].posted_at, "2026-10-01T12:00:00.000Z")
  assert.ok(result.jobs[0].description.includes("production software"))
  assert.equal(result.jobs[0].source, smart.id)
})

test("ATS identity drift, partial inventory pages, non-public postings and failed detail hydration cannot masquerade as successful full collection", async () => {
  await assert.rejects(
    fetchCatalogPage(smart, 1, {
      fetch: async () =>
        Response.json({ offset: 0, totalFound: 5, content: [] }),
    }),
    /incomplete/
  )
  await assert.rejects(
    fetchCatalogPage(smart, 1, {
      fetch: async () =>
        Response.json({
          offset: 0,
          totalFound: 1,
          content: [
            { ...smartJob(), company: { identifier: "other", name: "Other" } },
          ],
        }),
    }),
    /identity/
  )
  await assert.rejects(
    fetchCatalogPage(smart, 1, {
      fetch: async (url) =>
        String(url).includes("?")
          ? Response.json({ offset: 0, totalFound: 1, content: [smartJob()] })
          : new Response(null, {
              status: 503,
              headers: { "retry-after": "120" },
            }),
    }),
    /503/
  )
  const hidden = await fetchCatalogPage(smart, 1, {
    fetch: async (url) =>
      Response.json(
        String(url).includes("?")
          ? { offset: 0, totalFound: 1, content: [smartJob()] }
          : { ...smartJob(), visibility: "INTERNAL" }
      ),
  })
  assert.deepEqual(hidden.jobs, [])
  assert.equal(hidden.rejected, 1)
})

test("Workday POST and detail reads preserve locations, dates and site identity without using relative posting ages", async () => {
  const seen: string[] = []
  const result = await fetchCatalogPage(workday, 1, {
    fetch: async (input, init) => {
      const url = String(input)
      seen.push(url)
      assert.equal(init?.redirect, "error")
      if (url.endsWith("/jobs")) {
        assert.equal(init?.method, "POST")
        assert.deepEqual(JSON.parse(String(init?.body)), {
          appliedFacets: {},
          limit: 5,
          offset: 0,
          searchText: "",
        })
        return Response.json({
          total: 1,
          jobPostings: [
            { title: "Software Engineer", externalPath: workdayPath },
          ],
        })
      }
      return Response.json(workdayJob())
    },
  })
  assert.deepEqual(seen, [
    "https://example.wd5.myworkdayjobs.com/wday/cxs/example/ExternalCareers/jobs",
    `https://example.wd5.myworkdayjobs.com/wday/cxs/example/ExternalCareers${workdayPath}`,
  ])
  assert.equal(result.nextPage, null)
  assert.deepEqual(
    result.jobs.map((job) => [job.country, job.city]),
    [
      ["India", "Hyderabad"],
      ["India", "Bengaluru"],
      ["Canada", "Toronto"],
    ]
  )
  assert.equal(new Set(result.jobs.map((job) => job.id)).size, 3)
  assert.equal(result.jobs[0].posted_at, "2026-10-01T00:00:00.000Z")
  assert.ok(result.jobs.every((job) => job.work_mode === "unknown"))
})

test("Workday result caps and unsafe detail paths fail before any detail fetch or publishable snapshot", async () => {
  for (const [total, externalPath, pattern] of [
    [2000, workdayPath, /cap/],
    [1, "/job/x/%2e%2e", /path/],
    [1, "/job/%2e%2e", /path/],
    [1, "/job/..", /path/],
    [1, "/job/%2fprivate", /path/],
    [1, "/job/%5cprivate", /path/],
    [1, "/job/", /path/],
    [1, "/job/Software_R123?redirect=evil", /path/],
    [1, "/job/Software_R123#fragment", /path/],
    [1, "https://private.test/job", /path/],
  ] as const) {
    let calls = 0
    await assert.rejects(
      fetchCatalogPage(workday, 1, {
        fetch: async () => {
          calls++
          return Response.json({
            total,
            jobPostings: [{ title: "Software Engineer", externalPath }],
          })
        },
      }),
      pattern
    )
    assert.equal(calls, 1)
  }
  const candidate = {
    ...boardIdentity("workday", workday.board!),
    expected_company: null,
    historical_checked_at: null,
    evidence_url: "https://example.com/careers",
  }
  const capped = await validateCandidate(candidate, async () => ({
    total: 2000,
    jobPostings: [],
  }))
  assert.equal(capped.status, "needs_review")
  assert.match(capped.reason, /result cap/)
  assert.equal(capped.complete, false)
})

test("Workday continuation pages with an omitted total use a fresh first-page count before completing", async () => {
  const offsets: number[] = []
  const result = await fetchCatalogPage(workday, 2, {
    fetch: async (input, init) => {
      if (String(input).endsWith("/jobs")) {
        const offset = JSON.parse(String(init?.body)).offset
        offsets.push(offset)
        return Response.json(
          offset === 5
            ? {
                total: 0,
                jobPostings: [
                  { title: "Software Engineer", externalPath: workdayPath },
                ],
              }
            : {
                total: 6,
                jobPostings: Array.from({ length: 5 }, (_, n) => ({
                  title: "Software Engineer",
                  externalPath: `/job/India-Hyderabad/Software-Engineer_R${n}`,
                })),
              }
        )
      }
      return Response.json(workdayJob())
    },
  })
  assert.deepEqual(offsets, [5, 0])
  assert.equal(result.nextPage, null)
  assert.equal(result.fetched, 1)
  assert.equal(result.requests, 3)
  assert.ok(result.jobs.length > 0)
})

test("a continuation's fresh count cannot hide capped or contradictory Workday inventories", async () => {
  for (const total of [0, 2000]) {
    let details = 0
    await assert.rejects(
      fetchCatalogPage(workday, 2, {
        fetch: async (input, init) => {
          if (String(input).endsWith("/jobs")) {
            const offset = JSON.parse(String(init?.body)).offset
            return Response.json({
              total: offset === 5 ? 0 : total,
              jobPostings:
                offset === 5
                  ? [{ title: "Software Engineer", externalPath: workdayPath }]
                  : [],
            })
          }
          details++
          return Response.json(workdayJob())
        },
      }),
      /cap|incomplete/
    )
    assert.equal(details, 0)
  }
})

test("new ATS candidates pass through robots and live identity validation before activation eligibility", async () => {
  for (const source of [smart, workday]) {
    const read = probeClient(async (input, init) => {
      const url = String(input)
      if (url.endsWith("robots.txt"))
        return new Response("User-agent: *\nAllow: /")
      if (source.kind === "smartrecruiters")
        return Response.json(
          url.includes("?")
            ? { offset: 0, totalFound: 1, content: [smartJob()] }
            : smartJob()
        )
      if (!url.includes("/wday/cxs/"))
        return new Response(
          '<link rel="canonical" href="https://example.wd5.myworkdayjobs.com/ExternalCareers"><meta property="og:title" content="Careers at Example">'
        )
      if (url.endsWith("/jobs")) {
        assert.equal(init?.method, "POST")
        return Response.json({
          total: 1,
          jobPostings: [
            { title: "Software Engineer", externalPath: workdayPath },
          ],
        })
      }
      return Response.json(workdayJob())
    })
    const result = await validateCandidate(
      {
        ...boardIdentity(
          source.kind as "workday" | "smartrecruiters",
          source.board!
        ),
        expected_company: "Example",
        historical_checked_at: null,
        evidence_url: "https://example.com/careers",
      },
      read
    )
    assert.equal(result.status, "verified", result.reason)
    assert.ok(result.countries.includes("India"))
  }
  const denied = probeClient(
    async () => new Response("User-agent: *\nDisallow: /")
  )
  const result = await validateCandidate(
    {
      ...boardIdentity("workday", workday.board!),
      expected_company: null,
      historical_checked_at: null,
      evidence_url: "https://example.com",
    },
    denied
  )
  assert.equal(result.status, "needs_review")
})

test("bounded employer-page discovery follows career links and embedded ATS links, preserving candidates without inferring company facts", async () => {
  const seen: string[] = [],
    guarded: string[] = []
  const result = await discoverEmployerLinks(["https://example.com/"], {
    guard: async (url) => {
      guarded.push(url)
    },
    fetch: async (input, init) => {
      const url = String(input)
      seen.push(url)
      assert.equal(init?.redirect, "error")
      return new Response(
        url.endsWith("robots.txt")
          ? "User-agent: *\nAllow: /"
          : url.endsWith("/careers")
            ? '<iframe src="https://example.wd5.myworkdayjobs.com/ExternalCareers"></iframe><a href="https://jobs.smartrecruiters.com/Example">Jobs</a><a href="https://other.test/careers">Other</a>'
            : '<a href="/careers">Careers</a><a href="http://127.0.0.1/jobs">Bad</a>',
        { headers: { "Content-Type": "text/html" } }
      )
    },
  })
  assert.equal(result.complete, true)
  assert.deepEqual(result.candidates.map((candidate) => candidate.id).sort(), [
    smart.id,
    workday.id,
  ])
  assert.ok(
    result.candidates.every(
      (candidate) =>
        candidate.expected_company === null &&
        candidate.historical_checked_at === null &&
        candidate.evidence_url === "https://example.com/careers"
    )
  )
  assert.deepEqual(seen, [
    "https://example.com/robots.txt",
    "https://example.com/",
    "https://example.com/careers",
  ])
  assert.deepEqual(guarded, seen)
  assert.deepEqual(
    linkDiscoveryOrigin(["https://example.com/"], result.candidates),
    linkDiscoveryOrigin(
      ["https://example.com/"],
      [...result.candidates].reverse()
    )
  )
})

test("discovery refuses private-address guards, redirects, robots exclusions and oversized inputs without activating anything", async () => {
  let calls = 0
  const privateResult = await discoverEmployerLinks(
    ["https://internal.example/"],
    {
      guard: async () => {
        throw new Error("private address")
      },
      fetch: async () => {
        calls++
        return new Response("")
      },
    }
  )
  assert.equal(calls, 0)
  assert.equal(privateResult.complete, false)
  assert.deepEqual(privateResult.candidates, [])
  const denied = await discoverEmployerLinks(["https://example.com/careers"], {
    guard: async () => {},
    fetch: async () => new Response("User-agent: *\nDisallow: /"),
  })
  assert.equal(denied.complete, false)
  assert.match(denied.errors[0].reason, /robots/)
  await assert.rejects(
    discoverEmployerLinks(Array(21).fill("https://example.com")),
    /1–20/
  )
})

test("profile-scoped discovery uses new readers while preserving role/country filters and continuation", async () => {
  const result = await discoverProfileSource(
    smart,
    { countries: ["India"], roles: ["Software Engineer"] },
    {
      maxPages: 1,
      fetch: async (url) =>
        Response.json(
          String(url).includes("?")
            ? {
                offset: 0,
                totalFound: 6,
                content: Array.from({ length: 5 }, (_, n) =>
                  smartJob(String(n))
                ),
              }
            : smartJob(String(url).split("/").at(-1))
        ),
    }
  )
  assert.equal(result.complete, false)
  assert.equal(result.nextPage, 2)
  assert.equal(result.jobs.length, 5)
  assert.equal(result.requests, 6)
})

test("the documented SmartRecruiters API is read without crawler impersonation while access refusals remain refusals", async () => {
  const seen: string[] = []
  const read = probeClient(async (input, init) => {
    const url = String(input)
    seen.push(url)
    assert.equal(
      new Headers(init?.headers).get("User-Agent"),
      "JobSearchCatalog/1.0"
    )
    assert.equal(new Headers(init?.headers).has("Authorization"), false)
    if (url.endsWith("robots.txt"))
      return new Response("User-agent: *\nDisallow: /")
    return new Response(null, { status: 403 })
  })
  await assert.rejects(
    read(
      "https://api.smartrecruiters.com/v1/companies/example/postings?limit=1",
      "json"
    ),
    /HTTP 403/
  )
  assert.deepEqual(seen, [
    "https://api.smartrecruiters.com/v1/companies/example/postings?limit=1",
  ])
  await assert.rejects(
    read("https://careers.smartrecruiters.com/example", "html"),
    /robots/
  )
})

test("Workday detail URLs must corroborate the source site and missing identity cannot validate a candidate", async () => {
  const fetcher =
    (externalUrl: string, named = true) =>
    async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/jobs"))
        return Response.json({
          total: 1,
          jobPostings: [
            { title: "Software Engineer", externalPath: workdayPath },
          ],
        })
      const detail = workdayJob()
      return Response.json({
        ...detail,
        hiringOrganization: named ? detail.hiringOrganization : undefined,
        jobPostingInfo: { ...detail.jobPostingInfo, externalUrl },
      })
    }
  await assert.rejects(
    fetchCatalogPage(workday, 1, {
      fetch: fetcher(
        "https://other.wd5.myworkdayjobs.com/ExternalCareers/job/x/y"
      ),
    }),
    /identity/
  )
  const identity = boardIdentity("workday", workday.board!)
  const result = await validateCandidate(
    {
      ...identity,
      expected_company: null,
      historical_checked_at: null,
      evidence_url: "https://example.com/careers",
    },
    async (url) => {
      const response = await fetcher(
        `https://example.wd5.myworkdayjobs.com/ExternalCareers${workdayPath}`,
        false
      )(url)
      return response.json()
    }
  )
  assert.equal(result.status, "needs_review")
  assert.equal(result.company, null)
})
