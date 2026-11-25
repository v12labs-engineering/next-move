import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { advanceCollection } from "@/lib/server/catalog/source-worker"
import { sourceWorkerDatabase } from "./helpers/source-worker-database"
import { taskOperations } from "./helpers/source-task-database"

function feed(page: number, more = false) {
  return Response.json({
    data: [
      {
        slug: `fixture-${page}`,
        title: "Software Engineer",
        company_name: "Synthetic employer",
        description:
          "Build TypeScript services, operate PostgreSQL databases and support engineering teams. ".repeat(
            3
          ),
        location: "Berlin, Germany",
        url: `https://employer.example/jobs/${page}`,
        remote: true,
        created_at: Math.floor(Date.now() / 1000),
      },
    ],
    links: {
      next: more
        ? `https://www.arbeitnow.com/api/job-board-api?page=${page + 1}`
        : null,
    },
  })
}

test("a complete inventory yields for publication budget then publishes without refetching", async () => {
  let clock = Date.now(),
    fetched = 0
  const publicationTimeouts: (number | undefined)[] = []
  const { db, database } = await sourceWorkerDatabase({
    afterRpc(name, timeoutMs) {
      if (name === "checkpoint_catalog_source_work") clock += 70_000
      if (name === "finish_catalog_source_task")
        publicationTimeouts.push(timeoutMs)
      else assert.equal(timeoutMs, 15_000)
    },
  })
  try {
    await db.exec("reset role")
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611170083_catalog_publication_timeout.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const settings = await db.query<{
      name: string
      settings: string[] | null
    }>(`
      select proname as name,proconfig as settings from pg_proc where oid in (
        'public.finish_catalog_source_task(uuid,uuid)'::regprocedure,
        'public.claim_catalog_source_task(uuid,integer)'::regprocedure)
      order by proname`)
    assert.ok(
      !settings.rows[0].settings?.some((s) =>
        s.startsWith("statement_timeout=")
      )
    )
    assert.ok(settings.rows[1].settings?.includes("statement_timeout=45s"))
    assert.equal(
      (
        await db.query<{ allowed: boolean }>(
          "select has_function_privilege('anon','public.finish_catalog_source_task(uuid,uuid)','execute') allowed"
        )
      ).rows[0].allowed,
      false
    )
    await db.exec("set role service_role")
    const tasks = taskOperations(db),
      task = await tasks.request("publication-budget", "arbeitnow")
    const options = {
      database,
      now: () => clock,
      publicationTimeoutMs: 55_000,
      fetch: async () => {
        fetched++
        return feed(1)
      },
    }
    const first = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      options
    )
    assert.equal(first.status, "pending")
    if (first.status !== "pending") assert.fail("Expected continuation")
    assert.equal(first.reason, "time_budget")
    assert.equal((await tasks.read(task.id)).run?.next_page, null)
    assert.deepEqual(publicationTimeouts, [])
    const second = await advanceCollection(
      { taskId: task.id, dispatchGeneration: first.dispatchGeneration },
      options
    )
    assert.equal(second.status, "completed")
    assert.equal(fetched, 1)
    assert.deepEqual(publicationTimeouts, [55_000])
  } finally {
    await db.close()
  }
})

test("bounded pages yield a durable continuation and publish only the complete inventory", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("worker-epoch", "arbeitnow")
    await db.exec(
      "insert into job_catalog(id,title,company,country,url,source) values('previous','Engineer','Synthetic employer','Germany','https://employer.example/previous','arbeitnow')"
    )
    const pages: number[] = []
    const transport: typeof fetch = async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, "https://www.arbeitnow.com")
      const page = Number(url.searchParams.get("page"))
      pages.push(page)
      return feed(page, page === 1)
    }
    const first = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      { database, fetch: transport, maxPages: 1 }
    )
    assert.equal(first.status, "pending")
    assert.equal(
      await tasks.rpc("begin_catalog_run('arbeitnow')"),
      null,
      "Legacy collection cannot adopt a yielded task run"
    )
    assert.equal((await tasks.read(task.id)).run?.next_page, 2)
    assert.deepEqual(
      (await db.query("select id,is_active from job_catalog")).rows,
      [{ id: "previous", is_active: true }]
    )
    const second = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 2 },
      { database, fetch: transport, maxPages: 1 }
    )
    assert.equal(second.status, "completed")
    assert.deepEqual(pages, [1, 2])
    assert.equal((await tasks.read(task.id)).run?.pages, 2)
    assert.equal(
      (await db.query("select id from job_catalog where is_active")).rows
        .length,
      2
    )
    assert.equal(
      (
        await db.query<{ is_active: boolean }>(
          "select is_active from job_catalog where id='previous'"
        )
      ).rows[0].is_active,
      false
    )
    assert.equal(
      (
        await advanceCollection(
          { taskId: task.id, dispatchGeneration: 2 },
          { database, fetch: transport }
        )
      ).status,
      "completed"
    )
    assert.deepEqual(
      pages,
      [1, 2],
      "Completed delivery does not fetch or publish again"
    )
  } finally {
    await db.close()
  }
})

