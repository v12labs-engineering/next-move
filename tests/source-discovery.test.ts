import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { load } from "cheerio"
import { discoverEmployerLinks } from "@/lib/server/catalog/discovery/links"
import { publishedCareerLinks } from "../scripts/lib/career-links.mjs"
import {
  boardIdentity,
  csvRows,
  parseDirectory,
  downloadDirectory,
  seedDirectories,
  readBounded,
} from "@/lib/server/catalog/discovery/seeds"
import {
  observedCompany,
  probeClient,
  robotsAllowed,
  validateCandidate,
} from "@/lib/server/catalog/discovery/validate"

const candidate = {
  ...boardIdentity("ashby", "hospital"),
  expected_company: "Hospital",
  historical_checked_at: "2026-07-17",
  evidence_url: "https://jobs.ashbyhq.com/hospital",
}
const html =
  '<script>window.__appData = {"organization":{"name":"Hospital","hostedJobsPageSlug":"hospital"}};</script>'
const posting = {
  title: "Software Engineer",
  publishedAt: "2026-10-01T10:30:00.000Z",
  isListed: true,
  jobUrl:
    "https://jobs.ashbyhq.com/hospital/11111111-1111-4111-8111-111111111111",
  descriptionPlain:
    "Provide software development, maintain service reliability and coordinate API development. ".repeat(
      4
    ),
  address: { addressCountry: "US", addressLocality: "Boston" },
}

test("directory CSV preserves quoting and provenance, canonicalizes boards and rejects malformed inputs", () => {
  assert.deepEqual(csvRows('\uFEFFa,b\r\n"line\nwith ""quote""",b\r\n'), [
    ["a", "b"],
    ['line\nwith "quote"', "b"],
  ])
  assert.throws(() => csvRows('a,b\n"unterminated,b'), /Unterminated/)
  assert.throws(() => csvRows('a,b\n"closed"x,b'), /quoting/)
  const directory = seedDirectories[3]
  const parsed = parseDirectory(
    directory,
    'ats_vendor,company_name,board_slug,last_crawled\nashby,"Hospital, Inc.",HOSPITAL,2026-07-17\nashby,Hospital,hospital,2026-07-17\n'
  )
  assert.equal(parsed.rows, 2)
  assert.equal(parsed.distinctSources, 1)
  assert.equal(parsed.candidates[0].expected_company, "Hospital, Inc.")
  assert.equal(parsed.candidates[0].id, "ashby:hospital")
  assert.equal(parsed.candidates[0].historical_checked_at, "2026-07-17")
  assert.throws(() => boardIdentity("ashby", "../internal"), /Invalid/)
  assert.throws(() => parseDirectory(directory, "unexpected\nschema"), /schema/)
  assert.throws(
    () =>
      parseDirectory(
        seedDirectories[1],
        "provider,token,open_postings,board_url,api_url\nashby,hospital,5,https://jobs.ashbyhq.com.evil.example/hospital,https://api.ashbyhq.com/x"
      ),
    /match/
  )
})

test("validation uses current provider identity and public listings; unlisted or unusable jobs cannot activate a board", async () => {
  let jobs = [posting]
  const read = async (_url: string, format: "html" | "json") =>
    format === "html" ? html : { jobs }
  const result = await validateCandidate(candidate, read)
  assert.equal(result.status, "verified")
  assert.equal(result.company, "Hospital")
  assert.deepEqual(result.countries, ["United States"])
  assert.equal(result.accepted_count, 1)
  jobs = [{ ...posting, isListed: false }]
  assert.equal((await validateCandidate(candidate, read)).status, "empty")
  jobs = [{ ...posting, address: {} } as typeof posting]
  assert.equal(
    (await validateCandidate(candidate, read)).status,
    "needs_review"
  )
  assert.equal(
    (
      await validateCandidate(
        { ...candidate, expected_company: "Different Employer" },
        read
      )
    ).status,
    "needs_review"
  )
  assert.equal(
    (
      await validateCandidate(
        candidate,
        async () => "<script>window.__appData = alert(1)</script>"
      )
    ).status,
    "needs_review"
  )
  jobs = [
    {
      ...posting,
      jobUrl:
        "https://jobs.ashbyhq.com/other/11111111-1111-4111-8111-111111111111",
    },
  ]
  assert.equal(
    (await validateCandidate(candidate, read)).status,
    "needs_review"
  )
})

