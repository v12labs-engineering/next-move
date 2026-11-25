import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "playwright-core"
import {
  mergeFormStep,
  readNativeForm,
  walkEmployerForms,
} from "../lib/server/applications/forms"
import type { ApplicationField, ApplicationPacket } from "../lib/applications"
import { fillApplicationIdentity } from "../lib/applications/answers"

const field = (step: number, id: string, label: string): ApplicationField => ({
  id: `${step}:${id}`,
  label,
  kind: "text",
  help: "",
  required: true,
  options: [],
  step,
  selector: `#${id}`,
})
const name = field(0, "name", "Full Name")
const base: ApplicationPacket = {
  title: "Synthetic engineer",
  company: "Example",
  resume: "A truthful source resume with TypeScript and SQL API experience.",
  fields: [name],
  answers: { "0:name": "Test Candidate" },
  notices: "Employer privacy notice",
  stepNotices: ["Employer privacy notice"],
  formHash: "fixture",
  tailored: true,
}

// A deterministic managed-browser protocol fixture. It exercises the real
// traversal and pause logic without network, accounts or employer submissions.
function employer(pages: ApplicationField[][]) {
  let index = 0
  const entered: Record<string, string> = {}
  let nextClicks = 0
  const page = {
    evaluate: async (fn: unknown) =>
      fn === readNativeForm
        ? { fields: pages[index], notices: "Employer privacy notice" }
        : String(index),
    waitForFunction: async () => {},
    locator: (selector: string) => ({
      count: async () => 0,
      fill: async (value: string) => {
        entered[`${index}:${selector}`] = value
      },
    }),
    getByRole: (_role: string, options: { name: RegExp }) => ({
      count: async () =>
        options.name.test("Next")
          ? Number(index < pages.length - 1)
          : Number(index === pages.length - 1),
      click: async () => {
        index++
        nextClicks++
      },
    }),
  } as unknown as Page
  return { page, entered, nextClicks: () => nextClicks }
}

test("one action fills multiple known form pages and reaches the persisted submit boundary exactly once", async () => {
  const email = { ...field(1, "email", "Email"), kind: "email" as const }
  const browser = employer([[name], [email]])
  let beforeSubmit = 0
  const result = await walkEmployerForms(browser.page, base, {
    automatic: true,
    savedAnswers: async (packet) =>
      fillApplicationIdentity(packet, {
        fullName: "Test Candidate",
        resumeText: base.resume,
        email: "verified@example.test",
      }),
    beforeSubmit: async (packet) => {
      beforeSubmit++
      assert.equal(packet.answers["1:email"], "verified@example.test")
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(beforeSubmit, 1)
  assert.equal(browser.nextClicks(), 1)
  assert.deepEqual(browser.entered, {
    "0:#name": "Test Candidate",
    "1:#email": "verified@example.test",
  })
})

test("a missing answer on a later page pauses in-app before any final submission", async () => {
  const salary = field(1, "salary", "Salary expectation")
  const browser = employer([[name], [salary]])
  let submissions = 0
  const result = await walkEmployerForms(browser.page, base, {
    automatic: true,
    savedAnswers: async (packet) =>
      fillApplicationIdentity(packet, {
        fullName: "Test Candidate",
        resumeText: base.resume,
        email: "verified@example.test",
      }),
    beforeSubmit: async () => {
      submissions++
    },
  })
  assert.equal(result.needsAnswers, true)
  assert.equal(submissions, 0)
  assert.equal(
    result.packet.fields.some((f) => f.id === "1:salary"),
    true
  )
  assert.equal(result.packet.answers["1:salary"], undefined)
  assert.equal(browser.entered["1:#salary"], undefined)
  const resumed = employer([[name], [salary]])
  const completed = await walkEmployerForms(
    resumed.page,
    {
      ...result.packet,
      answers: {
        ...result.packet.answers,
        "1:salary": "Candidate's explicit answer",
      },
    },
    {
      automatic: true,
      beforeSubmit: async () => {
        submissions++
      },
    }
  )
  assert.equal(completed.needsAnswers, false)
  assert.equal(submissions, 1)
})

test("automatic traversal fills resume email, telephone and LinkedIn across form steps", async () => {
  const email = {
    ...field(0, "email", "E-mail address *"),
    kind: "email" as const,
  }
  const phone = { ...field(1, "phone", "Mobile number"), kind: "tel" as const }
  const linkedin = {
    ...field(1, "linkedin", "LinkedIn profile URL"),
    kind: "url" as const,
  }
  const browser = employer([
    [name, email],
    [phone, linkedin],
  ])
  let submissions = 0
  const result = await walkEmployerForms(browser.page, base, {
    automatic: true,
    savedAnswers: async (packet) =>
      fillApplicationIdentity(packet, {
        fullName: "Test Candidate",
        resumeText:
          "Test Candidate | candidate@example.test | +91 98765 43210 | linkedin.com/in/test-candidate",
        email: "login@example.test",
      }),
    beforeSubmit: async () => {
      submissions++
    },
  })
  assert.equal(result.needsAnswers, false)
  assert.equal(submissions, 1)
  assert.deepEqual(browser.entered, {
    "0:#name": "Test Candidate",
    "0:#email": "candidate@example.test",
    "1:#phone": "+91 98765 43210",
    "1:#linkedin": "https://linkedin.com/in/test-candidate",
  })
})

test("changed questions discard previously approved values, including optional consent", () => {
  const changed = {
    ...name,
    label: "Do you consent to marketing?",
    kind: "checkbox" as const,
    options: ["Yes"],
    required: true,
  }
  const result = mergeFormStep(
    base,
    { fields: [changed], notices: "New notice" },
    0
  )
  assert.equal(result.answers[name.id], undefined)
  assert.equal(result.notices, "New notice")
})

test("review-first runs pause on a changed employer form", async () => {
  const browser = employer([[{ ...name, label: "Legal name" }]])
  const result = await walkEmployerForms(browser.page, base, {
    automatic: false,
    beforeSubmit: async () => {
      assert.fail("Must not submit changed form")
    },
  })
  assert.equal(result.needsAnswers, true)
  assert.deepEqual(browser.entered, {})
})

test("a failing intent write cannot reach final submission and traversal is bounded", async () => {
  const browser = employer([[name]])
  await assert.rejects(
    walkEmployerForms(browser.page, base, {
      automatic: true,
      beforeSubmit: async () => {
        throw new Error("Intent persistence failed")
      },
    }),
    /Intent persistence failed/
  )
  const tooLong = employer(
    Array.from({ length: 9 }, (_, i) => [field(i, "name", "Full Name")])
  )
  await assert.rejects(
    walkEmployerForms(tooLong.page, base, {
      automatic: true,
      savedAnswers: async (packet) =>
        fillApplicationIdentity(packet, {
          fullName: "Test Candidate",
          resumeText: base.resume,
          email: "verified@example.test",
        }),
      beforeSubmit: async () => {
        assert.fail("Must not submit beyond bound")
      },
    }),
    /eight steps/
  )
})
