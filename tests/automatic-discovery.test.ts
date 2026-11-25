import assert from "node:assert/strict"
import test from "node:test"
import { countryOptions } from "@/lib/location/countries"
import { countryDiscoveryQueries } from "@/lib/server/catalog/discovery/worldwide"
import {
  prioritizeDiscoveryCountries,
  runAutomaticDiscovery,
  type CountryPriority,
} from "@/lib/server/catalog/discovery/automatic"
import { automaticDiscoveryDatabase } from "./helpers/automatic-discovery-database"
import {
  linkDiscoveryOrigin,
  candidatesFromLinks,
} from "@/lib/server/catalog/discovery/links"

const env = {
  AUTOMATIC_DISCOVERY_ENABLED: "true",
  APP_ENV: "staging",
  BROWSERBASE_API_KEY: "fixture-secret",
}
const row = (
  country: string,
  fields: Partial<CountryPriority> = {}
): CountryPriority => ({
  country,
  attempts: 0,
  users: 0,
  underserved: 0,
  unmeasured: 0,
  last_attempt_at: null,
  next_attempt_at: "2000-01-01T00:00:00Z",
  ...fields,
})

test("country priority reserves half the batch for worldwide exploration and respects cooldowns", () => {
  const rows = [
    row("Demand A", { users: 4, underserved: 4 }),
    row("Demand B", { users: 9, unmeasured: 9 }),
    row("Demand C", { users: 100 }),
    row("Demand D", { users: 1000 }),
    row("A unseen"),
    row("B unseen"),
    row("C unseen"),
    row("Cooling", {
      users: 2000,
      underserved: 2000,
      next_attempt_at: "2100-01-01",
    }),
  ]
  const selected = prioritizeDiscoveryCountries(rows)
  assert.equal(selected.length, 6)
  assert.equal(selected[0].country, "Demand A")
  assert.ok(selected.some((x) => x.country === "Demand B"))
  for (const country of ["A unseen", "B unseen", "C unseen"])
    assert.ok(selected.some((x) => x.country === country))
  assert.ok(!selected.some((x) => x.country === "Cooling"))
  assert.ok(
    countryOptions.every((country) =>
      [0, 1, 2].every((v) =>
        countryDiscoveryQueries(country, v).every((q) => q.length <= 200)
      )
    )
  )
})

async function setup() {
  const db = await automaticDiscoveryDatabase()
  await db.rpc("initialize_automatic_discovery", [countryOptions])
  const run = await db.rpc<{ claimed: boolean; id: string; token: string }>(
    "claim_automatic_discovery",
    ["fixture-run"]
  )
  const plan = [
    { country: "India", queries: ["one", "two"] },
    { country: "Japan", queries: ["three", "four"] },
  ]
  await db.rpc("set_automatic_discovery_plan", [run.id, run.token, plan])
  return { ...db, run, plan }
}

test("SQL enforces daily request and integer money caps, duplicate reservations and request-key replay", async () => {
  const db = await setup()
  try {
    assert.equal(
      (await db.rpc("claim_automatic_discovery", ["fixture-run"])).claimed,
      false
    )
    await db.sql.exec(
      "update automatic_discovery_settings set daily_budget_milliusd=14"
    )
    assert.equal(
      (
        await db.rpc("reserve_automatic_discovery_search", [
          db.run.id,
          db.run.token,
          0,
          "one",
        ])
      ).allowed,
      true
    )
    assert.equal(
      (
        await db.rpc("reserve_automatic_discovery_search", [
          db.run.id,
          db.run.token,
          0,
          "one",
        ])
      ).reason,
      "already_reserved"
    )
    assert.equal(
      (
        await db.rpc("reserve_automatic_discovery_search", [
          db.run.id,
          db.run.token,
          1,
          "two",
        ])
      ).allowed,
      true
    )
    assert.equal(
      (
        await db.rpc("reserve_automatic_discovery_search", [
          db.run.id,
          db.run.token,
          2,
          "three",
        ])
      ).reason,
      "daily_budget"
    )
    assert.deepEqual(
      (
        await db.sql.query(
          "select searches,reserved_milliusd from automatic_discovery_days"
        )
      ).rows,
      [{ searches: 2, reserved_milliusd: 14 }]
    )
    const receipt = await db.rpc("finish_automatic_discovery", [
      db.run.id,
      db.run.token,
      "failed",
      { reason: "fixture-network" },
    ])
    assert.equal(receipt.reservedSearches, 2)
    assert.equal(
      (await db.rpc("claim_automatic_discovery", ["fixture-run"])).result &&
        (
          await db.rpc<{ result: unknown }>("claim_automatic_discovery", [
            "fixture-run",
          ])
        ).result !== null,
      true
    )
    assert.equal(
      (
        await db.sql.query<{ searches: number }>(
          "select searches from automatic_discovery_days"
        )
      ).rows[0].searches,
      2,
      "Failures do not refund ambiguous paid calls"
    )
  } finally {
    await db.sql.close()
  }
})

