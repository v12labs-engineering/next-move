import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import {
  sourceTaskDatabase,
  taskOperations,
} from "./helpers/source-task-database"

async function fixture() {
  const db = await sourceTaskDatabase()
  await db.exec(`reset role;
    create table source_candidates(id text primary key,status text,validation jsonb);
    grant all on source_candidates to service_role;`)
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202611170081_catalog_task_scheduler.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202611170082_catalog_recovery_queue_order.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  await db.exec("set role service_role")
  const tasks = taskOperations(db)
  const add = async (
    name: string,
    india = true,
    successMinutes: number | null = null
  ) => {
    const id = `ashby:${name}`
    await db.query(
      "insert into job_source_directory(id,kind,company,board,enabled) values($1,'ashby',$2,$2,true)",
      [id, name]
    )
    await db.query(
      "insert into source_candidates values($1,'activated',jsonb_build_object('countries',$2::jsonb))",
      [id, JSON.stringify([india ? "India" : "Germany"])]
    )
    if (successMinutes !== null)
      await db.query(
        "insert into job_catalog_sources(id,last_success_at,published_count) values($1,now()-make_interval(mins=>$2),1)",
        [id, successMinutes]
      )
    return id
  }
  const rpc = tasks.rpc
  return { db, tasks, add, rpc }
}

test("scheduled admission requires evidence and respects hourly India and per-source background cadence", async () => {
  const { db, add, rpc } = await fixture()
  try {
    await add("india-due", true, 56)
    await add("india-fresh", true, 30)
    await add("global-due", false, 121)
    await add("global-fresh", false, 30)
    await db.exec(
      "update job_source_directory set collection_interval_seconds=7200 where id like 'ashby:global-%'"
    )
    await db.exec(
      "insert into job_source_directory(id,kind,company,board,enabled) select 'ashby:unverified'||n,'ashby','Unverified','unverified'||n,true from generate_series(1,100) n"
    )
    const result = await rpc<{
      admitted: { source_id: string }[]
      errors: unknown[]
      dueIndia: number
      dueBackground: number
    }>("admit_catalog_scheduled_tasks(100)")
    assert.deepEqual(
      result.admitted.map((t) => t.source_id),
      ["ashby:india-due", "ashby:global-due"]
    )
    assert.deepEqual(result.errors, [])
    assert.equal(result.dueIndia, 1)
    assert.equal(result.dueBackground, 1)
    assert.equal(
      (await rpc<{ admitted: unknown[] }>("admit_catalog_scheduled_tasks(100)"))
        .admitted.length,
      0
    )
    assert.equal(
      (
        await db.query<{ collection_interval_seconds: number }>(
          "select collection_interval_seconds from job_source_directory where id='ashby:india-due'"
        )
      ).rows[0].collection_interval_seconds,
      3300
    )
    await db.exec("reset role; set role authenticated")
    await assert.rejects(
      rpc("admit_catalog_scheduled_tasks(100)"),
      /permission denied/i
    )
  } finally {
    await db.close()
  }
})

