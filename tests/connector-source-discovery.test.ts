import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import {
  boardIdentity,
  publicBoardUrl,
} from "@/lib/server/catalog/source-identity"
import { seedDirectories } from "@/lib/server/catalog/discovery/seeds"
import { validateCandidate } from "@/lib/server/catalog/discovery/validate"
import { sourceTaskDatabase } from "./helpers/source-task-database"
import type { CatalogPosting } from "@/lib/server/catalog/feeds"

test("source admission accepts non-software professions without weakening posting evidence", async () => {
  const description =
    "Manage customer accounts, prepare proposals, coordinate contract renewals, and maintain accurate sales forecasts while collaborating with the account team."
  const published = new Date(Date.now() - 86_400_000).toISOString()
  const guid = "685d8736-d012-4881-b6b1-ae16b4745feb"
  for (const kind of ["keka", "zohorecruit", "greenhouse"] as const) {
    const candidate = {
      ...boardIdentity(
        kind,
        kind === "zohorecruit" ? "acme.zohorecruit.in" : "acme"
      ),
      expected_company: "Acme",
      historical_checked_at: null,
      evidence_url: "https://acme.com/careers",
    }
    const validate = async (
      text = description,
      country = "India",
      unsafe = false
    ) => {
      let catalogJobs: CatalogPosting[] | undefined
      const result = await validateCandidate(
        candidate,
        async (url, format) => {
          if (kind === "keka") {
            if (format === "html")
              return `<script>fetch('/ats/documents/${guid}/careerportal/index.html')</script>`
            if (url.endsWith("/careerportalinfo")) return { name: "Acme" }
            return [
              {
                id: "7",
                title: "Account Executive",
                description: text,
                jobLocations: [{ city: "Pune", countryName: country }],
                publishedOn: published,
              },
            ]
          }
          if (kind === "zohorecruit")
            return `<meta property="og:site_name" content="Acme"><input id="jobs" value="${JSON.stringify(
              [
                {
                  id: "7",
                  Posting_Title: "Account Executive",
                  Job_Description: text,
                  City: "Pune",
                  Country: country,
                  Publish: true,
                  Date_Opened: published,
                },
              ]
            ).replace(/"/g, "&#34;")}">`
          if (!url.includes("/jobs?")) return { name: "Acme" }
          return {
            jobs: [
              {
                id: 7,
                title: "Account Executive",
                content: text,
                first_published: published,
                location: {
                  name: ["Pune", country].filter(Boolean).join(", "),
                },
                absolute_url: unsafe
                  ? "https://user:pass@careers.acme.com/?gh_jid=7"
                  : "https://job-boards.greenhouse.io/acme/jobs/7",
              },
            ],
          }
        },
        new Date(),
        undefined,
        {
          observeJobs: (jobs) => {
            catalogJobs = jobs
          },
        }
      )
      return { result, catalogJobs }
    }
    const { result, catalogJobs } = await validate()
    assert.equal(result.status, "verified", `${kind}: ${result.reason}`)
    assert.equal(result.accepted_count, 1)
    assert.equal(result.fresh_count, 1)
    assert.deepEqual(result.countries, ["India"])
    assert.deepEqual(
      catalogJobs,
      [],
      "Source admission must not alter catalog profession eligibility"
    )
    for (const rejected of [
      await validate("Short description"),
      await validate(description, ""),
    ]) {
      assert.equal(rejected.result.status, "needs_review", kind)
      assert.equal(rejected.result.accepted_count, 0)
    }
    if (kind === "greenhouse") {
      const rejected = await validate(description, "India", true)
      assert.equal(rejected.result.status, "needs_review")
      assert.equal(rejected.result.accepted_count, 0)
    }
  }
})

