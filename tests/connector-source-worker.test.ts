import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { advanceCollection } from "@/lib/server/catalog/source-worker"
import { boardIdentity } from "@/lib/server/catalog/source-identity"
import { sourceWorkerDatabase } from "./helpers/source-worker-database"
import { taskOperations } from "./helpers/source-task-database"

test("registered Keka and Zoho connectors complete durable worker tasks and publish real snapshots", async () => {
  const { db, database } = await sourceWorkerDatabase()
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
    const tasks = taskOperations(db)
    const description =
      "Build distributed software services and APIs, write automated tests, and maintain reliable production systems with the engineering team."
    const published = new Date(Date.now() - 86_400_000).toISOString()
    const guid = "685d8736-d012-4881-b6b1-ae16b4745feb"
    for (const kind of ["keka", "zohorecruit"] as const) {
      const source = boardIdentity(
        kind,
        kind === "keka" ? "acme" : "acme.zohorecruit.in"
      )
      await db.query(
        "insert into job_source_directory(id,kind,company,board,enabled,countries) values($1,$2,'Acme',$3,true,array['India'])",
        [source.id, source.kind, source.board]
      )
      const task = await tasks.request(`connector-worker-${kind}`, source.id)
      let requests = 0
      const result = await advanceCollection(
        { taskId: task.id, dispatchGeneration: 1 },
        {
          database,
          fetch: async (input) => {
            requests++
            const url = new URL(String(input))
            if (kind === "keka") {
              assert.equal(url.origin, "https://acme.keka.com")
              if (url.pathname === "/careers/")
                return new Response(
                  `<script>fetch('/ats/documents/${guid}/careerportal/index.html')</script>`
                )
              if (url.pathname.endsWith("/careerportalinfo"))
                return Response.json({ name: "Acme" })
              assert.equal(
                url.pathname,
                `/careers/api/embedjobs/default/active/${guid}`
              )
              return Response.json([
                {
                  id: "7",
                  title: "Software Engineer",
                  description,
                  jobLocations: [{ city: "Pune", countryCode: "IN" }],
                  publishedOn: published,
                },
              ])
            }
            assert.equal(url.href, "https://acme.zohorecruit.in/jobs/Careers")
            return new Response(
              `<meta property="og:site_name" content="Acme"><input id="jobs" value="${JSON.stringify(
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
            )
          },
        }
      )
      assert.equal(result.status, "completed", JSON.stringify(result))
      assert.equal(requests, kind === "keka" ? 3 : 1)
      const settled = await tasks.read(task.id)
      assert.equal(settled.state, "completed")
      assert.equal(settled.run?.next_page, null)
      assert.equal(settled.run?.pages, 1)
      assert.equal(settled.run?.request_count, requests)
      assert.deepEqual(
        (
          await db.query(
            "select title,company,country,city,is_active from job_catalog where source=$1",
            [source.id]
          )
        ).rows,
        [
          {
            title: "Software Engineer",
            company: "Acme",
            country: "India",
            city: "Pune",
            is_active: true,
          },
        ]
      )
      const repeated = await advanceCollection(
        { taskId: task.id, dispatchGeneration: 1 },
        {
          database,
          fetch: async () =>
            assert.fail("a completed delivery must not fetch again"),
        }
      )
      assert.equal(repeated.status, "completed")
    }
  } finally {
    await db.close()
  }
})