test("outbox reserves in-flight capacity and cannot put background deliveries ahead of India", async () => {
  const { db, add, rpc } = await fixture()
  try {
    for (let i = 0; i < 5; i++) await add(`background${i}`, false)
    await rpc("admit_catalog_scheduled_tasks(100)")
    const first = await rpc<
      { id: string; priority: string; lease_token: string }[]
    >("claim_catalog_scheduled_outbox(4)")
    assert.equal(first.length, 1)
    assert.equal(first[0].priority, "background")
    assert.deepEqual(await rpc("claim_catalog_scheduled_outbox(4)"), [])
    assert.equal(
      await rpc("confirm_catalog_task_outbox($1,$2,'queued-background')", [
        first[0].id,
        first[0].lease_token,
      ]),
      true
    )
    assert.deepEqual(await rpc("claim_catalog_scheduled_outbox(4)"), [])
    for (let i = 0; i < 5; i++) await add(`india${i}`)
    await rpc("admit_catalog_scheduled_tasks(100)")
    const next = await rpc<{ id: string; priority: string }[]>(
      "claim_catalog_scheduled_outbox(4)"
    )
    assert.equal(next.length, 3)
    assert.ok(next.every((t) => t.priority === "india"))
    assert.deepEqual(await rpc("claim_catalog_scheduled_outbox(4)"), [])
    await db.exec(
      "reset role; update catalog_task_outbox set lease_until=now()-interval '1 second' where sent_at is null; set role service_role"
    )
    const recovered = await rpc<{ priority: string }[]>(
      "claim_catalog_scheduled_outbox(4)"
    )
    assert.equal(recovered.length, 3)
    assert.ok(recovered.every((t) => t.priority === "india"))
    await db.exec(
      "reset role; update catalog_task_outbox set lease_until=now()-interval '1 second',sent_at=case when sent_at is not null then now()-interval '6 minutes' end; set role service_role"
    )
    const expiredDelivery = await rpc<unknown[]>(
      "recover_catalog_source_tasks(100)"
    )
    assert.equal(expiredDelivery.length, 1)
    const afterRecovery = await rpc<{ priority: string }[]>(
      "claim_catalog_scheduled_outbox(4)"
    )
    assert.equal(afterRecovery.length, 4)
    assert.ok(afterRecovery.every((t) => t.priority === "india"))
  } finally {
    await db.close()
  }
})

test("crash recovery preserves the older task's queue position and checkpoint", async () => {
  const { db, add, tasks, rpc } = await fixture()
  try {
    const older = await tasks.request("older", await add("older"))
    const firstClaim = await tasks.claim(older.id)
    await rpc("checkpoint_catalog_source_task($1,$2,1,2,'[]'::jsonb,0,0,1)", [
      older.id,
      firstClaim.lease_token,
    ])
    const newer = await tasks.request("newer", await add("newer"))
    await db.exec(
      "reset role; update catalog_source_tasks set lease_until=now()-interval '1 second' where state='running'; update job_catalog_sources set lease_until=now()-interval '1 second'; set role service_role"
    )
    const recovered = await rpc<{ id: string; dispatch_generation: number }[]>(
      "recover_catalog_source_tasks(100)"
    )
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].id, older.id)
    const ordering = await db.query<{ recovery_is_newer: boolean }>(
      "select recovered.available_at>original.available_at as recovery_is_newer from catalog_task_outbox recovered,catalog_task_outbox original where recovered.task_id=$1 and recovered.dispatch_generation=$2 and original.task_id=$3",
      [older.id, recovered[0].dispatch_generation, newer.id]
    )
    assert.equal(ordering.rows[0].recovery_is_newer, true)
    const picked = await rpc<
      { task_id: string; dispatch_generation: number }[]
    >("claim_catalog_scheduled_outbox(1)")
    assert.equal(picked[0].task_id, older.id)
    assert.equal(
      picked[0].dispatch_generation,
      recovered[0].dispatch_generation
    )
    assert.equal((await tasks.claim(older.id, 1)).reason, "stale_delivery")
    const nextClaim = await tasks.claim(
      older.id,
      recovered[0].dispatch_generation
    )
    assert.equal(nextClaim.claimed, true)
    assert.equal(nextClaim.run_id, firstClaim.run_id)
    assert.equal(nextClaim.run?.next_page, 2)
    assert.notEqual(nextClaim.lease_token, firstClaim.lease_token)
  } finally {
    await db.close()
  }
})

test("source worker capacity is four total with at most one background worker", async () => {
  const { db, add, tasks } = await fixture()
  try {
    const bg1 = await tasks.request("bg1", await add("bg1", false))
    const bg2 = await tasks.request("bg2", await add("bg2", false))
    assert.equal((await tasks.claim(bg1.id)).claimed, true)
    assert.equal((await tasks.claim(bg2.id)).reason, "capacity")
    for (let i = 0; i < 3; i++) {
      const india = await tasks.request(`in${i}`, await add(`in${i}`))
      assert.equal((await tasks.claim(india.id)).claimed, true)
    }
    const overflow = await tasks.request("overflow", await add("overflow"))
    assert.equal((await tasks.claim(overflow.id)).reason, "capacity")
  } finally {
    await db.close()
  }
})

