import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { automaticDiscoveryDatabase } from "./helpers/automatic-discovery-database"
import { runScheduledArchive } from "@/lib/server/catalog/discovery/scheduled-archive"
import { discoverArchivePage } from "@/lib/server/catalog/discovery/archive"

const env = { APP_ENV: "staging", AUTOMATIC_DISCOVERY_ENABLED: "true" }
async function setup(afterRpc?: (name: string) => void, legacy = false) {
  const db = await automaticDiscoveryDatabase(afterRpc)
  await db.sql.exec("reset role")
  if (legacy) {
    await db.sql.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611010036_extended_ats_search.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.sql.exec(
      "alter table public.job_source_directory drop column config"
    )
  }
  for (const file of [
    "202611070060_public_ats_readers.sql",
    "202611070061_scheduled_archive_discovery.sql",
  ])
    await db.sql.exec(
      await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8"
      )
    )
  await db.sql.exec("set role service_role")
  return db
}
const archived = (board: string) =>
  JSON.stringify({
    url: `https://${board}.recruitee.com/o/software-engineer`,
    timestamp: "20261005100000",
    status: "200",
  })

test("ATS migration preserves the installed search pool with or without LinkedIn support", async () => {
  for (const legacy of [false, true]) {
    const db = await setup(undefined, legacy)
    try {
      const definition = (
        await db.sql.query<{ definition: string }>(
          "select pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure) definition"
        )
      ).rows[0].definition
      assert.ok(definition.includes("'recruitee','workable'"))
      assert.equal(definition.includes("d.config"), !legacy)
      assert.equal(definition.includes("d.kind='linkedin'"), !legacy)
    } finally {
      await db.sql.close()
    }
  }
})
function transport(
  pages = 2,
  rows = 1,
  index = "CC-MAIN-2026-43"
): typeof fetch {
  return async (input) => {
    const url = new URL(String(input))
    if (url.pathname === "/collinfo.json") return Response.json([{ id: index }])
    if (url.searchParams.has("showNumPages"))
      return Response.json({ pages, pageSize: 1 })
    return new Response(
      Array.from({ length: rows }, (_, i) =>
        archived(`fixture-${url.searchParams.get("page")}-${i}`)
      ).join("\n")
    )
  }
}
type Claim = {
  id: string
  token: string
  partition: string
  page: number
  index: string | null
  claimed: boolean
  reason?: string
}

test("scheduled intake atomically imports full blocks, pins continuation, and survives a lost settlement receipt", async () => {
  let lose = true
  const db = await setup((name) => {
    if (name === "finish_archive_discovery" && lose) {
      lose = false
      throw new Error("Receipt lost after commit")
    }
  })
  try {
    const first = await runScheduledArchive({
      requestKey: "first",
      env,
      database: db.database,
      fetch: transport(2, 501),
    })
    assert.equal(first.status, "completed")
    assert.equal(first.newCandidates, 501)
    assert.deepEqual(first.nextCursor, {
      index: "CC-MAIN-2026-43",
      partition: "recruitee",
      page: 1,
    })
    assert.deepEqual(
      await runScheduledArchive({
        requestKey: "first",
        env,
        database: db.database,
        fetch: async () => {
          assert.fail("replay must not fetch")
        },
      }),
      first
    )
    await db.sql.exec(
      "update archive_discovery_channels set next_attempt_at=now()+interval '1 day' where partition<>'recruitee'"
    )
    const second = await runScheduledArchive({
      requestKey: "second",
      env,
      database: db.database,
      fetch: async (input) => {
        assert.ok(
          !String(input).includes("collinfo"),
          "unfinished partitions retain their original index"
        )
        return transport()(input)
      },
    })
    assert.equal(second.status, "completed")
    assert.equal(second.nextCursor, null)
    assert.equal(
      (
        await db.sql.query<{ n: number }>(
          "select count(*)::int n from source_candidates where status='imported'"
        )
      ).rows[0].n,
      502
    )
    assert.equal(
      (
        await db.sql.query<{ n: number }>(
          "select count(*)::int n from job_source_directory where kind in ('recruitee','workable')"
        )
      ).rows[0].n,
      0
    )
    const same = await runScheduledArchive({
      requestKey: "not-due",
      env,
      database: db.database,
      fetch: async () => {
        assert.fail("completed partitions wait")
      },
    })
    assert.equal(same.reason, "not_due")
    await db.sql.exec(
      "update archive_discovery_channels set next_attempt_at=now() where partition='recruitee'"
    )
    const unchanged = await runScheduledArchive({
      requestKey: "weekly",
      env,
      database: db.database,
      fetch: transport(),
    })
    assert.equal(unchanged.status, "unchanged")
    await db.sql.exec(
      "update archive_discovery_channels set next_attempt_at=now() where partition='recruitee'"
    )
    const newIndex = await runScheduledArchive({
      requestKey: "new-index",
      env,
      database: db.database,
      fetch: transport(2, 1, "CC-MAIN-2026-47"),
    })
    assert.deepEqual(newIndex.cursor, {
      partition: "recruitee",
      index: "CC-MAIN-2026-47",
      page: 0,
    })
  } finally {
    await db.sql.close()
  }
})

