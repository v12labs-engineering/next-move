import assert from "node:assert/strict"
import test from "node:test"
import {
  applicationProfileSchema,
  applicationProfileFromResume,
  applicationProfileFresh,
  confirmApplicationProfile,
} from "../lib/applications/profile"
import {
  fillApplicationProfile,
  fillApplicationIdentity,
  observedLocationAnswer,
} from "../lib/applications/answers"
import { candidateSchema, emptyCandidate } from "../lib/candidate"
import {
  missingAnswers,
  packetSchema,
  type ApplicationField,
  type ApplicationPacket,
} from "../lib/applications"
import { mergeComputerFields } from "../lib/server/applications/computer-fields"
import { mergeFormStep } from "../lib/server/applications/forms"
import { applyRememberedAnswers } from "../lib/applications/questions"

const now = new Date("2026-10-31T12:00:00.000Z")

test("location dropdowns preserve city and country across an added region", () => {
  const location = {
    id: "location",
    label: "Location",
    help: "",
    kind: "combobox" as const,
    required: true,
    options: ["Hyderabad, Telangana, India", "Hyderabad, Sindh, Pakistan"],
  }
  assert.equal(
    observedLocationAnswer(location, "Hyderabad, India"),
    "Hyderabad, Telangana, India"
  )
  assert.equal(observedLocationAnswer(location, "Hyderabad"), undefined)
  assert.equal(
    observedLocationAnswer(location, "Hyderabad, Sindh, India"),
    undefined
  )
  assert.equal(
    observedLocationAnswer(
      { ...location, options: ["India", "British Indian Ocean Territory"] },
      "Hyderabad, India"
    ),
    "India"
  )
  assert.equal(
    observedLocationAnswer(
      {
        ...location,
        options: ["India", "Indiana, United States", "Kindia, Guinea"],
      },
      "Hyderabad, India"
    ),
    "India"
  )
  assert.equal(
    observedLocationAnswer(
      {
        ...location,
        label: "Physical location (City, State, Country)",
        options: ["India"],
      },
      "Hyderabad, India"
    ),
    undefined
  )
  assert.equal(
    observedLocationAnswer(
      { ...location, options: ["India", "IN"] },
      "Hyderabad, India"
    ),
    undefined
  )
  assert.equal(
    observedLocationAnswer(
      {
        ...location,
        options: [...location.options, "Hyderabad, Other Region, India"],
      },
      "Hyderabad, India"
    ),
    undefined
  )
  assert.equal(
    observedLocationAnswer(
      { ...location, label: "Preferred office location" },
      "Hyderabad, India"
    ),
    undefined
  )
  assert.equal(
    observedLocationAnswer(
      { ...location, label: "Are you willing to relocate to this location?" },
      "Hyderabad, India"
    ),
    undefined
  )
  const original = packet([{ ...location, options: [] }], {
    location: "Hyderabad, India",
  })
  assert.equal(
    mergeComputerFields(original, [location], "", 0).answers.location,
    "Hyderabad, Telangana, India"
  )
  const oldPlaceholder = packet(
    [{ ...location, label: "Location: Start typing...", options: [] }],
    { location: "Hyderabad, India" }
  )
  assert.equal(
    mergeComputerFields(oldPlaceholder, [location], "", 0).answers.location,
    "Hyderabad, Telangana, India"
  )
  assert.equal(
    mergeComputerFields(
      oldPlaceholder,
      [{ ...location, label: "Preferred location" }],
      "",
      0
    ).answers.location,
    undefined
  )
})
const profile = applicationProfileSchema.parse({
  enabled: true,
  confirmedAt: now.toISOString(),
  contact: {
    email: "applications@example.test",
    phone: "+49 1234567890",
    portfolio: "https://portfolio.example.test",
  },
  eligibility: [
    {
      country: "Germany",
      authorized: true,
      sponsorshipNow: false,
      sponsorshipFuture: true,
    },
    {
      country: "Canada",
      authorized: false,
      sponsorshipNow: true,
      sponsorshipFuture: true,
    },
  ],
  noticeDays: 14,
  earliestStart: "2026-11-20",
  willingToRelocate: true,
  willingToTravel: false,
  compensation: [
    {
      country: "Germany",
      minimum: 80000,
      maximum: 100000,
      singleAmount: 90000,
      currency: "EUR",
      period: "year",
      basis: "base",
    },
  ],
  generateWrittenAnswers: true,
  careerInterests: "I want to build reliable developer tools.",
})
const field = (
  label: string,
  overrides: Partial<ApplicationField> = {}
): ApplicationField => ({
  id: "question",
  label,
  help: "",
  kind: "text",
  required: true,
  options: [],
  ...overrides,
})
const packet = (
  fields: ApplicationField[],
  answers: ApplicationPacket["answers"] = {}
): ApplicationPacket => ({
  title: "Engineer",
  company: "Example",
  resume:
    "Built TypeScript APIs and reliable developer tools.\n\nOperated PostgreSQL services and automated tests.",
  fields,
  answers,
  tailored: true,
  notices: "",
  stepNotices: [""],
  formHash: "fixture",
})
function answer(
  label: string,
  overrides: Partial<ApplicationField> = {},
  country = "Germany",
  source = profile
) {
  return fillApplicationProfile(
    packet([field(label, overrides)]),
    source,
    country,
    now
  ).answers.question
}

