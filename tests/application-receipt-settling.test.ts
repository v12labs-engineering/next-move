import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import type { Page } from "playwright-core"
import type { ApplicationPacket } from "../lib/applications"
import { runComputerApplication } from "../lib/server/applications/computer-agent"
import {
  readComputerDocument,
  type ComputerControl,
} from "../lib/server/applications/computer-browser"

const packet: ApplicationPacket = {
  title: "Generated engineer",
  company: "Fictional employer",
  resume:
    "Fictional candidate with TypeScript experience for generated QA only.",
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
  answers: { email: "fictional@example.test" },
  notices: "",
  formHash: "fixture",
  tailored: true,
}

function fixture(
  t: TestContext,
  receiptText: (elapsed: number) => string,
  trackRelease = false,
  hooks: {
    afterInference?: () => void
    persisted?: () => void
    repeatConfirm?: boolean
    receiptControls?: (original: ComputerControl) => ComputerControl[]
    hiddenWaitMs?: number
  } = {}
) {
  const old = { ...process.env }
  Object.assign(process.env, {
    TAILORING_BASE_URL: "https://model.example.test/v1",
    TAILORING_MODEL: "synthetic-model",
    TAILORING_API_KEY: "synthetic-key",
    APPLICATION_COMPUTER_MODEL: "synthetic-model",
    APPLICATION_RECEIPT_MODEL: "synthetic-model",
    APPLICATION_FORM_PLANNER: "computer",
  })
  t.after(() => {
    process.env = old
  })
  let now = 0,
    submittedAt: number | undefined,
    submissions = 0
  let modelCalls = 0,
    reservations = 0,
    receiptCalls = 0
  let releases = 0
  let screenshots = 0
  t.mock.method(Date, "now", () => now)
  const email: ComputerControl = {
    target: "c0",
    frame: 0,
    selector: "#email",
    tag: "input",
    type: "email",
    role: "",
    label: "Email",
    group: "",
    context: "",
    id: "email",
    name: "email",
    required: true,
    disabled: false,
    options: [],
    value: "",
    checked: false,
    valid: true,
    selectedText: "",
    selectionObservable: false,
    href: "",
    scope: "body",
    autocomplete: "email",
    inViewport: true,
  }
  const submit = {
    ...email,
    target: "c1",
    selector: "#send",
    tag: "button",
    type: "submit",
    label: "Submit application",
    id: "send",
    name: "",
    required: false,
  }
  const frame = {
    parentFrame: () => null,
    isDetached: () => false,
    evaluate: async (fn: unknown) => {
      assert.equal(releases, 0, "Never read a released employer browser")
      assert.equal(fn, readComputerDocument)
      return {
        title: "Generated employer",
        notices: "",
        text:
          submittedAt === undefined
            ? "Email Submit application"
            : receiptText(now - submittedAt),
        controls:
          submittedAt === undefined
            ? [{ ...email }, { ...submit }]
            : receiptText(now - submittedAt).includes("verification code")
              ? [
                  {
                    ...email,
                    label: "Verification code",
                    type: "text",
                    autocomplete: "one-time-code",
                  },
                ]
              : hooks.receiptControls?.(email) || [],
      }
    },
    locator: (selector: string) => ({
      count: async () =>
        selector.includes("iframe")
          ? Number(
              submittedAt !== undefined &&
                receiptText(now - submittedAt) === "__challenge__"
            )
          : 1,
      fill: async (value: string) => {
        email.value = value
      },
      evaluate: async () => true,
      waitFor: async () => {
        assert.notEqual(submittedAt, undefined)
        now += hooks.hiddenWaitMs || 0
      },
      click: async () => {
        submissions++
        submittedAt = now
      },
    }),
  }
  const page = {
    ...frame,
    frames: () => [frame],
    context: () => ({}),
    screenshot: async () => {
      screenshots++
      return Buffer.from("generated-screenshot")
    },
    setViewportSize: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async (ms: number) => {
      now += ms
    },
    url: () => "https://synthetic.example.test/receipt",
  } as unknown as Page
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      modelCalls++
      assert.equal(
        modelCalls,
        reservations,
        "Every model call needs an earlier reservation"
      )
      const body = JSON.parse(String(init.body))
      const state = JSON.parse(
        body.messages
          .find((m: { role: string }) => m.role === "user")
          .content.find((p: { type: string }) => p.type === "text").text
      )
      if (state.visibleText !== undefined) {
        assert.ok(
          body.messages.some(
            (m: {
              content?: { type: string; image_url?: { url: string } }[]
            }) =>
              Array.isArray(m.content) &&
              m.content.some(
                (p) =>
                  p.type === "image_url" &&
                  p.image_url?.url.endsWith(
                    Buffer.from("generated-screenshot").toString("base64")
                  )
              )
          ),
          "Receipt model must receive the final captured screenshot"
        )
        assert.equal(
          releases,
          0,
          "Keep browser available during receipt inference"
        )
        receiptCalls++
        const confirmed = state.visibleText.includes("Thank you for applying")
        hooks.afterInference?.()
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  confirmed,
                  blocked: state.visibleText.includes("Application blocked"),
                  text: confirmed ? "Thank you for applying" : "",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
      }
      const name = modelCalls === 2 ? "fill" : "review"
      const args =
        name === "fill"
          ? { epoch: state.screen.epoch }
          : {
              epoch: state.screen.epoch,
              fields: [
                {
                  targets: ["c0"],
                  label: "Email",
                  kind: "email",
                  required: true,
                  options: [],
                },
              ],
            }
      return Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-generated",
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    }
  )
  return {
    run: (
      humanVerification?: (ready: () => Promise<boolean>) => Promise<void>
    ) =>
      runComputerApplication(page, packet, {
        automatic: true,
        humanVerification,
        releaseBrowser: trackRelease
          ? async () => {
              releases++
            }
          : undefined,
        reserveDecision: async () => {
          reservations++
        },
        beforeSubmit: async (_latest, confirm) => {
          await confirm()
          if (hooks.repeatConfirm) await confirm()
          assert.equal(
            releases,
            0,
            "Keep browser until receipt persistence finishes"
          )
          hooks.persisted?.()
        },
      }),
    evidence: () => ({
      elapsed: now,
      submissions,
      receiptCalls,
      modelCalls,
      reservations,
      releases,
      screenshots,
    }),
    advance: (ms: number) => {
      now += ms
    },
  }
}

