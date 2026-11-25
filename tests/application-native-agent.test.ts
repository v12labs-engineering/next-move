import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import type { Page } from "playwright-core"
import {
  ApplicationCaptchaError,
  ApplicationSubmissionError,
  applicationFailure,
  employerAuthRequired,
} from "../lib/applications/pipeline"
import { bindCaptchaSolver } from "../lib/server/applications/captcha-solver"
import { bindBrowserUse } from "../lib/server/applications/browser-use"
import {
  runNativeApplication,
  type NativeApplicationOptions,
} from "../lib/server/applications/native-agent"
import type { ApplicationPacket } from "../lib/applications"
import { resolvePacketAnswers } from "../lib/server/applications/answer-resolver"

const packet: ApplicationPacket = {
  title: "Engineer",
  company: "Example",
  resume:
    "Candidate Example\nTypeScript engineer with verified production experience.",
  fields: [
    {
      id: "country",
      label: "Country",
      help: "",
      kind: "combobox",
      required: true,
      options: ["Canada"],
    },
  ],
  answers: { country: "Canada" },
  notices: "",
  formHash: "fixture",
  tailored: true,
}
function fixture(t: TestContext) {
  const old = process.env.BROWSERBASE_API_KEY
  process.env.BROWSERBASE_API_KEY = "fictional"
  t.after(() => {
    if (old === undefined) delete process.env.BROWSERBASE_API_KEY
    else process.env.BROWSERBASE_API_KEY = old
  })
  let uploads = 0
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.match(
        String(input),
        /api.browserbase.com\/v1\/sessions\/fixture\/uploads/
      )
      // Exercise Node's real streaming-body validation, not just the URL.
      const request = new Request(String(input), init)
      const body = await request.arrayBuffer()
      assert.ok(body.byteLength > 0)
      uploads++
      return Response.json({ message: "File uploaded successfully" })
    }
  )
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: "fixture" } }),
      detach: async () => {},
    }),
  }
  const page = {
    context: () => context,
    frames: () => [],
    mainFrame: () => ({}),
    url: () => "https://employer.example/thanks",
    locator: () => ({
      count: async () => 0,
      innerText: async () =>
        "Thank you for applying. Your application has been received.",
    }),
  } as unknown as Page
  const events: string[] = []
  const options: NativeApplicationOptions = {
    sessionId: "fixture",
    deadline: Date.now() + 100,
    reserveDecision: async () => {},
    savedAnswers: async () => ({ country: "Canada" }),
    beginSubmission: async () => {
      events.push("intent")
    },
    recordReceipt: async () => {
      events.push("receipt")
    },
  }
  return { page, options, events, uploads: () => uploads }
}

test("native agent receives approved remote documents and business tools, with no backend field execution", async (t) => {
  const f = fixture(t)
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    const captcha = (await run.execute("solve_captcha", {})) as {
      solved: boolean
      challengeVisible: boolean
      instruction: string
    }
    assert.equal(captcha.solved, false)
    assert.equal(captcha.challengeVisible, false)
    assert.match(captcha.instruction, /passive reCAPTCHA badge/)
    assert.ok(run.files?.[0].startsWith("/tmp/.uploads/"))
    for (const name of ["fill", "review", "advance", "ready", "click"])
      assert.equal(name in run.tools, false)
    const context = (await run.execute("get_saved_answers", {})) as {
      approvedAnswers: { answer: string }[]
    }
    assert.equal(context.approvedAnswers[0].answer, "Canada")
    await run.execute("begin_submission", {})
    await run.execute("begin_submission", {})
    await run.execute("report_submission", {
      text: "Your application has been received.",
    })
  })
  t.after(unbind)
  const result = await runNativeApplication(f.page, packet, f.options)
  assert.equal(result.needsAnswers, false)
  assert.deepEqual(f.events, ["intent", "receipt"])
  assert.equal(f.uploads(), 1)
})

