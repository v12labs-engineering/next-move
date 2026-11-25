import assert from "node:assert/strict"
import test from "node:test"
import {
  sourceTaskDatabase,
  taskOperations,
} from "./helpers/source-task-database"

test("repeated source requests coalesce and retain one recoverable delivery intent", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db)
    const [first, duplicate, joined] = await Promise.all([
      tasks.request(),
      tasks.request(),
      tasks.request("operator-request"),
    ])
    assert.equal(duplicate.id, first.id)
    assert.equal(joined.id, first.id)
    assert.equal(first.state, "pending")
    const messages = await tasks.outbox()
    assert.equal(messages.length, 1)
    assert.equal(messages[0].task_id, first.id)
    assert.equal(
      (await tasks.outbox()).length,
      0,
      "A live publisher lease excludes duplicate dispatch"
    )
    assert.equal((await tasks.read(first.id)).state, "pending")
  } finally {
    await db.close()
  }
})

test("duplicate delivery claims one source attempt and fences stale generations", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db)
    const requested = await tasks.request()
    const [first, duplicate] = await Promise.all([
      tasks.claim(requested.id),
      tasks.claim(requested.id),
    ])
    assert.equal(first.claimed, true)
    assert.ok(first.run_id)
    assert.ok(first.lease_token)
    assert.equal(duplicate.claimed, false)
    assert.equal(duplicate.reason, "leased")
    assert.equal((await tasks.read(requested.id)).attempts, 1)
    assert.equal((await tasks.claim(requested.id, 99)).reason, "stale_delivery")
  } finally {
    await db.close()
  }
})

const posting = (id: string) => ({
  id,
  source: "ashby:n8n",
  title: "Synthetic engineer",
  company: "n8n",
  country: "Germany",
  city: "Berlin",
  url: `https://jobs.ashbyhq.com/n8n/${id}`,
  description: "A synthetic listing used only in the isolated database test.",
  work_mode: "remote",
  visa_signal: "possible",
  sponsorship_evidence: "",
  sponsor_verified: false,
  posted_at: new Date().toISOString(),
})

test("a lost checkpoint response replays its receipt even after later pages, without repeating counters", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db),
      requested = await tasks.request()
    const claim = await tasks.claim(requested.id)
    const page = [posting("fixture-one")]
    const checkpoint = (n: number, next: number | null, rows = page) =>
      tasks.rpc<{ pages: number; next_page: number | null }>(
        "checkpoint_catalog_source_task($1,$2,$3,$4,$5::jsonb,1,0,1)",
        [requested.id, claim.lease_token, n, next, JSON.stringify(rows)]
      )
    const first = await checkpoint(1, 2)
    await checkpoint(2, null, [posting("fixture-two")])
    assert.deepEqual(
      await checkpoint(1, 2),
      first,
      "The original committed receipt survives later steps"
    )
    const state = await tasks.read(requested.id)
    assert.equal(state.run?.pages, 2)
    assert.equal(state.run?.fetched_count, 2)
    assert.equal(state.run?.request_count, 2)
    assert.equal(state.run?.accepted_count, 2)
    assert.equal(state.run?.next_page, null)
    assert.equal(state.receipt_count, 2)
    await assert.rejects(checkpoint(1, 3), /receipt conflict/i)
    assert.equal((await tasks.read(requested.id)).receipt_count, 2)
  } finally {
    await db.close()
  }
})