test("a workflow atomically takes the next source and replays a lost delivery acknowledgement", async () => {
  const { db, add, tasks, rpc } = await fixture()
  try {
    await add("chain-one")
    await add("chain-two")
    await rpc("admit_catalog_scheduled_tasks(100)")
    const first = await rpc<{ task_id: string; dispatch_generation: number }>(
      "claim_catalog_workflow_delivery('workflow-chain')"
    )
    assert.ok(first.task_id)
    assert.deepEqual(
      await rpc("claim_catalog_workflow_delivery('workflow-chain')"),
      first
    )
    assert.equal(
      (
        await db.query(
          "select 1 from catalog_task_outbox where sent_at is not null"
        )
      ).rows.length,
      1
    )
    const claim = await tasks.claim(first.task_id, first.dispatch_generation)
    await rpc(
      "checkpoint_catalog_source_task($1,$2,1,null,'[]'::jsonb,0,0,1)",
      [first.task_id, claim.lease_token]
    )
    await rpc("finish_catalog_source_task($1,$2)", [
      first.task_id,
      claim.lease_token,
    ])
    const next = await rpc<{ task_id: string; dispatch_generation: number }>(
      "claim_catalog_workflow_delivery('workflow-chain')"
    )
    assert.notEqual(next.task_id, first.task_id)
    assert.deepEqual(
      await rpc("claim_catalog_workflow_delivery('workflow-chain')"),
      next
    )
    assert.equal(
      (await tasks.claim(next.task_id, next.dispatch_generation)).claimed,
      true
    )
    assert.equal(
      await rpc("claim_catalog_workflow_delivery('another-workflow')"),
      null
    )
  } finally {
    await db.close()
  }
})

test("a failed task without a snapshot still enforces its cooldown and gets a fresh request key", async () => {
  const { db, add, tasks, rpc } = await fixture()
  try {
    const source = await add("early-failure")
    const first = await rpc<{ admitted: { id: string }[] }>(
      "admit_catalog_scheduled_tasks(100)"
    )
    await db.exec(
      "reset role; update catalog_source_tasks set state='failed',finished_at=now(),not_before=now()+interval '1 hour'; set role service_role"
    )
    assert.equal(
      (await rpc<{ admitted: unknown[] }>("admit_catalog_scheduled_tasks(100)"))
        .admitted.length,
      0
    )
    await assert.rejects(
      tasks.request("manual-during-cooldown", source),
      /cooldown/
    )
    assert.equal(
      (await rpc<{ failedIndia: number }>("catalog_scheduler_health()"))
        .failedIndia,
      1
    )
    await db.exec(
      "reset role; update catalog_source_tasks set not_before=now()-interval '1 second'; set role service_role"
    )
    const next = await rpc<{ admitted: { id: string }[] }>(
      "admit_catalog_scheduled_tasks(100)"
    )
    assert.equal(next.admitted.length, 1)
    assert.notEqual(next.admitted[0].id, first.admitted[0].id)
  } finally {
    await db.close()
  }
})

const posting = (source: string, id: string) => ({
  id,
  source,
  title: "Software Engineer",
  company: "Fixture",
  country: "India",
  city: "Pune",
  url: `https://example.test/${id}`,
  description:
    "Synthetic test posting with sufficient content for the database publication seam.",
  work_mode: "onsite",
  visa_signal: "possible",
  sponsorship_evidence: "",
  sponsor_verified: false,
  posted_at: new Date().toISOString(),
})