test("Lever empty response is a recognized empty board, with canonical metadata required", async () => {
  const lever = { ...candidate, ...boardIdentity("lever", "hospital") }
  const page =
    '<title>Hospital</title><meta property="og:title" content="Hospital jobs"><meta property="og:url" content="https://jobs.lever.co/hospital">'
  const result = await validateCandidate(lever, async (_url, format) =>
    format === "html" ? page : []
  )
  assert.equal(result.status, "empty")
  assert.equal(result.company, "Hospital")
  assert.throws(
    () =>
      observedCompany(
        lever,
        page.replace(
          "https://jobs.lever.co/hospital",
          "https://jobs.lever.co.evil.example/hospital"
        )
      ),
    /mismatch/
  )
})

test("Greenhouse employer-hosted apply links are corroborated by the job ID in the authoritative board response", async () => {
  const greenhouse = {
    ...candidate,
    ...boardIdentity("greenhouse", "hospital"),
  }
  const job = {
    id: 123,
    title: "Software Engineer",
    absolute_url: "https://careers.hospital.com/jobs/?gh_jid=123",
    location: { name: "Boston, United States" },
    content: posting.descriptionPlain,
  }
  const read = async (url: string) =>
    url.includes("/jobs?") ? { jobs: [job] } : { name: "Hospital" }
  assert.equal((await validateCandidate(greenhouse, read)).status, "verified")
  job.absolute_url = "https://careers.hospital.com/jobs/?gh_jid=999"
  assert.equal(
    (await validateCandidate(greenhouse, read)).status,
    "needs_review"
  )
})

test("unstructured US state abbreviations are not promoted to countries during source expansion", async () => {
  const { parseGreenhouse, parseLever } =
    await import("@/lib/server/catalog/connectors/board-apis")
  const source = {
    id: "greenhouse:hospital",
    kind: "greenhouse" as const,
    board: "hospital",
    company: "Hospital",
  }
  const job = {
    id: 123,
    title: "Software Engineer",
    absolute_url: "https://careers.hospital.com/jobs/?gh_jid=123",
    location: { name: "Atlanta, GA" },
    content: posting.descriptionPlain,
  }
  assert.deepEqual(parseGreenhouse(source, { jobs: [job] }), [])
  assert.deepEqual(
    parseGreenhouse(source, {
      jobs: [{ ...job, location: { name: "Atlanta, Georgia" } }],
    }),
    []
  )
  const explicit = parseGreenhouse(source, {
    jobs: [{ ...job, metadata: [{ name: "Country", value: "US" }] }],
  })
  assert.equal(explicit[0].country, "United States")
  assert.deepEqual(
    parseLever({ ...source, id: "lever:hospital", kind: "lever" }, [
      {
        text: "Software Engineer",
        hostedUrl: "https://jobs.lever.co/hospital/123",
        categories: { location: "Atlanta, GA" },
        descriptionPlain: posting.descriptionPlain,
      },
    ]),
    []
  )
})

test("unavailable robots resource is distinct from denial at the actual public feed", async () => {
  const read = probeClient(async (input) => {
    const url = String(input)
    if (url.endsWith("/robots.txt")) return new Response(null, { status: 401 })
    if (url.startsWith("https://jobs.ashbyhq.com/")) return new Response(html)
    return Response.json({ jobs: [posting] })
  })
  assert.equal((await validateCandidate(candidate, read)).status, "verified")
  const denied = probeClient(async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 403 })
  )
  assert.equal(
    (await validateCandidate(candidate, denied)).status,
    "needs_review"
  )
})

test("known recruiting links can require a public page probe", async () => {
  const url = candidate.evidence_url
  const requests: string[] = []
  const transport = async (input: string | URL | Request) => {
    const address = String(input)
    requests.push(address)
    return address.endsWith("/robots.txt")
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 401 })
  }
  const options = { fetch: transport, guard: async () => {} }
  const candidateOnly = await discoverEmployerLinks([url], options)
  assert.equal(candidateOnly.candidates.length, 1)
  assert.deepEqual(requests, [])

  const checked = await discoverEmployerLinks([url], {
    ...options,
    inspectKnownBoards: true,
  })
  assert.deepEqual(requests, ["https://jobs.ashbyhq.com/robots.txt", url])
  assert.equal(checked.complete, false)
  assert.deepEqual(checked.checked, [])
  assert.match(checked.errors[0].reason, /HTTP 401/)
})

