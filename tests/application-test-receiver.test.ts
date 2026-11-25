import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/application-test/[token]/route"
import { resumeFile } from "../lib/server/applications/browser"

for (const scenario of [
  "native profile",
  "tampered profile",
  "unconfirmed profile",
  "wrong country profile",
  "profile explicit empty",
  "explicit",
  "tampered authorization",
  "tampered referral",
  "native identity",
  "tampered name",
  "tampered email",
  "missing source",
  "explicit precedence",
  "explicit empty",
  "manual missing identity",
])
  test(`synthetic receiver: ${scenario}`, async (t) => {
    const old = { ...process.env }
    Object.assign(process.env, {
      APP_ENV: "staging",
      APPLICATION_TEST_ORIGIN: "https://receiver.example.test",
      NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "fictional-key",
    })
    t.after(() => {
      process.env = old
    })
    const resume =
      "Test Candidate\n\nBuilt TypeScript APIs and SQL databases for a fictional staging project."
    const packet = {
      resume,
      fields: [
        { id: "agent_name", label: "Full name" },
        { id: "agent_email", label: "Email" },
        {
          id: "agent_authorization",
          label: "Do you have the required work authorization?",
        },
        {
          id: "agent_referral",
          label: "Who is your employee referral contact?",
        },
        { id: "agent_consent", label: "Optional future contact" },
      ],
      answers: {
        agent_name: "Test Candidate",
        agent_email: "test@example.invalid",
        agent_authorization: "No",
        agent_referral: "Generated QA Referral",
      },
    }
    const profileScenario = scenario.includes("profile")
    const native = [
      "native identity",
      "tampered name",
      "tampered email",
      "missing source",
    ].includes(scenario)
    if (native || profileScenario || scenario === "manual missing identity") {
      packet.fields = packet.fields.filter(
        (field) => !["agent_name", "agent_email"].includes(field.id)
      )
      Reflect.deleteProperty(packet.answers, "agent_name")
      Reflect.deleteProperty(packet.answers, "agent_email")
    }
    if (scenario === "explicit precedence")
      packet.answers.agent_name = "Approved Alternate"
    if (scenario === "explicit empty") packet.answers.agent_name = ""
    if (profileScenario) {
      packet.fields = packet.fields.filter(
        (field) => field.id !== "agent_authorization"
      )
      Reflect.deleteProperty(packet.answers, "agent_authorization")
      Object.assign(packet, {
        applicationContext: {
          country: scenario === "wrong country profile" ? "Canada" : "Germany",
          profile: {
            enabled: true,
            confirmedAt:
              scenario === "unconfirmed profile"
                ? null
                : "2026-11-01T00:00:00Z",
            contact: {
              preferredName: "Preferred Candidate",
              givenName: "Legal",
              familyName: "Candidate",
              email: "profile@example.invalid",
              linkedin: "https://example.com/linkedin",
            },
            eligibility: [
              {
                country: "Germany",
                authorized: true,
                sponsorshipNow: false,
                sponsorshipFuture: true,
              },
            ],
          },
        },
      })
      if (scenario === "profile explicit empty")
        Object.assign(packet.answers, { "legal-first-name": "" })
    }
    let receipts = 0
    let sourceReads = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith("/application_runs"))
          return Response.json({
            approved_packet: packet,
            status: "submitting",
            employer_key: profileScenario
              ? "synthetic-temporal-names"
              : "synthetic",
            revision: 4,
            automatic: scenario !== "manual missing identity",
          })
        if (url.pathname.endsWith("/application_tasks")) {
          sourceReads++
          assert.equal(url.searchParams.get("application_id"), "eq.fixture")
          assert.equal(url.searchParams.get("stage"), "eq.load_source")
          assert.equal(url.searchParams.get("state"), "eq.completed")
          assert.equal(url.searchParams.get("revision"), "lte.4")
          assert.equal(url.searchParams.get("order"), "revision.desc")
          return Response.json(
            scenario === "missing source"
              ? null
              : {
                  output: {
                    profile: { fullName: "Test Candidate" },
                    email: "test@example.invalid",
                  },
                }
          )
        }
        assert.ok(url.pathname.endsWith("/application_test_receipts"))
        if (init?.method === "PATCH") {
          receipts++
          return Response.json({ token: "fixture" })
        }
        return Response.json({ application_id: "fixture", submissions: 0 })
      }
    )
    const form = new FormData()
    form.set(
      "name",
      scenario === "tampered name"
        ? "Wrong Candidate"
        : scenario === "explicit precedence"
          ? "Approved Alternate"
          : "Test Candidate"
    )
    form.set(
      "email",
      scenario === "tampered email"
        ? "wrong@example.invalid"
        : "test@example.invalid"
    )
    form.set(
      "authorization",
      scenario === "tampered authorization" ? "Yes" : "No"
    )
    form.set(
      "referral",
      scenario === "tampered referral"
        ? "Wrong referral"
        : "Generated QA Referral"
    )
    if (profileScenario) {
      form.set("name", "Preferred Candidate")
      form.set("email", "profile@example.invalid")
      form.set("authorization", "Yes")
      form.set(
        "legalGivenName",
        scenario === "tampered profile" ? "Wrong" : "Legal"
      )
      form.set("legalFamilyName", "Candidate")
      form.set("linkedin", "https://example.com/linkedin")
      form.set("pronouns", "")
      form.set("pronunciation", "")
    }
    const upload = await resumeFile(resume)
    form.set(
      "resume",
      new File([new Uint8Array(upload.buffer)], upload.name, {
        type: "application/pdf",
      })
    )
    const response = await POST(
      new Request("https://receiver.example.test/submit", {
        method: "POST",
        body: form,
      }),
      {
        params: Promise.resolve({
          token: "00000000-0000-4000-8000-000000000001",
        }),
      }
    )
    const rejected = [
      "tampered profile",
      "unconfirmed profile",
      "wrong country profile",
      "profile explicit empty",
      "tampered authorization",
      "tampered referral",
      "tampered name",
      "tampered email",
      "missing source",
      "explicit empty",
      "manual missing identity",
    ].includes(scenario)
    assert.equal(response.status, rejected ? 422 : 200, await response.text())
    assert.equal(receipts, rejected ? 0 : 1)
    assert.equal(
      sourceReads,
      native || scenario === "unconfirmed profile" ? 1 : 0
    )
  })
