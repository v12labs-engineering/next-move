import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { CandidateStore } from "@/lib/server/catalog/discovery/store"
import { boardIdentity } from "@/lib/server/catalog/discovery/seeds"
import { bulkBatch, bulkProbe } from "@/lib/server/catalog/discovery/bulk"

test("bulk throttles keep Keka, Zoho and Lever in independent provider buckets", async () => {
  const providers = [
    ["keka", "https://acme.keka.com/careers/"],
    ["zohorecruit", "https://acme.zohorecruit.in/jobs/Careers"],
    ["lever", "https://jobs.lever.co/acme"],
  ] as const
  for (const [limitedKind, limitedUrl] of providers) {
    const seen: string[] = []
    const probe = bulkProbe(async (input) => {
      const url = new URL(String(input))
      seen.push(url.href)
      return url.origin === new URL(limitedUrl).origin
        ? new Response(null, { status: 429, headers: { "retry-after": "120" } })
        : new Response(
            url.pathname === "/robots.txt"
              ? "User-agent: *\nAllow: /"
              : "Provider body"
          )
    }, 0)
    await assert.rejects(probe.read(limitedUrl, "html"), /HTTP 429/)
    assert.deepEqual([...probe.blocked.keys()], [limitedKind])
    for (const [kind, url] of providers) {
      if (kind === limitedKind) continue
      assert.equal(await probe.read(url, "html"), "Provider body")
      assert.ok(seen.includes(url))
    }
    const previous = seen.length
    await assert.rejects(probe.read(limitedUrl, "html"), /HTTP 429/)
    assert.equal(
      seen.length,
      previous,
      "A provider retry must not bypass its backoff"
    )
  }
})

for (const { bulk, recent } of [
  { bulk: false, recent: false },
  { bulk: true, recent: false },
  { bulk: false, recent: true },
])
  test(`${bulk ? "parallel bulk" : recent ? "fresh scheduled" : "scheduled"} batches activate only candidates with current usable public evidence`, async (t) => {
    const oldFetch = globalThis.fetch,
      oldEnv = process.env.APP_ENV
    t.after(() => {
      globalThis.fetch = oldFetch
      if (oldEnv === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = oldEnv
    })
    process.env.APP_ENV = "staging"
    const base = {
      expected_company: null,
      historical_checked_at: null,
      evidence_url: "",
      status: "imported",
      validation: null as unknown,
      validated_at: null as string | null,
    }
    const rows = [
      { ...base, ...boardIdentity("ashby", "hospital") },
      { ...base, ...boardIdentity("greenhouse", "empty") },
      { ...base, ...boardIdentity("lever", "blocked") },
    ]
    const activated: string[] = [],
      claimed: string[] = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "db.example") {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        if (url.pathname.endsWith("/source_candidates")) {
          const kind = url.searchParams.get("kind")?.replace("eq.", "")
          const status = url.searchParams.get("status")
          return Response.json(
            rows.filter(
              (row) =>
                (!kind || row.kind === kind) &&
                (status === "eq.verified"
                  ? row.status === "verified"
                  : !["activated", "invalid"].includes(row.status))
            )
          )
        }
        if (url.pathname.endsWith("/claim_source_expansion"))
          return Response.json("11111111-1111-4111-8111-111111111111")
        if (url.pathname.endsWith("/claim_source_candidate")) {
          claimed.push(body.p_id)
          return Response.json({
            token: "22222222-2222-4222-8222-222222222222",
          })
        }
        if (url.pathname.endsWith("/finish_source_candidate")) {
          const row = rows.find((row) => row.id === body.p_id)!
          row.status = body.p_result.status
          row.validation = body.p_result
          row.validated_at = new Date().toISOString()
          return new Response(null, { status: 204 })
        }
        if (url.pathname.endsWith("/activate_source_candidate")) {
          const row = rows.find((row) => row.id === body.p_id)!
          assert.equal(row.status, "verified")
          row.status = "activated"
          activated.push(row.id)
          return Response.json({ id: row.id, enabled: true })
        }
        if (url.pathname.endsWith("/finish_source_expansion"))
          return new Response(null, { status: 204 })
        throw new Error("Unexpected operator endpoint")
      }
      if (url.pathname.endsWith("/robots.txt"))
        return new Response("User-agent: *\nAllow: /")
      if (url.hostname === "jobs.ashbyhq.com")
        return new Response(
          '<script>window.__appData = {"organization":{"name":"Hospital","hostedJobsPageSlug":"hospital"}};</script>'
        )
      if (url.hostname === "api.ashbyhq.com")
        return Response.json({
          jobs: [
            {
              isListed: true,
              title: "Software Engineer",
              jobUrl:
                "https://jobs.ashbyhq.com/hospital/11111111-1111-4111-8111-111111111111",
              descriptionPlain:
                "Provide software development, maintain service reliability and coordinate API development. ".repeat(
                  4
                ),
              address: { addressCountry: "US", addressLocality: "Boston" },
            },
          ],
        })
      if (url.hostname === "boards-api.greenhouse.io")
        return Response.json(
          url.pathname.endsWith("/jobs")
            ? { jobs: [] }
            : { name: "Empty Hospital" }
        )
      if (url.hostname === "jobs.lever.co")
        return new Response(null, { status: 403 })
      throw new Error("Unexpected external request")
    }
    const store = new CandidateStore(
      createClient("https://db.example", "fixture-operator-key", {
        auth: { persistSession: false },
      })
    )
    const result = bulk
      ? await bulkBatch({
          store,
          candidates: rows,
          probe: bulkProbe(globalThis.fetch, 0),
          parallelism: 2,
        })
      : await store.expand({
          limit: 3,
          apply: true,
          force: true,
          requireRecent: recent,
        })
    assert.deepEqual(
      claimed.sort(),
      ["ashby:hospital", "greenhouse:empty", "lever:blocked"].sort()
    )
    assert.deepEqual(activated, recent ? [] : ["ashby:hospital"])
    assert.deepEqual(result.activatedSources, recent ? [] : ["ashby:hospital"])
    assert.ok("counts" in result)
    assert.deepEqual(
      result.counts,
      recent
        ? { empty: 1, needs_review: 2 }
        : { verified: 1, empty: 1, needs_review: 1 }
    )
  })

test("a provider throttle stops further network requests for that provider", async () => {
  let requests = 0
  const probe = bulkProbe(async () => {
    requests++
    return new Response(null, {
      status: 429,
      headers: { "retry-after": "120" },
    })
  }, 0)
  await assert.rejects(
    probe.read("https://api.ashbyhq.com/posting-api/job-board/first", "json")
  )
  await assert.rejects(
    probe.read("https://api.ashbyhq.com/posting-api/job-board/second", "json")
  )
  assert.equal(requests, 1)
  assert.ok(probe.blocked.get("ashby")! > Date.now() + 110_000)
})