async function makeDue(
  db: Awaited<ReturnType<typeof sourceWorkerDatabase>>["db"],
  id: string
) {
  await db.exec("reset role")
  await db.query(
    "update catalog_source_tasks set not_before=now()-interval '1 second' where id=$1",
    [id]
  )
  await db.query(
    "update catalog_task_outbox set available_at=now()-interval '1 second' where task_id=$1",
    [id]
  )
  await db.query(
    "update job_catalog_runs set retry_at=now()-interval '1 second' where id=(select run_id from catalog_source_tasks where id=$1)",
    [id]
  )
  await db.exec("set role service_role")
}
async function expireWorker(
  db: Awaited<ReturnType<typeof sourceWorkerDatabase>>["db"],
  id: string
) {
  await db.exec("reset role")
  await db.query(
    "update catalog_source_tasks set lease_until=now()-interval '1 second' where id=$1",
    [id]
  )
  await db.query(
    "update job_catalog_sources set lease_until=now()-interval '1 second' where current_run=(select run_id from catalog_source_tasks where id=$1)",
    [id]
  )
  await db.exec("set role service_role")
  await taskOperations(db).rpc("recover_catalog_source_tasks(10)")
}

test("a confirmed publication rollback backs off and retries the saved inventory", async () => {
  let failPublication = true,
    fetched = 0
  const { db, database } = await sourceWorkerDatabase({
    beforeRpc(name) {
      if (name === "finish_catalog_source_task" && failPublication)
        throw Object.assign(
          new Error("canceling statement due to statement timeout"),
          {
            code: "57014",
          }
        )
    },
  })
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("publication-rollback", "arbeitnow")
    const options = {
      database,
      fetch: async () => {
        fetched++
        return feed(1)
      },
    }
    const failed = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      options
    )
    assert.equal(failed.status, "waiting")
    if (failed.status !== "waiting") assert.fail("Expected bounded retry")
    assert.equal(failed.reason, "worker_error")
    const saved = await tasks.read(task.id)
    assert.equal(saved.lease_token, null)
    assert.equal(saved.failure_count, 1)
    assert.equal(saved.run?.next_page, null)
    assert.equal(saved.run?.pages, 1)
    await makeDue(db, task.id)
    failPublication = false
    const recovered = await advanceCollection(
      { taskId: task.id, dispatchGeneration: failed.dispatchGeneration },
      options
    )
    assert.equal(recovered.status, "completed")
    assert.equal(fetched, 1)
  } finally {
    await db.close()
  }
})

test("provider backoff persists across deliveries, frees the lane, and resets after progress", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("backoff", "arbeitnow")
    let requests = 0
    const transport: typeof fetch = async () => {
      requests++
      return new Response("Limited", {
        status: 429,
        headers: { "Retry-After": "1200" },
      })
    }
    const before = Date.now()
    const first = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      { database, fetch: transport }
    )
    assert.equal(first.status, "waiting")
    if (first.status !== "waiting") assert.fail("Expected durable backoff")
    assert.ok(Date.parse(first.retryAt!) >= before + 1_199_000)
    assert.equal((await tasks.read(task.id)).failure_count, 1)
    assert.equal((await tasks.outbox()).length, 0)
    assert.equal(
      (
        await advanceCollection(
          { taskId: task.id, dispatchGeneration: 2 },
          { database, fetch: transport }
        )
      ).status,
      "skipped"
    )
    assert.equal(requests, 1)
    const other = await tasks.request("other", "ashby:n8n")
    const owner = await tasks.claim(other.id)
    assert.equal(
      owner.claimed,
      true,
      "Waiting source does not occupy the only lane"
    )
    await tasks.rpc("checkpoint_catalog_source_task($1,$2,1,null,'[]',0,0,1)", [
      other.id,
      owner.lease_token,
    ])
    await tasks.rpc("finish_catalog_source_task($1,$2)", [
      other.id,
      owner.lease_token,
    ])
    await makeDue(db, task.id)
    assert.equal(
      (
        await advanceCollection(
          { taskId: task.id, dispatchGeneration: 2 },
          {
            database,
            fetch: async () => {
              requests++
              return feed(1)
            },
          }
        )
      ).status,
      "completed"
    )
    const final = await tasks.read(task.id)
    assert.equal(final.failure_count, 0)
    assert.equal(final.run?.request_count, 2)
    assert.equal(requests, 2)
  } finally {
    await db.close()
  }
})