test("discovery reinspects Roblox dropdowns before accepting an empty option list", async (t) => {
  const { discoverNativeForm } =
    await import("../lib/server/applications/native-agent")
  const f = fixture(t)
  const fields = [
    "At the time of application, are you 18+ years of age?",
    "Are you legally authorized to work in the US?",
    "Will you now or in the future require sponsorship for work authorization?",
  ].map((label) => ({
    label,
    help: "",
    kind: "select",
    required: true,
    options: [] as string[],
  }))
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    const response = (await run.execute("report_form", {
      fields,
      notices: "",
    })) as { done?: boolean; instruction: string }
    assert.notEqual(
      response.done,
      true,
      "Empty dropdowns must not be handed to the candidate"
    )
    assert.match(response.instruction, /open|inspect/i)
    await run.execute("report_form", {
      fields: fields.map((f) => ({ ...f, options: ["Yes", "No"] })),
      notices: "",
    })
  })
  t.after(unbind)
  const result = await discoverNativeForm(
    f.page,
    { title: "Engineer", company: "Roblox" },
    async () => {}
  )
  assert.deepEqual(
    result.fields.map((f) => f.options),
    fields.map(() => ["Yes", "No"])
  )
})

test("missing-answer handoff inspects empty choice controls before asking the candidate", async (t) => {
  const f = fixture(t)
  const field = {
    label: "Are you legally authorized to work in the US?",
    help: "",
    kind: "select",
    required: true,
    options: [] as string[],
  }
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    const reply = (await run.execute("request_missing_answers", {
      fields: [field],
      notices: "",
    })) as { done?: boolean }
    assert.notEqual(
      reply.done,
      true,
      "Missing options are browser work, not missing candidate information"
    )
    await run.execute("request_missing_answers", {
      fields: [{ ...field, options: ["Yes", "No"] }],
      notices: "",
    })
  })
  t.after(unbind)
  const result = await runNativeApplication(f.page, packet, f.options)
  assert.equal(result.needsAnswers, true)
  assert.deepEqual(result.packet.fields.at(-1)?.options, ["Yes", "No"])
  assert.deepEqual(f.events, [])
})

test("unavailable choice lists fall back to a text question after one inspection", async (t) => {
  const f = fixture(t)
  const field = {
    label: "Which employment category applies to you?",
    help: "",
    kind: "select",
    required: true,
    options: ["Select..."],
  }
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    const report = { fields: [field], notices: "" }
    const first = (await run.execute("request_missing_answers", report)) as {
      done?: boolean
    }
    assert.notEqual(first.done, true)
    const second = (await run.execute("request_missing_answers", report)) as {
      done?: boolean
    }
    assert.equal(second.done, true)
  })
  t.after(unbind)
  const result = await runNativeApplication(f.page, packet, f.options)
  assert.equal(result.needsAnswers, true)
  assert.equal(result.packet.fields.at(-1)?.kind, "text")
  assert.deepEqual(result.packet.fields.at(-1)?.options, [])
})

test("native auto-apply starts without a copied form and uses saved facts in the live browser", async (t) => {
  const { packetSchema } = await import("../lib/applications")
  const f = fixture(t)
  const initial = packetSchema.parse({
    ...packet,
    engine: "browser-use",
    fields: [],
    answers: {},
  })
  assert.equal(
    packetSchema.safeParse({ ...initial, engine: "computer-v1" }).success,
    false
  )
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    const context = (await run.execute("get_saved_answers", {})) as {
      saved: { country: string }
      approvedAnswers: unknown[]
    }
    assert.equal(context.saved.country, "Canada")
    assert.deepEqual(context.approvedAnswers, [])
    await run.execute("begin_submission", {})
    await run.execute("report_submission", {
      text: "Your application has been received.",
    })
  })
  t.after(unbind)
  const result = await runNativeApplication(f.page, initial, f.options)
  assert.equal(result.needsAnswers, false)
  assert.deepEqual(f.events, ["intent", "receipt"])
})

test("a confirmed employer account gate stops auto-apply before send intent", async (t) => {
  const f = fixture(t)
  f.options.codeVerificationOnly = true
  t.mock.method(f.page, "frames", () => [
    {
      parentFrame: () => null,
      url: () => "https://employer.example/login",
      evaluate: async () => null,
      getByRole: (role: string) => ({
        filter: () => ({ count: async () => Number(role === "heading") }),
      }),
      locator: (selector: string) => ({
        count: async () => Number(selector.includes('type="password"')),
      }),
    },
  ])
  t.after(
    bindBrowserUse(f.page.context(), async (run) => {
      assert.ok(run.tools.report_account_gate)
      await run.execute("report_account_gate", {})
    })
  )
  await assert.rejects(
    runNativeApplication(f.page, packet, f.options),
    (error) => {
      assert.equal(applicationFailure(error).code, employerAuthRequired)
      assert.equal(applicationFailure(error).retryable, false)
      return true
    }
  )
  assert.deepEqual(f.events, [])
})

