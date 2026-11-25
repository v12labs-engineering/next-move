import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { seedDirectories } from "@/lib/server/catalog/discovery/seeds"
import {
  probeClient,
  validateCandidate,
} from "@/lib/server/catalog/discovery/validate"
import {
  boardIdentity,
  publicBoardUrl,
} from "@/lib/server/catalog/source-identity"
import { advanceCollection } from "@/lib/server/catalog/source-worker"
import { sourceWorkerDatabase } from "./helpers/source-worker-database"
import { taskOperations } from "./helpers/source-task-database"

const identities = [
  boardIdentity("teamtailor", "acme.teamtailor.com"),
  boardIdentity("personio", "acme.jobs.personio.com"),
]
const published = new Date(Date.now() - 86_400_000).toISOString()
const description =
  "Build distributed software services and APIs, write automated tests, and maintain reliable production systems with the engineering team."
function candidate(identity: (typeof identities)[number]) {
  return {
    ...identity,
    expected_company: "Acme",
    historical_checked_at: null,
    evidence_url: publicBoardUrl(identity.kind, identity.board),
  }
}
function fixtureTransport(
  identity: (typeof identities)[number],
  robots = "User-agent: *\nAllow: /",
  title = "Software Engineer"
) {
  const origin = publicBoardUrl(identity.kind, identity.board)
  const seen: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    seen.push(url.href)
    assert.equal(url.origin, origin)
    if (url.pathname === "/robots.txt") return new Response(robots)
    if (identity.kind === "teamtailor") {
      assert.equal(url.pathname, "/jobs.rss")
      return new Response(
        `<rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>Acme</title><description>Current openings</description><link>${origin}/jobs</link><item><title>${title}</title><description><![CDATA[${description}]]></description><pubDate>${new Date(published).toUTCString()}</pubDate><link>${origin}/jobs/7-software-engineer</link><guid>00000000-0000-4000-8000-000000000007</guid><remoteStatus>none</remoteStatus><tt:locations><tt:location><tt:name>Pune</tt:name><tt:city>Pune</tt:city><tt:country>India</tt:country></tt:location></tt:locations></item></channel></rss>`
      )
    }
    if (url.pathname === "/xml")
      return new Response(
        `<workzag-jobs><position><id>7</id><name>${title}</name><subcompany>Acme</subcompany><office>Pune</office><jobDescriptions><jobDescription><name>Role</name><value><![CDATA[${description}]]></value></jobDescription></jobDescriptions><createdAt>2010-01-01T00:00:00Z</createdAt></position></workzag-jobs>`
      )
    if (url.pathname === "/")
      return new Response(
        `<title>Jobs at Acme</title><link rel="canonical" href="${origin}/?language=en">`
      )
    assert.equal(url.pathname, "/job/7")
    return new Response(
      `<link rel="canonical" href="${origin}/job/7?language=en"><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title, identifier: { value: "7-123" }, hiringOrganization: { name: "Acme" }, datePosted: published, jobLocation: { address: { addressCountry: "IN", addressLocality: "Pune" } } })}</script>`
    )
  }
  return { fetch, seen }
}

test("XML ATS discovery uses trusted hosts, live identity and robots rules", async () => {
  for (const identity of identities) {
    const read = fixtureTransport(identity)
    const result = await validateCandidate(
      candidate(identity),
      probeClient(read.fetch)
    )
    assert.equal(result.status, "verified", result.reason)
    assert.equal(result.company, "Acme")
    assert.equal(result.accepted_count, 1)
    assert.equal(result.fresh_count, 1)
    assert.equal(result.complete, true)
    assert.deepEqual(result.countries, ["India"])
    assert.equal(
      read.seen.filter((url) => url.endsWith("/robots.txt")).length,
      1
    )
    const blocked = fixtureTransport(identity, "User-agent: *\nDisallow: /")
    const refused = await validateCandidate(
      candidate(identity),
      probeClient(blocked.fetch)
    )
    assert.equal(refused.status, "needs_review")
    assert.match(refused.reason, /robots/)
    assert.equal(blocked.seen.length, 1)
    const changed = await validateCandidate(
      { ...candidate(identity), expected_company: "Different Employer" },
      probeClient(fixtureTransport(identity).fetch)
    )
    assert.equal(changed.status, "needs_review")
    assert.match(changed.reason, /employer label/)
    const nonSoftware = await validateCandidate(
      candidate(identity),
      probeClient(
        fixtureTransport(identity, undefined, "Account Executive").fetch
      )
    )
    assert.equal(
      nonSoftware.status,
      "verified",
      "Source evidence is independent of catalog job categories"
    )
    await assert.rejects(
      probeClient(async () =>
        assert.fail("Untrusted host must not be requested")
      )(`https://${identity.board}.evil.test/xml`, "html"),
      /Untrusted provider/
    )
  }
})