test("old profiles remain valid, resume contacts are suggestions and missing data stays unspecified", () => {
  const old = {
    ...emptyCandidate,
    fullName: "QA Example",
    headline: "Engineer",
    resumeText:
      "An example resume with TypeScript, PostgreSQL and documented API projects. ".repeat(
        3
      ),
    skills: ["TypeScript"],
    targetRoles: ["Engineer"],
    targetCountries: ["Germany"],
  }
  assert.equal(candidateSchema.safeParse(old).success, true)
  assert.deepEqual(
    candidateSchema.parse({
      ...old,
      autoApply: { enabled: false, minScore: 90, dailyLimit: 2 },
    }).autoApply,
    { enabled: false, minScore: 90 }
  )
  assert.equal(
    candidateSchema.parse({ ...old, applicationProfile: profile })
      .applicationProfile?.eligibility[1].authorized,
    false
  )
  const extracted = applicationProfileFromResume(
    "Phone: +49 1234567890\nEmail: candidate@example.test\nhttp://linkedin.com/in/example"
  )
  assert.equal(extracted.contact.email, "candidate@example.test")
  assert.equal(extracted.contact.linkedin, "")
  assert.equal(extracted.enabled, true)
  assert.equal(extracted.confirmedAt, null)
  assert.deepEqual(extracted.eligibility, [])
  assert.equal(extracted.noticeDays, null)
})
test("confirmed name components answer separate employer fields with provenance and preserve edits", () => {
  const names = applicationProfileSchema.parse({
    enabled: true,
    confirmedAt: now.toISOString(),
    contact: { givenName: "Alex Morgan", familyName: "Rivera" },
  })
  const fields = [
    field("First name(s)", { id: "first" }),
    field("Last name (Surname)", { id: "last" }),
    field("Reference first name", {
      id: "reference",
      autocomplete: "given-name",
    }),
  ]
  const filled = fillApplicationProfile(packet(fields), names, "Germany", now)
  assert.deepEqual(filled.answers, { first: "Alex Morgan", last: "Rivera" })
  assert.match(
    filled.answerEvidence!.first.source,
    /Confirmed application profile/
  )
  assert.deepEqual(
    fillApplicationProfile(
      packet(fields, { first: "My edit", last: "" }),
      names,
      "Germany",
      now
    ).answers,
    { first: "My edit", last: "" }
  )
  assert.deepEqual(
    fillApplicationProfile(
      packet(fields),
      { ...names, confirmedAt: null },
      "Germany",
      now
    ).answers,
    {}
  )
})
test("Temporal preferred and legal name questions use distinct confirmed facts", () => {
  const names = applicationProfileSchema.parse({
    enabled: true,
    confirmedAt: now.toISOString(),
    contact: {
      preferredName: "Alex Rivera",
      givenName: "Alex Morgan",
      familyName: "Rivera",
    },
  })
  const labels = [
    "Preferred First & Last Name",
    "Legal First Name",
    "Legal Last Name",
    "Preferred Pronouns",
    "Name Pronunciation",
  ]
  const fields = labels.map((label, i) =>
    field(`${label} ${label}`, { id: String(i), required: i < 3 })
  )
  const filled = fillApplicationProfile(packet(fields), names, "Germany", now)
  assert.deepEqual(filled.answers, {
    0: "Alex Rivera",
    1: "Alex Morgan",
    2: "Rivera",
  })
  assert.deepEqual(
    fillApplicationIdentity(packet(fields), {
      fullName: "Alex Rivera",
      resumeText: "",
      email: "qa@example.test",
    }).answers,
    {}
  )
})