test("UTC boundary, request limit and provider backoff reject calls before another reservation", async () => {
  const db = await setup()
  try {
    await db.sql.exec("update automatic_discovery_runs set day=day-1")
    assert.equal(
      (
        await db.rpc("reserve_automatic_discovery_search", [
          db.run.id,
          db.run.token,
          0,
          "one",
        ])
      ).reason,
      "day_boundary"
    )
    await db.sql.exec(
      "update automatic_discovery_runs set day=(now() at time zone 'UTC')::date; update automatic_discovery_settings set daily_search_limit=1"
    )
    const claims = await Promise.all([
      db.rpc("reserve_automatic_discovery_search", [
        db.run.id,
        db.run.token,
        0,
        "one",
      ]),
      db.rpc("reserve_automatic_discovery_search", [
        db.run.id,
        db.run.token,
        1,
        "two",
      ]),
    ])
    assert.equal(claims.filter((c) => c.allowed).length, 1)
    await db.rpc("record_automatic_discovery_search", [
      db.run.id,
      db.run.token,
      0,
      429,
      {},
      {},
      [],
      new Date(Date.now() + 7200000).toISOString(),
    ])
    assert.equal(
      (
        await db.rpc("reserve_automatic_discovery_search", [
          db.run.id,
          db.run.token,
          1,
          "two",
        ])
      ).reason,
      "provider_backoff"
    )
    assert.equal(
      (await db.sql.query("select * from source_candidates")).rows.length,
      0
    )
  } finally {
    await db.sql.close()
  }
})

test("result intake rolls back atomically and expired workers cannot spend or activate", async () => {
  const db = await setup()
  try {
    await db.rpc("reserve_automatic_discovery_search", [
      db.run.id,
      db.run.token,
      0,
      "one",
    ])
    const url = "https://jobs.ashbyhq.com/fixture-new"
    const candidates = candidatesFromLinks(url, [url]),
      origin = linkDiscoveryOrigin([url], candidates)
    await assert.rejects(
      db.rpc("record_automatic_discovery_search", [
        db.run.id,
        db.run.token,
        0,
        200,
        { requestId: "one", results: [{ url }] },
        origin,
        [{ ...candidates[0], board: "../bad" }],
        null,
      ])
    )
    assert.equal(
      (
        await db.sql.query<{ status: string }>(
          "select status from automatic_discovery_queries"
        )
      ).rows[0].status,
      "reserved"
    )
    assert.equal(
      (await db.sql.query("select * from source_candidates")).rows.length,
      0
    )
    await db.rpc("record_automatic_discovery_search", [
      db.run.id,
      db.run.token,
      0,
      200,
      { requestId: "one", results: [{ url }] },
      origin,
      candidates,
      null,
    ])
    assert.equal(
      (await db.sql.query("select * from source_candidates")).rows.length,
      1
    )
    await db.sql.exec(
      "update automatic_discovery_control set lease_until=now()-interval '1 minute',last_started_at=now()-interval '5 hours'"
    )
    const next = await db.rpc<{ id: string; token: string }>(
      "claim_automatic_discovery",
      ["replacement"]
    )
    assert.notEqual(next.id, db.run.id)
    await assert.rejects(
      db.rpc("reserve_automatic_discovery_search", [
        db.run.id,
        db.run.token,
        1,
        "two",
      ]),
      /lease/
    )
    await assert.rejects(
      db.rpc("activate_automatic_discovery_source", [
        db.run.id,
        db.run.token,
        candidates[0].id,
      ]),
      /lease/
    )
    assert.equal(
      (await db.rpc<unknown[]>("automatic_discovery_pending_candidates"))
        .length,
      1,
      "Paid observations survive the interrupted run"
    )
    await db.sql.exec(
      "update source_candidates set status='verified',validated_at=now()-interval '2 days',validation='{\"fresh_count\":1}',next_attempt_at=now()-interval '1 day'"
    )
    assert.equal(
      (await db.rpc<unknown[]>("automatic_discovery_pending_candidates"))
        .length,
      1,
      "Stale successful validations return for revalidation after a long interruption"
    )
    await assert.rejects(
      db.rpc("activate_automatic_discovery_source", [
        next.id,
        next.token,
        candidates[0].id,
      ]),
      /Fresh automatic source evidence/
    )
  } finally {
    await db.sql.close()
  }
})