test("an explicit employer block cannot become success from surrounding thank-you text or trigger another send", async (t) => {
  const f = fixture(
    t,
    () =>
      "Thank you for applying. Application blocked: application limit exceeded."
  )
  await assert.rejects(
    f.run(async () =>
      assert.fail("A definitive block does not need another browser action")
    ),
    { code: "employer_rejected" }
  )
  assert.equal(f.evidence().submissions, 1)
})

test("browser stays live through receipt inference and persistence, then releases", async (t) => {
  const f = fixture(t, () => "Thank you for applying", true)
  assert.equal((await f.run()).needsAnswers, false)
  assert.equal(f.evidence().releases, 1)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
})

test("a newsletter email field with the same label is not the submitted application", async (t) => {
  const f = fixture(t, () => "Thank you for applying", true, {
    receiptControls: (original) => [
      {
        ...original,
        selector: "#newsletter-email",
        scope: "footer > form",
        id: "",
        name: "emailAddress",
        group: "Email",
        label: "Enter your email",
        value: "",
      },
    ],
  })
  await f.run()
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
})

test("the original application control still blocks confirmation after its label changes", async (t) => {
  const f = fixture(t, () => "Thank you for applying", true, {
    receiptControls: (original) => [{ ...original, label: "Contact email" }],
  })
  await assert.rejects(f.run(), { code: "receipt_form_visible" })
  assert.equal(f.evidence().submissions, 1)
})

