import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  sourceTaskDatabase,
  taskOperations,
} from "./helpers/source-task-database"

test("hourly board scans use only published checks and a successful daily full scan", async () => {
  const db = await sourceTaskDatabase()
  const source = "indiaboard:shine"
  const existing = {
    url: "https://www.shine.com/jobs/existing/example/1",
    fingerprint: "a".repeat(64),
  }
  const changed = { ...existing, fingerprint: "b".repeat(64) }
  const newLead = {
    url: "https://www.shine.com/jobs/new/example/2",
    fingerprint: "c".repeat(64),
  }
  try {
    await db.exec(`reset role;
      alter table job_source_directory drop constraint job_source_directory_kind_check;
      alter table job_source_directory add column if not exists collection_interval_seconds integer default 14400;
      insert into job_source_directory(id,kind,company,board,enabled) values('${source}','indiaboard','Shine','shine',true);`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611190099_hourly_firecrawl_boards.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec("set role service_role")
    assert.equal(
      (
        await db.query<{ collection_interval_seconds: number }>(
          "select collection_interval_seconds from job_source_directory where id=$1",
          [source]
        )
      ).rows[0].collection_interval_seconds,
      3600
    )
    const { request, claim, rpc } = taskOperations(db)
    async function start(key: string) {
      const task = await request(key, source)
      const work = await claim(task.id)
      assert.ok(work.claimed)
      return { id: task.id, token: work.lease_token, run: work.run_id }
    }
    type Work = Awaited<ReturnType<typeof start>>
    const select = (work: Work, leads = [existing]) =>
      rpc<{ mode: string; urls: string[] }>(
        "catalog_board_details_to_check($1,$2,$3)",
        [work.id, work.token, JSON.stringify(leads)]
      )
    const checkpoint = (work: Work, checked = [existing]) =>
      rpc(
        "checkpoint_catalog_board_source_work($1,$2,1,null,'[]',1,1,1,500,1048576,20,$3)",
        [work.id, work.token, JSON.stringify(checked)]
      )
    const finish = (work: Work) =>
      rpc("finish_catalog_source_task($1,$2)", [work.id, work.token])

    const full = await start("board-full")
    assert.deepEqual(await select(full), { mode: "full", urls: [existing.url] })
    await assert.rejects(
      checkpoint(full, [{ ...existing, fingerprint: "invalid" }]),
      /check constraint/
    )
    await checkpoint(full)
    await checkpoint(full, [newLead])
    assert.deepEqual(await select(full), { mode: "full", urls: [] })
    await finish(full)

    const hourly = await start("board-hourly")
    assert.deepEqual(await select(hourly, [existing, newLead]), {
      mode: "incremental",
      urls: [newLead.url],
    })
    assert.deepEqual(
      new Set((await select(hourly, [changed, newLead])).urls),
      new Set([changed.url, newLead.url])
    )
    await checkpoint(hourly, [changed])
    await rpc(
      "release_catalog_source_work($1,$2,'failed','invalid_source',0,null)",
      [hourly.id, hourly.token]
    )
    // A new task supersedes the abandoned run. Its staged checks never become a baseline.
    await db.query(
      "update job_catalog_sources set current_run=null where id=$1",
      [source]
    )

    const retry = await start("board-hourly-retry")
    assert.deepEqual(await select(retry, [changed]), {
      mode: "incremental",
      urls: [changed.url],
    })
    await checkpoint(retry, [changed])
    await finish(retry)

    await db.query(
      "update job_catalog_runs set started_at=now()-interval '25 hours' where id=$1",
      [full.run]
    )
    const daily = await start("board-next-day")
    assert.deepEqual(await select(daily, [changed]), {
      mode: "full",
      urls: [changed.url],
    })
    await assert.rejects(
      select({ ...daily, token: crypto.randomUUID() }),
      /lease lost/i
    )
  } finally {
    await db.close()
  }
})
