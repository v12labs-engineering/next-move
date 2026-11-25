import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import {
  matchingDatabase,
  MATCH_USER,
  OTHER_MATCH_USER,
} from "./helpers/matching-database"

test("software scope filters legacy cached jobs before pagination/counts, preserves history and fences workers", async () => {
  const db = await matchingDatabase()
  try {
    const apply = async (name: string) =>
      db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
          "utf8"
        )
      )
    for (const migration of [
      "202610310023_matching_capacity",
      "202610310024_matching_checkpoints",
      "202610310025_shared_match_reader",
      "202610310026_matching_status",
      "202610310027_compact_match_storage",
      "202611010033_rule_scorer",
    ])
      await apply(migration)
    const generation = "00000000-0000-4000-8000-000000000010"
    const worker = "00000000-0000-4000-8000-000000000011"
    await db.query(
      `insert into account_match_state(user_id,generation,profile_version,catalog_revision,computed_at,token,building_version,lease_until)
       values($1,$2,1,1,now(),$3,1,now()+interval '10 minutes')`,
      [MATCH_USER, generation, worker]
    )
    const entries = [
      { id: "a-legacy-nurse", title: "Nurse" },
      { id: "b-civil", title: "Civil Engineer", softwareRole: false },
      { id: "c-cto", title: "CTO", softwareRole: true },
      { id: "d-junior", title: "Junior Software Engineer", softwareRole: true },
      { id: "e-history", title: "Accountant" },
    ]
    for (const row of entries) {
      await db.query("insert into job_catalog(id,title) values($1,$2)", [
        row.id,
        row.title,
      ])
      const job = {
        id: row.id,
        title: row.title,
        company: "Example",
        country: "Germany",
        url: `https://example.com/${row.id}`,
        seenAt: new Date().toISOString(),
        postedDate: new Date().toISOString(),
        visaSignal: "possible",
        match: {
          score: 80,
          relevant: true,
          reviewable: true,
          eligible: true,
          softwareRole: row.softwareRole,
        },
      }
      await db.query(
        "insert into account_match_jobs(user_id,generation,job_id,job) values($1,$2,$3,$4)",
        [MATCH_USER, generation, row.id, job]
      )
    }
    await db.exec("select compact_account_matches(200)")
    await db.query(
      "insert into account_job_states(user_id,job_id,status) values($1,'e-history','applied')",
      [MATCH_USER]
    )
    await apply("202611020041_software_role_scope")
    const state = (
      await db.query<{ token: string | null; computed_at: string | null }>(
        "select token,computed_at from account_match_state where user_id=$1",
        [MATCH_USER]
      )
    ).rows[0]
    assert.equal(state.token, null)
    assert.equal(state.computed_at, null)
    assert.equal(
      (await db.query("select * from job_catalog")).rows.length,
      entries.length
    )
    await apply("202611160072_restore_compact_match_reader")
    await db.query(
      `update account_match_state
       set computed_at=now(),catalog_revision=account_matching_revision(user_id)
       where user_id=$1`,
      [MATCH_USER]
    )
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='${MATCH_USER}'`
    )
    const read = async (filters: object) =>
      (
        await db.query<{
          page: {
            jobs: { id: string; title: string; company: string }[]
            total: number
            counts: { new: number; toReview: number }
            matching: { stale: boolean; profileCurrent: boolean }
          }
        }>("select read_account_matches($1) page", [filters])
      ).rows[0].page
    const first = await read({ view: "jobs", limit: 1 })
    assert.deepEqual(
      first.jobs.map((job) => job.id),
      ["c-cto"]
    )
    assert.equal(first.total, 2)
    assert.equal(first.jobs[0].title, "CTO")
    assert.equal(first.jobs[0].company, "Example")
    assert.equal(first.counts.new, 2)
    assert.equal(first.counts.toReview, 2)
    assert.equal(first.matching.stale, false)
    assert.equal(first.matching.profileCurrent, true)
    assert.deepEqual(
      (await read({ view: "jobs", limit: 1, offset: 1 })).jobs.map(
        (job) => job.id
      ),
      ["d-junior"]
    )
    assert.deepEqual(
      (await read({ view: "saved" })).jobs.map((job) => job.id),
      ["e-history"]
    )
    await assert.rejects(
      db.query("select read_account_matches_for($1,'{}')", [OTHER_MATCH_USER]),
      /permission denied/
    )
    await db.exec(`set request.jwt.claim.sub='${OTHER_MATCH_USER}'`)
    assert.equal((await read({ view: "all" })).total, 0)
    await db.exec("set role anon")
    await assert.rejects(read({}), /permission denied/)
  } finally {
    await db.close()
  }
})
