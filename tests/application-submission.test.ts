import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "playwright-core"
import type { ApplicationPacket } from "../lib/applications"
import { ApplicationSubmissionError } from "../lib/applications/pipeline"
import { BrowserUseWorkerError } from "../lib/server/applications/browser-use"
import { sendApplication } from "../lib/server/applications/worker"
import { HUMAN_VERIFICATION_WAIT_MS } from "../lib/server/applications/browser-assistance"

const employerLimitNotice =
  "This job has application limits. Candidates may not apply more than 5 times in any 60 days for any job. Candidates may not re-apply to the same role within 30 days if not presented with an offer."

const packet: ApplicationPacket = {
  title: "Engineer",
  company: "Fixture employer",
  resume:
    "Approved fixture resume. Documented TypeScript backend experience and production application delivery. No unverified facts.",
  fields: [
    {
      id: "email",
      label: "Email",
      kind: "email",
      required: true,
      options: [],
      help: "",
    },
  ],
  answers: { email: "candidate@example.test" },
  notices: "",
  formHash: "fixture",
  tailored: true,
}
for (const scenario of [
  "saved",
  "lost_response",
  "retry_database",
  "task_failure",
  "verification_incomplete",
  "database_unavailable",
  "saved_limit_notice",
  "new_limit_notice",
  "unconfirmed_with_limit_notice",
  "unconfirmed_auto_retry",
  "employer_cooldown",
  "unsupported_control",
  "known_identity",
  "captcha_during_slow_fill",
  "captcha_after_slow_fill",
  "otp_during_fill",
  "network_queue",
  "worker_queue",
  "post_send_worker",
  "retry_exhausted",
  "post_send_timeout",
] as const) {
  test(`submission worker: ${scenario} preserves submission boundaries and authoritative status`, async (t) => {
    const old = { ...process.env }
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: "https://submission.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "fixture",
      TELEGRAM_ENABLED: "false",
    })
    t.after(() => {
      process.env = old
    })
    const captchaScenario =
      scenario.startsWith("captcha_") || scenario === "otp_during_fill"
    let now = Date.now()
    if (captchaScenario) t.mock.method(Date, "now", () => now)
    const id = "00000000-0000-4000-8000-000000000001"
    const approvedPacket = [
      "saved_limit_notice",
      "unconfirmed_with_limit_notice",
    ].includes(scenario)
      ? { ...packet, notices: employerLimitNotice }
      : packet
    let run: Record<string, unknown> = {
      id,
      user_id: "00000000-0000-4000-8000-000000000002",
      status: "queued",
      revision: 2,
      approved_revision: 2,
      approved_packet: approvedPacket,
      packet: approvedPacket,
      target_url: "https://employer.example/apply",
      ...(scenario === "employer_cooldown" ? { employer_key: "n8n" } : {}),
      automatic: [
        "unsupported_control",
        "known_identity",
        "unconfirmed_auto_retry",
      ].includes(scenario),
    }
    let clicks = 0,
      writes = 0,
      releases = 0,
      browsers = 0,
      handoffs = 0,
      fillAttempts = 0
    let challengeVisible = false
    let otpPending = false
    const tasks = new Map<string, Record<string, unknown>>()
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | Request | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        )
        const op = url.pathname.split("/").at(-1)
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (op === "read_application_question_memory") return Response.json([])
        if (op === "account_profiles")
          return Response.json({
            data: {
              fullName: "Generated Candidate",
              resumeText: packet.resume,
            },
          })
        if (url.pathname.includes("/auth/v1/admin/users/"))
          return Response.json({
            id: "fixture-user",
            email: "candidate@example.test",
          })
        if (op === "claim_application") {
          if (
            run.status !== "queued" ||
            body.p_revision !== run.revision ||
            run.retry_after
          )
            return Response.json(null)
          run.status = "running"
          return Response.json(run)
        }
        if (op === "queue_application_retry") {
          assert.equal(clicks, 0)
          assert.ok(
            releases > 0,
            "release the browser before scheduling backoff"
          )
          assert.equal(body.p_revision, 2)
          assert.equal(body.p_stage, "fill_employer_form")
          assert.equal(
            body.p_error_code,
            scenario === "captcha_during_slow_fill"
              ? "captcha_unresolved"
              : "temporary_unavailable"
          )
          if (scenario === "retry_exhausted") return Response.json(null)
          const retryAt = new Date(now + 300000).toISOString()
          run = {
            ...run,
            status: "queued",
            revision: 3,
            approved_revision: 3,
            retry_after: retryAt,
          }
          return Response.json({ revision: 3, retryAt })
        }
        if (op === "record_application_task") {
          if (scenario === "task_failure" && clicks === 1)
            return Response.json(
              { message: "private telemetry error" },
              { status: 503 }
            )
          const task = {
            state:
              body.p_action === "start"
                ? "running"
                : body.p_action === "complete"
                  ? "completed"
                  : "blocked",
            ...body.p_data,
          }
          tasks.set(body.p_stage, task)
          return Response.json(task)
        }
        if (op === "confirm_application") {
          assert.equal(clicks, 1)
          assert.equal(
            releases,
            0,
            "Browser must remain available until database save"
          )
          assert.equal(body.p_receipt.text, "Application received")
          assert.match(body.p_receipt.resumeHash, /^[a-f0-9]{64}$/)
          writes++
          if (
            scenario === "database_unavailable" ||
            (scenario === "retry_database" && writes === 1)
          )
            return Response.json(
              { message: "private storage diagnostic" },
              { status: 503 }
            )
          run = { ...run, status: "submitted", receipt: body.p_receipt }
          return scenario === "lost_response"
            ? Response.json({ message: "lost response" }, { status: 503 })
            : Response.json(true)
        }
        if (op === "application_runs") {
          if (url.searchParams.has("user_id"))
            return Response.json(
              scenario === "employer_cooldown"
                ? [
                    {
                      id: "prior-application",
                      employer_key: "n8n",
                      status: "submitted",
                      updated_at: new Date().toISOString(),
                    },
                  ]
                : []
            )
          if (init?.method === "PATCH") {
            const status = url.searchParams.get("status")
            assert.equal(
              status,
              body.status === "submitting"
                ? "eq.running"
                : body.status === "needs_attention"
                  ? "in.(running)"
                  : "in.(submitting)"
            )
            run = { ...run, ...body }
            if (
              scenario === "unconfirmed_auto_retry" &&
              body.status === "submission_unknown"
            ) {
              run = {
                ...run,
                status: "queued",
                revision: 3,
                approved_revision: 3,
                retry_after: new Date(now + 15_000).toISOString(),
              }
            }
            return body.status === "submitting"
              ? Response.json({ id })
              : Response.json(run)
          }
          if (scenario === "database_unavailable")
            return Response.json(
              { message: "private storage diagnostic" },
              { status: 503 }
            )
          return Response.json(run)
        }
        if (op === "application_tasks" && init?.method === "PATCH") {
          const stage = url.searchParams.get("stage")!.slice(3)
          const task = tasks.get(stage)!
          Object.assign(task, body)
          if (body.output?.browserAssistance) {
            handoffs++
            assert.equal(
              Date.parse(body.output.browserAssistance.expiresAt) - now,
              HUMAN_VERIFICATION_WAIT_MS,
              "Slow filling must not consume the three-minute verification window"
            )
            assert.equal(releases, 0)
            assert.equal(clicks, scenario === "otp_during_fill" ? 0 : 1)
            // The same browser remains connected while the owner takes nearly
            // the full window to complete the challenge.
            now += HUMAN_VERIFICATION_WAIT_MS - 5_000
            challengeVisible = false
            otpPending = false
          }
          return url.searchParams.has("select")
            ? Response.json([{ application_id: id }])
            : new Response(null, { status: 204 })
        }
        throw new Error(`Unexpected fixture operation ${op}`)
      }
    )
    const deps: NonNullable<Parameters<typeof sendApplication>[2]> = {
      withBrowser: async (_url, execute) => {
        browsers++
        try {
          const context = { route: async () => {}, unroute: async () => {} }
          const page = captchaScenario
            ? {
                frames: () => [],
                context: () => context,
                locator: (selector: string) => ({
                  count: async () =>
                    selector.includes("iframe") && challengeVisible ? 1 : 0,
                }),
              }
            : {}
          return await execute(
            page as unknown as Page,
            "20000000-0000-4000-8000-000000000001",
            async () => {
              releases++
            }
          )
        } finally {
          releases++
        }
      },
      runAgent: async (_page, approved, options) => {
        if (scenario === "known_identity") {
          assert.equal(options.codeVerificationOnly, true)
          const resolved = await options.resolveAnswers!({
            ...approved,
            answers: {},
            fields: [
              ...approved.fields,
              {
                id: "name",
                label: "Full name",
                help: "",
                kind: "text",
                required: true,
                options: [],
              },
            ],
          })
          assert.equal(resolved.answers.email, "candidate@example.test")
          assert.equal(resolved.answers.name, "Generated Candidate")
          assert.match(
            resolved.answerEvidence?.email.source || "",
            /account email/
          )
        }
        if (scenario === "worker_queue")
          throw new BrowserUseWorkerError({
            type: "failure",
            code: "RuntimeError",
          })
        if (scenario === "network_queue" || scenario === "retry_exhausted")
          throw new Error("fetch failed")
        if (captchaScenario && fillAttempts++ === 0) {
          // Replay the observed delay before the real application's CAPTCHA.
          now += 122_431
          if (scenario === "captcha_during_slow_fill") {
            challengeVisible = true
            throw new Error("Human verification required")
          }
        }
        if (scenario === "unsupported_control") {
          assert.equal(typeof options.savedAnswers, "function")
          throw new Error("Unsupported employer control")
        }
        if (scenario === "otp_during_fill") {
          otpPending = true
          await options.humanVerification!(() => Promise.resolve(!otpPending))
        }
        await options.beginSubmission(
          scenario === "new_limit_notice"
            ? { ...approved, notices: employerLimitNotice }
            : approved
        )
        const receipt = await (async () => {
          assert.equal(
            run.status,
            "submitting",
            "Intent must be durable before employer click"
          )
          clicks++
          if (scenario === "post_send_worker")
            throw new BrowserUseWorkerError({
              type: "failure",
              code: "RuntimeError",
            })
          if (["post_send_timeout", "post_send_worker"].includes(scenario))
            throw new Error("fetch failed")
          if (scenario === "captcha_after_slow_fill") {
            challengeVisible = true
            await options.humanVerification!(() =>
              Promise.resolve(!challengeVisible)
            )
          }
          if (scenario === "verification_incomplete")
            throw new ApplicationSubmissionError("verification_incomplete")
          if (
            [
              "unconfirmed_with_limit_notice",
              "unconfirmed_auto_retry",
            ].includes(scenario)
          )
            throw new ApplicationSubmissionError("receipt_unconfirmed")
          return {
            text: "Application received",
            url: "https://employer.example/thanks",
            confirmedAt: "2026-11-02T00:00:00.000Z",
          }
        })()
        await options.recordReceipt(approved, receipt)
        return { packet: approved, needsAnswers: false }
      },
    }
    const scheduled = await sendApplication(id, 2, deps)
    if (scenario === "unconfirmed_auto_retry") {
      assert.equal(run.status, "queued")
      assert.deepEqual(scheduled, {
        revision: 3,
        retryAt: new Date(now + 15_000).toISOString(),
      })
      assert.equal(clicks, 1)
      assert.equal(releases, browsers)
      await sendApplication(id, 2, deps)
      assert.equal(
        clicks,
        1,
        "The original workflow revision cannot send again"
      )
      return
    }
    if (
      scenario === "captcha_during_slow_fill" ||
      scenario === "network_queue" ||
      scenario === "worker_queue"
    ) {
      assert.equal(run.status, "queued")
      assert.equal(scheduled?.revision, 3)
      assert.equal(clicks, 0)
      assert.equal(handoffs, 0)
      assert.equal(tasks.has("submit"), false)
      await sendApplication(id, 2, deps)
      assert.equal(browsers, 1)
      return
    }
    if (scenario === "retry_exhausted") {
      assert.equal(run.status, "needs_attention")
      assert.equal(scheduled, undefined)
      assert.equal(clicks, 0)
      return
    }
    if (
      scenario === "employer_cooldown" ||
      scenario === "unsupported_control"
    ) {
      const stage =
        scenario === "employer_cooldown"
          ? "check_application"
          : "fill_employer_form"
      const task = tasks.get(stage)
      assert.equal(run.status, "needs_attention")
      assert.equal(task?.state, "blocked")
      assert.equal(
        task?.error_code,
        scenario === "unsupported_control"
          ? "unsupported_control"
          : "employer_cooldown"
      )
      assert.equal(run.message, `${task?.message} Nothing has been submitted.`)
      assert.match(
        String(run.message),
        scenario === "unsupported_control"
          ? /control.*support.*employer application/i
          : /recent or unconfirmed application.*waiting period/i
      )
      assert.doesNotMatch(String(run.message), /browser or provider|retry/i)
      assert.equal(clicks, 0)
      assert.equal(writes, 0)
      assert.equal(tasks.has("submit"), false)
      await sendApplication(id, 2, deps)
      assert.equal(browsers, scenario === "employer_cooldown" ? 0 : 1)
      assert.equal(releases, browsers)
      return
    }
    const uncertain = [
      "post_send_timeout",
      "post_send_worker",
      "verification_incomplete",
      "database_unavailable",
      "unconfirmed_with_limit_notice",
    ].includes(scenario)
    assert.equal(run.status, uncertain ? "submission_unknown" : "submitted")
    if (uncertain) {
      const code = ["post_send_timeout", "post_send_worker"].includes(scenario)
        ? "temporary_unavailable"
        : scenario === "verification_incomplete"
          ? scenario
          : scenario === "unconfirmed_with_limit_notice"
            ? "receipt_unconfirmed"
            : "receipt_persistence_failed"
      assert.equal(
        tasks.get(scenario === "database_unavailable" ? "confirm" : "submit")
          ?.error_code,
        code
      )
      assert.match(String(run.message), /try again/i)
      assert.doesNotMatch(
        String(run.message),
        /check with.*employer|resubmission.*blocked/i
      )
      assert.doesNotMatch(String(run.message), /private|secret/)
    }
    assert.equal(
      writes,
      [
        "verification_incomplete",
        "unconfirmed_with_limit_notice",
        "post_send_timeout",
        "post_send_worker",
      ].includes(scenario)
        ? 0
        : scenario === "retry_database"
          ? 2
          : 1
    )
    await sendApplication(id, 2, deps)
    assert.equal(clicks, 1)
    if (captchaScenario) assert.equal(handoffs, 1)
    assert.equal(browsers, 1)
    assert.equal(releases, 1)
  })
}
