import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { sourceTaskDatabase } from "./helpers/source-task-database"

const owner = "00000000-0000-4000-8000-000000000001"
const other = "00000000-0000-4000-8000-000000000002"
const generation = "00000000-0000-4000-8000-000000000010"
const oldWorker = "00000000-0000-4000-8000-000000000011"
const migration = "202611170078_profile_job_categories.sql"
const filtersMigration = "202611180093_job_board_filters.sql"
type Database = Awaited<ReturnType<typeof sourceTaskDatabase>>
type MatchPage = {
  jobs: {
    id: string
    title: string
    status: string
    match: { inScope?: boolean; softwareRole: boolean }
  }[]
  total: number
  counts: { new: number; toReview: number; fresh: number }
  matching: { profileCurrent: boolean }
}

async function apply(db: Database, filename: string) {
  await db.exec(
    await readFile(
      new URL(`../supabase/migrations/${filename}`, import.meta.url),
      "utf8"
    )
  )
}

async function setup() {
  const db = await sourceTaskDatabase(true)
  await db.exec("reset role")
  for (const filename of [
    "202611020041_software_role_scope.sql",
    "202611040050_automatic_source_discovery.sql",
    "202611160072_restore_compact_match_reader.sql",
  ])
    await apply(db, filename)
  for (const user of [owner, other]) {
    await db.query("insert into auth.users(id) values($1)", [user])
    await db.query("insert into account_profiles(user_id,data) values($1,$2)", [
      user,
      { jobCategories: ["design", "sales"] },
    ])
    await db.query(
      "insert into account_countries(user_id,country) values($1,'India')",
      [user]
    )
  }
  return db
}

async function state(db: Database, user = owner) {
  await db.query(
    "insert into account_match_state(user_id,generation,profile_version,computed_at) values($1,$2,1,now())",
    [user, generation]
  )
}

async function score(
  db: Database,
  id: string,
  match: {
    score: number
    softwareRole: boolean
    inScope?: boolean
    category?: string
    reviewable?: boolean
  },
  options: {
    compact?: boolean
    user?: string
    status?: "interested" | "applied" | "dismissed"
    listing?: {
      city?: string
      company?: string
      postedDate?: string
      remote?: string
      url?: string
    }
  } = {}
) {
  const user = options.user ?? owner
  const now = new Date(Date.now() - 60_000).toISOString()
  const listing = {
    id,
    title: `Product Designer ${id}`,
    country: "India",
    company: "Example",
    url: `https://example.com/jobs/${id}`,
    seenAt: now,
    postedDate: now,
    lastCheckedAt: now,
    visaSignal: "possible",
    ...options.listing,
  }
  await db.query(
    `insert into job_catalog(id,title,country,company,url,source,posted_at,last_checked_at,is_active,visa_signal)
    values($1,$2,'India',$3,$4,'ashby:n8n',$5,$6,true,'possible')`,
    [id, listing.title, listing.company, listing.url, listing.postedDate, now]
  )
  const assessment = {
    ...match,
    eligible: true,
    reviewable: match.reviewable ?? true,
    relevant: true,
  }
  const key = options.compact
    ? createHash("sha256").update(id).digest("hex")
    : null
  if (key)
    await db.query(
      "insert into match_listing_snapshots(id,data) values($1,$2)",
      [key, listing]
    )
  await db.query(
    "insert into account_match_jobs(user_id,generation,job_id,job,listing_key) values($1,$2,$3,$4,$5)",
    [
      user,
      generation,
      id,
      options.compact
        ? { id, country: "India", match: assessment }
        : { ...listing, match: assessment },
      key,
    ]
  )
  if (options.status)
    await db.query(
      "insert into account_job_states(user_id,job_id,status) values($1,$2,$3)",
      [user, id, options.status]
    )
}

async function read(db: Database, filters: object = {}) {
  return (
    await db.query<{ result: MatchPage }>(
      "select read_account_matches($1) result",
      [filters]
    )
  ).rows[0].result
}