for (const lostRpc of [
  "checkpoint_catalog_source_work",
  "finish_catalog_source_task",
  "release_catalog_source_work",
]) {
  test(`recovery after losing the ${lostRpc} acknowledgment uses committed progress`, async () => {
    let lost = false
    const { db, database } = await sourceWorkerDatabase({
      afterRpc(name) {
        if (name === lostRpc && !lost) {
          lost = true
          throw new Error("Injected lost acknowledgment")
        }
      },
    })
    try {
      const tasks = taskOperations(db),
        task = await tasks.request("lost-response", "arbeitnow")
      const pages: number[] = []
      const transport: typeof fetch = async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"))
        pages.push(page)
        return feed(
          page,
          lostRpc !== "finish_catalog_source_task" && page === 1
        )
      }
      await assert.rejects(
        advanceCollection(
          { taskId: task.id, dispatchGeneration: 1 },
          { database, fetch: transport, maxPages: 1 }
        )
      )
      assert.equal(lost, true)
      const committed = await tasks.read(task.id)
      assert.equal(committed.run?.pages, 1)
      if (lostRpc === "checkpoint_catalog_source_work") {
        assert.equal(
          committed.state,
          "running",
          "Uncertain mutation retains the lease"
        )
        await expireWorker(db, task.id)
      }
      const resumed = await tasks.read(task.id)
      const result = await advanceCollection(
        { taskId: task.id, dispatchGeneration: resumed.dispatch_generation },
        { database, fetch: transport }
      )
      assert.equal(result.status, "completed")
      assert.deepEqual(
        pages,
        lostRpc === "finish_catalog_source_task" ? [1] : [1, 2]
      )
      assert.equal(
        (await tasks.read(task.id)).run?.request_count,
        lostRpc === "finish_catalog_source_task" ? 1 : 2
      )
      assert.equal((await tasks.read(task.id)).state, "completed")
    } finally {
      await db.close()
    }
  })
}

test("retries stop after five consecutive failed deliveries without publishing an empty inventory", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("poison", "arbeitnow")
    let requests = 0
    const transport: typeof fetch = async () => {
      requests++
      return new Response("Unavailable", {
        status: 503,
        headers: { "Retry-After": "120" },
      })
    }
    for (let generation = 1; generation <= 5; generation++) {
      if (generation > 1) await makeDue(db, task.id)
      const result = await advanceCollection(
        { taskId: task.id, dispatchGeneration: generation },
        { database, fetch: transport }
      )
      assert.equal(result.status, generation === 5 ? "failed" : "waiting")
    }
    const status = await tasks.read(task.id)
    assert.equal(status.failure_count, 5)
    assert.equal(status.run?.pages, 0)
    assert.equal(status.run?.request_count, 5)
    assert.equal((await tasks.outbox()).length, 0)
    assert.equal(
      (
        await advanceCollection(
          { taskId: task.id, dispatchGeneration: status.dispatch_generation },
          { database, fetch: transport }
        )
      ).status,
      "failed"
    )
    assert.equal(requests, 5)
  } finally {
    await db.close()
  }
})

test("HTTP retries count against the request budget and cannot loop inside one delivery", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("http-retry", "arbeitnow")
    let requests = 0
    const transport: typeof fetch = async () => {
      requests++
      return new Response("Unavailable", {
        status: 503,
        headers: { "Retry-After": "0" },
      })
    }
    const exhausted = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      { database, fetch: transport, maxRequests: 1 }
    )
    assert.equal(exhausted.status, "waiting")
    if (exhausted.status !== "waiting") assert.fail("Expected durable retry")
    assert.equal(exhausted.reason, "request_budget")
    assert.equal(requests, 1)
    assert.equal((await tasks.read(task.id)).run?.request_count, 1)
    await makeDue(db, task.id)
    const recovered = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 2 },
      {
        database,
        maxRequests: 2,
        fetch: async () => {
          requests++
          return requests === 2
            ? new Response("Temporary", {
                status: 503,
                headers: { "Retry-After": "0" },
              })
            : feed(1)
        },
      }
    )
    assert.equal(recovered.status, "completed")
    assert.equal(requests, 3)
    assert.equal((await tasks.read(task.id)).run?.request_count, 3)
  } finally {
    await db.close()
  }
})

