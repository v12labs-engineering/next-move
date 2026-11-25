import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import {
  matchingDatabase,
  MATCH_USER,
  OTHER_MATCH_USER,
} from "./helpers/matching-database"

test("scoped invalidation eliminates housekeeping rebuilds, caps admission and fences batch replays", async () => {
  const db = await matchingDatabase()
  try {
    await db.exec(`alter table job_catalog add column description text default '',add column description_ref jsonb;
      insert into job_catalog(id,country) values('de','Germany'),('in','India');`)
    const rpc = async <T>(sql: string, values: unknown[] = []) =>
      (await db.query<{ result: T }>(`select ${sql} as result`, values)).rows[0]
        .result
    const claim = (id = MATCH_USER) =>
      rpc<{ token: string; profileVersion: number } | null>(
        "claim_account_matching($1)",
        [id]
      )
    const publish = (token: string, id = MATCH_USER) =>
      rpc("publish_account_matches($1,$2,'{}',0)", [id, token])
    // Measure old behavior against the identical unchanged-check workload.
    let oldRebuilds = 0
    await publish((await claim())!.token)
    for (let i = 0; i < 5; i++) {
      await db.exec(
        "update job_catalog set last_checked_at=now() where id='de'"
      )
      const run = await claim()
      if (run) {
        oldRebuilds++
        await publish(run.token)
      }
    }
    assert.equal(oldRebuilds, 5)
    for (const name of [
      "202610310023_matching_capacity.sql",
      "202610310024_matching_checkpoints.sql",
      "202610310028_matching_dispatcher.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}`, import.meta.url),
          "utf8"
        )
      )
    await publish((await claim())!.token)
    let newRebuilds = 0
    for (let i = 0; i < 5; i++) {
      await db.exec(
        "update job_catalog set last_checked_at=now() where id='de'"
      )
      if (await claim()) newRebuilds++
    }
    assert.equal(newRebuilds, 0)
    await db.exec(
      "update job_catalog set title='Changed in India' where id='in'"
    )
    assert.equal(
      await claim(),
      null,
      "an unrelated destination must not trigger scoring"
    )
    await db.exec(
      "update account_match_state set computed_at=now()-interval '16 minutes' where user_id='" +
        MATCH_USER +
        "'"
    )
    assert.equal(
      await claim(),
      null,
      "time filters do not need a 15 minute scoring rebuild"
    )
    await db.exec(
      "update job_catalog set description='new requirements' where id='de'"
    )
    const changed = (await claim())!
    assert.ok(changed)
    await publish(changed.token)
    await db.exec(
      "update job_catalog set description_ref=jsonb_build_object('sha256',encode(sha256(convert_to(description,'UTF8')),'hex')),description='' where id='de'"
    )
    assert.equal(
      await claim(),
      null,
      "lossless archival must not invalidate features"
    )
    await db.exec(
      "insert into account_job_states values('" +
        MATCH_USER +
        "','in','interested',now())"
    )
    await db.exec(
      "update job_catalog set title='Changed saved job' where id='in'"
    )
    assert.ok(
      await claim(),
      "saved jobs outside destinations are dependencies too"
    )
    await db.exec(
      "update account_match_state set lease_until=now()-interval '1 minute' where user_id='" +
        MATCH_USER +
        "'; update matching_capacity set max_workers=1 where singleton"
    )
    const active = (await claim())!
    assert.equal(await claim(OTHER_MATCH_USER), null, "global slot cap")
    assert.ok(
      (
        await db.query<{ queued_at: string }>(
          "select queued_at from account_match_state where user_id=$1",
          [OTHER_MATCH_USER]
        )
      ).rows[0].queued_at
    )
    const dispatcher = await rpc<string>("claim_matching_dispatcher()")
    assert.ok(dispatcher)
    assert.equal(
      await rpc("claim_matching_dispatcher()"),
      null,
      "queued work shares one dispatcher"
    )
    assert.equal(
      await rpc("heartbeat_matching_dispatcher($1)", [dispatcher]),
      true
    )
    const context = await rpc<{ cursor: Record<string, unknown> }>(
      "begin_account_match_build($1,$2)",
      [MATCH_USER, active.token]
    )
    const next = { ...context.cursor, batch: 1, phase: "done" }
    const payload = { jobs: [], coverage: [], lexical: [] }
    await rpc("checkpoint_account_match_batch($1,$2,0,$3,$4)", [
      MATCH_USER,
      active.token,
      next,
      payload,
    ])
    await rpc("checkpoint_account_match_batch($1,$2,0,$3,$4)", [
      MATCH_USER,
      active.token,
      next,
      payload,
    ])
    assert.equal(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from account_match_batches"
        )
      ).rows[0].count,
      1
    )
    await db.exec(
      "set role authenticated; set request.jwt.claim.sub='" +
        OTHER_MATCH_USER +
        "'"
    )
    await assert.rejects(
      db.query("select * from account_match_batches"),
      /permission denied/
    )
    await assert.rejects(claim(), /permission denied/)
    await db.exec("reset role")
    await publish(active.token)
    assert.equal(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from account_match_batches"
        )
      ).rows[0].count,
      0
    )
    assert.ok(
      await claim(OTHER_MATCH_USER),
      "queued work acquires a freed slot"
    )
    await assert.rejects(
      rpc("checkpoint_account_match_batch($1,$2,1,$3,$4)", [
        MATCH_USER,
        active.token,
        { ...next, batch: 2 },
        payload,
      ]),
      /superseded/
    )
    assert.equal(
      await rpc("heartbeat_matching_dispatcher($1)", [dispatcher]),
      false,
      "dispatcher retires after queue drains"
    )
    console.log(
      JSON.stringify({
        benchmark: "unchanged_catalog_checks",
        attempts: 5,
        beforeRebuilds: oldRebuilds,
        afterRebuilds: newRebuilds,
      })
    )
  } finally {
    await db.close()
  }
})