test("confirmation is server-timestamped and can be withdrawn", () => {
  const future = { ...profile, confirmedAt: "2099-01-01T00:00:00Z" }
  assert.equal(
    confirmApplicationProfile(future, undefined, now).confirmedAt,
    now.toISOString()
  )
  assert.equal(
    confirmApplicationProfile({ ...profile, confirmedAt: null }, profile, now)
      .confirmedAt,
    null
  )
  assert.equal(
    confirmApplicationProfile(
      { ...profile, noticeDays: 30, confirmedAt: null },
      profile,
      now
    ).confirmedAt,
    null
  )
  assert.equal(applicationProfileFresh(profile, now), true)
  assert.equal(applicationProfileFresh(profile, new Date("2027-02-01")), true)
  assert.equal(applicationProfileFresh(future, now), false)
  assert.equal(
    answer("Do you need sponsorship?", {}, "Germany", {
      ...profile,
      enabled: false,
    }),
    undefined
  )
})

test("eligibility is destination-scoped and separates sponsorship now from later", () => {
  const binary = { kind: "radio" as const, options: ["Yes", "No"] }
  assert.equal(
    answer("Are you legally authorized to work in Germany?", binary),
    "Yes"
  )
  assert.equal(
    answer("Are you legally authorized to work in Canada?", binary, "Canada"),
    "No"
  )
  assert.equal(answer("Do you require visa sponsorship?", binary), "No")
  assert.equal(
    answer("Will you need sponsorship in the future?", binary),
    "Yes"
  )
  assert.equal(
    answer("Will you require sponsorship now or in the future?", binary),
    "Yes"
  )
  assert.equal(
    answer("Will you require sponsorship at any point?", binary),
    "Yes"
  )
  assert.equal(
    answer("Do you require sponsorship?", binary, "Japan"),
    undefined
  )
  assert.equal(
    answer("Do you need sponsorship?", binary, "Germany", {
      ...profile,
      eligibility: [
        {
          country: "Germany",
          authorized: null,
          sponsorshipNow: null,
          sponsorshipFuture: null,
        },
      ],
    }),
    undefined
  )
})

test("negated, compound, conditional, foreign-country and consent questions stay unresolved", () => {
  for (const label of [
    "Are you NOT authorized to work?",
    "Do you require sponsorship if your permit expires?",
    "Do you require sponsorship and relocation assistance?",
    "Have you ever needed sponsorship?",
    "Do you have unrestricted authorization to work?",
    "Are you authorized to work and over 18?",
    "Are you authorized to work in Canada?",
    "Are you authorized to work in the US?",
    "Are you authorized to work anywhere in the EU?",
    "Will you be authorized to work at the start date?",
    "Have you received sponsorship before?",
    "I certify that I am authorized to work",
    "Do you agree to relocate?",
    "Do you have a criminal conviction?",
    "What is your gender?",
    "Are you a citizen?",
  ])
    assert.equal(
      answer(label, { kind: "radio", options: ["Yes", "No"] }),
      undefined,
      label
    )
  assert.equal(
    answer("Do you require sponsorship?", {
      kind: "radio",
      options: ["Yes, if needed", "No, I am a citizen"],
    }),
    undefined
  )
})

