import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { randomUUID, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { chromium } from "playwright-core"
import { assertStagingTarget } from "../lib/staging.mjs"

// Generated accounts, generated resume and the staging receiver only. No email
// and no employer submission. Account deletion cascades every QA record.
const env = parseEnv(await readFile(".env.staging.local", "utf8"))
const config = JSON.parse(await readFile("staging/project.json", "utf8"))
assertStagingTarget(config, env)
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const accounts = []
let browser
const checks = []
const resume =
  "Test Candidate\nGenerated fictional QA resume. TypeScript engineer at Example Test Company. Built SQL APIs, tests and reliable services. No real applicant is represented."
async function account() {
  const email = `generated-question-qa-${Date.now()}-${randomBytes(4).toString("hex")}@example.invalid`,
    password = randomBytes(32).toString("base64url")
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { staging_qa: true, synthetic_only: true },
  })
  assert.ifError(created.error)
  accounts.push(created.data.user.id)
  assert.ifError(
    (
      await admin.from("account_profiles").insert({
        user_id: created.data.user.id,
        data: {
          fullName: "Test Candidate",
          headline: "Generated QA engineer",
          resumeText: resume,
          targetRoles: ["Engineer"],
          skills: ["TypeScript"],
          currentLocation: null,
          experienceYears: null,
          workModes: ["remote"],
          sponsorshipRequired: null,
          excludedCompanies: [],
        },
      })
    ).error
  )
  const jar = new Map()
  const db = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (values) =>
          values.forEach(({ name, value }) => jar.set(name, value)),
      },
    }
  )
  assert.ifError((await db.auth.signInWithPassword({ email, password })).error)
  return {
    id: created.data.user.id,
    email,
    jar,
    request: async (path, method = "GET", body) => {
      const response = await fetch(config.appUrl + path, {
        method,
        headers: {
          Origin: config.appUrl,
          Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45000),
      })
      return { status: response.status, data: await response.json() }
    },
  }
}
function packet(email) {
  return {
    title: "Generated QA engineer",
    company: "Synthetic staging employer",
    engine: "computer-v1",
    resume,
    notices: "Generated staging fixture",
    stepNotices: ["Generated staging fixture"],
    formHash: "generated-question-qa",
    tailored: true,
    fields: [
      {
        id: "_systemfield_name",
        label: "Full name",
        help: "",
        kind: "text",
        required: true,
        options: [],
        step: 0,
      },
      {
        id: "_systemfield_email",
        label: "Email",
        help: "",
        kind: "email",
        required: true,
        options: [],
        step: 0,
      },
      {
        id: "_systemfield_resume",
        label: "Resume",
        help: "",
        kind: "resume",
        required: true,
        options: [],
        step: 0,
      },
      {
        id: "authorization",
        label: "Do you have the required work authorization?",
        help: "",
        kind: "radio",
        required: true,
        options: ["Yes", "No"],
        step: 0,
      },
      {
        id: "motivation",
        label: "Why this role?",
        help: "",
        kind: "textarea",
        required: true,
        options: [],
        step: 0,
      },
      {
        id: "future-contact",
        label: "Optional future contact",
        help: "",
        kind: "checkbox",
        required: false,
        options: ["I agree"],
        step: 0,
      },
    ],
    answers: { _systemfield_name: "Test Candidate", _systemfield_email: email },
  }
}
async function seed(user) {
  const id = randomUUID(),
    token = randomUUID()
  assert.ifError(
    (
      await admin.from("application_runs").insert({
        id,
        user_id: user.id,
        target_url: `${config.appUrl}/application-test/${token}`,
        employer_key: "synthetic-question-employer",
        status: "ready",
        automatic: true,
        packet: packet(user.email),
      })
    ).error
  )
  assert.ifError(
    (
      await admin
        .from("application_test_receipts")
        .insert({ token, application_id: id })
    ).error
  )
  return { id, token }
}
async function app(user, id) {
  const result = await user.request(`/api/applications/${id}`)
  assert.equal(result.status, 200)
  return result.data.application
}
async function verify() {
  const alice = await account(),
    bob = await account(),
    first = await seed(alice)
  const alerts = await alice.request("/api/application-questions/alerts")
  assert.equal(alerts.status, 200)
  assert.equal(
    alerts.data.alerts.find((a) => a.applicationId === first.id).questions
      .length,
    2
  )
  assert.deepEqual(
    (await bob.request("/api/application-questions/alerts")).data.alerts,
    []
  )
  let library = (await alice.request("/api/application-questions")).data
    .questions
  assert.equal(library.length, 3)
  assert.ok(library.every((q) => q.answer === null))
  const known = library.find((q) => q.question.id === "authorization")
  assert.ok(known)
  checks.push("persistent owner-only alerts and new-question history")
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  await context.addCookies(
    [...alice.jar].map(([name, value]) => ({
      name,
      value,
      url: config.appUrl,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }))
  )
  const page = await context.newPage()
  await page.goto(`${config.appUrl}/applications/${first.id}`)
  await page
    .locator('section[aria-label="Applications need answers"]')
    .getByText(/2|your answers/)
    .first()
    .waitFor()
  await page.screenshot({
    path: ".local-data/application-questions-notification.png",
    fullPage: true,
  })
  await page
    .getByRole("combobox", {
      name: /^Do you have the required work authorization/,
    })
    .selectOption("No")
  await page
    .getByRole("textbox", { name: /^Why this role/ })
    .fill(
      "Generated fictional QA answer for the first role. Not a real application."
    )
  await page
    .getByRole("combobox", {
      name: "Reuse answer: Do you have the required work authorization?",
    })
    .selectOption("employer")
  assert.equal(
    await page
      .getByRole("combobox", { name: "Reuse answer: Why this role?" })
      .inputValue(),
    "all"
  )
  await page
    .getByRole("combobox", { name: "Reuse answer: Why this role?" })
    .selectOption("never")
  await page.getByRole("button", { name: "Save answers", exact: true }).click()
  await page.waitForFunction(
    () => !document.body.textContent.includes("Unsaved changes")
  )
  const saved = await app(alice, first.id)
  assert.equal(saved.revision, 2)
  library = (await alice.request("/api/application-questions")).data.questions
  assert.equal(library.find((q) => q.id === known.id).reuse_scope, "employer")
  assert.equal(library.find((q) => q.id === known.id).answer, "No")
  assert.equal(
    library.find((q) => q.question.id === "motivation").reuse_scope,
    "never"
  )
  assert.equal(
    (await alice.request("/api/application-questions/alerts")).data.alerts
      .length,
    0
  )
  assert.equal(
    (
      await alice.request(`/api/applications/${first.id}`, "PATCH", {
        revision: 1,
        answers: { ...saved.packet.answers, authorization: "Yes" },
        resume,
        remember: { authorization: "all" },
      })
    ).status,
    409
  )
  assert.equal(
    (
      await bob.request(`/api/application-questions/${known.id}`, "PATCH", {
        answer: "Yes",
        scope: "all",
      })
    ).status,
    404
  )
  assert.equal(
    (await bob.request(`/api/application-questions/${known.id}`, "DELETE"))
      .status,
    404
  )
  checks.push(
    "UI saves answers and employer reuse atomically; stale and cross-account edits denied"
  )
  await page.goto(`${config.appUrl}/applications/questions`)
  await page
    .getByRole("heading", { name: "Saved application answers" })
    .waitFor()
  await page
    .getByRole("heading", {
      name: "Do you have the required work authorization?",
      exact: true,
    })
    .waitFor()
  await page.screenshot({
    path: ".local-data/application-questions-library.png",
    fullPage: true,
  })
  const second = await seed(alice)
  await page.goto(`${config.appUrl}/applications/${second.id}`)
  await page
    .getByRole("button", { name: "Fill saved answers and resume details" })
    .click()
  await page.waitForFunction(
    () =>
      document.querySelector('select[id="answer-authorization"]')?.value ===
      "No"
  )
  let next = await app(alice, second.id)
  assert.equal(next.packet.answers.authorization, "No")
  assert.equal(
    await page
      .getByRole("combobox", {
        name: "Reuse answer: Do you have the required work authorization?",
      })
      .inputValue(),
    "employer"
  )
  assert.equal(next.packet.answers.motivation, undefined)
  const remaining = (
    await alice.request("/api/application-questions/alerts")
  ).data.alerts.find((a) => a.applicationId === second.id)
  assert.equal(remaining.questions.length, 1)
  assert.equal(remaining.questions[0].id, "motivation")
  checks.push(
    "new application reuses only opted-in answer and not the role-specific answer"
  )
  await page
    .getByRole("textbox", { name: /^Why this role/ })
    .fill(
      "Generated fictional QA answer for this second role. No employer is contacted by this test."
    )
  await page
    .getByRole("button", { name: "Continue application", exact: true })
    .click()
  for (let i = 0; i < 150; i++) {
    next = await app(alice, second.id)
    console.log(JSON.stringify({ state: next.status }))
    if (
      ["submitted", "needs_attention", "submission_unknown"].includes(
        next.status
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  assert.equal(next.status, "submitted", next.message)
  const received = await admin
    .from("application_test_receipts")
    .select("submissions")
    .eq("token", second.token)
    .single()
  assert.ifError(received.error)
  assert.equal(received.data.submissions, 1)
  assert.equal(
    (await alice.request("/api/application-questions/alerts")).data.alerts
      .length,
    0
  )
  checks.push(
    "actual Browserbase/Browser Use/model fill, approved PDF and answers, exactly one synthetic receipt"
  )
  assert.equal(
    (await alice.request(`/api/application-questions/${known.id}`, "DELETE"))
      .status,
    200
  )
  assert.equal((await app(alice, second.id)).packet.answers.authorization, "No")
  assert.ok(
    !(await alice.request("/api/application-questions")).data.questions.some(
      (q) => q.id === known.id
    )
  )
  checks.push(
    "forgetting an answer stops reuse without rewriting application history"
  )
  const receipt = {
    passed: true,
    syntheticOnly: true,
    employerSubmissions: 0,
    checks,
    checkedAt: new Date().toISOString(),
  }
  await writeFile(
    ".local-data/application-questions-verification.json",
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 }
  )
  console.log(JSON.stringify(receipt))
}
try {
  await verify()
} finally {
  await browser?.close()
  for (const id of accounts)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error)
  console.log(JSON.stringify({ generatedAccountsDeleted: accounts.length }))
}
