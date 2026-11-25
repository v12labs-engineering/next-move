import assert from "node:assert/strict"
import test from "node:test"
import {
  acceptAnswerDrafts,
  canDraftAnswer,
} from "../lib/applications/answer-drafts"
import type { ApplicationField, ApplicationPacket } from "../lib/applications"
import {
  draftAnswerSuggestions,
  addTelegramAIDrafts,
} from "../lib/server/telegram/drafts"
import {
  editCode,
  questionMessage,
  transition,
  type TelegramRequest,
} from "../lib/telegram"

const field: ApplicationField = {
  id: "safety",
  label:
    "What do you currently think is the most important problem for AI safety?",
  help: "",
  kind: "textarea",
  required: true,
  options: [],
}
const packet: ApplicationPacket = {
  company: "FAR.AI",
  title: "Senior Software Engineer, GPU Cluster Infrastructure",
  resume: "Private resume evidence, never sent to the opinion generator.",
  notices: "",
  formHash: "fixture",
  tailored: true,
  fields: [field],
  answers: {},
  applicationContext: {
    country: "Germany",
    jobDescription: "Build GPU cluster infrastructure for AI safety research.",
  },
}
const answer =
  "I think the most important problem is establishing reliable ways to evaluate and control increasingly capable AI systems before deployment. Better evaluations need to expose dangerous capabilities and failures under realistic conditions, and their results must inform deployment decisions."

test("Opinion drafting accepts the FAR.AI question and excludes unknown personal facts and declarations", () => {
  assert.equal(canDraftAnswer(field), true)
  assert.equal(
    canDraftAnswer({ ...field, label: "Why are you interested in this role?" }),
    true
  )
  for (const label of [
    "Why do you expect this salary?",
    "How would you describe your work authorization?",
    "Why are you available to start now?",
    "What is your notice period?",
    "What is your opinion on disclosing your disability?",
    "Why did you leave your previous employer?",
    "Describe your experience with GPU clusters",
    "Do you consent to these terms?",
    "Why are you eligible to work here?",
  ]) {
    assert.equal(canDraftAnswer({ ...field, label }), false, label)
  }
  assert.equal(
    canDraftAnswer({ ...field, kind: "radio", options: ["Yes", "No"] }),
    false
  )
  const proposals = acceptAnswerDrafts(packet, [field], {
    answers: [
      { fieldId: field.id, answer },
      { fieldId: "unknown", answer },
      { fieldId: field.id, answer: "Duplicate" },
    ],
  })
  assert.deepEqual(Object.keys(proposals), [field.id])
  assert.equal(proposals.safety.answer, answer)
  assert.deepEqual(packet.answers, {})
  assert.deepEqual(
    acceptAnswerDrafts(
      { ...packet, answers: { safety: "My own answer" } },
      [field],
      { answers: [{ fieldId: field.id, answer }] }
    ),
    {}
  )
  assert.deepEqual(
    acceptAnswerDrafts(packet, [field], {
      answers: [
        {
          fieldId: field.id,
          answer: "I've led research at this employer for five years.",
        },
      ],
    }),
    {}
  )
})

test("The generator receives only eligible questions and public role context; drafts need approval and edits win", async () => {
  const inputPacket = {
    ...packet,
    answers: { safety: "" },
    fields: [
      ...packet.fields,
      { ...field, id: "salary", label: "What salary do you expect?" },
    ],
  }
  const proposals = await draftAnswerSuggestions(
    inputPacket,
    inputPacket.fields,
    async (input) => {
      assert.deepEqual(Object.keys(input).sort(), [
        "company",
        "fields",
        "jobDescription",
        "role",
      ])
      assert.deepEqual(input.fields, [field])
      assert.equal(JSON.stringify(input).includes("Private resume"), false)
      return {
        answers: [
          { fieldId: "safety", answer },
          { fieldId: "salary", answer: "100000" },
        ],
      }
    }
  )
  let q: TelegramRequest = {
    id: "20000000-0000-4000-8000-000000000001",
    user_id: "fixture",
    application_id: "fixture",
    revision: 1,
    version: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    packet,
    state: {
      initialized: true,
      editing: false,
      confirmed: [],
      answers: {},
      proposals,
    },
  }
  const message = questionMessage(q, "https://app.example.test")
  assert.match(message.text, /AI-generated draft/)
  assert.deepEqual(
    message.buttons.flat().map((b) => b.label),
    ["Use answer", "Edit answer", "Pause"]
  )
  assert.throws(() => transition(q, "send"), /confirm every/)
  assert.equal(transition(q, "use").state.answers.safety, answer)
  assert.deepEqual(
    q.packet.answers,
    {},
    "Even Use answer stays in review state until final approval"
  )
  q = { ...q, version: 2, state: transition(q, "edit").state }
  q = {
    ...q,
    state: transition(q, "confirm", `${editCode(q)}:My edited perspective`)
      .state,
    version: 3,
  }
  assert.equal(q.state.answers.safety, "My edited perspective")
  assert.deepEqual(q.state.confirmed, [])
  q = { ...q, state: transition(q, "confirm").state, version: 4 }
  assert.equal(q.state.answers.safety, "My edited perspective")
  assert.equal(transition(q, "send").finish, true)
  assert.deepEqual(q.packet.answers, {})
})

test("Telegram asks the current personal question without waiting for later essay drafting", async (t) => {
  const q: TelegramRequest = {
    id: "20000000-0000-4000-8000-000000000001",
    user_id: "fixture",
    application_id: "fixture",
    revision: 1,
    version: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    packet: {
      ...packet,
      fields: [
        { ...field, id: "phone", label: "Phone number", kind: "tel" },
        field,
      ],
    },
    state: {
      initialized: true,
      editing: false,
      confirmed: [],
      answers: {},
      proposals: {},
    },
  }
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("No draft or database request may delay the current question")
  )
  assert.equal(await addTelegramAIDrafts(q, "lease", "telegram:42"), false)
  assert.match(
    questionMessage(q, "https://app.example.test").text,
    /Phone number/
  )
})