test("an unfamiliar receipt releases the browser on failure without resending", async (t) => {
  const f = fixture(
    t,
    () => "The fictional employer has displayed another page.",
    true
  )
  await assert.rejects(f.run(), /Confirmation is ambiguous/)
  assert.equal(f.evidence().releases, 1)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
})

test("reentering confirmation never repeats the employer submit", async (t) => {
  const f = fixture(t, () => "Thank you for applying", true, {
    repeatConfirm: true,
  })
  await f.run()
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
})

test("receipt persistence failure releases the session and never resends", async (t) => {
  const f = fixture(t, () => "Thank you for applying", true, {
    persisted: () => {
      throw new Error("persistence unavailable")
    },
  })
  await assert.rejects(f.run(), /persistence unavailable/)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().releases, 1)
})

test("receipt provider failure is specific, private and releases without resending", async (t) => {
  const f = fixture(t, () => "Thank you for applying", true, {
    afterInference: () => {
      throw new Error("private provider payload with candidate data")
    },
  })
  await assert.rejects(f.run(), { code: "receipt_provider_failed" })
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().releases, 1)
})

test("uncompleted email verification cannot be reported as a receipt", async (t) => {
  const f = fixture(t, () => "Enter verification code sent to your email", true)
  await assert.rejects(
    f.run(async (ready) => {
      assert.equal(await ready(), false)
      throw new Error("Human verification required; assistance time expired")
    }),
    { code: "verification_incomplete" }
  )
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 0)
  assert.equal(f.evidence().releases, 1)
})

test("email code requires same-session human help before receipt inference", async (t) => {
  let solved = false,
    handoffs = 0
  const f = fixture(
    t,
    () =>
      solved
        ? "Thank you for applying"
        : "Enter verification code sent to your email",
    true
  )
  await f.run(async (ready) => {
    handoffs++
    assert.equal(f.evidence().releases, 0)
    assert.equal(f.evidence().receiptCalls, 0)
    assert.equal(await ready(), false)
    solved = true
    assert.equal(await ready(), true)
  })
  assert.equal(handoffs, 1)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().releases, 1)
})

test("an unknown post-submit result closes for review without starting a human wait", async (t) => {
  const f = fixture(t, () => "Check the next step on this employer page", true)
  await assert.rejects(
    f.run(async () => assert.fail("No verification gate is visible")),
    { code: "receipt_unconfirmed" }
  )
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
  assert.equal(f.evidence().elapsed, 2500)
  assert.equal(f.evidence().releases, 1)
  assert.equal(f.evidence().reservations, f.evidence().modelCalls)
})

test("a confirmed result releases immediately without a field-disappearance or human wait", async (t) => {
  const f = fixture(t, () => "Thank you for applying", true, {
    hiddenWaitMs: 20_000,
  })
  await f.run(async () => assert.fail("A receipt needs no human help"))
  assert.equal(f.evidence().elapsed, 0)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
  assert.equal(f.evidence().releases, 1)
})

test("a CAPTCHA is handed off immediately and finishing early releases without using the whole allowance", async (t) => {
  let solved = false,
    handoffs = 0
  const f = fixture(
    t,
    () => (solved ? "Thank you for applying" : "__challenge__"),
    true,
    {
      hiddenWaitMs: 20_000,
    }
  )
  await f.run(async (ready) => {
    handoffs++
    assert.equal(f.evidence().elapsed, 0)
    assert.equal(f.evidence().submissions, 1)
    assert.equal(await ready(), false)
    f.advance(5_000)
    solved = true
    assert.equal(await ready(), true)
  })
  assert.equal(handoffs, 1)
  assert.equal(f.evidence().elapsed, 5_000)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().releases, 1)
})

