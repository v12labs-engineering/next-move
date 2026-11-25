import assert from "node:assert/strict"
import test from "node:test"
import { resolvePacketAnswers } from "../lib/server/applications/answer-resolver"
import { packetSchema } from "../lib/applications"
import type { SavedAnswerExample } from "../lib/server/applications/question-memory"

process.env.TAILORING_BASE_URL = "https://provider.example.test/v1"
process.env.TAILORING_MODEL = "fixture"
process.env.TAILORING_API_KEY = "fictional-test-key"

for (const automatic of [false, true]) {
  test(`answer provider failure stays ${automatic ? "a worker error" : "a manual review"}`, async () => {
    const packet = packetSchema.parse({
      title: "Engineer",
      company: "Example",
      tailored: true,
      resume: "Original candidate resume with documented software projects.",
      formHash: "fixture",
      notices: "",
      answers: {},
      fields: [
        {
          id: "why",
          label: "Why this role?",
          kind: "textarea",
          required: true,
          options: [],
          help: "",
        },
      ],
    })
    const error = new Error("fetch failed")
    const result = resolvePacketAnswers(
      packet,
      async () => {
        throw error
      },
      undefined,
      [],
      { failOnProviderError: automatic }
    )
    if (automatic) await assert.rejects(result, (actual) => actual === error)
    else assert.deepEqual((await result).answers, {})
  })
}

function knownAnswer(
  question: string,
  answer: string,
  country = "United States"
) {
  return {
    question,
    answer,
    country,
    help: "",
    confirmedAt: "2026-11-04T08:00:00Z",
  }
}

async function resolveKnown(
  label: string,
  saved: SavedAnswerExample[],
  kind = "text"
) {
  return resolvePacketAnswers(
    packetSchema.parse({
      title: "Engineer",
      company: "Example",
      resume: "Original candidate resume with documented software projects.",
      tailored: true,
      formHash: "fixture",
      notices: "",
      answers: {},
      applicationContext: { country: "United States", jobDescription: "" },
      fields: [
        {
          id: "q",
          label,
          help: "required",
          kind,
          required: true,
          options: kind === "combobox" ? ["Yes", "No"] : [],
        },
      ],
    }),
    undefined,
    undefined,
    saved
  )
}

test("reworded compensation question reuses the candidate's saved expectation before handoff", async () => {
  const result = await resolveKnown(
    "What is the total compensation range you are looking in?",
    [knownAnswer("What are your salary expectations?", "120K")]
  )
  assert.equal(result.answers.q, "120K")
  assert.match(result.answerEvidence?.q.source ?? "", /saved answer/i)
})

test("saved total software experience answers a minimum experience question", async () => {
  const result = await resolveKnown(
    "Do you have at least 6 years of professional software engineering experience?",
    [
      knownAnswer(
        "How many years of professional software engineering experience do you have?",
        "11"
      ),
    ],
    "combobox"
  )
  assert.equal(result.answers.q, "Yes")
})

test("conflicting saved expectations remain unanswered", async () => {
  const result = await resolveKnown(
    "What is the total compensation range you are looking in?",
    [
      knownAnswer("Salary expectations", "120K"),
      knownAnswer("Desired Pay", "100k"),
    ]
  )
  assert.equal(result.answers.q, undefined)
})

for (const [label, question, answer, country, kind] of [
  ["Salary expectations", "Salary expectations", "120K", "Germany", "text"],
  [
    "Expected annual salary in USD",
    "Expected monthly salary in USD",
    "10000",
    "United States",
    "text",
  ],
  [
    "Expected annual salary in USD",
    "Expected annual salary in EUR",
    "120000",
    "United States",
    "text",
  ],
  [
    "Expected gross salary",
    "Expected net salary",
    "120K",
    "United States",
    "text",
  ],
  [
    "Expected total compensation",
    "Expected base salary",
    "120K",
    "United States",
    "text",
  ],
  [
    "Expected annual salary in USD",
    "Salary expectations",
    "120K",
    "United States",
    "text",
  ],
  [
    "Expected total annual compensation in USD",
    "Expected total annual compensation in USD",
    "100000–120000",
    "United States",
    "number",
  ],
  ["Current salary", "Salary expectations", "120K", "United States", "text"],
  [
    "Do you have at least 6 years of Java experience?",
    "How many years of professional software engineering experience do you have?",
    "11",
    "United States",
    "combobox",
  ],
  [
    "Do you have at least 6 years of professional software engineering experience?",
    "How many years of professional software engineering experience do you have?",
    "5+ years",
    "United States",
    "combobox",
  ],
]) {
  test(`saved facts preserve meaning: ${label} from ${question} (${country}, ${answer})`, async () => {
    const result = await resolveKnown(
      label,
      [knownAnswer(question, answer, country)],
      kind
    )
    assert.equal(result.answers.q, undefined)
  })
}

test("saved salary units survive a reworded free-text question", async () => {
  const result = await resolveKnown("Salary expectations", [
    knownAnswer("Expected annual base salary in EUR, gross", "120000"),
  ])
  assert.equal(result.answers.q, "120000 EUR per year base salary gross")
})