for (const tool of [
  "request_verification",
  "request_missing_answers",
  "solve_captcha",
  "report_account_gate",
]) {
  test(`post-submit email code uses Telegram handoff through ${tool} and resumes receipt verification`, async (t) => {
    const f = fixture(t)
    f.options.codeVerificationOnly = true
    let visible = true
    const frame = {
      parentFrame: () => null,
      url: () => "https://employer.example/verify",
      evaluate: async () =>
        visible
          ? {
              mode: "code",
              targets: [
                {
                  selector: "#code",
                  kind: "code",
                  label: "Verification code",
                  tile: false,
                },
              ],
              signature: "verification",
              message: "Enter code",
            }
          : null,
    }
    t.mock.method(f.page, "frames", () => [frame])
    f.options.humanVerification = async (ready) => {
      assert.equal(await ready(), false)
      f.events.push("telegram")
      visible = false
      assert.equal(await ready(), true)
    }
    const unbind = bindBrowserUse(f.page.context(), async (run) => {
      assert.ok(run.tools.request_verification)
      await run.execute("begin_submission", {})
      const result = await run.execute(tool, {})
      assert.equal(JSON.stringify(result).includes("verification"), true)
      await run.execute("report_submission", {
        text: "Your application has been received.",
      })
    })
    t.after(unbind)
    const result = await runNativeApplication(f.page, packet, f.options)
    assert.equal(result.needsAnswers, false)
    assert.deepEqual(f.events, ["intent", "telegram", "receipt"])
  })
}

for (const reason of [
  "missing_intent",
  "invented_receipt",
  "native_done_only",
]) {
  test(`native completion rejects ${reason}`, async (t) => {
    const f = fixture(t)
    if (reason === "invented_receipt")
      t.mock.method(
        f.page,
        "locator",
        () => ({ innerText: async () => "Employer application form" }) as never
      )
    const unbind = bindBrowserUse(f.page.context(), async (run) => {
      if (reason === "native_done_only") return
      if (reason !== "missing_intent") await run.execute("begin_submission", {})
      await run.execute("report_submission", {
        text:
          reason === "invented_receipt"
            ? "Thank you for applying to a different employer."
            : "Your application has been received.",
      })
    })
    t.after(unbind)
    await assert.rejects(runNativeApplication(f.page, packet, f.options))
    assert.equal(f.events.includes("receipt"), false)
  })
}

test("an unmatched receipt quote keeps the same agent alive to inspect and correct it", async (t) => {
  const f = fixture(t)
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("begin_submission", {})
    const rejected = await run.execute("report_submission", {
      text: "Thank you, your application was successfully submitted.",
    })
    assert.equal(
      (rejected as { receiptVerified: boolean }).receiptVerified,
      false
    )
    assert.deepEqual(f.events, ["intent"])
    await run.execute("report_submission", {
      text: "Your application has been received.",
    })
  })
  t.after(unbind)
  await runNativeApplication(f.page, packet, f.options)
  assert.deepEqual(f.events, ["intent", "receipt"])
})

for (const embedded of [false, true])
  test(`receipt verification reads ${embedded ? "a visible employer iframe" : "typographic punctuation"}`, async (t) => {
    const f = fixture(t)
    const receipt = "Thanks for applying! We’ve received your application."
    t.mock.method(
      f.page,
      "locator",
      () =>
        ({
          innerText: async () => (embedded ? "Employer careers" : receipt),
          count: async () => 0,
        }) as never
    )
    if (embedded)
      t.mock.method(
        f.page,
        "frames",
        () =>
          [
            {
              parentFrame: () => ({ parentFrame: () => null }),
              locator: () => ({
                innerText: async () => receipt,
                count: async () => 0,
              }),
              frameElement: async () => ({
                isVisible: async () => true,
                dispose: async () => {},
              }),
              url: () => "https://employer.example/confirmation",
            },
          ] as never
      )
    const unbind = bindBrowserUse(f.page.context(), async (run) => {
      await run.execute("begin_submission", {})
      await run.execute("report_submission", {
        text: "Thanks for applying! We've received your application.",
      })
    })
    t.after(unbind)
    await runNativeApplication(f.page, packet, f.options)
    assert.deepEqual(f.events, ["intent", "receipt"])
  })