test("publisher death and lost delivery recover from durable intents and fence old messages", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db),
      requested = await tasks.request()
    const [lost] = await tasks.outbox()
    // Fault injection: a publisher dies after claiming but before confirming send.
    await db.exec("reset role")
    await db.query(
      "update catalog_task_outbox set lease_until=now()-interval '1 second' where id=$1",
      [lost.id]
    )
    await db.exec("set role service_role")
    const [replacement] = await tasks.outbox()
    assert.equal(replacement.id, lost.id)
    assert.notEqual(replacement.lease_token, lost.lease_token)
    const confirm = (token: string) =>
      tasks.rpc<boolean>(
        "confirm_catalog_task_outbox($1,$2,'fixture-message')",
        [lost.id, token]
      )
    assert.equal(await confirm(lost.lease_token), false)
    assert.equal(await confirm(replacement.lease_token), true)
    assert.equal(
      await confirm(replacement.lease_token),
      true,
      "Lost confirmation responses are replayable"
    )
    // Fault injection: the queue lost/expired a confirmed message before delivery.
    await db.exec("reset role")
    await db.query(
      "update catalog_task_outbox set sent_at=now()-interval '6 minutes' where id=$1",
      [lost.id]
    )
    await db.exec("set role service_role")
    const recovered = await tasks.rpc<
      { id: string; dispatch_generation: number }[]
    >("recover_catalog_source_tasks(10)")
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].id, requested.id)
    assert.equal(recovered[0].dispatch_generation, 2)
    assert.equal((await tasks.claim(requested.id, 1)).reason, "stale_delivery")
    const [message] = await tasks.outbox()
    assert.equal(message.dispatch_generation, 2)
    assert.equal((await tasks.claim(requested.id, 2)).claimed, true)
  } finally {
    await db.close()
  }
})

test("worker death after a committed page resumes the same run and rejects the replaced worker", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db),
      requested = await tasks.request()
    const old = await tasks.claim(requested.id)
    const page = JSON.stringify([posting("before-crash")])
    const checkpoint = (token: string | null, n = 1, next: number | null = 2) =>
      tasks.rpc<{ pages: number }>(
        "checkpoint_catalog_source_task($1,$2,$3,$4,$5::jsonb,1,0,1)",
        [requested.id, token, n, next, page]
      )
    const committed = await checkpoint(old.lease_token)
    await db.exec("reset role")
    await db.query(
      "update catalog_source_tasks set lease_until=now()-interval '1 second' where id=$1",
      [requested.id]
    )
    await db.exec("set role service_role")
    assert.deepEqual(
      await tasks.rpc("recover_catalog_source_tasks(10)"),
      [],
      "A live source lease prevents takeover"
    )
    await db.exec("reset role")
    await db.query(
      "update job_catalog_sources set lease_until=now()-interval '1 second' where id='ashby:n8n'"
    )
    await db.exec("set role service_role")
    await tasks.rpc("recover_catalog_source_tasks(10)")
    const replacement = await tasks.claim(requested.id, 2)
    assert.equal(replacement.run_id, old.run_id)
    assert.notEqual(replacement.lease_token, old.lease_token)
    assert.equal(replacement.run?.next_page, 2)
    await assert.rejects(checkpoint(old.lease_token, 2, null), /lease lost/i)
    assert.deepEqual(await checkpoint(replacement.lease_token), committed)
    await checkpoint(replacement.lease_token, 2, null)
    const status = await tasks.read(requested.id)
    assert.equal(status.attempts, 2)
    assert.equal(status.run?.pages, 2)
    assert.equal(status.run?.fetched_count, 2)
    await assert.rejects(
      tasks.rpc("finish_catalog_source_task($1,$2)", [
        requested.id,
        old.lease_token,
      ]),
      /lease lost/i
    )
    await tasks.rpc("finish_catalog_source_task($1,$2)", [
      requested.id,
      replacement.lease_token,
    ])
    await assert.rejects(
      tasks.rpc("finish_catalog_source_task($1,$2)", [
        requested.id,
        old.lease_token,
      ]),
      /lease lost/i
    )
  } finally {
    await db.close()
  }
})

