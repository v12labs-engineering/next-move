import assert from "node:assert/strict"
import test from "node:test"
import {
  discoverWithBrowserbase,
  DiscoveryBrowserError,
} from "@/lib/server/catalog/discovery/browserbase"
import { browserbaseCareerRenderer } from "@/lib/server/catalog/discovery/browserbase-render"
import { discoverEmployerLinks } from "@/lib/server/catalog/discovery/links"

const apiKey = "fixture-secret-never-in-reports"
const search = (urls: string[]) =>
  Response.json({
    requestId: "fixture-search",
    results: urls.map((url) => ({ url })),
  })
const noStatic = async () => ({
  candidates: [],
  checked: [],
  errors: [],
  complete: true,
})

test("renderer refuses robots exclusion before creating a paid session", async () => {
  const requests: string[] = []
  const render = browserbaseCareerRenderer(
    { BROWSERBASE_API_KEY: apiKey, BROWSERBASE_PROJECT_ID: "fixture-project" },
    {
      guard: async () => {},
      fetch: async (url) => {
        requests.push(String(url))
        return new Response("User-agent: *\nDisallow: /")
      },
    }
  )
  await assert.rejects(
    render("https://employer.com/careers", AbortSignal.timeout(1000)),
    (error) => {
      assert.ok(error instanceof DiscoveryBrowserError)
      assert.equal(error.phase, "robots")
      assert.equal(error.sessionId, "")
      return true
    }
  )
  assert.deepEqual(requests, ["https://employer.com/robots.txt"])
})

test("renderer reports account refusal without retry or exposing provider response", async () => {
  let creates = 0
  const render = browserbaseCareerRenderer(
    { BROWSERBASE_API_KEY: apiKey, BROWSERBASE_PROJECT_ID: "fixture-project" },
    {
      guard: async () => {},
      fetch: async (input, init) => {
        if (String(input).endsWith("robots.txt"))
          return new Response("User-agent: *\nAllow: /")
        creates++
        const body = JSON.parse(String(init?.body))
        assert.equal(body.timeout, 120)
        assert.equal(body.proxies, false)
        assert.equal(body.browserSettings.solveCaptchas, false)
        return Response.json({ error: apiKey }, { status: 402 })
      },
    }
  )
  await assert.rejects(
    render("https://employer.com/careers", AbortSignal.timeout(1000)),
    (error) => {
      assert.ok(error instanceof DiscoveryBrowserError)
      assert.equal(error.phase, "create")
      assert.equal(error.status, 402)
      assert.equal(error.message.includes(apiKey), false)
      return true
    }
  )
  assert.equal(creates, 1)
})

test("a failed CDP connection still releases the known session independently", async () => {
  const operations: string[] = []
  const render = browserbaseCareerRenderer(
    { BROWSERBASE_API_KEY: apiKey, BROWSERBASE_PROJECT_ID: "fixture-project" },
    {
      guard: async () => {},
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith("robots.txt"))
          return new Response("User-agent: *\nAllow: /")
        operations.push(url)
        if (url.endsWith("/sessions"))
          return Response.json({
            id: "fixture-session",
            connectUrl: "wss://signed-control.example/" + apiKey,
          })
        assert.equal(JSON.parse(String(init?.body)).status, "REQUEST_RELEASE")
        return Response.json({ status: "COMPLETED" })
      },
      connect: async () => {
        throw new Error("CDP error with " + apiKey)
      },
    }
  )
  await assert.rejects(
    render("https://employer.com/careers", AbortSignal.timeout(1000)),
    (error) => {
      assert.ok(error instanceof DiscoveryBrowserError)
      assert.equal(error.phase, "connect")
      assert.equal(error.sessionId, "fixture-session")
      assert.equal(error.releaseRequested, true)
      assert.equal(error.message.includes(apiKey), false)
      return true
    }
  )
  assert.deepEqual(operations, [
    "https://api.browserbase.com/v1/sessions",
    "https://api.browserbase.com/v1/sessions/fixture-session",
  ])
})

test("search discovers canonical new boards, rejects unsafe destinations and never invents query country evidence", async () => {
  let calls = 0
  const result = await discoverWithBrowserbase(
    ["software Singapore", "software Singapore"],
    {
      apiKey,
      maxBrowsers: 0,
      maxUrls: 2,
      knownSourceIds: new Set(["ashby:existing"]),
      fetch: async (url, init) => {
        calls++
        assert.equal(String(url), "https://api.browserbase.com/v1/search")
        assert.equal(init?.redirect, "error")
        assert.deepEqual(JSON.parse(String(init?.body)), {
          query: "software Singapore",
          provider: "parallel",
          mode: "fast",
          numResults: 25,
        })
        return search([
          "https://jobs.ashbyhq.com/existing/job1",
          "https://jobs.ashbyhq.com/newco/job1",
          "https://jobs.ashbyhq.com/newco/job2",
          "https://careers.smartrecruiters.com/Other",
          "http://jobs.lever.co/unsafe",
          "https://127.0.0.1/private",
          "https://user:password@employer.com/careers",
        ])
      },
      discover: async () => {
        throw new Error("Direct ATS URLs must not be crawled")
      },
    }
  )
  assert.equal(calls, 1)
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.candidates.map((c) => c.id),
    ["ashby:newco", "smartrecruiters:other"]
  )
  assert.ok(
    result.candidates.every(
      (c) => c.expected_company === null && c.historical_checked_at === null
    )
  )
  assert.equal(result.usage.checkedUrls, 2)
  assert.equal(result.usage.skippedKnown, 1)
  assert.equal(result.usage.rejectedUrls, 3)
  assert.equal(JSON.stringify(result).includes(apiKey), false)
  assert.equal("countries" in result.candidates[0], false)
})

