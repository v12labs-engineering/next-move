import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { catalogSources } from "@/lib/server/catalog/feeds"
import {
  parseAshby,
  parseLever,
} from "@/lib/server/catalog/connectors/board-apis"
import { catalogJob, type CatalogRow } from "@/lib/server/catalog/job"
import {
  postingDetails,
  structuredPostingDetails,
} from "@/lib/server/catalog/posting-details"
import {
  sourceTaskDatabase,
  taskOperations,
} from "./helpers/source-task-database"

const description =
  "Build and maintain distributed software systems in TypeScript and PostgreSQL. Work with the team to ship reliable products."
const source = catalogSources[0]
const providerJob = {
  title: "Senior Software Engineer",
  jobUrl: "https://jobs.ashbyhq.com/n8n/disclosed",
  isListed: true,
  descriptionPlain: description,
  publishedAt: new Date(Date.now() - 60_000).toISOString(),
  address: { postalAddress: { addressCountry: "IN", addressLocality: "Pune" } },
  employmentType: "FullTime",
  compensation: {
    summaryComponents: [
      {
        compensationType: "Salary",
        currencyCode: "INR",
        interval: "1 YEAR",
        minValue: 1_500_000,
        maxValue: 2_000_000,
      },
    ],
  },
}
const salary = {
  currency: "INR",
  period: "year",
  min: 1_500_000,
  max: 2_000_000,
}

test("normalizes explicitly posted details and excludes ambiguous or inferred values", () => {
  assert.deepEqual(
    postingDetails(
      "Salary: 15–20 LPA\nJob type: Part-time\nSeniority level: Mid-Senior Level",
      "India"
    ),
    { salary, employmentTypes: ["part_time"], experienceLevel: "mid_senior" }
  )
  assert.equal(
    postingDetails(
      "Senior engineer. Five years of experience. Competitive salary. Full-time team members receive benefits.",
      "India"
    ),
    undefined
  )
  assert.equal(
    postingDetails(
      "Salary: 20,000\nExperience level: Senior\nExperience level: Entry level",
      "India"
    ),
    undefined
  )
  assert.equal(postingDetails("Salary: $50,000 per year", "India"), undefined)
  assert.equal(postingDetails("Salary: 15–20 LPA", "Bangladesh"), undefined)
  assert.equal(
    postingDetails(
      "Salary: ₹150,000 per year\nSalary: ₹200,000 per year",
      "India"
    ),
    undefined
  )
  const [lever] = parseLever({ ...source, id: "lever:n8n", kind: "lever" }, [
    {
      text: "Software Engineer",
      hostedUrl: "https://jobs.lever.co/n8n/fixture",
      country: "IN",
      categories: { commitment: "Contract" },
      descriptionPlain: description,
      salaryRange: {
        currency: "INR",
        interval: "per-year-salary",
        min: salary.min,
        max: salary.max,
      },
    },
  ])
  assert.deepEqual(lever.posting_details, {
    employmentTypes: ["contract"],
    salary,
  })
  const details = structuredPostingDetails({
    employmentType: ["FULL_TIME", "CONTRACTOR"],
    experienceRequirements: { monthsOfExperience: 36 },
    baseSalary: { currency: "USD", value: { unitText: "HOUR", value: 40 } },
  })
  assert.deepEqual(postingDetails("", "India", details), {
    employmentTypes: ["contract", "full_time"],
    salary: { currency: "USD", period: "hour", min: 40, max: 40 },
  })
})