test("snapshot limits include staged pages from previous deliveries and preserve published jobs", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("snapshot-cap", "arbeitnow")
    await db.exec(
      "insert into job_catalog(id,title,company,country,url,source) values('protected-snapshot','Engineer','Example','Germany','https://employer.example/previous','arbeitnow')"
    )
    const transport: typeof fetch = async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"))
      return feed(page, page === 1)
    }
    assert.equal(
      (
        await advanceCollection(
          { taskId: task.id, dispatchGeneration: 1 },
          { database, fetch: transport, maxPages: 1, maxSnapshotRecords: 1 }
        )
      ).status,
      "pending"
    )
    const limited = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 2 },
      { database, fetch: transport, maxSnapshotRecords: 1 }
    )
    assert.equal(limited.status, "failed")
    if (limited.status !== "failed")
      assert.fail("Expected explicit snapshot failure")
    assert.equal(limited.reason, "snapshot_limit")
    const state = await tasks.read(task.id)
    assert.equal(state.run?.pages, 1)
    assert.equal(state.run?.next_page, 2)
    assert.equal(
      (
        await db.query<{ is_active: boolean }>(
          "select is_active from job_catalog where id='protected-snapshot'"
        )
      ).rows[0].is_active,
      true
    )
    assert.equal((await tasks.outbox()).length, 0)
    assert.equal(
      await tasks.rpc("begin_catalog_run('arbeitnow')"),
      null,
      "Quarantined snapshots remain ledger-owned"
    )
  } finally {
    await db.close()
  }
})

test("bad pagination and oversized responses fail without publishing partial or empty snapshots", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("bad-next", "arbeitnow")
    let requests = 0
    const bad: typeof fetch = async () => {
      requests++
      const body = await feed(1, true).json()
      body.links.next = "http://127.0.0.1/private?page=2"
      return Response.json(body)
    }
    const rejected = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      { database, fetch: bad }
    )
    assert.equal(rejected.status, "failed")
    assert.equal(requests, 1)
    assert.equal((await tasks.read(task.id)).run?.pages, 0)
    const other = await tasks.request("oversized", "ashby:n8n")
    const oversized = await advanceCollection(
      { taskId: other.id, dispatchGeneration: 1 },
      {
        database,
        maxResponseBytes: 16,
        fetch: async () => Response.json({ jobs: ["x".repeat(200)] }),
      }
    )
    assert.equal(oversized.status, "failed")
    assert.equal((await tasks.read(other.id)).run?.pages, 0)
    assert.equal((await db.query("select id from job_catalog")).rows.length, 0)
  } finally {
    await db.close()
  }
})

test("a deadline after the final checkpoint yields and resumes publication without refetching", async () => {
  const start = Date.now()
  let clock = start
  const { db, database } = await sourceWorkerDatabase({
    afterRpc(name) {
      if (name === "checkpoint_catalog_source_work") clock = start + 34_000
    },
  })
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("deadline", "arbeitnow")
    let requests = 0
    const transport: typeof fetch = async () => {
      requests++
      return feed(1)
    }
    const result = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      { database, fetch: transport, now: () => clock, maxMs: 35_000 }
    )
    assert.equal(result.status, "pending")
    if (result.status !== "pending") assert.fail("Expected continuation")
    assert.equal(result.reason, "time_budget")
    assert.equal((await tasks.read(task.id)).run?.next_page, null)
    assert.equal((await db.query("select id from job_catalog")).rows.length, 0)
    assert.equal(
      (
        await advanceCollection(
          { taskId: task.id, dispatchGeneration: 2 },
          { database, fetch: transport }
        )
      ).status,
      "completed"
    )
    assert.equal(requests, 1)
  } finally {
    await db.close()
  }
})

test("a replaced worker cannot checkpoint its late HTTP response", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("stale-response", "arbeitnow")
    let finishHttp: (response: Response) => void = () => {
      throw new Error("Request not started")
    }
    let notify: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      notify = resolve
    })
    const late = advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      {
        database,
        fetch: async () => {
          return new Promise<Response>((resolve) => {
            finishHttp = resolve
            notify()
          })
        },
      }
    )
    const rejected = assert.rejects(late)
    await started
    await expireWorker(db, task.id)
    const replacement = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 2 },
      { database, fetch: async () => feed(1) }
    )
    assert.equal(replacement.status, "completed")
    finishHttp(feed(1))
    await rejected
    assert.equal((await tasks.read(task.id)).run?.pages, 1)
    assert.equal((await db.query("select id from job_catalog")).rows.length, 1)
  } finally {
    await db.close()
  }
})