test("salary preserves currency, pay period and basis; numeric fields require an approved amount", () => {
  assert.equal(
    answer("What is your expected salary?"),
    "80000–100000 EUR per year (base salary)"
  )
  assert.equal(
    answer("Expected annual base salary (EUR)", { kind: "number" }),
    "90000"
  )
  for (const label of [
    "Expected salary",
    "Expected annual base salary (USD)",
    "Expected monthly base salary (EUR)",
    "Expected annual total compensation (EUR)",
    "Expected annual net base salary (EUR)",
  ])
    assert.equal(answer(label, { kind: "number" }), undefined, label)
  assert.equal(
    answer("Current annual base salary (EUR)", { kind: "number" }),
    undefined
  )
  const withoutSingle = {
    ...profile,
    compensation: [{ ...profile.compensation[0], singleAmount: null }],
  }
  assert.equal(
    answer(
      "Expected annual base salary (EUR)",
      { kind: "number" },
      "Germany",
      withoutSingle
    ),
    undefined
  )
  assert.equal(answer("Expected salary", {}, "Canada"), undefined)
  assert.equal(
    applicationProfileSchema.safeParse({
      ...profile,
      compensation: [{ ...profile.compensation[0], maximum: 70000 }],
    }).success,
    false
  )
  assert.equal(
    applicationProfileSchema.safeParse({
      ...profile,
      compensation: [{ ...profile.compensation[0], singleAmount: 200000 }],
    }).success,
    false
  )
})

test("availability uses both notice and earliest date, with no invented unit conversion", () => {
  assert.equal(answer("Notice period in days", { kind: "number" }), "14")
  assert.equal(answer("Notice period"), "14 days")
  assert.equal(answer("Notice period", { kind: "number" }), undefined)
  assert.equal(answer("Notice period in months", { kind: "number" }), undefined)
  assert.equal(answer("What is your earliest start date?"), "2026-11-20")
  assert.equal(
    answer("Can you start within 15 days?", {
      kind: "radio",
      options: ["Yes", "No"],
    }),
    "No"
  )
  assert.equal(
    answer("Can you start within 30 days?", {
      kind: "radio",
      options: ["Yes", "No"],
    }),
    "Yes"
  )
  assert.equal(answer("Are you willing to relocate?"), "Yes")
  assert.equal(answer("Are you willing to travel?"), "No")
  assert.equal(answer("Are you willing to travel 50% of the time?"), undefined)
  assert.equal(
    answer("Notice period", {}, "Germany", { ...profile, noticeDays: null }),
    undefined
  )
})

test("user edits, explicit blanks and saved answers take precedence; every new fill has evidence", () => {
  const fields = [
    field("Expected salary"),
    field("Email", { id: "email", kind: "email" }),
  ]
  for (const value of ["", "85000", []]) {
    const original = packet(fields, { question: value })
    const result = fillApplicationProfile(original, profile, "Germany", now)
    assert.deepEqual(result.answers.question, value)
    assert.equal(result.answers.email, "applications@example.test")
    assert.ok(result.answerEvidence?.email.source.includes("email"))
    assert.deepEqual(original.answers, { question: value })
  }
  const initial = packet([
    field("Do you require sponsorship?", {
      kind: "radio",
      options: ["Yes", "No"],
    }),
  ])
  const remembered = applyRememberedAnswers(initial, [
    {
      id: "remembered",
      question: initial.fields[0],
      answer: "Yes",
      reuse_scope: "all",
      country: "Germany",
      company: "Example",
      source_application_id: null,
      last_seen_at: now.toISOString(),
    },
  ])
  assert.equal(
    fillApplicationProfile(remembered, profile, "Germany", now).answers
      .question,
    "Yes"
  )
  assert.equal(
    fillApplicationIdentity(packet(fields, { email: "" }), {
      fullName: "QA Example",
      resumeText: "Email: old@example.test",
      email: "account@example.test",
    }).answers.email,
    ""
  )
})

test("explicit employer ask-again choices suppress profile reuse, and manager contact fields stay blank", () => {
  const initial = packet([
    field("Do you require sponsorship?", {
      kind: "radio",
      options: ["Yes", "No"],
    }),
  ])
  const optedOut = applyRememberedAnswers(initial, [
    {
      id: "opted-out",
      question: initial.fields[0],
      answer: "Yes",
      reuse_scope: "never",
      reuse_explicit: true,
      country: "Germany",
      company: "Example",
      source_application_id: null,
      last_seen_at: now.toISOString(),
    },
  ])
  assert.equal(
    fillApplicationProfile(optedOut, profile, "Germany", now).answers.question,
    undefined
  )
  assert.equal(
    answer("Email", { kind: "email", help: "Your manager's email address" }),
    undefined
  )
})

test("confirmed profiles keep answering without a 90-day expiry", () => {
  const old = { ...profile, confirmedAt: "2026-01-01T00:00:00Z" }
  assert.equal(
    answer("Email", { kind: "email" }, "Germany", old),
    "applications@example.test"
  )
  assert.notEqual(answer("Expected salary", {}, "Germany", old), undefined)
})