test("XML ATS candidates activate and publish through the protected shared collection path", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    await db.exec("reset role")
    for (const migration of [
      "202611070060_public_ats_readers.sql",
      "202611070061_scheduled_archive_discovery.sql",
      "202611160074_amazon_india_catalog.sql",
      "202611160075_regional_employer_catalog.sql",
      "202611170076_keka_zoho_recruit_sources.sql",
      "202611170077_teamtailor_personio_sources.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${migration}`, import.meta.url),
          "utf8"
        )
      )
    await db.exec("set role service_role")
    const partitions = ["personio-com", "personio-de", "teamtailor"]
    assert.deepEqual(
      (
        await db.query<{ partition: string }>(
          "select partition from archive_discovery_channels where partition=any($1::text[]) order by partition",
          [partitions]
        )
      ).rows.map((row) => row.partition),
      partitions
    )
    assert.equal(
      (
        await db.query<{ daily_page_limit: number }>(
          "select daily_page_limit from archive_discovery_control"
        )
      ).rows[0].daily_page_limit,
      12,
      "Adding platforms must not increase the shared archive budget"
    )
    await db.query(
      "update archive_discovery_channels set next_attempt_at=now()+interval '1 day' where not (partition=any($1::text[]))",
      [partitions]
    )
    await db.exec("update archive_discovery_control set daily_page_limit=0")
    assert.deepEqual(
      (
        await db.query<{ result: unknown }>(
          "select claim_archive_discovery('xml-disabled-budget') result"
        )
      ).rows[0].result,
      { claimed: false, reason: "daily_page_limit" }
    )
    await db.exec("update archive_discovery_control set daily_page_limit=12")
    for (const partition of partitions) {
      const claim = (
        await db.query<{
          result: {
            claimed: boolean
            id: string
            token: string
            partition: string
          }
        }>("select claim_archive_discovery($1) result", [
          `xml-archive-${partition}`,
        ])
      ).rows[0].result
      assert.equal(claim.claimed, true)
      assert.equal(claim.partition, partition)
      const competing = (
        await db.query<{ result: { claimed: boolean; reason: string } }>(
          "select claim_archive_discovery($1) result",
          [`xml-archive-competing-${partition}`]
        )
      ).rows[0].result
      assert.deepEqual(competing, { claimed: false, reason: "leased" })
      await db.query(
        "select finish_archive_discovery($1,$2,'failed',null,'fixture-network-unavailable')",
        [claim.id, claim.token]
      )
    }
    await assert.rejects(
      db.query(
        "insert into archive_discovery_channels(partition) values('unknown-platform')"
      ),
      /check/
    )
    for (const identity of identities) {
      const input = candidate(identity)
      const importCandidate = () =>
        db.query<{ result: { new_candidates: number } }>(
          "select import_source_candidates($1::jsonb,$2::jsonb) result",
          [JSON.stringify(seedDirectories[3]), JSON.stringify([input])]
        )
      assert.equal((await importCandidate()).rows[0].result.new_candidates, 1)
      assert.equal((await importCandidate()).rows[0].result.new_candidates, 0)
      await assert.rejects(
        db.query(
          "select activate_source_candidate($1,'Reviewed public provider evidence')",
          [identity.id]
        ),
        /validation/
      )
      const validation = await validateCandidate(
        input,
        probeClient(fixtureTransport(identity).fetch)
      )
      assert.equal(validation.status, "verified", validation.reason)
      const claim = (
        await db.query<{ token: string }>(
          "select claim_source_candidate($1)->>'token' token",
          [identity.id]
        )
      ).rows[0]
      await db.query("select finish_source_candidate($1,$2,$3::jsonb)", [
        identity.id,
        claim.token,
        JSON.stringify(validation),
      ])
      await db.query(
        "select activate_source_candidate($1,'Reviewed public provider evidence')",
        [identity.id]
      )
      assert.deepEqual(
        (
          await db.query(
            "select enabled,company,countries from job_source_directory where id=$1",
            [identity.id]
          )
        ).rows,
        [{ enabled: true, company: "Acme", countries: ["India"] }]
      )
      assert.equal(
        (
          await db.query("select id from job_catalog where source=$1", [
            identity.id,
          ])
        ).rows.length,
        0,
        "Activation alone must not publish jobs"
      )
    }
    const run = (
      await db.query<{ id: string }>(
        "insert into job_search_runs(scope_key,roles,countries) values('xml-ats-fixture',array['software engineer'],array['India']) returning id"
      )
    ).rows[0]
    const pool = (
      await db.query<{ result: { id: string }[] }>(
        "select job_search_source_pool($1,array['%software%']) result",
        [run.id]
      )
    ).rows[0].result
    assert.deepEqual(
      pool.map((source) => source.id).sort(),
      identities.map((source) => source.id).sort()
    )
    const tasks = taskOperations(db)
    for (const identity of identities) {
      const task = await tasks.request(
        `xml-ats-worker-${identity.kind}`,
        identity.id
      )
      const read = fixtureTransport(identity)
      const result = await advanceCollection(
        { taskId: task.id, dispatchGeneration: 1 },
        { database, fetch: read.fetch }
      )
      assert.equal(result.status, "completed", JSON.stringify(result))
      const settled = await tasks.read(task.id)
      assert.equal(settled.state, "completed")
      assert.equal(settled.run?.next_page, null)
      assert.equal(
        settled.run?.request_count,
        identity.kind === "personio" ? 3 : 1
      )
      assert.deepEqual(
        (
          await db.query(
            "select title,company,country,city,is_active from job_catalog where source=$1",
            [identity.id]
          )
        ).rows,
        [
          {
            title: "Software Engineer",
            company: "Acme",
            country: "India",
            city: "Pune",
            is_active: true,
          },
        ]
      )
      const replay = await advanceCollection(
        { taskId: task.id, dispatchGeneration: 1 },
        {
          database,
          fetch: async () => assert.fail("Completed tasks must not refetch"),
        }
      )
      assert.equal(replay.status, "completed")
    }
    for (const [kind, board] of [
      ["teamtailor", "acme.teamtailor.com.evil.test"],
      ["teamtailor", "api.teamtailor.com"],
      ["personio", "acme.jobs.personio.com.evil.test"],
      ["personio", "api.jobs.personio.de"],
    ]) {
      await assert.rejects(
        db.query(
          "insert into source_candidates(id,kind,board) values($1,$2,$3)",
          [`${kind}:${board}`, kind, board]
        ),
        /check/
      )
      await assert.rejects(
        db.query(
          "insert into job_source_directory(id,kind,board,company) values($1,$2,$3,'Acme')",
          [`${kind}:${board}`, kind, board]
        ),
        /check/
      )
    }
    await db.exec("reset role; set role authenticated")
    await assert.rejects(
      db.query(
        "select activate_source_candidate($1,'Unauthorized activation attempt')",
        [identities[0].id]
      ),
      /permission denied/
    )
    await assert.rejects(
      db.query("select * from source_candidates"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select * from archive_discovery_channels"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select claim_archive_discovery('unauthorized-xml-archive')"),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})