test("an unleased legacy snapshot is adopted at its cursor and its old worker is fenced", async () => {
  const { db, add, tasks, rpc } = await fixture()
  try {
    const source = await add("legacy")
    const old = await rpc<{ id: string; token: string }>(
      "begin_catalog_run($1)",
      [source]
    )
    await rpc("checkpoint_catalog_page($1,$2,1,2,$3::jsonb,1,0,1)", [
      old.id,
      old.token,
      JSON.stringify([posting(source, "legacy-page")]),
    ])
    await assert.rejects(tasks.request("too-early", source), /leased/)
    await rpc("pause_catalog_run($1,$2,null,0)", [old.id, old.token])
    const unrelated = await add("unrelated")
    await db.query(
      "insert into job_catalog_sources(id,current_run) values($1,$2)",
      [unrelated, old.id]
    )
    await assert.rejects(
      tasks.request("wrong-source", unrelated),
      /source mismatch/
    )
    const task = await tasks.request("adopt", source)
    assert.equal(task.run_id, old.id)
    const claim = await tasks.claim(task.id)
    assert.equal(claim.run?.next_page, 2)
    assert.notEqual(claim.lease_token, old.token)
    await assert.rejects(
      rpc("finish_catalog_run($1,$2)", [old.id, old.token]),
      /lease/i
    )
  } finally {
    await db.close()
  }
})

test("terminal failure waits through cooldown then restarts only unpublished staging", async () => {
  const { db, add, tasks, rpc } = await fixture()
  try {
    const source = await add("failure")
    const admission = await rpc<{ admitted: { id: string }[] }>(
      "admit_catalog_scheduled_tasks(100)"
    )
    const taskId = admission.admitted[0].id
    const claim = await tasks.claim(taskId)
    await rpc("checkpoint_catalog_source_task($1,$2,1,2,$3::jsonb,1,0,1)", [
      taskId,
      claim.lease_token,
      JSON.stringify([posting(source, "unpublished")]),
    ])
    await db.query(
      "insert into job_catalog(id,title,company,country,url,description,work_mode,visa_signal,source) values('published','Software Engineer','Fixture','India','https://example.test/published','Existing published data','onsite','possible',$1)",
      [source]
    )
    await rpc(
      "release_catalog_source_work($1,$2,'failed','incomplete_inventory',0,null)",
      [taskId, claim.lease_token]
    )
    assert.equal(
      (await rpc<{ admitted: unknown[] }>("admit_catalog_scheduled_tasks(100)"))
        .admitted.length,
      0
    )
    await db.exec(
      "reset role; update catalog_source_tasks set not_before=now()-interval '1 second' where state='failed'; set role service_role"
    )
    const replacement = await rpc<{
      admitted: { id: string; run_id: string | null }[]
    }>("admit_catalog_scheduled_tasks(100)")
    assert.equal(replacement.admitted.length, 1)
    assert.notEqual(replacement.admitted[0].id, taskId)
    assert.equal(replacement.admitted[0].run_id, null)
    assert.equal(
      (await db.query("select 1 from job_catalog where id='published'")).rows
        .length,
      1
    )
    assert.equal(
      (
        await db.query("select 1 from job_catalog_run_items where run_id=$1", [
          claim.run_id,
        ])
      ).rows.length,
      0
    )
    const next = await tasks.claim(replacement.admitted[0].id)
    assert.notEqual(next.run_id, claim.run_id)
    assert.equal(next.run?.next_page, 1)
  } finally {
    await db.close()
  }
})

