import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { findFollowupContacts } from "@/lib/server/applications/followup"

const employer = {
  company: "Example Robotics",
  title: "Senior Software Engineer",
  targetUrl: "https://jobs.example.com/123",
}

function person(slug: string, title: string, company = employer.company) {
  return {
    full_name: `Test ${slug}`,
    linkedin_url: `https://www.linkedin.com/in/${slug}`,
    experiences: [
      {
        company_name: company,
        company_domain: "example.com",
        company_linkedin_url: "https://www.linkedin.com/company/example",
        job_title: title,
        job_is_current: true,
      },
    ],
    email: "private@example.net",
  }
}

function firecrawl(data: unknown) {
  return Response.json({ success: true, data: { alexandria: [{ data }] } })
}

test("contact lookup is employer-scoped and returns ranked professional profiles only", async () => {
  const past = person("past", "Recruiter")
  past.experiences[0].job_is_current = false
  const contacts = await findFollowupContacts(
    employer,
    "test-key",
    async (url, request) => {
      assert.equal(url, "https://api.firecrawl.dev/v2/scrape")
      assert.deepEqual(JSON.parse(String(request?.body)), {
        alexandria: {
          provider: "blitzapi",
          capability: "people/search",
          options: {
            company: { name: { include: ["Example Robotics"] } },
            people: {
              job_title: {
                include: [
                  "recruiter",
                  "talent acquisition",
                  "people operations",
                  "founder",
                  "Software Engineer",
                  "engineering manager",
                ],
              },
            },
            max_results: 3,
          },
        },
      })
      return firecrawl({
        results: [
          person("lead", "Engineering Manager"),
          person("other", "Recruiter", "Other Company"),
          past,
          {
            ...person("fake", "Recruiter"),
            linkedin_url: "https://linkedin.com.example.org/in/fake",
          },
          person("recruiter", "Technical Recruiter"),
        ],
      })
    }
  )
  assert.deepEqual(contacts, [
    {
      name: "Test recruiter",
      title: "Technical Recruiter",
      profileUrl: "https://www.linkedin.com/in/recruiter",
      reason: "Recruiting",
    },
    {
      name: "Test lead",
      title: "Engineering Manager",
      profileUrl: "https://www.linkedin.com/in/lead",
      reason: "Related role",
    },
  ])
})

test("a shared employer name needs disambiguation when the provider returns multiple companies", async () => {
  const a = person("one", "Recruiter")
  const b = person("two", "Recruiter")
  b.experiences[0].company_domain = "other.example"
  b.experiences[0].company_linkedin_url =
    "https://www.linkedin.com/company/other"
  const fetcher = async () => firecrawl([a, b])
  assert.deepEqual(
    await findFollowupContacts(
      { ...employer, targetUrl: "https://jobs.ashbyhq.com/example/123" },
      "key",
      fetcher
    ),
    []
  )
  assert.equal(
    (await findFollowupContacts(employer, "key", fetcher))[0]?.name,
    "Test one"
  )
})

test("provider errors stay distinct from empty results", async () => {
  await assert.rejects(
    findFollowupContacts(employer, "key", async () =>
      Response.json({
        success: true,
        data: {
          alexandria: [{ error: { code: "THIRD_PARTY_DATA_TERMS_REQUIRED" } }],
        },
      })
    )
  )
  assert.deepEqual(
    await findFollowupContacts(employer, "key", async () =>
      firecrawl({ results: [] })
    ),
    []
  )
})

