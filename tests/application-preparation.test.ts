import assert from "node:assert/strict"
import test from "node:test"
import {
  prepareApplication,
  queuePreparedAutomaticApplication,
} from "../lib/server/applications/worker"
import {
  missingAnswers,
  packetSchema,
  type ApplicationField,
} from "../lib/applications"

for (const scenario of [
  {
    name: "automatic applications retry tailoring without a separate form discovery pass",
    extraQuestion: false,
    initialConsent: true,
    transient: true,
    invalidSelection: true,
  },
  {
    name: "a temporary tailoring failure resumes from checkpoints",
    extraQuestion: false,
    initialConsent: true,
    transient: true,
  },
  {
    name: "automatic applications defer employer questions to the browser agent",
    extraQuestion: true,
    initialConsent: true,
  },
  {
    name: "qualification warnings do not block auto-send when every form answer is known",
    extraQuestion: false,
    initialConsent: true,
  },
  {
    name: "automatic preparation pauses below 80 percent keyword coverage",
    extraQuestion: false,
    initialConsent: true,
    lowCoverage: true,
  },
  {
    name: "explicit review retry still prepares a reviewable packet with warnings",
    extraQuestion: true,
    initialConsent: false,
  },
]) {
  test(scenario.name, async (t) => {
    const oldFetch = globalThis.fetch
    const oldEnv = { ...process.env }
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: "https://preparation-fixture.example",
      SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
      APPLICATION_FORM_ENGINE: "computer",
    })
    t.after(() => {
      globalThis.fetch = oldFetch
      process.env = oldEnv
    })
    const id = "00000000-0000-4000-8000-000000000001"
    const userId = "00000000-0000-4000-8000-000000000002"
    let run: Record<string, unknown> = {
      id,
      user_id: userId,
      job_id: "job-1",
      target_url: "https://employer.example/apply",
      status: "queued_prepare",
      revision: 1,
      automatic: scenario.initialConsent,
      auto_submit_requested_at: scenario.initialConsent
        ? new Date().toISOString()
        : null,
      packet: null,
    }
    const fields: ApplicationField[] = [
      {
        id: "email",
        label: "Email",
        help: "",
        kind: "email",
        required: true,
        options: [],
        step: 0,
      },
      ...(scenario.extraQuestion
        ? [
            {
              id: "experience",
              label: "Describe your relevant experience",
              help: "",
              kind: "textarea" as const,
              required: true,
              options: [],
              step: 0,
            },
          ]
        : []),
    ]
    let tailoringCalls = 0,
      discoveryCalls = 0,
      sourceCalls = 0
    let discovered = false,
      assessed = false,
      queueCalls = 0
    const tasks = new Map<string, Record<string, unknown>>()
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const op = url.pathname.split("/").at(-1)
      if (url.pathname.includes("/auth/v1/admin/users/"))
        return Response.json({ id: userId, email: "candidate@example.test" })
      if (op === "account_profiles") {
        sourceCalls++
        return Response.json({
          data: {
            fullName: "Example Candidate",
            resumeText:
              "Example candidate with documented TypeScript API and database development experience. Built backend services and tested production applications.",
          },
        })
      }
      if (op === "job_catalog")
        return Response.json({
          title: "Senior Engineer",
          company: "Example Employer",
          country: "Germany",
          is_active: true,
          description:
            "Required: five years of Node.js experience. Build reliable backend services and review engineering requirements.",
        })
      if (op === "resume_drafts") return Response.json(null)
      if (op === "reserve_application_decision") return Response.json(true)
      if (op === "read_application_question_memory") return Response.json([])
      if (op === "claim_application_preparation") {
        const body = JSON.parse(String(init?.body))
        if (run.status !== "queued_prepare") return Response.json(null)
        run = { ...run, status: "preparing", preparation_token: body.p_token }
        return Response.json(run)
      }
      if (op === "record_application_task") {
        const body = JSON.parse(String(init?.body))
        const prior = tasks.get(body.p_stage)
        const task =
          body.p_action === "start"
            ? prior?.state === "completed"
              ? prior
              : { state: "running", attempts: Number(prior?.attempts || 0) + 1 }
            : body.p_action === "fail"
              ? { ...prior, ...body.p_data }
              : { ...prior, state: "completed", output: body.p_data.output }
        tasks.set(body.p_stage, task)
        return Response.json(task)
      }
      if (op === "application_runs") {
        if (init?.method === "PATCH") {
          const update = JSON.parse(String(init.body))
          assert.equal(url.searchParams.get("id"), `eq.${id}`)
          assert.equal(
            url.searchParams.get("status"),
            update.status === "preparing"
              ? "eq.queued_prepare"
              : update.status
                ? "eq.preparing"
                : "eq.ready"
          )
          run = { ...run, ...update }
          if (update.status === "preparing") return Response.json(run)
          assert.equal(url.searchParams.get("revision"), "eq.1")
          return new Response(null, { status: 204 })
        }
        return Response.json(run)
      }
      if (op === "queue_automatic_application") {
        queueCalls++
        return Response.json(true)
      }
      throw new Error(`Unexpected preparation operation: ${op}`)
    }
    const dependencies: NonNullable<Parameters<typeof prepareApplication>[1]> =
      {
        discoverForm: async () => {
          discoveryCalls++
          discovered = true
          return { fields, notices: "Employer privacy notice" }
        },
        tailorResume: async () => {
          tailoringCalls++
          if ("transient" in scenario && tailoringCalls === 1)
            throw "invalidSelection" in scenario
              ? new Error("AI returned an unknown source reference.")
              : Object.assign(new Error("Provider unavailable"), {
                  statusCode: 503,
                })
          assessed = true
          return {
            content:
              "Example Candidate\nDocumented TypeScript API development.",
            coverage:
              "lowCoverage" in scenario
                ? {
                    percent: 50,
                    matched: ["backend services"],
                    missing: ["Node.js"],
                    total: 2,
                  }
                : {
                    percent: 80,
                    matched: ["a", "b", "c", "d"],
                    missing: ["Node.js"],
                    total: 5,
                  },
            highlights: [],
            fit: {
              meetsRequired: false,
              missing: ["5+ years of Node.js experience"],
            },
          }
        },
      }
    const retryAt = await prepareApplication(id, dependencies)
    if ("transient" in scenario) {
      assert.ok(retryAt)
      assert.equal(run.status, "queued_prepare")
      assert.equal(tasks.get("tailor_resume")?.state, "retry_wait")
      await prepareApplication(id, dependencies)
      assert.equal(tailoringCalls, 2)
      assert.equal(discoveryCalls, scenario.initialConsent ? 0 : 1)
      assert.equal(sourceCalls, 1)
    }
    assert.equal(discovered, !scenario.initialConsent)
    assert.equal(assessed, true)
    const packet = packetSchema.parse(run.packet)
    assert.deepEqual(packet.fields, scenario.initialConsent ? [] : fields)
    assert.equal(
      packet.resume,
      "Example Candidate\nDocumented TypeScript API development."
    )
    assert.equal(
      packet.answers.email,
      scenario.initialConsent ? undefined : "candidate@example.test"
    )
    assert.match(String(run.message), /5\+ years of Node.js experience/)
    const paused = "lowCoverage" in scenario
    assert.equal(run.status, paused ? "needs_attention" : "ready")
    assert.equal(run.automatic, scenario.initialConsent && !paused)
    assert.equal(
      !!run.auto_submit_requested_at,
      scenario.initialConsent && !paused
    )
    if (paused)
      assert.match(String(run.message), /Auto-apply paused.*50%.*Node\.js/)
    assert.equal(
      missingAnswers(packet).length,
      !scenario.initialConsent && scenario.extraQuestion ? 1 : 0
    )
    const shouldQueue = scenario.initialConsent && !paused
    assert.equal(
      await queuePreparedAutomaticApplication(id),
      shouldQueue ? 1 : null
    )
    assert.equal(queueCalls, shouldQueue ? 1 : 0)
  })
}