test("a worker ending after submit still checks the live employer receipt without resending", async (t) => {
  const f = fixture(t)
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("begin_submission", {})
    throw new Error("The employer receipt could not be verified.")
  })
  t.after(unbind)
  await runNativeApplication(f.page, packet, f.options)
  assert.deepEqual(f.events, ["intent", "receipt"])
})

for (const body of [
  "Thank you for your interest in our company.",
  "Your application was not submitted. Please correct the errors.",
  "Your application will be submitted after you verify your email.",
  "Thank you for applying. Your application was rejected.",
  "Thank you for applying. Submission failed.",
  "Thank you for applying. Error submitting your application.",
  "Thank you for applying. You have reached your application limit.",
])
  test(`receipt fallback does not confirm: ${body}`, async (t) => {
    const f = fixture(t)
    t.mock.method(
      f.page,
      "locator",
      () => ({ innerText: async () => body, count: async () => 0 }) as never
    )
    const unbind = bindBrowserUse(f.page.context(), async (run) => {
      await run.execute("begin_submission", {})
      throw new Error("Agent stopped")
    })
    t.after(unbind)
    await assert.rejects(
      runNativeApplication(f.page, packet, f.options),
      /Agent stopped/
    )
    assert.deepEqual(f.events, ["intent"])
  })

test("hidden iframe confirmation cannot establish an employer receipt", async (t) => {
  const f = fixture(t)
  t.mock.method(
    f.page,
    "locator",
    () =>
      ({
        innerText: async () => "Application form",
        count: async () => 0,
      }) as never
  )
  t.mock.method(
    f.page,
    "frames",
    () =>
      [
        {
          parentFrame: () => ({ parentFrame: () => null }),
          frameElement: async () => ({
            isVisible: async () => false,
            dispose: async () => {},
          }),
          locator: () => ({
            innerText: async () => "Your application was submitted.",
          }),
        },
      ] as never
  )
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("begin_submission", {})
    throw new Error("Agent stopped")
  })
  t.after(unbind)
  await assert.rejects(
    runNativeApplication(f.page, packet, f.options),
    /Agent stopped/
  )
  assert.deepEqual(f.events, ["intent"])
})

test("genuinely missing facts pause the agent without submitting", async (t) => {
  const f = fixture(t)
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("get_saved_answers", {})
    const result = await run.execute("request_missing_answers", {
      fields: [
        {
          label: "Earliest start date",
          kind: "text",
          required: true,
          options: [],
          help: "",
        },
      ],
    })
    assert.deepEqual(result, { done: true })
  })
  t.after(unbind)
  const result = await runNativeApplication(f.page, packet, f.options)
  assert.equal(result.needsAnswers, true)
  assert.equal(result.packet.fields.at(-1)?.label, "Earliest start date")
  assert.deepEqual(f.events, [])
})

test("late salary questions are resolved before a native agent can hand off", async (t) => {
  const f = fixture(t)
  const current = {
    ...packet,
    applicationContext: { country: "United States", jobDescription: "" },
  }
  f.options.resolveAnswers = async (value) =>
    resolvePacketAnswers(value, undefined, undefined, [
      {
        question: "Salary expectations",
        help: "",
        answer: "120K",
        country: "United States",
        confirmedAt: "2026-11-04T00:00:00Z",
      },
    ])
  f.options.beginSubmission = async (value) => {
    assert.equal(value.answers[value.fields.at(-1)!.id], "120K")
    f.events.push("intent")
  }
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    const reply = (await run.execute("request_missing_answers", {
      fields: [
        {
          label: "What is the total compensation range you are looking in?",
          help: "required",
          kind: "text",
          required: true,
          options: [],
        },
      ],
    })) as { done?: boolean; answers: { answer: string }[] }
    assert.notEqual(reply.done, true)
    assert.equal(reply.answers[0].answer, "120K")
    await run.execute("begin_submission", {})
    await run.execute("report_submission", {
      text: "Your application has been received.",
    })
  })
  t.after(unbind)
  const result = await runNativeApplication(f.page, current, f.options)
  assert.equal(result.needsAnswers, false)
  assert.deepEqual(f.events, ["intent", "receipt"])
})

test("repeated no-challenge calls stop without submitting or inventing a receipt", async (t) => {
  const f = fixture(t)
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    for (let i = 0; i < 3; i++) await run.execute("solve_captcha", {})
    assert.fail("Repeated empty CAPTCHA calls must stop")
  })
  t.after(unbind)
  await assert.rejects(
    runNativeApplication(f.page, packet, f.options),
    (error) =>
      error instanceof Error && !(error instanceof ApplicationCaptchaError)
  )
  assert.deepEqual(f.events, [])
})

