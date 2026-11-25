import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const alice = "00000000-0000-4000-8000-000000000001"
const bob = "00000000-0000-4000-8000-000000000002"

test("public account migration enforces ownership in real Postgres", async (t) => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      insert into auth.users values('${alice}'),('${bob}');`)
    for (const file of [
      "202606160001_initial_schema.sql",
      "202606160002_enable_rls.sql",
      "202606290002_normalized_runtime_state.sql",
    ]) {
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${file}`, import.meta.url),
          "utf8"
        )
      )
    }
    await db.exec(
      "create table research_reports(id text primary key,answer text); grant all on all tables in schema public to anon,authenticated;"
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290001_public_accounts.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290003_destination_countries.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611160073_onboarding_experience.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      "insert into job_catalog(id,title,company,country,url,source) values('job-1','Backend Engineer','Example','Germany','https://example.com/jobs/1','test')"
    )
    const asUser = async (id: string) => {
      await db.exec("reset role")
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ])
      await db.exec("set role authenticated")
    }
    await t.test(
      "anonymous users cannot read any account or catalogue data",
      async () => {
        await db.exec("set role anon")
        for (const table of [
          "account_profiles",
          "account_countries",
          "account_job_states",
          "resume_drafts",
          "account_ai_usage",
          "job_catalog",
        ]) {
          await assert.rejects(
            db.query(`select * from ${table}`),
            /permission denied/
          )
        }
        await assert.rejects(
          db.query("select reserve_tailoring_attempt()"),
          /permission denied/
        )
      }
    )
    await t.test(
      "onboarding is atomic and cannot set a different owner",
      async () => {
        await asUser(bob)
        for (const experienceYears of [null, 1, "2"]) {
          await assert.rejects(
            db.query("select save_candidate($1::jsonb,0)", [
              JSON.stringify({ experienceYears, targetCountries: ["India"] }),
            ]),
            /at least 2 years/
          )
        }
        await assert.rejects(
          db.query("insert into account_profiles(data) values ('{}')"),
          /at least 2 years/
        )
        assert.equal(
          (await db.query("select * from account_profiles")).rows.length,
          0
        )
        assert.equal(
          (await db.query("select * from account_countries")).rows.length,
          0
        )
        await asUser(alice)
        await db.query("select save_candidate($1::jsonb,0)", [
          JSON.stringify({
            fullName: "Alice",
            experienceYears: 2,
            resumeText: "Private Alice history",
            targetCountries: ["Germany"],
            applicationProfile: {
              enabled: true,
              contact: { email: "private-applications@example.test" },
              eligibility: [{ country: "Germany", authorized: true }],
              compensation: [
                {
                  country: "Germany",
                  minimum: 80000,
                  maximum: 100000,
                  currency: "EUR",
                  period: "year",
                  basis: "base",
                },
              ],
            },
          }),
        ])
        await assert.rejects(
          db.query(
            "insert into account_profiles(user_id,data) values($1,'{}')",
            [bob]
          ),
          /row-level security/
        )
        await assert.rejects(
          db.query("select save_candidate($1::jsonb,1)", [
            JSON.stringify({
              fullName: "Changed",
              targetCountries: ["x".repeat(101)],
            }),
          ])
        )
        const profile = await db.query<{ data: { fullName: string } }>(
          "select data from account_profiles"
        )
        assert.equal(profile.rows[0].data.fullName, "Alice")
        const privateDetails = await db.query<{
          profile: { contact: { email: string } }
        }>("select data->'applicationProfile' profile from account_profiles")
        assert.equal(
          privateDetails.rows[0].profile.contact.email,
          "private-applications@example.test"
        )
        await asUser(bob)
        assert.equal(
          (
            await db.query(
              "select data->'applicationProfile' from account_profiles"
            )
          ).rows.length,
          0
        )
        await asUser(alice)
        assert.equal(
          (await db.query("select * from account_countries")).rows.length,
          1
        )
      }
    )
    await t.test(
      "stale profile edits cannot overwrite another tab",
      async () => {
        await asUser(alice)
        await db.query("select save_candidate($1::jsonb,1)", [
          JSON.stringify({
            fullName: "Alice updated",
            experienceYears: null,
            targetCountries: ["Japan"],
          }),
        ])
        await assert.rejects(
          db.query("select save_candidate($1::jsonb,1)", [
            JSON.stringify({ fullName: "Stale", targetCountries: ["Germany"] }),
          ]),
          /changed in another session/
        )
        assert.equal(
          (
            await db.query<{ country: string }>(
              "select country from account_countries"
            )
          ).rows[0].country,
          "Japan"
        )
        assert.deepEqual(
          (
            await db.query(
              "select data->'experienceYears' as experience from account_profiles"
            )
          ).rows,
          [{ experience: null }]
        )
      }
    )
    await t.test(
      "destination countries can be added and removed and persist on a fresh read",
      async () => {
        await asUser(alice)
        await db.query("select save_candidate($1::jsonb,2)", [
          JSON.stringify({
            fullName: "Alice updated",
            targetCountries: ["Canada", "Japan", "Singapore"],
            targetLocations: [
              {
                id: 6167865,
                country: "Canada",
                name: "Toronto",
                region: "Ontario",
              },
            ],
          }),
        ])
        await asUser(bob)
        assert.equal(
          (await db.query("select country from account_countries")).rows.length,
          0
        )
        await asUser(alice)
        const restored = await db.query<{
          data: { targetLocations: unknown[] }
        }>("select data from account_profiles")
        assert.deepEqual(restored.rows[0].data.targetLocations, [
          {
            id: 6167865,
            country: "Canada",
            name: "Toronto",
            region: "Ontario",
          },
        ])
        assert.deepEqual(
          (
            await db.query(
              "select country from account_countries order by country"
            )
          ).rows,
          [
            { country: "Canada" },
            { country: "Japan" },
            { country: "Singapore" },
          ]
        )
        await db.query("select save_candidate($1::jsonb,3)", [
          JSON.stringify({
            fullName: "Alice updated",
            targetCountries: ["Canada"],
          }),
        ])
        assert.deepEqual(
          (await db.query("select country from account_countries")).rows,
          [{ country: "Canada" }]
        )
        await assert.rejects(
          db.query("select save_candidate($1::jsonb,4)", [
            JSON.stringify({ fullName: "Alice updated", targetCountries: [] }),
          ]),
          /Choose target countries/
        )
        assert.deepEqual(
          (await db.query("select country from account_countries")).rows,
          [{ country: "Canada" }]
        )
      }
    )
    let draftId = ""
    await t.test(
      "private statuses and drafts are isolated even for the same shared job",
      async () => {
        await asUser(alice)
        await db.exec(
          "insert into account_job_states(job_id,status) values('job-1','applied')"
        )
        const draft = await db.query<{ id: string }>(
          "insert into resume_drafts(job_id,profile_version,content,evidence,model) values('job-1',1,'Private Alice resume','{}','test') returning id"
        )
        draftId = draft.rows[0].id
        await asUser(bob)
        assert.equal(
          (await db.query("select * from account_profiles")).rows.length,
          0
        )
        assert.equal(
          (await db.query("select * from account_countries")).rows.length,
          0
        )
        assert.equal(
          (await db.query("select * from account_job_states")).rows.length,
          0
        )
        assert.equal(
          (await db.query("select * from resume_drafts")).rows.length,
          0
        )
        assert.equal(
          (await db.query("select * from job_catalog")).rows.length,
          1
        )
        assert.equal(
          (
            await db.query(
              "update account_job_states set status='dismissed' where user_id=$1 returning *",
              [alice]
            )
          ).rows.length,
          0
        )
        assert.equal(
          (
            await db.query(
              "update resume_drafts set content='stolen' where id=$1 returning id",
              [draftId]
            )
          ).rows.length,
          0
        )
        await assert.rejects(
          db.query(
            "insert into account_job_states(user_id,job_id,status) values($1,'job-1','dismissed')",
            [alice]
          ),
          /row-level security/
        )
        await db.exec(
          "insert into account_job_states(job_id,status) values('job-1','interested')"
        )
        await assert.rejects(
          db.exec("update job_catalog set title='tampered'"),
          /permission denied/
        )
        await asUser(alice)
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from account_job_states"
            )
          ).rows[0].status,
          "applied"
        )
        await db.query(
          "update resume_drafts set content='Alice edited' where id=$1",
          [draftId]
        )
        await assert.rejects(
          db.query("update resume_drafts set user_id=$1 where id=$2", [
            bob,
            draftId,
          ]),
          /permission denied/
        )
      }
    )
    await t.test(
      "legacy data cannot be read or written by public accounts",
      async () => {
        for (const table of [
          "jobs",
          "companies",
          "candidate_profiles",
          "applications",
          "app_state",
          "collection_runs",
          "tracked_countries",
          "research_reports",
        ]) {
          await assert.rejects(
            db.query(`select * from ${table}`),
            /permission denied/
          )
        }
      }
    )
    await t.test(
      "daily AI quota is atomic, bounded and independent per account",
      async () => {
        await asUser(alice)
        const attempts = await Promise.all(
          Array.from({ length: 12 }, () =>
            db.query<{ reserve_tailoring_attempt: boolean }>(
              "select reserve_tailoring_attempt()"
            )
          )
        )
        assert.equal(
          attempts.filter((r) => r.rows[0].reserve_tailoring_attempt).length,
          10
        )
        await assert.rejects(
          db.exec("update account_ai_usage set attempts=1"),
          /permission denied/
        )
        await asUser(bob)
        assert.equal(
          (await db.query("select * from account_ai_usage")).rows.length,
          0
        )
        assert.equal(
          (
            await db.query<{ reserve_tailoring_attempt: boolean }>(
              "select reserve_tailoring_attempt()"
            )
          ).rows[0].reserve_tailoring_attempt,
          true
        )
      }
    )
    await t.test(
      "India rollout retains Indian cities and application history",
      async () => {
        await asUser(alice)
        const city = { id: 1, name: "Pune", country: "India", region: null }
        const oldCity = {
          id: 2,
          name: "Toronto",
          country: "Canada",
          region: null,
        }
        const applicationProfile = { eligibility: [{ country: "Canada" }] }
        await db.query("select save_candidate($1::jsonb,4)", [
          JSON.stringify({
            targetCountries: ["India", "Canada"],
            targetLocations: [city, oldCity],
            applicationProfile,
          }),
        ])
        await asUser(bob)
        await db.query("select save_candidate($1::jsonb,0)", [
          JSON.stringify({
            experienceYears: 3,
            targetCountries: ["Canada"],
            targetLocations: [oldCity],
          }),
        ])
        await db.exec("reset role")
        const migration = await readFile(
          new URL(
            "../supabase/migrations/202611180092_india_job_search.sql",
            import.meta.url
          ),
          "utf8"
        )
        await db.exec(migration)
        await db.exec(migration)
        await asUser(alice)
        assert.deepEqual(
          (await db.query("select country from account_countries")).rows,
          [{ country: "India" }]
        )
        assert.deepEqual(
          (await db.query("select version,data from account_profiles")).rows,
          [
            {
              version: 6,
              data: { targetLocations: [city], applicationProfile },
            },
          ]
        )
        assert.deepEqual(
          (await db.query("select job_id,status from account_job_states")).rows,
          [{ job_id: "job-1", status: "applied" }]
        )
        await asUser(bob)
        assert.deepEqual(
          (await db.query("select country from account_countries")).rows,
          [{ country: "India" }]
        )
        assert.deepEqual(
          (await db.query("select version,data from account_profiles")).rows,
          [{ version: 2, data: { experienceYears: 3, targetLocations: [] } }]
        )
      }
    )
  } finally {
    await db.close()
  }
})