test("retirement disables legacy job providers and lookup reservations require ownership and a receipt", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table job_source_directory (kind text, enabled boolean);
      insert into job_source_directory values ('alexandria', true), ('ashby', true);
      create table alexandria_search_control (singleton boolean, enabled boolean);
      insert into alexandria_search_control values (true, true);
      create table application_runs (id uuid primary key, user_id uuid, status text, receipt jsonb, job_id text);
    `)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611110068_application_followup.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    assert.deepEqual(
      (await db.query("select * from job_source_directory order by kind")).rows,
      [
        { kind: "alexandria", enabled: false },
        { kind: "ashby", enabled: true },
      ]
    )
    assert.deepEqual(
      (await db.query("select enabled from alexandria_search_control")).rows,
      [{ enabled: false }]
    )
    const id = randomUUID(),
      owner = randomUUID()
    await db.query(
      "insert into application_runs values ($1, $2, 'submission_unknown', null, 'job')",
      [id, owner]
    )
    const reserve = async (user: string) =>
      (
        await db.query<{
          result: { status: string; id?: string; contacts?: unknown }
        }>("select reserve_application_followup($1, $2) as result", [id, user])
      ).rows[0].result

    await db.exec("set role authenticated")
    await assert.rejects(reserve(owner), /permission denied/)
    await db.exec("set role service_role")
    assert.equal((await reserve(owner)).status, "ineligible")
    await db.exec("reset role")
    await db.query(
      "update application_runs set status = 'submitted', receipt = '{}' where id = $1",
      [id]
    )
    await db.exec("set role service_role")
    assert.equal((await reserve(randomUUID())).status, "ineligible")
    const reserved = await reserve(owner)
    assert.equal(reserved.status, "reserved")
    assert.equal((await reserve(owner)).status, "recent")
    await db.query(
      "update application_followup_lookups set contacts = '[]' where id = $1",
      [reserved.id]
    )
    assert.deepEqual(await reserve(owner), { status: "cached", contacts: [] })

    await db.exec("reset role")
    await db.exec(
      "update application_followup_lookups set requested_at = now() - interval '8 days'"
    )
    await db.query(
      "insert into application_followup_lookups(application_id) select $1 from generate_series(1, 20)",
      [id]
    )
    const secondId = randomUUID()
    await db.query(
      "insert into application_runs values ($1, $2, 'submitted', '{}', 'job')",
      [secondId, owner]
    )
    const capped = await db.query<{ result: { status: string } }>(
      "select reserve_application_followup($1, $2) as result",
      [secondId, owner]
    )
    assert.equal(capped.rows[0].result.status, "daily_limit")
    assert.deepEqual(
      (
        await db.query(
          "select id from application_followup_lookups where id = $1",
          [reserved.id]
        )
      ).rows,
      []
    )
  } finally {
    await db.close()
  }
})

test("manual follow-up is limited to the latest five applied jobs for the owner and shares the confirmed lookup budget", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table job_source_directory (kind text, enabled boolean);
      create table alexandria_search_control (singleton boolean, enabled boolean);
      create table application_runs (id uuid primary key, user_id uuid, status text, receipt jsonb, job_id text);
      create table job_catalog (id text primary key, company text, title text, url text, description text);
      create table account_job_states (user_id uuid, job_id text, status text, updated_at timestamptz, primary key(user_id, job_id));
      grant select on job_catalog, account_job_states, application_runs to service_role;
    `)
    for (const migration of [
      "202611110068_application_followup.sql",
      "202611110069_manual_application_followup.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${migration}`, import.meta.url),
          "utf8"
        )
      )

    const owner = randomUUID(),
      otherOwner = randomUUID(),
      confirmed = randomUUID()
    await db.exec(`insert into job_catalog
      select 'job-' || i, 'Example Robotics', 'Engineer ' || i, 'https://example.com/jobs/' || i, 'Long listing text'
      from generate_series(1, 8) as i`)
    await db.query(
      `insert into account_job_states
      select $1, 'job-' || i, case when i = 8 then 'dismissed' else 'applied' end,
        now() + i * interval '1 second' from generate_series(1, 8) as i`,
      [owner]
    )
    await db.query(
      "insert into application_runs values ($1, $2, 'submitted', '{}', 'job-7')",
      [confirmed, owner]
    )
    const list = async (user: string) =>
      (
        await db.query<{ job_id: string; job: Record<string, unknown> }>(
          "select * from recent_manual_followup_jobs($1)",
          [user]
        )
      ).rows
    const reserve = async (job: string, user = owner) =>
      (
        await db.query<{
          result: { status: string; id?: string; employer?: unknown }
        }>("select reserve_manual_application_followup($1, $2) as result", [
          job,
          user,
        ])
      ).rows[0].result

    await db.exec("set role authenticated")
    await assert.rejects(list(owner), /permission denied/)
    await assert.rejects(reserve("job-6"), /permission denied/)
    await db.exec("set role service_role")
    const rows = await list(owner)
    assert.deepEqual(
      rows.map(({ job_id }) => job_id),
      ["job-6", "job-5", "job-4", "job-3", "job-2"]
    )
    assert.equal(rows[0].job.description, undefined)
    assert.deepEqual(await list(otherOwner), [])
    for (const job of ["job-1", "job-7", "job-8"])
      assert.equal((await reserve(job)).status, "ineligible")
    assert.equal((await reserve("job-6", otherOwner)).status, "ineligible")
    const reservation = await reserve("job-6")
    assert.equal(reservation.status, "reserved")
    assert.deepEqual(reservation.employer, {
      company: "Example Robotics",
      title: "Engineer 6",
      targetUrl: "https://example.com/jobs/6",
    })
    assert.equal((await reserve("job-6")).status, "recent")
    await db.query(
      "update application_followup_lookups set contacts = '[]' where id = $1",
      [reservation.id]
    )
    assert.deepEqual(await reserve("job-6"), { status: "cached", contacts: [] })

    await db.exec("reset role")
    await db.query(
      "update account_job_states set status = 'dismissed' where user_id = $1 and job_id = 'job-6'",
      [owner]
    )
    assert.equal((await reserve("job-6")).status, "ineligible")
    assert.equal((await list(owner)).at(-1)?.job_id, "job-1")
    await db.query(
      "insert into application_followup_lookups(application_id) select $1 from generate_series(1, 19)",
      [confirmed]
    )
    assert.equal((await reserve("job-5")).status, "daily_limit")
  } finally {
    await db.close()
  }
})