test("exhausted transient retries respect provider backoff before a fresh snapshot is admitted", async () => {
  const { db, add, tasks, rpc } = await fixture()
  try {
    const task = await tasks.request("retry", await add("retry"))
    let generation = task.dispatch_generation
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claim = await tasks.claim(task.id, generation)
      assert.equal(claim.claimed, true)
      const released = await rpc<{
        state: string
        dispatch_generation: number
      }>(
        "release_catalog_source_work($1,$2,'retry','provider_backoff',1,now()+interval '3 hours')",
        [task.id, claim.lease_token]
      )
      assert.equal(released.state, attempt < 5 ? "waiting" : "failed")
      assert.deepEqual(await rpc("recover_catalog_source_tasks(100)"), [])
      generation = released.dispatch_generation
      if (attempt < 5) {
        await db.exec(
          "reset role; update catalog_source_tasks set not_before=now()-interval '1 second' where state='waiting'; update job_catalog_runs set retry_at=now()-interval '1 second'; set role service_role"
        )
      }
    }
    assert.equal(
      (
        await db.query<{ honors_provider: boolean }>(
          "select not_before>=now()+interval '179 minutes' as honors_provider from catalog_source_tasks where id=$1",
          [task.id]
        )
      ).rows[0].honors_provider,
      true
    )
    assert.equal(
      (await rpc<{ admitted: unknown[] }>("admit_catalog_scheduled_tasks(100)"))
        .admitted.length,
      0
    )
  } finally {
    await db.close()
  }
})

test("continuation confirmation is replayable and a competing publisher is respected", async () => {
  const { db, add, tasks, rpc } = await fixture()
  try {
    const task = await tasks.request("continuation", await add("continuation"))
    const claim = await tasks.claim(task.id)
    const released = await rpc<{ dispatch_generation: number }>(
      "release_catalog_source_work($1,$2,'continue','page_budget',0,null)",
      [task.id, claim.lease_token]
    )
    assert.equal(
      await rpc("confirm_catalog_task_continuation($1,$2,'workflow-one')", [
        task.id,
        released.dispatch_generation,
      ]),
      true
    )
    assert.equal(
      await rpc("confirm_catalog_task_continuation($1,$2,'workflow-one')", [
        task.id,
        released.dispatch_generation,
      ]),
      true
    )
    assert.equal(
      await rpc("confirm_catalog_task_continuation($1,$2,'workflow-two')", [
        task.id,
        released.dispatch_generation,
      ]),
      false
    )
    assert.deepEqual(await rpc("claim_catalog_scheduled_outbox(4)"), [])
    const next = await tasks.claim(task.id, released.dispatch_generation)
    const later = await rpc<{ dispatch_generation: number }>(
      "release_catalog_source_work($1,$2,'continue','page_budget',0,null)",
      [task.id, next.lease_token]
    )
    await rpc("claim_catalog_scheduled_outbox(4)")
    assert.equal(
      await rpc("confirm_catalog_task_continuation($1,$2,'workflow-one')", [
        task.id,
        later.dispatch_generation,
      ]),
      false
    )
  } finally {
    await db.close()
  }
})

test("maintenance survives a lost acknowledgement and expired ownership is reclaimed", async () => {
  const { db, rpc } = await fixture()
  try {
    const first = await rpc<string>("claim_catalog_scheduler_maintenance()")
    assert.ok(first)
    assert.equal(await rpc("claim_catalog_scheduler_maintenance()"), null)
    await db.exec(
      "reset role; update catalog_scheduler_state set maintenance_lease_until=now()-interval '1 second'; set role service_role"
    )
    const next = await rpc<string>("claim_catalog_scheduler_maintenance()")
    assert.notEqual(next, first)
    await assert.rejects(
      rpc("finish_catalog_scheduler_maintenance($1)", [first]),
      /lease lost/
    )
    await rpc("finish_catalog_scheduler_maintenance($1)", [next])
    await rpc("finish_catalog_scheduler_maintenance($1)", [next])
    assert.equal(await rpc("claim_catalog_scheduler_maintenance()"), null)
    await rpc("record_catalog_scheduler_tick('fixture failure')")
    assert.equal(
      (await rpc<{ lastError: string }>("catalog_scheduler_health()"))
        .lastError,
      "fixture failure"
    )
    await rpc("record_catalog_scheduler_tick(null)")
    assert.equal(
      (await rpc<{ lastError: string | null }>("catalog_scheduler_health()"))
        .lastError,
      null
    )
  } finally {
    await db.close()
  }
})