test("resume matching invalidates old recommendations and filters both discovery views", async () => {
  const db = await setup()
  try {
    await apply(db, migration)
    await apply(db, filtersMigration)
    await state(db)
    const match = { score: 80, softwareRole: false, inScope: true }
    await score(db, "match", match, { compact: true })
    await score(db, "weak", { ...match, score: 95, reviewable: false })
    await score(db, "saved", match, { status: "interested" })
    await db.query(
      "update account_match_state set token=$2,building_version=1,lease_until=now()+interval '10 minutes' where user_id=$1",
      [owner, oldWorker]
    )
    await apply(db, "202611230104_resume_grounded_matches.sql")
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='${owner}'`
    )
    const pending = await read(db, { view: "jobs" })
    assert.equal(pending.matching.profileCurrent, false)
    assert.equal(pending.total, 0)
    assert.deepEqual(
      (await read(db, { view: "saved" })).jobs.map(({ id }) => id),
      ["saved"]
    )
    await db.exec("reset role; set role service_role")
    await assert.rejects(
      db.query("select stage_account_matches($1,$2,'[]')", [owner, oldWorker]),
      /superseded/
    )
    // Simulate the new generation being ready with the two assessment outcomes.
    await db.exec("reset role")
    await db.query(
      "update account_match_state set profile_version=1,computed_at=now() where user_id=$1",
      [owner]
    )
    await db.exec("set role authenticated")
    for (const view of ["all", "jobs"]) {
      const page = await read(db, { view, jobStatus: "new", limit: 1 })
      assert.equal(page.total, 1)
      assert.equal(page.counts.new, 1)
      assert.deepEqual(
        page.jobs.map(({ id }) => id),
        ["match"]
      )
    }
  } finally {
    await db.close()
  }
})

test("board filters compose across compact and legacy matches before deduplication and pagination", async () => {
  const db = await setup()
  try {
    await state(db)
    const match = {
      score: 80,
      softwareRole: false,
      inScope: true,
      category: "design",
    }
    const listing = {
      city: "Hyderabad",
      company: "Example Studio",
      remote: "hybrid",
    }
    const sharedUrl = "https://example.com/jobs/shared"
    await score(db, "compact", match, {
      compact: true,
      listing: { ...listing, url: sharedUrl },
    })
    await score(db, "legacy", { ...match, score: 70 }, { listing })
    await score(
      db,
      "wrong-city",
      { ...match, score: 100 },
      {
        listing: { ...listing, city: "Pune", url: sharedUrl },
      }
    )
    await score(db, "wrong-company", match, {
      listing: { ...listing, company: "Other" },
    })
    await score(
      db,
      "wrong-category",
      { ...match, category: "sales" },
      { listing }
    )
    await score(db, "wrong-arrangement", match, {
      listing: { ...listing, remote: "onsite" },
    })
    await score(db, "older", match, {
      listing: {
        ...listing,
        postedDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    })
    await score(db, "applied", match, { listing, status: "applied" })
    await score(db, "dismissed", match, { listing, status: "dismissed" })
    await apply(db, migration)
    await apply(db, filtersMigration)
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='${owner}'`
    )

    const filters = {
      view: "jobs",
      query: "STUDIO designer",
      city: "hyder",
      company: "EXAMPLE",
      workMode: "hybrid",
      category: "design",
      datePosted: "day",
      limit: 1,
    }
    const first = await read(db, filters)
    assert.equal(first.total, 2)
    assert.equal(first.counts.toReview, 2)
    assert.deepEqual(
      first.jobs.map(({ id }) => id),
      ["compact"]
    )
    const second = await read(db, { ...filters, offset: 1 })
    assert.equal(second.total, 2)
    assert.deepEqual(
      second.jobs.map(({ id }) => id),
      ["legacy"]
    )
    assert.equal((await read(db, { ...filters, datePosted: "week" })).total, 3)
    assert.equal(
      (await read(db, { ...filters, query: "studio % designer" })).total,
      0
    )
    assert.equal((await read(db, { ...filters, jobStatus: "all" })).total, 4)
    for (const status of ["applied", "dismissed"]) {
      const page = await read(db, { ...filters, jobStatus: status })
      assert.equal(page.total, 1)
      assert.deepEqual(
        page.jobs.map(({ id }) => id),
        [status]
      )
    }
    const commandSearch = await read(db, {
      view: "all",
      query: "STUDIO designer",
    })
    assert.equal(
      commandSearch.total,
      0,
      "Command search retains phrase matching"
    )
  } finally {
    await db.close()
  }
})