test("operator-only country metrics distinguish zero matches from unmeasured profiles", async () => {
  const db = await setup()
  try {
    await db.sql.exec(`reset role;
      insert into auth.users(id) values('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
      insert into account_profiles(user_id,data) select id,'{}' from auth.users;
      insert into account_countries(user_id,country) values('10000000-0000-4000-8000-000000000001','India'),('10000000-0000-4000-8000-000000000002','Japan');
      insert into account_match_state(user_id,profile_version,computed_at) values('10000000-0000-4000-8000-000000000001',1,now()); set role service_role;`)
    const metrics = await db.rpc<CountryPriority[]>(
      "automatic_discovery_country_priority"
    )
    assert.equal(metrics.length, 249)
    assert.deepEqual(
      metrics
        .filter((m) => m.users)
        .map((m) => [m.country, m.users, m.underserved, m.unmeasured]),
      [
        ["India", 1, 1, 0],
        ["Japan", 1, 0, 1],
      ]
    )
    await db.sql.exec("reset role;set role authenticated")
    await assert.rejects(
      db.rpc("automatic_discovery_country_priority"),
      /permission/
    )
    await assert.rejects(
      db.sql.query("select * from automatic_discovery_days"),
      /permission/
    )
  } finally {
    await db.sql.close()
  }
})

for (const { status, ageDays, activates } of [
  { status: 200, ageDays: 1, activates: true },
  { status: 200, ageDays: 31, activates: false },
  { status: 200, ageDays: -1, activates: false },
  { status: 429, ageDays: 1, activates: false },
])
  test(`worker HTTP ${status}, posting age ${ageDays} days: ledger, freshness and publication boundaries`, async (t) => {
    const db = await automaticDiscoveryDatabase(),
      original = globalThis.fetch
    t.after(async () => {
      globalThis.fetch = original
      await db.sql.close()
    })
    let paid = 0
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith("robots.txt"))
        return new Response("User-agent: *\nAllow: /")
      if (url.startsWith("https://jobs.ashbyhq.com/"))
        return new Response(
          '<script>window.__appData = {"organization":{"name":"Fixture New","hostedJobsPageSlug":"fixture-new"}};</script>'
        )
      if (url.startsWith("https://api.ashbyhq.com/"))
        return Response.json({
          jobs: [
            {
              isListed: true,
              title: "Software Engineer",
              jobUrl: "https://jobs.ashbyhq.com/fixture-new/123",
              publishedAt: new Date(
                Date.now() - ageDays * 86400000
              ).toISOString(),
              descriptionPlain:
                "Build production software services and reliable APIs with TypeScript and Postgres. ".repeat(
                  4
                ),
              address: { addressCountry: "IN", addressLocality: "Hyderabad" },
            },
          ],
        })
      throw new Error("Unexpected ATS URL")
    }
    const paidFetch: typeof fetch = async () => {
      paid++
      return status === 200
        ? Response.json({
            requestId: `search-${paid}`,
            results: [{ url: "https://jobs.ashbyhq.com/fixture-new/123" }],
          })
        : new Response("private provider body", {
            status,
            headers: { "retry-after": "7200" },
          })
    }
    const first = await runAutomaticDiscovery({
      requestKey: "fixture-workflow",
      env,
      database: db.database,
      fetch: paidFetch,
      maxCountries: 1,
    })
    assert.equal(first.reservedSearches, status === 200 ? 2 : 1)
    assert.deepEqual(
      first.activatedSources,
      activates ? ["ashby:fixture-new"] : [],
      JSON.stringify({
        first,
        candidates: (
          await db.sql.query(
            "select id,status,validation from source_candidates"
          )
        ).rows,
      })
    )
    assert.equal(first.status, status === 200 ? "completed" : "partial")
    const calls = paid
    const replay = await runAutomaticDiscovery({
      requestKey: "fixture-workflow",
      env,
      database: db.database,
      fetch: paidFetch,
      maxCountries: 1,
    })
    assert.deepEqual(replay, first)
    assert.equal(paid, calls)
    assert.equal(
      (await db.sql.query("select * from job_catalog")).rows.length,
      0
    )
  })

for (const lostAcknowledgement of [false, true])
  test(`no paid request without a confirmed reservation: ${lostAcknowledgement ? "lost acknowledgement" : "exhausted daily budget"}`, async (t) => {
    const db = await automaticDiscoveryDatabase((name) => {
      if (lostAcknowledgement && name === "reserve_automatic_discovery_search")
        throw new Error("Reservation committed; acknowledgement lost")
    })
    t.after(() => db.sql.close())
    if (!lostAcknowledgement)
      await db.sql.exec(
        "update automatic_discovery_settings set daily_budget_milliusd=0"
      )
    let paid = 0
    const result = await runAutomaticDiscovery({
      requestKey: "fixture-admission",
      env,
      database: db.database,
      maxCountries: 1,
      fetch: async () => {
        paid++
        throw new Error("Must never reach provider")
      },
    })
    assert.equal(paid, 0)
    assert.equal(result.status, "partial")
    assert.equal(result.reservedSearches, lostAcknowledgement ? 1 : 0)
    assert.equal(result.reservedMilliusd, lostAcknowledgement ? 7 : 0)
    assert.deepEqual(result.activatedSources, [])
  })