test("new conditional form pages use the frozen profile and invalidate changed question meanings", () => {
  const snapshot = { ...profile, confirmedAt: new Date().toISOString() }
  const initial = {
    ...packet([field("Email", { id: "email", kind: "email" })], {
      email: "edited@example.test",
    }),
    applicationContext: {
      profile: snapshot,
      country: "Germany",
      jobDescription: "Build developer tools.",
    },
  }
  for (const merge of [
    (fields: ApplicationField[]) => mergeComputerFields(initial, fields, "", 1),
    (fields: ApplicationField[]) =>
      mergeFormStep(initial, { fields, notices: "" }, 1),
  ]) {
    const fields = [
      field("Will you need sponsorship in the future?", {
        id: "late",
        step: 1,
        kind: "radio",
        options: ["Yes", "No"],
      }),
    ]
    const result = fillApplicationProfile(merge(fields), snapshot, "Germany")
    assert.equal(result.answers.late, "Yes")
    assert.equal(result.answers.email, "edited@example.test")
    assert.ok(result.answerEvidence?.late.source.includes("future sponsorship"))
  }
  const old = mergeComputerFields(
    initial,
    [
      field("Will you need sponsorship in the future?", {
        id: "late",
        step: 1,
        kind: "radio",
        options: ["Yes", "No"],
      }),
    ],
    "",
    1
  )
  const changed = mergeComputerFields(
    old,
    [
      field("Will you NOT need sponsorship in the future?", {
        id: "late",
        step: 1,
        kind: "radio",
        options: ["Yes", "No"],
      }),
    ],
    "",
    1
  )
  assert.equal(changed.answers.late, undefined)
  assert.equal(missingAnswers(changed).length, 1)
  assert.ok(packetSchema.safeParse(old).success)
})

test("confirmed residence maps country labels and options without inferring legal or destination facts", () => {
  const source = applicationProfileSchema.parse({
    ...profile,
    contact: { ...profile.contact, location: "Hyderabad, India" },
  })
  for (const label of [
    "Country",
    "Country of residence",
    "Current country",
    "Select country",
    "Which country do you live in?",
  ]) {
    assert.equal(
      answer(
        label,
        { kind: "select", options: ["Germany", "IN"] },
        "Germany",
        source
      ),
      "IN"
    )
    assert.equal(
      answer(label, { kind: "combobox", options: [] }, "Germany", source),
      "India"
    )
  }
  assert.equal(
    answer("Country", { autocomplete: "country" }, "Germany", source),
    "IN"
  )
  assert.equal(
    answer(
      "Country",
      { kind: "select", options: ["India", "IN"] },
      "Germany",
      source
    ),
    undefined
  )
  assert.equal(
    answer(
      "Country",
      { kind: "select", options: ["Germany"] },
      "Germany",
      source
    ),
    undefined
  )
  assert.equal(answer("Location", {}, "Germany", source), "Hyderabad, India")
  assert.equal(
    answer(
      "Where are you based?",
      { kind: "combobox", options: ["Hyderabad, Telangana, India"] },
      "Germany",
      source
    ),
    "Hyderabad, Telangana, India"
  )
  for (const label of [
    "Country of citizenship",
    "Country of birth",
    "Preferred country",
    "Country code",
    "Employer country",
  ]) {
    assert.equal(answer(label, {}, "Germany", source), undefined)
  }
  assert.equal(
    answer("Country", { help: "Select your nationality" }, "Germany", source),
    undefined
  )
  for (const location of ["", "Hyderabad"]) {
    assert.equal(
      answer("Country", {}, "Germany", {
        ...source,
        contact: { ...source.contact, location },
      }),
      undefined
    )
  }
  const countryPacket = packet([field("Country")], { question: "" })
  assert.equal(
    fillApplicationProfile(countryPacket, source, "Germany").answers.question,
    ""
  )
  assert.equal(
    fillApplicationProfile(
      { ...countryPacket, answers: {}, answerReuseBlocked: ["question"] },
      source,
      "Germany"
    ).answers.question,
    undefined
  )
  assert.equal(
    answer("Country", {}, "Germany", { ...source, confirmedAt: null }),
    undefined
  )
})
