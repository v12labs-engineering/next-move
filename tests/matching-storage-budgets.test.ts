import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { matchingDatabase, MATCH_USER } from "./helpers/matching-database"

test("matching pools stop growth before the global guard; title cleanup is bounded and preserves references", async () => {
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
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611010030_matching_storage_pools.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const health = (
      await db.query<{
        r: {
          features: { limitBytes: number }
          accounts: { limitBytes: number }
        }
      }>("select matching_storage_pools() r")
    ).rows[0].r
    assert.equal(health.features.limitBytes, 100 * 1024 * 1024)
    assert.equal(health.accounts.limitBytes, 160 * 1024 * 1024)
    await db.exec("insert into job_catalog(id) values('referenced');")
    const feature = {
      job_id: "referenced",
      source_hash: "a".repeat(64),
      title_hash: "b".repeat(64),
      engine_version: "oss-test",
      search_text: "Engineer",
      features: {
        version: "oss-test",
        requirements: [],
        embedding: Array(384).fill(0),
        titleEmbedding: Array(1024).fill(0),
      },
    }
    await db.query("select cache_matching_features($1)", [[feature]])
    await db.exec(
      "insert into catalog_matching_titles select repeat(c,64),'oss-test',array_fill(0::real,array[1024]) from unnest(array['c','d','e']) c"
    )
    assert.equal(
      (await db.query<{ n: number }>("select prune_matching_titles(2) n"))
        .rows[0].n,
      2
    )
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from catalog_matching_titles"
        )
      ).rows[0].n,
      2
    )
    assert.equal(
      (await db.query<{ n: number }>("select prune_matching_titles(2) n"))
        .rows[0].n,
      1
    )
    assert.equal(
      (
        await db.query("select * from read_matching_features($1,$2,$3)", [
          ["referenced"],
          "Engineer",
          "oss-test",
        ])
      ).rows.length,
      1
    )
    const claim = (
      await db.query<{ r: { token: string } }>(
        "select claim_account_matching($1) r",
        [MATCH_USER]
      )
    ).rows[0].r
    const build = (
      await db.query<{ r: { cursor: Record<string, unknown> } }>(
        "select begin_account_match_build($1,$2) r",
        [MATCH_USER, claim.token]
      )
    ).rows[0].r
    const next = { ...build.cursor, batch: 1 }
    const checkpoint = [
      MATCH_USER,
      claim.token,
      0,
      next,
      { jobs: [], coverage: [], lexical: [] },
    ]
    await db.query(
      "select checkpoint_account_match_batch($1,$2,$3,$4,$5)",
      checkpoint
    )
    await db.query("select stage_account_matches($1,$2,$3)", [
      MATCH_USER,
      claim.token,
      [
        {
          id: "referenced",
          country: "Germany",
          title: "Engineer",
          match: { score: 80 },
        },
      ],
    ])
    await db.exec(
      "update matching_storage_limits set feature_bytes=1 where singleton"
    )
    await assert.rejects(
      db.query("select cache_matching_features($1)", [[feature]]),
      /features storage budget/
    )
    await db.exec(
      "update matching_storage_limits set account_bytes=1 where singleton"
    )
    await assert.rejects(
      db.query("select enforce_matching_storage_pool('accounts',100)"),
      /accounts storage budget/
    )
    await assert.rejects(
      db.query("select stage_account_matches($1,$2,$3)", [
        MATCH_USER,
        claim.token,
        [{ id: "referenced", country: "Germany", match: { score: 90 } }],
      ]),
      /accounts storage budget/
    )
    assert.equal(
      (
        await db.query<{ score: number }>(
          "select score from account_match_jobs where user_id=$1",
          [MATCH_USER]
        )
      ).rows[0].score,
      80
    )
    // A receipt replay must remain successful even when the pool filled later.
    await db.query(
      "select checkpoint_account_match_batch($1,$2,$3,$4,$5)",
      checkpoint
    )

    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select matching_storage_pools()"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select prune_matching_titles(10)"),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})