test("catalog publishers preserve posting facts and match pages filter compact snapshots before pagination", async () => {
  const db = await sourceTaskDatabase(true)
  const user = "00000000-0000-4000-8000-000000000001"
  const generation = "00000000-0000-4000-8000-000000000002"
  try {
    await db.exec("reset role")
    for (const migration of [
      "202611020041_software_role_scope.sql",
      "202611040050_automatic_source_discovery.sql",
      "202611160072_restore_compact_match_reader.sql",
      "202611170078_profile_job_categories.sql",
      "202611180093_job_board_filters.sql",
      "202611180094_job_posting_details.sql",
    ]) {
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${migration}`, import.meta.url),
          "utf8"
        )
      )
    }
    const [disclosed, unknown] = parseAshby(source, {
      jobs: [
        {
          ...providerJob,
          descriptionPlain: description + "\nExperience level: Senior",
        },
        {
          ...providerJob,
          jobUrl: "https://jobs.ashbyhq.com/n8n/missing",
          employmentType: null,
          compensation: null,
        },
      ],
    })
    assert.deepEqual(disclosed.posting_details, {
      salary,
      employmentTypes: ["full_time"],
      experienceLevel: "senior",
    })
    assert.equal(unknown.posting_details, undefined)

    await db.query("insert into auth.users(id) values($1)", [user])
    await db.query(
      "insert into account_profiles(user_id,data) values($1,'{}')",
      [user]
    )
    await db.query(
      "insert into account_countries(user_id,country) values($1,'India')",
      [user]
    )
    await db.query(
      "insert into account_match_state(user_id,generation,profile_version,token,lease_until,computed_at) values($1,$2,1,$2,now()+interval '10 minutes',now())",
      [user, generation]
    )

    await db.exec("set role service_role")
    const tasks = taskOperations(db)
    const task = await tasks.request()
    const { lease_token } = await tasks.claim(task.id)
    await tasks.rpc(
      "checkpoint_catalog_source_task($1,$2,1,null,$3::jsonb,2,0,1)",
      [task.id, lease_token, JSON.stringify([disclosed, unknown])]
    )
    await tasks.rpc("finish_catalog_source_task($1,$2)", [task.id, lease_token])

    const search = async (observation: object) => {
      const {
        rows: [run],
      } = await db.query<{ id: string; dispatch_token: string }>(
        "insert into job_search_runs(scope_key,roles,countries,status,dispatch_token,sources) values('fixture',array['Engineer'],array['India'],'running',gen_random_uuid(),'[\"ashby:n8n\"]') returning id,dispatch_token"
      )
      return tasks.rpc<{ updatedRecords: number }>(
        "publish_job_search_source($1,$2,'ashby:n8n',$3,false,null,1)",
        [run.id, run.dispatch_token, JSON.stringify([observation])]
      )
    }
    assert.equal((await search(unknown)).updatedRecords, 0)
    const {
      rows: [unchanged],
    } = await db.query<{ posting_details: unknown }>(
      "select posting_details from job_catalog where id=$1",
      [disclosed.id]
    )
    assert.deepEqual(unchanged.posting_details, disclosed.posting_details)

    const monthly = {
      ...disclosed,
      id: "monthly",
      url: "https://example.com/monthly",
      posting_details: {
        ...disclosed.posting_details,
        salary: { currency: "INR", period: "month", min: 100_000, max: null },
      },
    }
    const usd = {
      ...disclosed,
      id: "usd",
      url: "https://example.com/usd",
      posting_details: {
        ...disclosed.posting_details,
        salary: { currency: "USD", period: "year", min: 999_999, max: null },
      },
    }
    await search(monthly)
    await search(usd)
    const batch = await tasks.rpc<{ items: CatalogRow[] }>(
      "catalog_matching_batch(array['India'],now(),null,20)"
    )
    assert.equal(batch.items.length, 4)
    const jobs = batch.items.map((row) => ({
      ...catalogJob(row),
      match: {
        score: row.id === disclosed.id ? 100 : 80,
        inScope: true,
        eligible: true,
        relevant: true,
        reviewable: true,
      },
    }))
    await tasks.rpc("stage_account_matches($1,$2,$3)", [
      user,
      generation,
      JSON.stringify(jobs),
    ])

    await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`)
    const read = (filters: Record<string, string | number>) =>
      tasks.rpc<{
        total: number
        jobs: { id: string; postingDetails?: unknown }[]
      }>("read_account_matches($1)", [
        JSON.stringify({ view: "jobs", datePosted: "month", ...filters }),
      ])
    const salaryFilters = {
      employmentType: "full_time",
      experienceLevel: "senior",
      salary: "1000000",
      limit: 1,
    }
    const page = await read(salaryFilters)
    assert.equal(page.total, 2)
    assert.equal(page.jobs[0].id, disclosed.id)
    assert.deepEqual(page.jobs[0].postingDetails, disclosed.posting_details)
    assert.equal(
      (await read({ ...salaryFilters, offset: 1 })).jobs[0].id,
      "monthly"
    )
    assert.equal((await read({ ...salaryFilters, salary: "1500000" })).total, 1)
    assert.equal(
      (await read({ ...salaryFilters, salary: "disclosed" })).total,
      3
    )
    assert.equal(
      (
        await read({
          salary: "unknown",
          employmentType: "unknown",
          experienceLevel: "unknown",
        })
      ).jobs[0].id,
      unknown.id
    )
    assert.equal((await read({ salary: "invalid" })).total, 0)
    await db.exec("set role service_role")
    const withoutDetails = { ...monthly, posting_details: null }
    assert.equal(
      (await search(withoutDetails)).updatedRecords,
      1,
      "A source can remove previously disclosed details"
    )
    assert.equal((await search(withoutDetails)).updatedRecords, 0)
  } finally {
    await db.close()
  }
})
