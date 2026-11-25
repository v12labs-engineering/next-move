import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"
import { applicationStatusGroups } from "@/lib/applications/activity"

// Execute the real route with only authentication and workflow imports isolated.
function route(file: string, db: unknown) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports: { GET?: (request: Request) => Promise<Response> } = {}
  const dependencies: Record<string, unknown> = {
    zod: { z },
    "@/lib/server/session": {
      requireAccount: async () => ({ db, user: { id: "owner" } }),
    },
    "@/lib/server/http": {
      privateJson: Response.json.bind(Response),
      apiError: (e: unknown) => {
        throw e
      },
    },
    "@/lib/applications/activity": { applicationStatusGroups },
    "workflow/api": {},
    "@/workflows/applications": {},
    "@/lib/server/applications/store": {},
    "@/lib/applications": {},
  }
  vm.runInNewContext(compiled, {
    exports,
    URL,
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  })
  return exports.GET!
}

for (const country of ["all", "India"]) {
  test(`application list scopes rows and every count before pagination: ${country}`, async () => {
    const requests: URL[] = []
    const db = createClient("https://fixture.example", "fixture", {
      global: {
        fetch: async (input, init) => {
          const url = new URL(String(input))
          requests.push(url)
          assert.equal(url.searchParams.get("user_id"), "eq.owner")
          assert.equal(
            url.searchParams.get("job.country"),
            country === "all" ? null : "eq.India"
          )
          assert.equal(
            url.searchParams.get("select")!.includes("!inner"),
            country !== "all"
          )
          return new Response(init?.method === "HEAD" ? null : "[]", {
            headers: {
              "content-type": "application/json",
              "content-range": "*/0",
            },
          })
        },
      },
    })
    const get = route("app/api/applications/route.ts", db)
    const response = await get(
      new Request(
        `https://fixture.example/api/applications?country=${country}&offset=50`
      )
    )
    assert.equal(response.status, 200)
    assert.equal(requests.length, 6)
    assert.equal(requests[0].searchParams.get("offset"), "50")
    assert.equal((await response.json()).total, 0)
  })
}

test("inbox excludes automatic ready rows in the database before its limit", async () => {
  const db = createClient("https://fixture.example", "fixture", {
    global: {
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith("application_events"))
          return Response.json([])
        assert.equal(url.searchParams.get("limit"), "100")
        // Without this database predicate, 100 newer automatic rows crowd out
        // the older question. The query must exclude them, not just the response.
        assert.equal(
          url.searchParams.get("or"),
          "(status.neq.ready,automatic.eq.false,auto_submit_requested_at.is.null)"
        )
        return Response.json([
          {
            id: "question",
            status: "needs_attention",
            automatic: true,
            auto_submit_requested_at: null,
            company: "Fixture",
            target_url: "https://fixture.example",
          },
        ])
      },
    },
  })
  const response = await route(
    "app/api/inbox/route.ts",
    db
  )(new Request("https://fixture.example/api/inbox"))
  assert.equal((await response.json()).needs[0].id, "question")
})

test("draft list DOCX download requests the DOCX format", async () => {
  const { createElement } = await import("react")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { ResumeDrafts } = await import("@/components/resume/resume-drafts")
  const html = renderToStaticMarkup(
    createElement(ResumeDrafts, {
      drafts: [
        {
          id: "draft-fixture",
          profile_version: 1,
          created_at: "2026-11-09T00:00:00Z",
          evidence: null,
        },
      ],
    })
  )
  assert.match(
    html,
    /href="\/api\/resumes\/draft-fixture\/download\?format=docx"/
  )
})