test("repeated absent-CAPTCHA calls after send report missing receipt, not failed CAPTCHA", async (t) => {
  const f = fixture(t)
  f.page.locator = (() => ({
    count: async () => 0,
    innerText: async () => "Application form",
  })) as unknown as Page["locator"]
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("begin_submission", {})
    for (let i = 0; i < 3; i++) await run.execute("solve_captcha", {})
    assert.fail("No-progress calls remain bounded")
  })
  t.after(unbind)
  await assert.rejects(
    runNativeApplication(f.page, packet, f.options),
    (error) =>
      error instanceof ApplicationSubmissionError &&
      error.code === "receipt_unconfirmed"
  )
  assert.deepEqual(f.events, ["intent"])
})

test("a real receipt still wins after repeated absent-CAPTCHA calls", async (t) => {
  const f = fixture(t)
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("begin_submission", {})
    for (let i = 0; i < 3; i++) await run.execute("solve_captcha", {})
  })
  t.after(unbind)
  await runNativeApplication(f.page, packet, f.options)
  assert.deepEqual(f.events, ["intent", "receipt"])
})

test("CAPTCHA business tools follow the native agent into an employer popup", async (t) => {
  const f = fixture(t)
  const context = f.page.context()
  const popup = {
    ...f.page,
    url: () => "https://employer.example/application-popup",
  } as Page
  context.pages = () => [f.page, popup]
  context.newCDPSession = (async (page: Page) => ({
    send: async () => ({
      targetInfo: { targetId: page === popup ? "popup" : "fixture" },
    }),
    detach: async () => {},
  })) as unknown as typeof context.newCDPSession
  let solvedOn: Page | undefined
  t.after(
    bindCaptchaSolver(context, async (page) => {
      solvedOn = page
      return {
        solved: false,
        challengeVisible: false,
        instruction: "No challenge",
      }
    })
  )
  t.after(
    bindBrowserUse(context, async (run) => {
      await run.execute("solve_captcha", {}, "popup")
      assert.equal(
        solvedOn,
        popup,
        "The original tab must not be mistaken for the active employer tab"
      )
      await run.execute("begin_submission", {}, "popup")
      await run.execute(
        "report_submission",
        { text: "Your application has been received." },
        "popup"
      )
    })
  )
  await runNativeApplication(f.page, packet, f.options)
  assert.deepEqual(f.events, ["intent", "receipt"])
})

test("discovery recognizes document upload instructions without converting text questions", async (t) => {
  const { discoverNativeForm } =
    await import("../lib/server/applications/native-agent")
  const { missingAnswers } = await import("../lib/applications")
  const f = fixture(t)
  const fields = [
    {
      label: "Resume",
      help: "Upload File or drag and drop here. Accepts PDF/DOC/DOCX.",
      kind: "text",
      required: true,
      options: [],
    },
    {
      label: "Cover Letter",
      help: "Upload File or drag and drop here. Optional.",
      kind: "text",
      required: false,
      options: [],
    },
    {
      label: "Resume URL",
      help: "Provide a link",
      kind: "url",
      required: true,
      options: [],
    },
    {
      label: "Cover Letter",
      help: "Write your cover letter",
      kind: "textarea",
      required: false,
      options: [],
    },
    {
      label: "Have you uploaded your resume?",
      help: "",
      kind: "yesno",
      required: true,
      options: ["Yes", "No"],
    },
  ]
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("report_form", { fields, notices: "" })
  })
  t.after(unbind)
  const form = await discoverNativeForm(
    f.page,
    { title: "Engineer", company: "Example" },
    async () => {}
  )
  assert.deepEqual(
    form.fields.map((f) => f.kind),
    ["resume", "cover_letter", "url", "textarea", "yesno"]
  )
  assert.equal(
    missingAnswers({ ...packet, ...form, answers: {} }).includes("Resume"),
    false
  )
})