test("a failed yield transaction retains ownership and recovers without skipping a page", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("yield-rollback", "arbeitnow")
    await db.exec(`reset role;
      create function reject_continuation() returns trigger language plpgsql as $$begin
      if new.dispatch_generation>1 then raise exception 'Injected continuation failure'; end if; return new; end $$;
      create trigger reject_continuation before insert on catalog_task_outbox for each row execute function reject_continuation();
      set role service_role;`)
    const pages: number[] = []
    const transport: typeof fetch = async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"))
      pages.push(page)
      return feed(page, page === 1)
    }
    await assert.rejects(
      advanceCollection(
        { taskId: task.id, dispatchGeneration: 1 },
        { database, fetch: transport, maxPages: 1 }
      )
    )
    const current = await tasks.read(task.id)
    assert.equal(current.state, "running")
    assert.equal(current.dispatch_generation, 1)
    assert.equal(current.run?.next_page, 2)
    await db.exec(
      "reset role; drop trigger reject_continuation on catalog_task_outbox; set role service_role"
    )
    await expireWorker(db, task.id)
    assert.equal(
      (
        await advanceCollection(
          { taskId: task.id, dispatchGeneration: 2 },
          { database, fetch: transport }
        )
      ).status,
      "completed"
    )
    assert.deepEqual(pages, [1, 2])
  } finally {
    await db.close()
  }
})

test("worker release receipts replay safely and worker operations remain service-only", async () => {
  const { db } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("release-replay", "arbeitnow")
    const owner = await tasks.claim(task.id)
    const release = () =>
      tasks.rpc(
        "release_catalog_source_work($1,$2,'continue','page_budget',0,null)",
        [task.id, owner.lease_token]
      )
    const committed = await release()
    const replacement = await tasks.claim(task.id, 2)
    assert.equal(replacement.claimed, true)
    assert.deepEqual(await release(), committed)
    assert.equal(
      (await tasks.read(task.id)).lease_token,
      replacement.lease_token
    )
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role; set role ${role}`)
      await assert.rejects(
        tasks.rpc("read_catalog_source_work($1,$2)", [
          task.id,
          replacement.lease_token,
        ]),
        /permission denied/i
      )
      await assert.rejects(release(), /permission denied/i)
      await assert.rejects(
        tasks.rpc(
          "checkpoint_catalog_source_work($1,$2,1,null,'[]',0,0,1,10,1024)",
          [task.id, replacement.lease_token]
        ),
        /permission denied/i
      )
      await assert.rejects(
        db.query("select * from catalog_source_task_releases"),
        /permission denied/i
      )
    }
  } finally {
    await db.close()
  }
})

test("invalid limits fail before a source is claimed or fetched", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("bad-limits", "arbeitnow")
    await assert.rejects(
      advanceCollection(
        { taskId: task.id, dispatchGeneration: 1 },
        { database, maxPages: 0 }
      ),
      /worker limits/
    )
    await assert.rejects(
      advanceCollection(
        { taskId: task.id, dispatchGeneration: 1 },
        { database, maxMs: 300_000 }
      ),
      /worker limits/
    )
    assert.equal((await tasks.read(task.id)).attempts, 0)
  } finally {
    await db.close()
  }
})

test("an endlessly paginating source hits its total-page cap without publishing a partial inventory", async () => {
  const { db, database } = await sourceWorkerDatabase()
  try {
    const tasks = taskOperations(db),
      task = await tasks.request("endless-pages", "arbeitnow")
    const pages: number[] = []
    const transport: typeof fetch = async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"))
      pages.push(page)
      return feed(page, true)
    }
    const result = await advanceCollection(
      { taskId: task.id, dispatchGeneration: 1 },
      { database, fetch: transport, maxTotalPages: 2 }
    )
    assert.equal(result.status, "failed")
    assert.deepEqual(pages, [1, 2])
    assert.equal((await tasks.read(task.id)).run?.next_page, 3)
    assert.equal((await tasks.outbox()).length, 0)
    assert.equal((await db.query("select id from job_catalog")).rows.length, 0)
  } finally {
    await db.close()
  }
})