test("archive admission enforces provider cooldown, stale fencing, daily limits and service-only access", async () => {
  const db = await setup()
  try {
    for (const role of ["anon", "authenticated"]) {
      await db.sql.exec(`set role ${role}`)
      await assert.rejects(
        db.rpc("claim_archive_discovery", ["forbidden"]),
        /permission denied/
      )
      await assert.rejects(
        db.sql.query("select * from archive_discovery_channels"),
        /permission denied/
      )
      await db.sql.exec("set role service_role")
    }
    const one = await db.rpc<Claim>("claim_archive_discovery", ["one"])
    assert.equal(one.partition, "recruitee")
    assert.equal(
      (await db.rpc("claim_archive_discovery", ["two"])).reason,
      "leased"
    )
    await db.sql.exec(
      "update archive_discovery_control set lease_until=now()-interval '1 second'"
    )
    const two = await db.rpc<Claim>("claim_archive_discovery", ["two"])
    assert.equal(two.partition, "workable")
    await assert.rejects(
      db.rpc("finish_archive_discovery", [one.id, one.token, "failed"]),
      /lease lost/
    )
    await db.rpc("finish_archive_discovery", [
      two.id,
      two.token,
      "failed",
      null,
      "provider_http_429",
      new Date(Date.now() + 3600000).toISOString(),
    ])
    assert.equal(
      (await db.rpc("claim_archive_discovery", ["three"])).reason,
      "provider_backoff"
    )
    await db.sql.exec(
      "update archive_discovery_control set provider_retry_at=null"
    )
    for (let i = 2; i < 12; i++) {
      await db.sql.exec(
        "update archive_discovery_channels set next_attempt_at=now()"
      )
      const claim = await db.rpc<Claim>("claim_archive_discovery", [
        `cycle-${i}`,
      ])
      assert.equal(claim.claimed, true)
      await db.rpc("finish_archive_discovery", [
        claim.id,
        claim.token,
        "failed",
      ])
    }
    assert.equal(
      (await db.rpc("claim_archive_discovery", ["over-limit"])).reason,
      "daily_page_limit"
    )
    await assert.rejects(
      db.sql.exec("update archive_discovery_control set daily_page_limit=13"),
      /check constraint/
    )
    await db.sql.exec(
      "update archive_discovery_runs set started_at=started_at-interval '1 day'; update archive_discovery_channels set next_attempt_at=now()"
    )
    assert.equal(
      (await db.rpc("claim_archive_discovery", ["tomorrow"])).claimed,
      true
    )
  } finally {
    await db.sql.close()
  }
})

test("malformed imports roll back all chunks and cursor; failed provider pages retry the same page later", async () => {
  const db = await setup()
  try {
    const claim = await db.rpc<Claim>("claim_archive_discovery", ["malformed"])
    const page = await discoverArchivePage(
      { partition: "recruitee", index: "CC-MAIN-2026-43" },
      { fetch: transport(2, 501) }
    )
    page.candidates[500].board = "../invalid"
    await assert.rejects(
      db.rpc("finish_archive_discovery", [
        claim.id,
        claim.token,
        "completed",
        page,
      ])
    )
    assert.equal(
      (
        await db.sql.query<{ n: number }>(
          "select count(*)::int n from source_candidates"
        )
      ).rows[0].n,
      0
    )
    assert.equal(
      (
        await db.sql.query<{ next_page: number }>(
          "select next_page from archive_discovery_channels where partition='recruitee'"
        )
      ).rows[0].next_page,
      0
    )
    await db.rpc("finish_archive_discovery", [claim.id, claim.token, "failed"])
    await db.sql.exec(
      "update archive_discovery_channels set next_attempt_at=now()+interval '1 day'; update archive_discovery_channels set pinned_index='CC-MAIN-2026-43',next_page=1,next_attempt_at=now() where partition='recruitee'"
    )
    const failed = await runScheduledArchive({
      requestKey: "throttle",
      env,
      database: db.database,
      fetch: async () =>
        new Response(null, { status: 429, headers: { "retry-after": "7200" } }),
    })
    assert.equal(failed.reason, "provider_http_429")
    assert.deepEqual(
      (
        await db.sql.query(
          "select pinned_index,next_page,failures from archive_discovery_channels where partition='recruitee'"
        )
      ).rows[0],
      { pinned_index: "CC-MAIN-2026-43", next_page: 1, failures: 2 }
    )
    const blocked = await runScheduledArchive({
      requestKey: "blocked",
      env,
      database: db.database,
      fetch: async () => {
        assert.fail("cooldown must prevent requests")
      },
    })
    assert.equal(blocked.reason, "provider_backoff")
    await db.sql.exec(
      "update archive_discovery_control set provider_retry_at=null; update archive_discovery_channels set next_attempt_at=now() where partition='recruitee'; update catalog_capacity_control set budget_bytes=52428800"
    )
    await db.sql.exec(
      "reset role; create or replace function public.catalog_storage_usage() returns jsonb language sql security invoker as $$ select jsonb_build_object('database_bytes',52428800) $$; set role service_role"
    )
    assert.equal(
      (
        await runScheduledArchive({
          requestKey: "capacity",
          env,
          database: db.database,
          fetch: transport(),
        })
      ).reason,
      "storage_budget"
    )
    assert.equal(
      (
        await db.sql.query<{ n: number }>(
          "select count(*)::int n from archive_discovery_runs"
        )
      ).rows[0].n,
      2
    )
  } finally {
    await db.sql.close()
  }
})

test("disabled discovery and non-staging environments never access providers or storage", async () => {
  for (const flags of [
    { APP_ENV: "staging" },
    { AUTOMATIC_DISCOVERY_ENABLED: "true", APP_ENV: "production" },
  ]) {
    const result = await runScheduledArchive({
      requestKey: "off",
      env: flags,
      fetch: async () => {
        assert.fail("must not fetch")
      },
    })
    assert.ok(["disabled", "skipped"].includes(String(result.status)))
  }
})