for (const tool of [
  "request_missing_answers",
  "request_verification",
  "solve_captcha",
]) {
  for (const codeOnly of [false, true])
    for (const solver of ["clears", "fails", "claims_success", "reveals_code"])
      test(`post-send challenge through ${tool}, solver ${solver}, code-only ${codeOnly}`, async (t) => {
        const f = fixture(t)
        f.options.codeVerificationOnly = codeOnly
        let visible = true
        let mode = "challenge"
        const frame = {
          parentFrame: () => null,
          locator: () => ({ innerText: async () => "", count: async () => 0 }),
          url: () => "https://www.google.com/recaptcha/api2/bframe",
          evaluate: async () =>
            visible
              ? {
                  mode,
                  targets: [
                    {
                      selector: "#verify",
                      kind: "click",
                      label: "Verify",
                      tile: false,
                    },
                  ],
                  signature: "observed-challenge",
                  message: "Verification required",
                }
              : null,
        }
        t.mock.method(f.page, "frames", () => [frame])
        t.mock.method(
          f.page,
          "locator",
          () =>
            ({
              count: async () => 0,
              innerText: async () =>
                visible
                  ? "Verification required"
                  : "Your application has been received.",
            }) as never
        )
        t.after(
          bindCaptchaSolver(f.page.context(), async () => {
            f.events.push("solver")
            if (solver === "fails") throw new ApplicationCaptchaError()
            if (solver === "clears") visible = false
            if (solver === "reveals_code") mode = "code"
            return { solved: true, instruction: "Verification cleared" }
          })
        )
        f.options.humanVerification = async (ready) => {
          assert.equal(await ready(), false)
          f.events.push("human")
          visible = false
          assert.equal(await ready(), true)
        }
        t.after(
          bindBrowserUse(f.page.context(), async (run) => {
            await run.execute("begin_submission", {})
            await run.execute(tool, {})
            assert.equal(
              visible,
              false,
              "An observed challenge must be handled, not reported as missing personal information"
            )
            await run.execute("report_submission", {
              text: "Your application has been received.",
            })
          })
        )
        if (codeOnly && ["fails", "claims_success"].includes(solver)) {
          await assert.rejects(
            runNativeApplication(f.page, packet, f.options),
            ApplicationCaptchaError
          )
          assert.deepEqual(f.events, ["intent", "solver"])
          return
        }
        const result = await runNativeApplication(f.page, packet, f.options)
        assert.equal(result.needsAnswers, false)
        assert.deepEqual(f.events, [
          "intent",
          "solver",
          ...(solver === "clears" ? [] : ["human"]),
          "receipt",
        ])
      })
}

for (const label of ["Verification code", "One-time code", "OTP", "Password"]) {
  test(`${label} is never persisted as a candidate question`, async (t) => {
    const f = fixture(t)
    t.after(
      bindBrowserUse(f.page.context(), async (run) => {
        await run.execute("request_missing_answers", {
          fields: [
            { label, kind: "text", required: true, options: [], help: "" },
          ],
        })
      })
    )
    await assert.rejects(
      runNativeApplication(f.page, packet, f.options),
      /verification could not be completed|sign-in method/
    )
    assert.deepEqual(f.events, [])
    assert.equal(
      packet.fields.some((field) => field.label === label),
      false
    )
  })
}

for (const body of [
  "Your application has been received.\nIf you experience an error with our careers website, contact support.",
  "Thank you for submitting your application.",
  "Your application has been successfully received.",
])
  test(`native receipt accepts explicit acknowledgement: ${body}`, async (t) => {
    const f = fixture(t)
    t.mock.method(
      f.page,
      "locator",
      () => ({ innerText: async () => body, count: async () => 0 }) as never
    )
    const unbind = bindBrowserUse(f.page.context(), async (run) => {
      await run.execute("begin_submission", {})
      await run.execute("report_submission", { text: body.split("\n")[0] })
    })
    t.after(unbind)
    await runNativeApplication(f.page, packet, f.options)
    assert.deepEqual(f.events, ["intent", "receipt"])
  })

test("worker fallback waits for delayed acknowledgement without another submission", async (t) => {
  const f = fixture(t)
  f.options.deadline = Date.now() + 2000
  let reads = 0
  t.mock.method(
    f.page,
    "locator",
    () =>
      ({
        count: async () => 0,
        innerText: async () =>
          ++reads < 3
            ? "Processing your application..."
            : "Your application has been received.",
      }) as never
  )
  const unbind = bindBrowserUse(f.page.context(), async (run) => {
    await run.execute("begin_submission", {})
    throw new Error("Worker disconnected after click")
  })
  t.after(unbind)
  await runNativeApplication(f.page, packet, f.options)
  assert.ok(reads >= 3)
  assert.deepEqual(f.events, ["intent", "receipt"])
})
