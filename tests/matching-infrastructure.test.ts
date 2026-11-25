import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import {
  matchingDatabase,
  MATCH_USER,
  OTHER_MATCH_USER,
} from "./helpers/matching-database"
import { measureMatching } from "@/lib/server/matching/metrics"

test("compact scores preserve reader output and lightweight polling preserves ownership", async () => {
  const db = await matchingDatabase()
  try {
    for (const name of [
      "023_matching_capacity",
      "024_matching_checkpoints",
      "025_shared_match_reader",
      "026_matching_status",
      "027_compact_match_storage",
      "029_matching_observability",
    ])
      await db.exec(
        await readFile(
          new URL(
            `../supabase/migrations/202610310${name}.sql`,
            import.meta.url
          ),
          "utf8"
        )
      )
    const health = (
      await db.query<{
        result: { databaseBytes: number; activeWorkers: number }
      }>("select matching_operational_status() result")
    ).rows[0].result
    assert.ok(health.databaseBytes > 0)
    assert.equal(health.activeWorkers, 0)
    await db.exec("insert into job_catalog(id) values('shared')")
    const now = new Date().toISOString()
    const job = {
      id: "shared",
      country: "Germany",
      title: "Backend Engineer",
      company: "Public employer",
      url: "https://example.com/shared",
      remote: "onsite",
      source: "Public listing source",
      visaSignal: "possible",
      sponsorVerified: false,
      seenAt: now,
      postedDate: now,
      lastCheckedAt: now,
      status: "new",
      isActive: true,
      freshness: "fresh",
      match: { score: 80, relevant: true, reviewable: true, eligible: true },
    }
    for (const user of [MATCH_USER, OTHER_MATCH_USER]) {
      const {
        rows: [{ run }],
      } = await db.query<{ run: { token: string } }>(
        "select claim_account_matching($1) run",
        [user]
      )
      await db.query("select stage_account_matches($1,$2,$3)", [
        user,
        run.token,
        [job],
      ])
      await db.query("select publish_account_matches($1,$2,'{}',1)", [
        user,
        run.token,
      ])
    }
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from match_listing_snapshots"
        )
      ).rows[0].n,
      1
    )
    const stored = (
      await db.query<{ job: object }>("select job from account_match_jobs")
    ).rows
    assert.ok(
      stored.every((row) => !("title" in row.job)),
      "public metadata must not be duplicated per account"
    )
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='${MATCH_USER}'`
    )
    const page = (
      await db.query<{ result: { jobs: (typeof job)[]; generation: string } }>(
        "select read_account_matches('{}') result"
      )
    ).rows[0].result
    assert.deepEqual(
      page.jobs.map((row) => ({ ...row, lastCheckedAt: undefined })),
      [{ ...job, lastCheckedAt: undefined }]
    )
    assert.ok(
      page.jobs[0].lastCheckedAt,
      "availability timestamps come from the live catalogue"
    )
    const status = (
      await db.query<{
        result: { generation: string; matching: { stale: boolean } }
      }>("select read_account_matching_status() result")
    ).rows[0].result
    assert.equal(status.generation, page.generation)
    assert.equal(status.matching.stale, false)
    await assert.rejects(
      db.query("select read_account_matches_for($1,'{}')", [OTHER_MATCH_USER]),
      /permission denied/
    )
    await assert.rejects(
      db.query("select matching_operational_status()"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select * from match_listing_snapshots"),
      /permission denied/
    )
    await db.exec("reset role")
    // Live status is independent of shared public snapshots.
    await db.query(
      "insert into account_job_states values($1,'shared','interested',now())",
      [MATCH_USER]
    )
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='${MATCH_USER}'`
    )
    const changed = (
      await db.query<{ result: { jobs: (typeof job)[] } }>(
        "select read_account_matches('{}') result"
      )
    ).rows[0].result
    assert.equal(changed.jobs[0].status, "interested")
    await db.exec("reset role")
    // Simulate old rows: bounded compaction reconstructs exactly the same page.
    await db.query(
      "update account_match_jobs set listing_key=null,job=$1 where user_id=$2",
      [job, MATCH_USER]
    )
    assert.equal(
      (await db.query<{ n: number }>("select compact_account_matches(1) n"))
        .rows[0].n,
      1
    )
    const beforeBytes = Buffer.byteLength(JSON.stringify(job)) * 100
    const compactBytes =
      Buffer.byteLength(JSON.stringify(stored[0].job)) * 100 +
      Buffer.byteLength(
        JSON.stringify({
          ...job,
          match: undefined,
          status: undefined,
          lastCheckedAt: undefined,
          freshness: undefined,
        })
      )
    assert.ok(compactBytes < beforeBytes)
    console.log(
      JSON.stringify({
        benchmark: "100_account_score_payloads",
        beforeBytes,
        compactBytes,
        note: "JSON payload estimate; excludes indexes and TOAST",
      })
    )
    assert.equal(
      (await db.query<{ n: number }>("select prune_match_snapshots(200) n"))
        .rows[0].n,
      0
    )
    await db.exec("delete from account_match_jobs where job_id='shared'")
    assert.equal(
      (await db.query<{ n: number }>("select prune_match_snapshots(200) n"))
        .rows[0].n,
      1
    )
  } finally {
    await db.close()
  }
})

test("failure instrumentation records duration without private error text or raw lease tokens", async (t) => {
  const logs: string[] = []
  t.mock.method(console, "log", (line: string) => logs.push(line))
  await assert.rejects(
    measureMatching(
      "inference",
      async () => {
        throw new Error("private resume")
      },
      "secret lease"
    )
  )
  assert.equal(logs.length, 1)
  assert.ok(!logs[0].includes("private resume"))
  assert.ok(!logs[0].includes("secret lease"))
  assert.equal(JSON.parse(logs[0]).ok, false)
})