test("employer sites can publish career pages with file and opening paths", () => {
  const page = new URL("https://www.employer.com/")
  const $ = load(`
    <a href="/careers.php">Careers</a>
    <a href="/current-openings/">Current openings</a>
    <a href="https://unrelated.com/careers.php">Careers</a>
  `)
  assert.deepEqual(publishedCareerLinks(page, $), [
    "https://www.employer.com/careers.php",
    "https://www.employer.com/current-openings/",
  ])
})

test("live probe client restricts origins, refuses redirects, bounds bodies and preserves backoff instead of empty success", async () => {
  const now = new Date("2026-10-30T00:00:00Z")
  const seen: string[] = []
  const read = probeClient(
    async (input, init) => {
      const url = String(input)
      seen.push(url)
      assert.equal(init?.redirect, "error")
      assert.equal(init?.cache, "no-store")
      assert.equal(new Headers(init?.headers).has("authorization"), false)
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: *\nDisallow:")
      if (url.startsWith("https://jobs.ashbyhq.com/")) return new Response(html)
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "120" },
      })
    },
    () => now
  )
  const deferred = await validateCandidate(candidate, read, now)
  assert.equal(deferred.status, "deferred")
  assert.equal(deferred.next_attempt_at, "2026-10-30T00:02:00.000Z")
  assert.equal(deferred.accepted_count, 0)
  await assert.rejects(read("https://127.0.0.1/private", "json"), /Untrusted/)
  assert.equal(
    seen.some((url) => url.includes("127.0.0.1")),
    false
  )
  await assert.rejects(readBounded(new Response("too large"), 3), /size/)
  const missing = probeClient(async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 404 })
  )
  assert.equal((await validateCandidate(candidate, missing)).status, "missing")
})

test("robots restrictions use the most specific matching rules without treating refusals as no jobs", () => {
  assert.equal(
    robotsAllowed(
      "User-agent: *\nDisallow:\nUser-agent: OtherBot\nDisallow: /",
      "/hospital"
    ),
    true
  )
  assert.equal(
    robotsAllowed("User-agent: *\nDisallow: /\nAllow: /hospital$", "/hospital"),
    true
  )
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /", "/hospital"), false)
  assert.equal(
    robotsAllowed("User-agent: *\nDisallow: /private/*\n", "/private/a"),
    false
  )
  assert.equal(
    robotsAllowed(
      "User-agent: OtherBot\nDisallow: /\nUser-agent: *\nAllow: /",
      "/hospital"
    ),
    true
  )
})

test("pinned directory downloads refuse modified content before import", async () => {
  await assert.rejects(
    downloadDirectory(seedDirectories[0], async (_url, init) => {
      assert.equal(init?.redirect, "error")
      return new Response("provider,token,open_postings,board_url,api_url\n")
    }),
    /checksum/
  )
})