test("Keka and Zoho use the existing protected discovery lifecycle and scoped source pool", async () => {
  const db = await sourceTaskDatabase(true)
  try {
    await db.exec("reset role")
    for (const migration of [
      "202611070060_public_ats_readers.sql",
      "202611160074_amazon_india_catalog.sql",
      "202611160075_regional_employer_catalog.sql",
      "202611170076_keka_zoho_recruit_sources.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${migration}`, import.meta.url),
          "utf8"
        )
      )
    await db.exec("set role service_role")

    const identities = [
      boardIdentity("keka", "acme"),
      boardIdentity("zohorecruit", "acme.zohorecruit.in"),
    ]
    const description =
      "Build distributed software services and APIs, write automated tests, and maintain reliable production systems with the engineering team."
    const published = new Date(Date.now() - 86_400_000).toISOString()
    const guid = "685d8736-d012-4881-b6b1-ae16b4745feb"
    for (const identity of identities) {
      const candidate = {
        ...identity,
        expected_company: "Acme",
        historical_checked_at: null,
        evidence_url: publicBoardUrl(identity.kind, identity.board),
      }
      const importCandidates = () =>
        db.query<{ result: { new_candidates: number } }>(
          "select import_source_candidates($1::jsonb,$2::jsonb) result",
          [JSON.stringify(seedDirectories[3]), JSON.stringify([candidate])]
        )
      assert.equal((await importCandidates()).rows[0].result.new_candidates, 1)
      assert.equal((await importCandidates()).rows[0].result.new_candidates, 0)
      await assert.rejects(
        db.query(
          "select activate_source_candidate($1,'Reviewed public provider evidence')",
          [identity.id]
        ),
        /validation/
      )

      const validation = await validateCandidate(
        candidate,
        async (url, format) => {
          if (identity.kind === "keka") {
            if (format === "html")
              return `<script>fetch('/ats/documents/${guid}/careerportal/index.html')</script>`
            if (url.endsWith("/careerportalinfo")) return { name: "Acme" }
            return [
              {
                id: "7",
                title: "Software Engineer",
                description,
                jobLocations: [{ city: "Pune", countryCode: "IN" }],
                publishedOn: published,
              },
            ]
          }
          return `<meta property="og:site_name" content="Acme"><input id="jobs" value="${JSON.stringify(
            [
              {
                id: "7",
                Posting_Title: "Software Engineer",
                Job_Description: description,
                City: "Pune",
                Country: "India",
                Publish: true,
                Date_Opened: published,
              },
            ]
          ).replace(/"/g, "&#34;")}">`
        }
      )
      assert.equal(validation.status, "verified", validation.reason)
      const claimed = (
        await db.query<{ token: string }>(
          "select claim_source_candidate($1)->>'token' token",
          [identity.id]
        )
      ).rows[0]
      await db.query("select finish_source_candidate($1,$2,$3::jsonb)", [
        identity.id,
        claimed.token,
        JSON.stringify(validation),
      ])
      await db.query(
        "select activate_source_candidate($1,'Reviewed public provider evidence')",
        [identity.id]
      )
      const source = (
        await db.query<{
          enabled: boolean
          company: string
          countries: string[]
        }>(
          "select enabled,company,countries from job_source_directory where id=$1",
          [identity.id]
        )
      ).rows[0]
      assert.deepEqual(source, {
        enabled: true,
        company: "Acme",
        countries: ["India"],
      })
      assert.equal(
        (
          await db.query("select id from job_catalog where source=$1", [
            identity.id,
          ])
        ).rows.length,
        0,
        "Activating a source must not publish jobs"
      )
    }

    const run = (
      await db.query<{ id: string }>(
        "insert into job_search_runs(scope_key,roles,countries) values('connector-fixture',array['software engineer'],array['India']) returning id"
      )
    ).rows[0]
    const pool = (
      await db.query<{ result: { id: string }[] }>(
        "select job_search_source_pool($1,array['%software%']) result",
        [run.id]
      )
    ).rows[0].result
    assert.deepEqual(
      pool.map((source) => source.id).sort(),
      identities.map((source) => source.id).sort()
    )

    for (const [kind, board] of [
      ["keka", "acme.evil"],
      ["zohorecruit", "acme.zohorecruit.in.evil.test"],
    ]) {
      await assert.rejects(
        db.query(
          "insert into source_candidates(id,kind,board) values($1,$2,$3)",
          [`${kind}:${board}`, kind, board]
        ),
        /check/
      )
      await assert.rejects(
        db.query(
          "insert into job_source_directory(id,kind,board,company) values($1,$2,$3,'Acme')",
          [`${kind}:${board}`, kind, board]
        ),
        /check/
      )
    }
    await db.exec("reset role; set role authenticated")
    await assert.rejects(
      db.query(
        "select activate_source_candidate($1,'Unauthorized activation attempt')",
        [identities[0].id]
      ),
      /permission denied/
    )
    await assert.rejects(
      db.query("select * from source_candidates"),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})
