import assert from "node:assert/strict"
import test from "node:test"
import { savedAnswerLibrary } from "../lib/server/applications/question-memory"
import { packetSchema } from "../lib/applications"

// Exercise the real Supabase reader, including its query filters, rather than
// passing already-filtered examples straight to the answer resolver.
test("saved library retains units and destination and honors unanswered employer opt-outs", async (t) => {
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fictional-key"
  t.after(() => {
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
  })
  const question = {
    id: "q",
    label: "Salary expectations",
    help: "USD annually",
    kind: "text",
    required: true,
    options: [],
  }
  const rows = [
    {
      question,
      question_key: "salary",
      answer: "120K",
      country: "United States",
      employer_key: "other",
      reuse_scope: "all",
      answered_at: "2026-11-04T00:00:00Z",
    },
    {
      question: { ...question, label: "Desired Pay" },
      question_key: "pay",
      answer: "100K",
      country: "United States",
      employer_key: "other",
      reuse_scope: "all",
    },
    {
      question,
      question_key: "foreign",
      answer: "90000",
      country: "Germany",
      employer_key: "other",
      reuse_scope: "all",
    },
    {
      question,
      question_key: "private",
      answer: "140K",
      country: "United States",
      employer_key: "other",
      reuse_scope: "employer",
    },
  ]
  let overridesRead = false
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/application_runs")) {
      assert.equal(url.searchParams.get("id"), "eq.run")
      // Preparation hasn't persisted a packet yet. Its caller supplies context.
      return Response.json({
        user_id: "owner",
        employer_key: "example",
        target_url: "https://example.test",
        packet: null,
      })
    }
    assert.ok(url.pathname.endsWith("/account_application_questions"))
    assert.equal(url.searchParams.get("user_id"), "eq.owner")
    assert.equal(url.searchParams.get("country"), "eq.United States")
    if (url.searchParams.get("reuse_scope") === "eq.never") {
      assert.equal(url.searchParams.get("employer_key"), "eq.example")
      assert.equal(url.searchParams.get("reuse_explicit"), "eq.true")
      assert.equal(url.searchParams.has("answer"), false)
      overridesRead = true
      return Response.json([{ question_key: "pay", country: "United States" }])
    }
    return Response.json(
      rows.filter(
        (row) => `eq.${row.country}` === url.searchParams.get("country")
      )
    )
  })
  const packet = packetSchema.parse({
    title: "Engineer",
    company: "Example",
    resume: "Original candidate resume with documented software projects.",
    tailored: true,
    formHash: "fixture",
    notices: "",
    answers: {},
    fields: [question],
    applicationContext: { country: "United States", jobDescription: "" },
  })
  assert.deepEqual(await savedAnswerLibrary("run", packet), [
    {
      question: "Salary expectations",
      help: "USD annually",
      answer: "120K",
      country: "United States",
      confirmedAt: "2026-11-04T00:00:00Z",
    },
  ])
  assert.equal(overridesRead, true)
  assert.deepEqual(await savedAnswerLibrary("run"), [])
})