test("publication and its receipt commit together, and post-publication delivery cannot publish twice", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db),
      requested = await tasks.request()
    await tasks.request("joined-request")
    const claim = await tasks.claim(requested.id)
    const finish = () =>
      tasks.rpc<{ new_count: number; accepted_count: number }>(
        "finish_catalog_source_task($1,$2)",
        [requested.id, claim.lease_token]
      )
    await assert.rejects(finish(), /incomplete/i)
    await tasks.rpc(
      "checkpoint_catalog_source_task($1,$2,1,null,$3::jsonb,1,0,1)",
      [
        requested.id,
        claim.lease_token,
        JSON.stringify([posting("published-once")]),
      ]
    )
    // Fault injection at the storage seam: receipt persistence fails after the
    // publisher has executed. The entire RPC must roll back, including jobs.
    await db.exec(`reset role;
      create function reject_task_publication_receipt() returns trigger language plpgsql as $$
      begin if new.operation='publish' then raise exception 'Injected receipt failure'; end if; return new; end $$;
      create trigger reject_task_publication_receipt before insert on catalog_source_task_receipts for each row execute function reject_task_publication_receipt();
      set role service_role;`)
    await assert.rejects(finish(), /Injected receipt failure/)
    assert.equal((await tasks.read(requested.id)).state, "running")
    assert.equal(
      (await db.query("select id from job_catalog where id='published-once'"))
        .rows.length,
      0
    )
    await db.exec(
      "reset role; drop trigger reject_task_publication_receipt on catalog_source_task_receipts; set role service_role"
    )
    const result = await finish()
    assert.equal(result.new_count, 1)
    assert.equal(result.accepted_count, 1)
    assert.deepEqual(
      await finish(),
      result,
      "Lost publish acknowledgments replay the committed receipt"
    )
    const duplicate = await tasks.claim(requested.id)
    assert.equal(duplicate.claimed, false)
    assert.equal(duplicate.state, "completed")
    assert.deepEqual(duplicate.result, result)
    assert.equal((await tasks.request("joined-request")).id, requested.id)
    const state = await tasks.read(requested.id)
    assert.equal(state.attempts, 1)
    assert.equal(state.receipt_count, 2)
    assert.equal((await tasks.outbox()).length, 0)
    assert.equal(
      (await db.query("select id from job_catalog where id='published-once'"))
        .rows.length,
      1
    )
    assert.notEqual(
      (await tasks.request("next-six-hour-epoch")).id,
      requested.id
    )
  } finally {
    await db.close()
  }
})

test("the opt-in ledger keeps one execution lane across different source deliveries", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db)
    const first = await tasks.request("one", "ashby:n8n")
    const second = await tasks.request("two", "ashby:deepl")
    assert.equal((await tasks.claim(first.id)).claimed, true)
    const blocked = await tasks.claim(second.id)
    assert.equal(blocked.claimed, false)
    assert.equal(blocked.reason, "capacity")
    assert.equal((await tasks.read(second.id)).attempts, 0)
  } finally {
    await db.close()
  }
})

test("source configuration changes fence a claimed task before it can checkpoint", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db),
      requested = await tasks.request()
    const claim = await tasks.claim(requested.id)
    await db.query(
      "update job_source_directory set company='Changed employer identity' where id='ashby:n8n'"
    )
    await assert.rejects(
      tasks.rpc(
        "checkpoint_catalog_source_task($1,$2,1,null,$3::jsonb,1,0,1)",
        [
          requested.id,
          claim.lease_token,
          JSON.stringify([posting("changed-config")]),
        ]
      ),
      /configuration changed/i
    )
    assert.equal((await tasks.read(requested.id)).receipt_count, 0)
  } finally {
    await db.close()
  }
})

test("admission and page receipts roll back with their writes when storage fails before commit", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db)
    await db.exec(`reset role;
      create function reject_task_outbox() returns trigger language plpgsql as $$begin raise exception 'Injected outbox failure'; end $$;
      create trigger reject_task_outbox before insert on catalog_task_outbox for each row execute function reject_task_outbox();
      set role service_role;`)
    await assert.rejects(tasks.request(), /Injected outbox failure/)
    await db.exec(
      "reset role; drop trigger reject_task_outbox on catalog_task_outbox; set role service_role"
    )
    const requested = await tasks.request()
    assert.equal(
      (await tasks.outbox()).length,
      1,
      "Retry admits one task and one intent after transaction rollback"
    )
    const claim = await tasks.claim(requested.id)
    await db.exec(`reset role;
      create function reject_task_page() returns trigger language plpgsql as $$begin raise exception 'Injected page receipt failure'; end $$;
      create trigger reject_task_page before insert on catalog_source_task_receipts for each row execute function reject_task_page();
      set role service_role;`)
    const checkpoint = () =>
      tasks.rpc(
        "checkpoint_catalog_source_task($1,$2,1,null,$3::jsonb,1,0,1)",
        [
          requested.id,
          claim.lease_token,
          JSON.stringify([posting("rolled-back-page")]),
        ]
      )
    await assert.rejects(checkpoint(), /Injected page receipt failure/)
    const rolledBack = await tasks.read(requested.id)
    assert.equal(rolledBack.run?.next_page, 1)
    assert.equal(rolledBack.run?.pages, 0)
    assert.equal(rolledBack.run?.fetched_count, 0)
    assert.equal(rolledBack.receipt_count, 0)
    await db.exec(
      "reset role; drop trigger reject_task_page on catalog_source_task_receipts; set role service_role"
    )
    await checkpoint()
    assert.equal((await tasks.read(requested.id)).run?.pages, 1)
  } finally {
    await db.close()
  }
})