test("static extraction wins; rendered links stay candidates with origin evidence", async () => {
  const rendered: string[] = []
  const result = await discoverWithBrowserbase(["software India careers"], {
    apiKey,
    maxBrowsers: 1,
    fetch: async () =>
      search([
        "https://static-employer.com/careers",
        "https://dynamic-employer.com/careers",
      ]),
    discover: async (urls, options) => {
      assert.equal(options?.maxPages, 1)
      return urls[0].includes("static")
        ? {
            candidates: [
              {
                id: "ashby:static",
                kind: "ashby",
                board: "static",
                expected_company: null,
                historical_checked_at: null,
                evidence_url: urls[0],
              },
            ],
            checked: urls,
            errors: [],
            complete: true,
          }
        : noStatic()
    },
    render: async (url, signal) => {
      assert.equal(signal.aborted, false)
      rendered.push(url)
      return {
        sessionId: "fixture-session",
        releaseRequested: true,
        links: [
          "https://jobs.lever.co/dynamic/job1",
          "https://jobs.lever.co/dynamic/job2",
          "https://jobs.lever.co.evil.com/not-a-board",
        ],
      }
    },
  })
  assert.deepEqual(rendered, ["https://dynamic-employer.com/careers"])
  assert.equal(result.complete, true)
  assert.equal(result.candidates.length, 2)
  assert.equal(result.candidates[1].evidence_url, rendered[0])
  assert.equal(result.usage.browserAttempts, 1)
  assert.equal(result.usage.reservedCostUsd, 0.011)
  assert.deepEqual(result.sessions, [
    { sessionId: "fixture-session", releaseRequested: true },
  ])
})

for (const status of [401, 402, 403, 429, 500])
  test(`Search HTTP ${status} stops further paid calls, preserves earlier observed boards and hides provider errors`, async () => {
    let calls = 0,
      renders = 0
    const result = await discoverWithBrowserbase(["first", "second", "third"], {
      apiKey,
      maxBrowsers: 1,
      fetch: async () =>
        ++calls === 1
          ? search([
              "https://jobs.ashbyhq.com/observed",
              "https://dynamic-employer.com/careers",
            ])
          : new Response(`leaked signed URL and ${apiKey}`, { status }),
      discover: noStatic,
      render: async () => {
        renders++
        throw new Error("Must not start after Search refusal")
      },
    })
    assert.equal(calls, 2)
    assert.equal(renders, 0)
    assert.equal(result.usage.searchAttempts, 2)
    assert.equal(result.usage.reservedCostUsd, 0.014)
    assert.deepEqual(
      result.candidates.map((c) => c.id),
      ["ashby:observed"]
    )
    assert.equal(result.complete, false)
    assert.deepEqual(result.stopReasons, ["search_error"])
    assert.equal(JSON.stringify(result).includes(apiKey), false)
  })

test("source refusal never triggers a browser and has no effect on other discovered candidates", async () => {
  const result = await discoverWithBrowserbase(["software careers"], {
    apiKey,
    maxBrowsers: 1,
    fetch: async () =>
      search([
        "https://refused-employer.com/careers",
        "https://jobs.ashbyhq.com/other",
      ]),
    discover: async (urls) => ({
      candidates: [],
      checked: [],
      errors: [{ url: urls[0], reason: "Discovery HTTP 403" }],
      complete: false,
    }),
    render: async () => {
      throw new Error("Cannot bypass source refusal")
    },
  })
  assert.equal(result.usage.browserAttempts, 0)
  assert.equal(result.complete, false)
  assert.equal(result.candidates[0].id, "ashby:other")
})