test("operator-only candidate lifecycle is durable, idempotent and fenced; activation alone publishes no jobs", async () => {
  const db = new PGlite()
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role; create type visa_confidence as enum('confirmed','possible','no'); create table job_catalog(id text primary key,title text not null,company text not null,country text not null,city text,url text not null,description text not null,work_mode text not null,visa_signal visa_confidence,sponsorship_evidence text,sponsor_verified boolean,source text,posted_at timestamptz,discovered_at timestamptz default now()); grant all on job_catalog to service_role; create table account_countries(user_id uuid,country text);"
    )
    for (const file of [
      "202610290002_live_catalog.sql",
      "202610290006_catalog_collection.sql",
      "202610290007_catalog_backoff.sql",
      "202610300003_source_discovery.sql",
      "202610300004_unknown_discovery_observation.sql",
      "202610300005_automatic_source_expansion.sql",
      "202610300006_catalog_capacity.sql",
      "202610300007_durable_catalog_refresh.sql",
      "202610300008_catalog_source_index.sql",
      "202610300009_catalog_demand_assignments.sql",
      "202610300010_catalog_storage_reservations.sql",
      "202610300011_catalog_publication_lookup.sql",
      "202610300012_source_candidate_queue_indexes.sql",
      "202610300013_catalog_refresh_unchanged.sql",
      "202610300014_catalog_posted_date_comparison.sql",
      "202611010035_extended_ats_discovery.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${file}`, import.meta.url),
          "utf8"
        )
      )
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`)
      await assert.rejects(
        db.query("select * from source_candidates"),
        /permission denied/
      )
      await assert.rejects(
        db.query("select claim_source_candidate('ashby:hospital')"),
        /permission denied/
      )
      await assert.rejects(
        db.query("select claim_source_expansion(false)"),
        /permission denied/
      )
      await assert.rejects(
        db.query("select catalog_storage_usage()"),
        /permission denied/
      )
      await assert.rejects(
        db.query("select claim_catalog_refresh()"),
        /permission denied/
      )
      await assert.rejects(
        db.query(
          "select activate_source_candidate('ashby:hospital','unauthorized activation')"
        ),
        /permission denied/
      )
    }
    await db.exec("set role service_role")
    const refreshClaim = async () =>
      (
        await db.query<{ result: { id: string; claimed: boolean } }>(
          "select claim_catalog_refresh() result"
        )
      ).rows[0].result
    const refresh = await refreshClaim()
    assert.equal(refresh.claimed, true)
    assert.equal((await refreshClaim()).claimed, false)
    const record = () =>
      db.query(
        "select record_catalog_refresh_step($1,'stable-step',$2::jsonb)",
        [refresh.id, JSON.stringify({ published: 1, records: 3 })]
      )
    await record()
    await record()
    assert.equal(
      (
        await db.query<{ published_snapshots: number }>(
          "select published_snapshots from catalog_refresh_runs where id=$1",
          [refresh.id]
        )
      ).rows[0].published_snapshots,
      1
    )
    await db.exec(
      "reset role; update catalog_refresh_control set lease_until=now()-interval '1 second'; set role service_role"
    )
    const recoveredRefresh = await refreshClaim()
    assert.notEqual(recoveredRefresh.id, refresh.id)
    await assert.rejects(record(), /lease lost/)
    await assert.rejects(
      db.query("select finish_catalog_refresh($1,'completed','{}')", [
        refresh.id,
      ]),
      /lease lost/
    )
    await db.query("select finish_catalog_refresh($1,'completed','{}')", [
      recoveredRefresh.id,
    ])
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from catalog_refresh_runs where id=$1",
          [refresh.id]
        )
      ).rows[0].status,
      "interrupted"
    )
    const insert = async (rows = [candidate]) =>
      (
        await db.query<{
          result: { new_candidates: number; new_observations: number }
        }>("select import_source_candidates($1::jsonb,$2::jsonb) result", [
          JSON.stringify(seedDirectories[3]),
          JSON.stringify(rows),
        ])
      ).rows[0].result
    assert.equal((await insert()).new_candidates, 1)
    assert.deepEqual(await insert(), {
      new_candidates: 0,
      new_observations: 0,
      rows: 1,
    })
    await assert.rejects(
      db.query(
        "select activate_source_candidate('ashby:hospital','reviewed public source for staging')"
      ),
      /validation/
    )
    const claim = async () =>
      (
        await db.query<{ result: { token: string } }>(
          "select claim_source_candidate('ashby:hospital') result"
        )
      ).rows[0].result
    const first = await claim()
    assert.ok(first.token)
    assert.equal(await claim(), null)
    await db.exec(
      "reset role; update source_candidates set lease_until=now()-interval '1 minute'; set role service_role"
    )
    const second = await claim()
    assert.notEqual(second.token, first.token)
    const result = await validateCandidate(candidate, async (_url, format) =>
      format === "html" ? html : { jobs: [posting] }
    )
    const finish = (token: string) =>
      db.query("select finish_source_candidate($1,$2,$3::jsonb)", [
        candidate.id,
        token,
        JSON.stringify(result),
      ])
    await assert.rejects(finish(first.token), /lease/)
    await finish(second.token)
    assert.equal(
      (await db.query("select * from source_candidate_checks")).rows.length,
      1
    )
    await insert()
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from source_candidates"
        )
      ).rows[0].status,
      "verified"
    )
    await db.query("select activate_source_candidate($1,$2)", [
      candidate.id,
      "Public source reviewed for isolated staging evaluation",
    ])
    await db.query("select activate_source_candidate($1,$2)", [
      candidate.id,
      "Idempotent retry of reviewed activation",
    ])
    assert.equal((await db.query("select * from job_catalog")).rows.length, 0)
    await db.exec(
      "reset role; insert into account_countries(user_id,country) values('11111111-1111-4111-8111-111111111111','United States'); set role service_role"
    )
    assert.equal(
      (
        await db.query<{ demand: number | string }>(
          "select * from catalog_source_demand() where source='ashby:hospital'"
        )
      ).rows[0].demand,
      1
    )
    assert.equal(
      (
        await db.query(
          "select * from job_source_directory where id='ashby:hospital' and enabled"
        )
      ).rows.length,
      1
    )
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from source_candidates"
        )
      ).rows[0].status,
      "activated"
    )
    const collected = (
      await db.query<{ result: { id: string; token: string } }>(
        "select begin_catalog_run('ashby:hospital') result"
      )
    ).rows[0].result
    const { parseAshby } =
      await import("@/lib/server/catalog/connectors/board-apis")
    const jobs = parseAshby(
      { ...candidate, company: "Hospital" },
      { jobs: [posting] }
    )
    await db.exec("update catalog_capacity_control set budget_bytes=52428800")
    await assert.rejects(
      db.query("select checkpoint_catalog_page($1,$2,1,null,$3::jsonb,1,0,1)", [
        collected.id,
        collected.token,
        JSON.stringify(
          jobs.map((job) => ({ ...job, description: "x".repeat(20_000_000) }))
        ),
      ]),
      /storage budget/
    )
    assert.equal(
      (await db.query("select * from job_catalog_run_items")).rows.length,
      0
    )
    await db.exec("update catalog_capacity_control set budget_bytes=419430400")
    await db.exec(
      "update catalog_capacity_control set budget_bytes=pg_database_size(current_database())+60000000"
    )
    await db.query(
      "select reserve_catalog_storage($1,$2,'checkpoint',40000000)",
      [collected.id, collected.token]
    )
    const other = (
      await db.query<{ result: { id: string; token: string } }>(
        "select begin_catalog_run('ashby:n8n') result"
      )
    ).rows[0].result
    await assert.rejects(
      db.query("select reserve_catalog_storage($1,$2,'checkpoint',40000000)", [
        other.id,
        other.token,
      ]),
      /currently reserved/
    )
    await db.query(
      "select checkpoint_catalog_page($1,$2,1,null,$3::jsonb,1,0,1)",
      [collected.id, collected.token, JSON.stringify(jobs)]
    )
    assert.equal(
      (await db.query("select * from catalog_storage_reservations")).rows
        .length,
      0
    )
    await db.query(
      "select reserve_catalog_storage($1,$2,'checkpoint',40000000)",
      [other.id, other.token]
    )
    await db.exec(
      "reset role; update catalog_storage_reservations set expires_at=now()-interval '1 second'; set role service_role"
    )
    await db.query("select reserve_catalog_storage($1,$2,'publish',0)", [
      collected.id,
      collected.token,
    ])
    await db.query("select finish_catalog_run($1,$2)", [
      collected.id,
      collected.token,
    ])
    assert.equal(
      (await db.query("select * from catalog_storage_reservations")).rows
        .length,
      0
    )
    await db.exec("update catalog_capacity_control set budget_bytes=419430400")
    assert.equal(
      (await db.query("select * from job_catalog where is_active")).rows.length,
      1
    )
    const discovered = (
      await db.query<{ discovered_at: Date }>(
        "select discovered_at from job_catalog"
      )
    ).rows[0].discovered_at
    const updatedRun = (
      await db.query<{ result: { id: string; token: string } }>(
        "select begin_catalog_run('ashby:hospital') result"
      )
    ).rows[0].result
    await db.query(
      "select checkpoint_catalog_page($1,$2,1,null,$3::jsonb,1,0,1)",
      [
        updatedRun.id,
        updatedRun.token,
        JSON.stringify(
          jobs.map((job) => ({
            ...job,
            description:
              job.description + " Updated software responsibilities.",
          }))
        ),
      ]
    )
    const published = (
      await db.query<{ result: { new_count: number; updated_count: number } }>(
        "select finish_catalog_run($1,$2) result",
        [updatedRun.id, updatedRun.token]
      )
    ).rows[0].result
    assert.equal(published.new_count, 0)
    assert.equal(published.updated_count, 1)
    assert.equal(
      new Date(
        (
          await db.query<{ discovered_at: Date }>(
            "select discovered_at from job_catalog"
          )
        ).rows[0].discovered_at
      ).getTime(),
      new Date(discovered).getTime()
    )
    const refreshSnapshot = async (items: typeof jobs) => {
      const run = (
        await db.query<{ result: { id: string; token: string } }>(
          "select begin_catalog_run('ashby:hospital') result"
        )
      ).rows[0].result
      await db.query(
        "select checkpoint_catalog_page($1,$2,1,null,$3::jsonb,$4,0,1)",
        [run.id, run.token, JSON.stringify(items), items.length]
      )
      return (
        await db.query<{
          result: {
            new_count: number
            updated_count: number
            expired_count: number
          }
        }>("select finish_catalog_run($1,$2) result", [run.id, run.token])
      ).rows[0].result
    }
    const sameJobs = jobs.map((job) => ({
      ...job,
      description: job.description + " Updated software responsibilities.",
    }))
    await db.exec(
      "update job_catalog set sponsor_verified=true,last_checked_at=now()-interval '1 hour'"
    )
    const unchanged = await refreshSnapshot(sameJobs)
    assert.equal(unchanged.new_count, 0)
    assert.equal(unchanged.updated_count, 0)
    const observed = (
      await db.query<{ sponsor_verified: boolean; recent: boolean }>(
        "select sponsor_verified,last_checked_at>now()-interval '1 minute' recent from job_catalog"
      )
    ).rows[0]
    assert.equal(observed.sponsor_verified, true)
    assert.equal(observed.recent, true)
    assert.equal(
      (
        await db.query<{ published_count: number }>(
          "select published_count from job_catalog_sources where id='ashby:hospital'"
        )
      ).rows[0].published_count,
      1
    )
    assert.equal((await refreshSnapshot([])).expired_count, 1)
    assert.equal(
      (await db.query("select * from job_catalog where is_active")).rows.length,
      0
    )
    const reopened = await refreshSnapshot(sameJobs)
    assert.equal(reopened.new_count, 0)
    assert.equal(reopened.updated_count, 0)
    assert.equal(
      (
        await db.query(
          "select * from job_catalog where is_active and sponsor_verified"
        )
      ).rows.length,
      1
    )
    assert.equal(
      (
        await refreshSnapshot(
          sameJobs.map((job) => ({
            ...job,
            posted_at: "2026-10-01T12:30:00+02:00",
          }))
        )
      ).updated_count,
      0
    )
    assert.equal(
      (
        await refreshSnapshot(
          sameJobs.map((job) => ({
            ...job,
            posted_at: "2026-10-02T10:30:00.000Z",
          }))
        )
      ).updated_count,
      1
    )
    const batch = async (force = false) =>
      (
        await db.query<{ result: string | null }>(
          "select claim_source_expansion($1) result",
          [force]
        )
      ).rows[0].result
    const firstBatch = await batch()
    assert.ok(firstBatch)
    assert.equal(await batch(true), null)
    await db.query("select finish_source_expansion($1,'{}'::jsonb,false)", [
      firstBatch,
    ])
    assert.equal(
      await batch(),
      null,
      "Continuation requests must not activate another expansion batch"
    )
    const interrupted = await batch(true)
    await db.exec(
      "reset role; update source_expansion_control set lease_until=now()-interval '1 minute'; set role service_role"
    )
    const recovered = await batch(true)
    assert.notEqual(recovered, interrupted)
    await assert.rejects(
      db.query("select finish_source_expansion($1,'{}'::jsonb,false)", [
        interrupted,
      ]),
      /lease/
    )
    await db.query("select finish_source_expansion($1,'{}'::jsonb,false)", [
      recovered,
    ])
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from source_expansion_runs where id=$1",
          [interrupted]
        )
      ).rows[0].status,
      "interrupted"
    )
    // Newly discovered ATS families use the same operator-only lifecycle.
    for (const identity of [
      boardIdentity("smartrecruiters", "Example"),
      boardIdentity("workday", "example.wd5.myworkdayjobs.com~ExternalCareers"),
    ]) {
      const row = {
        ...identity,
        expected_company: null,
        historical_checked_at: null,
        evidence_url: "https://example.com/careers",
      }
      const origin = { ...seedDirectories[3], id: `observed:${identity.kind}` }
      await db.query("select import_source_candidates($1::jsonb,$2::jsonb)", [
        JSON.stringify(origin),
        JSON.stringify([row]),
      ])
      await assert.rejects(
        db.query(
          "select activate_source_candidate($1,'Reviewed public employer source')",
          [row.id]
        ),
        /validation/
      )
      const claimed = (
        await db.query<{ token: string }>(
          "select claim_source_candidate($1)->>'token' token",
          [row.id]
        )
      ).rows[0]
      const smartDetail = {
        id: "123",
        name: "Software Engineer",
        company: { identifier: "Example", name: "Example" },
        active: true,
        visibility: "PUBLIC",
        location: { country: "IN", city: "Hyderabad" },
        releasedDate: "2026-10-01",
        jobAd: {
          sections: { description: { text: posting.descriptionPlain } },
        },
      }
      const externalPath = "/job/Hyderabad/Software-Engineer_R123"
      const response = (url: string) =>
        identity.kind === "smartrecruiters"
          ? url.includes("?")
            ? { offset: 0, totalFound: 1, content: [smartDetail] }
            : smartDetail
          : url.endsWith("/jobs")
            ? {
                total: 1,
                jobPostings: [{ title: "Software Engineer", externalPath }],
              }
            : {
                hiringOrganization: { name: "Example" },
                jobPostingInfo: {
                  title: "Software Engineer",
                  jobPostingSiteId: "ExternalCareers",
                  externalUrl: `https://example.wd5.myworkdayjobs.com/ExternalCareers${externalPath}`,
                  jobDescription: posting.descriptionPlain,
                  location: "India, Hyderabad",
                  country: { descriptor: "India" },
                  startDate: "2026-10-01",
                  canApply: true,
                  posted: true,
                },
              }
      const verified = await validateCandidate(row, async (url) =>
        response(url)
      )
      assert.equal(verified.status, "verified", verified.reason)
      await db.query("select finish_source_candidate($1,$2,$3::jsonb)", [
        row.id,
        claimed.token,
        JSON.stringify(verified),
      ])
      await db.query(
        "select activate_source_candidate($1,'Reviewed public employer source')",
        [row.id]
      )
      const source = (
        await db.query<{ board: string; enabled: boolean }>(
          "select board,enabled from job_source_directory where id=$1",
          [row.id]
        )
      ).rows[0]
      assert.equal(source.enabled, true)
      assert.equal(source.board, identity.board)
      const { fetchCatalogPage } = await import("@/lib/server/catalog/feeds")
      const snapshot = await fetchCatalogPage(
        { ...identity, company: verified.company! },
        1,
        { fetch: async (url) => Response.json(response(String(url))) }
      )
      assert.equal(snapshot.nextPage, null)
      assert.equal(snapshot.jobs.length, 1)
      assert.equal(
        (await db.query("select id from job_catalog where source=$1", [row.id]))
          .rows.length,
        0,
        "activation is not publication"
      )
      const collected = (
        await db.query<{ run: { id: string; token: string } }>(
          "select begin_catalog_run($1) run",
          [row.id]
        )
      ).rows[0].run
      await db.query(
        "select reserve_catalog_storage($1,$2,'checkpoint',10000)",
        [collected.id, collected.token]
      )
      await db.query(
        "select checkpoint_catalog_page($1,$2,1,null,$3::jsonb,1,0,$4)",
        [
          collected.id,
          collected.token,
          JSON.stringify(snapshot.jobs),
          snapshot.requests,
        ]
      )
      await db.query("select reserve_catalog_storage($1,$2,'publish',0)", [
        collected.id,
        collected.token,
      ])
      await db.query("select finish_catalog_run($1,$2)", [
        collected.id,
        collected.token,
      ])
      assert.equal(
        (
          await db.query(
            "select id from job_catalog where source=$1 and is_active",
            [row.id]
          )
        ).rows.length,
        1
      )
    }
    await assert.rejects(
      db.query(
        "insert into source_candidates(id,kind,board) values('workday:evil~Site','workday','evil~Site')"
      ),
      /check/
    )
  } finally {
    await db.close()
  }
})