test("a slow result with the original form visible keeps checking instead of reporting a premature failure", async (t) => {
  let elapsed = 0
  const f = fixture(
    t,
    (ms) => {
      elapsed = ms
      return ms < 8_000 ? "Email Submit application" : "Thank you for applying"
    },
    true,
    {
      receiptControls: (original) => (elapsed < 8_000 ? [original] : []),
    }
  )
  await f.run(async () => assert.fail("A delayed receipt is not a CAPTCHA"))
  assert.equal(f.evidence().elapsed, 8_000)
  assert.equal(f.evidence().receiptCalls, 1)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().releases, 1)
})

test("a form that never completes closes at the result timeout without opening human assistance", async (t) => {
  const f = fixture(t, () => "Email Submit application", true, {
    receiptControls: (original) => [original],
  })
  await assert.rejects(
    f.run(async () => assert.fail("An unchanged form is not a CAPTCHA")),
    { code: "receipt_form_visible" }
  )
  assert.equal(f.evidence().elapsed, 20_000)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 0)
  assert.equal(f.evidence().releases, 1)
})

test("a verification screen arriving during inference invalidates the old receipt", async (t) => {
  let pending = false,
    solved = false,
    handoffs = 0
  const f = fixture(
    t,
    () =>
      pending && !solved ? "Enter verification code" : "Thank you for applying",
    true,
    {
      afterInference: () => {
        pending = true
      },
    }
  )
  await f.run(async (ready) => {
    handoffs++
    assert.equal(await ready(), false)
    solved = true
    assert.equal(await ready(), true)
  })
  assert.equal(handoffs, 1)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 2)
})

test("a two-second SPA receipt is observed before the single reserved receipt-model call", async (t) => {
  const f = fixture(t, (elapsed) =>
    elapsed < 2000
      ? "Processing application. Please wait."
      : "Thank you for applying"
  )
  assert.equal((await f.run()).needsAnswers, false)
  const proof = f.evidence()
  assert.ok(proof.elapsed >= 2000)
  assert.ok(proof.elapsed < 20000)
  assert.equal(proof.submissions, 1)
  assert.equal(proof.receiptCalls, 1)
  assert.equal(proof.modelCalls, 4)
  assert.equal(proof.reservations, 4)
  assert.equal(
    proof.screenshots,
    3,
    "Two form observations and one final receipt screenshot; readiness polls need no image"
  )
})

test("a permanently busy receipt expires without another submit or model call", async (t) => {
  const f = fixture(t, () => "Processing application. Please wait.")
  await assert.rejects(f.run(), /receipt.*(?:loading|timed out)/i)
  const proof = f.evidence()
  assert.equal(proof.elapsed, 20000)
  assert.equal(proof.submissions, 1)
  assert.equal(proof.receiptCalls, 0)
  assert.equal(proof.modelCalls, 3)
  assert.equal(proof.reservations, 4)
})

test("a stable unfamiliar page still needs the one receipt-model check and remains ambiguous", async (t) => {
  const f = fixture(
    t,
    () => "The fictional employer has displayed another page."
  )
  await assert.rejects(f.run(), /Confirmation is ambiguous/)
  assert.equal(f.evidence().elapsed, 2500)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
  assert.equal(f.evidence().modelCalls, 4)
})

test("a challenge that appears during receipt settling uses the same handoff without another send", async (t) => {
  let solved = false,
    handoffs = 0
  const f = fixture(t, (elapsed) =>
    elapsed < 1000
      ? "Processing application. Please wait."
      : solved
        ? "Thank you for applying"
        : "__challenge__"
  )
  const result = await f.run(async (ready) => {
    handoffs++
    assert.equal(f.evidence().submissions, 1)
    assert.equal(await ready(), false)
    solved = true
    assert.equal(await ready(), true)
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(handoffs, 1)
  assert.equal(f.evidence().submissions, 1)
  assert.equal(f.evidence().receiptCalls, 1)
  assert.equal(f.evidence().modelCalls, 4)
})