test("search, URL, browser and cost limits stop work before spending their next reservation", async () => {
  let calls = 0
  const cost = await discoverWithBrowserbase(["first", "second"], {
    apiKey,
    maxBrowsers: 0,
    maxCostUsd: 0.007,
    fetch: async () => {
      calls++
      return search([])
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(cost.stopReasons, ["cost_budget"])
  const urls = await discoverWithBrowserbase(["first", "second"], {
    apiKey,
    maxBrowsers: 0,
    maxUrls: 1,
    fetch: async () =>
      search([
        "https://jobs.ashbyhq.com/first",
        "https://jobs.ashbyhq.com/second",
      ]),
  })
  assert.equal(urls.candidates.length, 1)
  assert.equal(urls.usage.searchAttempts, 1)
  assert.deepEqual(urls.stopReasons, ["url_budget"])
  let renders = 0
  const browsers = await discoverWithBrowserbase(["first"], {
    apiKey,
    maxBrowsers: 1,
    fetch: async () =>
      search([
        "https://first-employer.com/careers",
        "https://second-employer.com/careers",
      ]),
    discover: noStatic,
    render: async () => {
      renders++
      return { links: [], sessionId: "fixture-session", releaseRequested: true }
    },
  })
  assert.equal(renders, 1)
  assert.deepEqual(browsers.stopReasons, ["browser_budget"])
  const unaffordable = await discoverWithBrowserbase(["first"], {
    apiKey,
    maxBrowsers: 1,
    maxCostUsd: 0.01,
    fetch: async () => search(["https://first-employer.com/careers"]),
    discover: noStatic,
    render: async () => {
      throw new Error("Cannot exceed reservation budget")
    },
  })
  assert.equal(unaffordable.usage.browserAttempts, 0)
  assert.deepEqual(unaffordable.stopReasons, ["cost_budget"])
})

test("ambiguous browser failure stops subsequent browser creation and counts the attempt", async () => {
  let renders = 0
  const result = await discoverWithBrowserbase(["first"], {
    apiKey,
    maxBrowsers: 2,
    fetch: async () =>
      search([
        "https://first-employer.com/careers",
        "https://second-employer.com/careers",
      ]),
    discover: noStatic,
    render: async () => {
      renders++
      throw new Error("signed websocket URL " + apiKey)
    },
  })
  assert.equal(renders, 1)
  assert.equal(result.usage.browserAttempts, 1)
  assert.deepEqual(result.stopReasons, ["browser_error"])
  assert.equal(JSON.stringify(result).includes(apiKey), false)
})

test("a failed browser cannot discard direct ATS URLs or later static discoveries", async () => {
  const checked: string[] = []
  const result = await discoverWithBrowserbase(["software careers"], {
    apiKey,
    maxBrowsers: 2,
    fetch: async () =>
      search([
        "https://dynamic-employer.com/careers",
        "https://jobs.ashbyhq.com/direct",
        "https://static-employer.com/careers",
      ]),
    discover: async (urls) => {
      checked.push(urls[0])
      return urls[0].includes("static")
        ? {
            candidates: [
              {
                id: "lever:static",
                kind: "lever",
                board: "static",
                expected_company: null,
                historical_checked_at: null,
                evidence_url: urls[0],
              },
            ],
            checked: urls,
            errors: [],
            complete: true,
          }
        : noStatic()
    },
    render: async () => {
      throw new Error("Browser refused navigation")
    },
  })
  assert.deepEqual(
    result.candidates.map((c) => c.id),
    ["ashby:direct", "lever:static"]
  )
  assert.deepEqual(checked, [
    "https://dynamic-employer.com/careers",
    "https://static-employer.com/careers",
  ])
  assert.equal(result.usage.browserAttempts, 1)
  assert.equal(result.complete, false)
})

test("the run deadline aborts in-flight Search and starts no subsequent work", async () => {
  let calls = 0
  const result = await discoverWithBrowserbase(["first", "second"], {
    apiKey,
    maxBrowsers: 0,
    maxMs: 1000,
    fetch: async (_input, init) => {
      calls++
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("test deadline did not abort")),
          2000
        )
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            reject(init.signal?.reason)
          },
          { once: true }
        )
      })
      return search([])
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(result.stopReasons, ["time_budget"])
  assert.equal(result.usage.browserAttempts, 0)
})

test("invalid configuration and malformed/oversized responses cannot create browser work", async () => {
  for (const change of [
    { maxUrls: 51 },
    { maxBrowsers: 11 },
    { maxCostUsd: 2 },
    { maxMs: 0 },
  ]) {
    await assert.rejects(
      discoverWithBrowserbase(["query"], {
        apiKey,
        maxBrowsers: 0,
        ...change,
        fetch: async () => {
          throw new Error("Validation must precede network access")
        },
      })
    )
  }
  for (const response of [
    Response.json({ results: [] }),
    new Response("x".repeat(256_001)),
  ]) {
    const result = await discoverWithBrowserbase(["query", "other"], {
      apiKey,
      maxBrowsers: 0,
      fetch: async () => response,
    })
    assert.equal(result.complete, false)
    assert.equal(result.usage.searchAttempts, 1)
    assert.equal(result.usage.browserAttempts, 0)
    assert.deepEqual(result.stopReasons, ["search_error"])
  }
})

test("a single-page discovery budget never follows extra career links", async () => {
  const requests: string[] = []
  const result = await discoverEmployerLinks(["https://employer.com/careers"], {
    maxPages: 1,
    guard: async () => {},
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      return url.endsWith("robots.txt")
        ? new Response("User-agent: *\nAllow: /")
        : new Response(
            '<a href="/jobs">More careers</a><a href="https://jobs.ashbyhq.com/observed">Jobs</a>',
            { headers: { "Content-Type": "text/html" } }
          )
    },
  })
  assert.deepEqual(requests, [
    "https://employer.com/robots.txt",
    "https://employer.com/careers",
  ])
  assert.equal(result.candidates[0].id, "ashby:observed")
})
