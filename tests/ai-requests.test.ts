import assert from "node:assert/strict"
import test from "node:test"
import { analyzeResume } from "@/lib/server/resume/profile"
import { tailorResume, tailorApplicationResume } from "@/lib/server/tailoring"
import { resolvePacketAnswers } from "@/lib/server/applications/answer-resolver"
import { applicationProfileSchema } from "@/lib/applications/profile"
import type { ApplicationPacket } from "@/lib/applications"

test("analysis and tailoring send JSON schemas, disable reasoning and respect token caps", async (t) => {
  const values = {
    TAILORING_BASE_URL: "https://provider.example/v1",
    TAILORING_MODEL: "test-model",
    TAILORING_API_KEY: "test-key",
    TAILORING_REASONING: "none",
  }
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const source =
    "Alex Example\nBackend Engineer\n\nBuilt Python APIs using Postgres databases. Improved monitoring and production reliability."
  const profile = {
    fullName: { value: "Alex Example", quote: "Alex Example" },
    headline: { value: "Backend Engineer", quote: "Backend Engineer" },
    currentLocation: null,
    skills: [
      { value: "Python", quote: "Built Python APIs using Postgres databases." },
    ],
    experience: [],
    education: [],
    projects: [],
    achievements: [],
  }
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      assert.equal(body.reasoning_effort, "none")
      assert.equal(body.response_format.type, "json_schema")
      assert.ok(body.response_format.json_schema.schema.properties)
      assert.equal(body.max_tokens, calls === 0 ? 5000 : 1800)
      const output =
        calls++ === 0
          ? profile
          : {
              blockIds: ["block-2"],
              keywords: ["Python", "Postgres"],
              fit: { missing: ["Kubernetes"] },
            }
      return Response.json({
        id: "test-response",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(output) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      })
    }
  )
  const candidate = await analyzeResume(source)
  assert.equal(candidate.fullName, "Alex Example")
  const tailored = await tailorResume(source, {
    title: "Backend Engineer",
    company: "Example",
    description: "Build Python APIs and maintain Postgres databases.",
  })
  assert.equal(
    tailored.highlights[0].text,
    "Built Python APIs using Postgres databases. Improved monitoring and production reliability."
  )
  assert.deepEqual(tailored.fit, {
    meetsRequired: false,
    missing: ["Kubernetes"],
  })
  assert.equal(calls, 2)
  const reusable = applicationProfileSchema.parse({
    enabled: true,
    confirmedAt: new Date().toISOString(),
    generateWrittenAnswers: true,
  })
  const packet: ApplicationPacket = {
    title: "Engineer",
    company: "Example",
    resume: source,
    fields: [
      {
        id: "project",
        label: "Describe a relevant project you built",
        help: "",
        kind: "textarea",
        required: true,
        options: [],
      },
    ],
    answers: {},
    notices: "",
    formHash: "fixture",
    tailored: true,
    applicationContext: {
      country: "Germany",
      profile: reusable,
      jobDescription: "Build Python APIs.",
    },
  }
  let reserved = 0
  const attempted = new Set<string>()
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.equal(reserved, 1, "quota is reserved before contacting provider")
      const body = JSON.parse(String(init.body))
      assert.equal(body.response_format.type, "json_schema")
      assert.equal(body.reasoning_effort, "none")
      assert.ok(
        body.messages.some((message: { content: string }) =>
          message.content.includes("Built Python APIs")
        )
      )
      calls++
      return Response.json({
        id: "test-answer",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                answers: [
                  {
                    fieldId: "project",
                    text: "I built Python APIs on Postgres — and improved monitoring.",
                    selected: [],
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      })
    }
  )
  const resolved = await resolvePacketAnswers(
    packet,
    async () => {
      reserved++
    },
    attempted
  )
  assert.equal(
    resolved.answers.project,
    "I built Python APIs on Postgres, and improved monitoring."
  )
  assert.ok(resolved.answerEvidence?.project.source.includes("resume"))
  assert.equal(calls, 3)
  assert.deepEqual(
    (
      await resolvePacketAnswers(
        packet,
        async () => {
          reserved++
        },
        attempted
      )
    ).answers,
    {}
  )
  assert.equal(
    reserved,
    1,
    "repeated observations cannot repeat an attempt for the same question"
  )
  assert.deepEqual(
    (
      await resolvePacketAnswers(packet, async () => {
        throw new Error("quota exhausted")
      })
    ).answers,
    {}
  )
  assert.equal(calls, 3)
})

test("automatic draft reuse reassesses current qualifications while preserving edited content", async (t) => {
  const env = { ...process.env }
  Object.assign(process.env, {
    TAILORING_BASE_URL: "https://provider.example/v1",
    TAILORING_MODEL: "test-model",
    TAILORING_API_KEY: "fixture",
  })
  t.after(() => {
    process.env = env
  })
  let calls = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      assert.ok(
        body.messages.some((message: { content: string }) =>
          message.content.includes("Kubernetes is required")
        )
      )
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                blockIds: ["block-1"],
                keywords: ["Kubernetes"],
                fit: { missing: ["Kubernetes"] },
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    }
  )
  const source =
    "Built Python APIs and SQL databases with automated regression testing."
  const job = {
    title: "Engineer",
    company: "Fixture",
    description: "Kubernetes is required",
  }
  const draft = {
    content: "Candidate's edited draft",
    evidence: { highlights: [{ text: source }] },
  }
  const result = await tailorApplicationResume(source, job, draft, true)
  assert.equal(result.content, draft.content)
  assert.deepEqual(result.highlights, draft.evidence.highlights)
  assert.deepEqual(result.fit, {
    meetsRequired: false,
    missing: ["Kubernetes"],
  })
  assert.equal(calls, 1)
  await tailorApplicationResume(source, job, draft, false)
  assert.equal(calls, 1, "manual draft reuse does not add an AI request")
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("Provider unavailable")
  })
  await assert.rejects(
    tailorApplicationResume(source, job, draft, true),
    /Provider unavailable/
  )
})

test("AI fill accepts dropdown answers without listed options and never guesses work authorization", async (t) => {
  const env = { ...process.env }
  Object.assign(process.env, {
    TAILORING_BASE_URL: "https://provider.example/v1",
    TAILORING_MODEL: "test-model",
    TAILORING_API_KEY: "fixture",
  })
  t.after(() => {
    process.env = env
  })
  const field = (id: string, label: string) => ({
    id,
    label,
    help: "",
    kind: "combobox" as const,
    required: true,
    options: [],
  })
  const packet: ApplicationPacket = {
    title: "Engineer",
    company: "Example",
    resume: "Alex Example, Berlin, Germany. Built TypeScript APIs.",
    fields: [
      field("ack", "I acknowledge the background check policy"),
      field("auth", "Are you legally authorized to work in the United States?"),
    ],
    answers: {},
    notices: "",
    formHash: "fixture",
    tailored: true,
    applicationContext: {
      country: "United States",
      profile: applicationProfileSchema.parse({
        enabled: true,
        confirmedAt: new Date().toISOString(),
      }),
      jobDescription: "",
    },
  }
  let prompt = ""
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      prompt = String(init.body)
      return Response.json({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                answers: [
                  { fieldId: "ack", text: "", selected: ["Yes"] },
                  { fieldId: "auth", text: "No", selected: [] },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
  )
  const resolved = await resolvePacketAnswers(packet, async () => {})
  assert.equal(resolved.answers.ack, "Yes")
  assert.equal(resolved.answers.auth, undefined)
  assert.ok(!prompt.includes("legally authorized"))
})