test("matching numeric salary units allow formatting without conversion", async () => {
  const result = await resolveKnown(
    "Desired total annual compensation in USD",
    [knownAnswer("Expected total annual compensation in USD", "120,000")],
    "number"
  )
  assert.equal(result.answers.q, "120000")
})

test("known experience can answer No as well as Yes", async () => {
  const result = await resolveKnown(
    "Do you have at least 6 years of professional software engineering experience?",
    [
      knownAnswer(
        "How many years of professional software engineering experience do you have?",
        "4"
      ),
    ],
    "combobox"
  )
  assert.equal(result.answers.q, "No")
})

test("explicit blanks and ask-again choices beat semantic saved facts", async () => {
  for (const override of [
    { answers: { q: "" } },
    { answerReuseBlocked: ["q"] },
  ]) {
    const packet = packetSchema.parse({
      title: "Engineer",
      company: "Example",
      resume: "Original candidate resume with documented software projects.",
      tailored: true,
      formHash: "fixture",
      notices: "",
      answers: {},
      applicationContext: { country: "United States", jobDescription: "" },
      fields: [
        {
          id: "q",
          label: "Desired salary",
          help: "",
          kind: "text",
          required: true,
          options: [],
        },
      ],
      ...override,
    })
    const result = await resolvePacketAnswers(packet, undefined, undefined, [
      knownAnswer("Salary expectations", "120K"),
    ])
    assert.equal(result.answers.q, packet.answers.q)
  }
})

for (const label of [
  "Expected gross annual salary in INR",
  "Current CTC?",
  "What is your English proficiency?",
  "Do you live and work in the Americas?",
  "Pick date...",
  "How many years of professional software engineering experience do you have?",
]) {
  test(`unresolved personal facts never go to unconstrained generation: ${label}`, async () => {
    const packet = packetSchema.parse({
      title: "Engineer",
      company: "Generated employer",
      resume: "Original candidate resume with documented software projects.",
      tailored: true,
      formHash: "fixture",
      notices: "",
      answers: {},
      fields: [
        { id: "q", label, help: "", kind: "text", required: true, options: [] },
      ],
    })
    let calls = 0
    const result = await resolvePacketAnswers(packet, async () => {
      calls++
      throw Error("No provider needed")
    })
    assert.equal(calls, 0)
    assert.deepEqual(result.answers, {})
  })
}

test("confirmed residence fills country before handing the form to the candidate", async () => {
  const packet = packetSchema.parse({
    title: "Engineer",
    company: "Example",
    resume: "Candidate resume with documented software projects.",
    tailored: true,
    formHash: "fixture",
    notices: "",
    answers: {},
    applicationContext: {
      country: "Germany",
      jobDescription: "Software engineer",
      profile: {
        enabled: true,
        confirmedAt: "2026-11-01T00:00:00Z",
        contact: { location: "Hyderabad, India" },
      },
    },
    fields: [
      {
        id: "country",
        label: "Country",
        help: "",
        kind: "select",
        required: true,
        options: ["Germany", "India", "United States"],
      },
    ],
  })
  const result = await resolvePacketAnswers(packet)
  assert.equal(result.answers.country, "India")
})

test("optional contact consent is never sent to the automatic answer generator", async () => {
  const packet = packetSchema.parse({
    title: "Engineer",
    company: "Example",
    resume: "Original candidate resume with documented software projects.",
    tailored: true,
    formHash: "fixture",
    notices: "",
    answers: {},
    fields: [
      {
        id: "consent",
        label: "Optional future contact",
        help: "",
        kind: "checkbox",
        required: false,
        options: ["I agree"],
      },
    ],
  })
  let calls = 0
  const result = await resolvePacketAnswers(packet, async () => {
    calls++
    throw Error("No provider needed")
  })
  assert.equal(calls, 0)
  assert.equal(result.answers.consent, undefined)
})

for (const label of [
  "Who is your employee referral contact?",
  "Were you referred by an employee?",
  "Please provide a professional reference",
  "Name of your referee",
]) {
  test(`unknown referral facts never reach AI: ${label}`, async () => {
    const packet = packetSchema.parse({
      title: "Engineer",
      company: "Example",
      tailored: true,
      resume: "Candidate resume with documented software projects.",
      formHash: "referral",
      notices: "",
      answers: {},
      fields: [
        {
          id: "referral",
          label,
          kind: "text",
          required: true,
          options: [],
          help: "",
        },
      ],
    })
    let calls = 0
    const result = await resolvePacketAnswers(packet, async () => {
      calls++
      throw new Error("Personal facts must not reach the model")
    })
    assert.equal(calls, 0)
    assert.deepEqual(result.answers, {})
    const explicit = await resolvePacketAnswers(
      { ...packet, answers: { referral: "No employee referral" } },
      async () => {
        throw new Error("Unexpected model call")
      }
    )
    assert.equal(explicit.answers.referral, "No employee referral")
  })
}