test("category migration fences old workers and scopes compact and legacy scores before pagination", async () => {
  const db = await setup()
  try {
    await state(db)
    await state(db, other)
    await score(
      db,
      "compact-design",
      { score: 60, softwareRole: false, inScope: true },
      { compact: true }
    )
    await score(db, "legacy-sales", {
      score: 50,
      softwareRole: false,
      inScope: true,
    })
    await score(db, "old-software-marker", { score: 100, softwareRole: true })
    await score(db, "outside-category", {
      score: 99,
      softwareRole: true,
      inScope: false,
    })
    await score(
      db,
      "saved-history",
      { score: 98, softwareRole: false },
      { status: "interested" }
    )
    await score(
      db,
      "applied-history",
      { score: 97, softwareRole: false },
      { status: "applied" }
    )
    await score(
      db,
      "other-account",
      { score: 90, softwareRole: false, inScope: true },
      { user: other }
    )
    await db.query(
      "update account_match_state set token=$2,building_version=1,lease_until=now()+interval '10 minutes',summary='{}' where user_id=$1",
      [owner, oldWorker]
    )
    await apply(db, migration)
    const worker = (
      await db.query<{
        token: string | null
        computed_at: string | null
        building_version: number | null
      }>(
        "select token,computed_at,building_version from account_match_state where user_id=$1",
        [owner]
      )
    ).rows[0]
    assert.deepEqual(worker, {
      token: null,
      computed_at: null,
      building_version: null,
    })
    await db.exec("set role service_role")
    await assert.rejects(
      db.query("select stage_account_matches($1,$2,'[]')", [owner, oldWorker]),
      /superseded/
    )
    assert.equal(
      (
        await db.query<{ published: boolean }>(
          "select publish_account_matches($1,$2,'{}',0) published",
          [owner, oldWorker]
        )
      ).rows[0].published,
      false
    )
    assert.equal(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from account_match_jobs"
        )
      ).rows[0].count,
      7
    )
    assert.equal(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from job_catalog"
        )
      ).rows[0].count,
      7
    )
    assert.equal(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from account_job_states"
        )
      ).rows[0].count,
      2
    )

    await db.exec(
      `reset role; set role authenticated; set request.jwt.claim.sub='${owner}'`
    )
    const first = await read(db, { limit: 1 })
    assert.equal(first.total, 2)
    assert.deepEqual(
      first.jobs.map((job) => job.id),
      ["compact-design"]
    )
    assert.equal(first.jobs[0].title, "Product Designer compact-design")
    assert.equal(first.jobs[0].match.softwareRole, false)
    assert.deepEqual(first.counts, {
      new: 2,
      toReview: 2,
      fresh: 2,
      confirmed: 0,
    })
    const second = await read(db, { limit: 1, offset: 1 })
    assert.deepEqual(
      second.jobs.map((job) => job.id),
      ["legacy-sales"]
    )
    assert.equal(second.total, 2)
    assert.deepEqual(
      (await read(db, { view: "saved" })).jobs.map((job) => job.id).sort(),
      ["applied-history", "saved-history"]
    )
    await assert.rejects(
      db.query("select read_account_matches_for($1,'{}')", [other]),
      /permission denied/
    )
    assert.deepEqual(
      (
        await db.query<{ user_id: string }>(
          "select distinct user_id from account_match_jobs"
        )
      ).rows,
      [{ user_id: owner }]
    )

    await db.exec(`set request.jwt.claim.sub='${other}'`)
    assert.deepEqual(
      (await read(db)).jobs.map((job) => job.id),
      ["other-account"]
    )
    await db.exec("reset role")
    await db.query(
      'update account_profiles set version=2,data=\'{"jobCategories":["software"]}\' where user_id=$1',
      [owner]
    )
    await db.exec(
      `set role authenticated; set request.jwt.claim.sub='${owner}'`
    )
    const changed = await read(db)
    assert.equal(
      changed.total,
      0,
      "New jobs scored for old category preferences must disappear immediately"
    )
    assert.equal(changed.counts.new, 0)
    assert.equal(changed.matching.profileCurrent, false)
    assert.deepEqual(
      (await read(db, { view: "saved" })).jobs.map((job) => job.id).sort(),
      ["applied-history", "saved-history"]
    )
    assert.deepEqual(
      (await read(db, { view: "all" })).jobs.map((job) => job.id).sort(),
      ["applied-history", "saved-history"]
    )
    await db.exec("reset role; set role anon")
    await assert.rejects(read(db), /permission denied/)
  } finally {
    await db.close()
  }
})

test("discovery priorities count selected nonsoftware categories and keep stale profile scores unmeasured", async () => {
  const db = await setup()
  try {
    await apply(db, migration)
    await state(db)
    for (let i = 0; i < 5; i++)
      await score(
        db,
        `design-${i}`,
        { score: 70, softwareRole: false, inScope: true },
        { compact: i % 2 === 0 }
      )
    await score(db, "old-marker", { score: 100, softwareRole: true })
    await db.exec("set role service_role")
    await db.query("select initialize_automatic_discovery($1)", [["India"]])
    const priority = async () =>
      (
        await db.query<{
          result: {
            country: string
            users: number
            underserved: number
            unmeasured: number
          }[]
        }>("select automatic_discovery_country_priority() result")
      ).rows[0].result[0]
    const enough = await priority()
    assert.equal(enough.users, 2)
    assert.equal(
      enough.underserved,
      0,
      "Five in-scope design jobs satisfy measured supply even with softwareRole false"
    )
    assert.equal(enough.unmeasured, 1)
    await db.query(
      "update account_match_jobs set job=jsonb_set(job,'{match,inScope}','false') where job_id='design-0'"
    )
    const fewer = await priority()
    assert.equal(
      fewer.underserved,
      1,
      "Old software-only marker cannot substitute for the user's selected categories"
    )
    assert.equal(fewer.unmeasured, 1)
    await db.query("update account_profiles set version=2 where user_id=$1", [
      owner,
    ])
    const stale = await priority()
    assert.equal(stale.underserved, 0)
    assert.equal(stale.unmeasured, 2)
    await db.exec("reset role; set role authenticated")
    await assert.rejects(priority(), /permission denied/)
  } finally {
    await db.close()
  }
})