test("source tasks, receipts and delivery mutation are operator-only and respect storage admission", async () => {
  const db = await sourceTaskDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request()
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role; set role ${role}`)
      for (const operation of [
        () => tasks.request(),
        () => tasks.read(task.id),
        () => tasks.claim(task.id),
        () => tasks.outbox(),
        () => tasks.rpc("recover_catalog_source_tasks(10)"),
        () => tasks.rpc("finish_catalog_source_task($1,null)", [task.id]),
        () => db.query("select * from catalog_source_task_receipts"),
        () => db.query("select * from catalog_source_task_requests"),
        () => db.query("update catalog_source_tasks set state='completed'"),
      ])
        await assert.rejects(operation(), /permission denied/i)
    }
    await db.exec("reset role; set role service_role")
    await assert.rejects(tasks.request(" "), /request key/i)
    await assert.rejects(
      tasks.rpc("claim_catalog_task_outbox(1000)"),
      /batch limit/i
    )
    const owner = await tasks.claim(task.id)
    await db.query(
      "insert into catalog_storage_reservations(run_id,operation,token,bytes,expires_at) values($1,'checkpoint',$2,419430400,now()+interval '5 minutes')",
      [owner.run_id, owner.lease_token]
    )
    await assert.rejects(tasks.request("new", "ashby:deepl"), /storage budget/i)
    assert.equal(
      (await tasks.request()).id,
      task.id,
      "Existing admission remains replayable when storage is full"
    )
    await db.exec("reset role")
    await db.query("delete from catalog_storage_reservations where run_id=$1", [
      owner.run_id,
    ])
    await db.exec("set role service_role")
    assert.equal((await tasks.request("new", "ashby:deepl")).state, "pending")
  } finally {
    await db.close()
  }
})

test("the ledger composes with the current public migration chain and preserves publication guards", async () => {
  const db = await sourceTaskDatabase(true)
  try {
    const tasks = taskOperations(db),
      requested = await tasks.request()
    const claim = await tasks.claim(requested.id)
    await tasks.rpc(
      "checkpoint_catalog_source_task($1,$2,1,null,$3::jsonb,1,0,1)",
      [
        requested.id,
        claim.lease_token,
        JSON.stringify([posting("current-schema")]),
      ]
    )
    const result = await tasks.rpc<{ new_count: number }>(
      "finish_catalog_source_task($1,$2)",
      [requested.id, claim.lease_token]
    )
    assert.equal(result.new_count, 1)
    assert.deepEqual(
      await tasks.rpc("finish_catalog_source_task($1,$2)", [
        requested.id,
        claim.lease_token,
      ]),
      result
    )
    assert.equal((await tasks.read(requested.id)).state, "completed")
    // Search-window sources never acquire full-inventory task semantics.
    await tasks.rpc("configure_linkedin_source($1::jsonb)", [
      JSON.stringify({
        keywords: "Engineer",
        location: "India",
        country: "India",
      }),
    ])
    await assert.rejects(
      tasks.request("linkedin-window", "linkedin"),
      /search-window/i
    )
  } finally {
    await db.close()
  }
})
