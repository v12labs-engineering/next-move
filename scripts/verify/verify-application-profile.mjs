import assert from "node:assert/strict"
import { readFile, mkdir } from "node:fs/promises"
import { parseEnv } from "node:util"
import { randomBytes, randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { chromium } from "playwright-core"
import { assertStagingTarget } from "../lib/staging.mjs"

// Run against a local build configured with the isolated staging credentials.
// AI extraction alone is stubbed; profile/application APIs and storage are real.
// All accounts and listings are generated and removed. No email or employer send.
const origin =
  process.argv.find((arg) => arg.startsWith("--origin="))?.slice(9) ||
  "http://localhost:3018"
assert.ok(
  /^http:\/\/localhost:\d+$/.test(origin),
  "This verifier requires a local server"
)
const env = parseEnv(await readFile(".env.staging.local", "utf8"))
const config = JSON.parse(await readFile("staging/project.json", "utf8"))
assertStagingTarget(config, env)
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const users = [],
  jobs = []
let browser
const resume =
  "Generated QA Candidate\n\nFictional engineer at Example Test Company. Built TypeScript APIs, PostgreSQL services and automated tests for a synthetic developer tools project. This is not a real applicant.\n\nEmail: source@example.invalid"
const candidate = {
  fullName: "Generated QA Candidate",
  headline: "Synthetic engineer",
  currentLocation: null,
  targetRoles: ["Engineer"],
  skills: ["TypeScript"],
  experienceYears: null,
  targetCountries: [],
  targetLocations: [],
  workModes: ["remote"],
  sponsorshipRequired: null,
  excludedCompanies: [],
  resumeText: resume,
}
async function account() {
  const email = `generated-profile-qa-${randomBytes(8).toString("hex")}@example.invalid`,
    password = randomBytes(32).toString("base64url")
  const result = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { staging_qa: true, synthetic_only: true },
  })
  assert.ifError(result.error)
  users.push(result.data.user.id)
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
  return { id: result.data.user.id, jar, db }
}
async function request(user, path, method = "GET", body, version) {
  console.log(`Checking ${method} ${path}`)
  const response = await fetch(origin + path, {
    method,
    headers: {
      Cookie: [...user.jar].map(([key, value]) => `${key}=${value}`).join("; "),
      Origin: origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(version === undefined ? {} : { "If-Match": String(version) }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  })
  const data = await response.json()
  console.log(`Checked ${method} ${path}: ${response.status}`)
  return { status: response.status, data }
}
function employerPacket(label) {
  return {
    title: "Synthetic engineer",
    company: "Generated profile QA employer",
    resume,
    fields: [
      {
        id: "question",
        label,
        help: "",
        kind: "text",
        required: true,
        options: [],
      },
    ],
    answers: {},
    notices: "Generated fixture only",
    formHash: randomUUID(),
    tailored: true,
  }
}
const checks = []
try {
  const alice = await account(),
    bob = await account()
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  })
  const context = await browser.newContext({
    viewport: { width: 1365, height: 1000 },
  })
  context.setDefaultNavigationTimeout(90000)
  await context.addCookies(
    [...alice.jar].map(([name, value]) => ({
      name,
      value,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }))
  )
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/profile/analyze", (route) =>
    route.fulfill({ json: { ok: true, candidate } })
  )
  await page.goto(origin + "/onboarding", { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Resume text", { exact: true }).fill(resume)
  await page
    .getByRole("button", { name: "Build my profile", exact: true })
    .click()
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.getByLabel("Add a destination country").click()
  await page
    .getByRole("combobox", { name: "Search countries" })
    .fill("Mongolia")
  await page.getByRole("combobox", { name: "Search countries" }).press("Enter")
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page
    .getByRole("switch", { name: /Answer application questions for me/ })
    .click()
  assert.equal(
    await page.getByLabel("Application email", { exact: true }).inputValue(),
    "source@example.invalid"
  )
  await page
    .getByLabel("Application email", { exact: true })
    .fill("applications@example.invalid")
  await page
    .getByLabel("Notice period in calendar days", { exact: true })
    .fill("14")
  await page
    .getByLabel("Currently authorized to work in Mongolia?", { exact: true })
    .selectOption("true")
  await page
    .getByLabel("Need sponsorship now?", { exact: true })
    .selectOption("false")
  await page
    .getByLabel("Need sponsorship in the future?", { exact: true })
    .selectOption("true")
  await page
    .getByText("Salary expectations (optional)", { exact: true })
    .click()
  await page
    .getByLabel("Expected range: minimum", { exact: true })
    .fill("80000")
  await page
    .getByLabel("Expected range: maximum", { exact: true })
    .fill("100000")
  await page.getByLabel("Currency", { exact: true }).selectOption("MNT")
  await page
    .getByLabel("What do you want from your next role? (optional)", {
      exact: true,
    })
    .fill("I want to build reliable developer tools.")
  await page.getByLabel(/I confirm these details are current/).check()
  await mkdir(".local-data", { recursive: true })
  await page.screenshot({
    path: ".local-data/application-profile-desktop.png",
    fullPage: true,
  })
  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/profile") &&
      response.request().method() === "PUT"
  )
  await page
    .getByRole("button", { name: "Confirm and find matches", exact: true })
    .click()
  assert.equal((await saveResponse).status(), 200)
  const saved = await request(alice, "/api/profile")
  assert.equal(saved.status, 200)
  const restored = saved.data.profile.candidate
  assert.equal(
    restored.applicationProfile.contact.email,
    "applications@example.invalid"
  )
  assert.equal(restored.applicationProfile.compensation[0].currency, "MNT")
  assert.equal(
    restored.applicationProfile.eligibility[0].sponsorshipFuture,
    true
  )
  assert.ok(restored.applicationProfile.confirmedAt)
  assert.equal(
    (await request(alice, "/api/profile", "PUT", restored, 0)).status,
    409
  )
  checks.push(
    "four-step onboarding, prefilled contacts, global currency selection, persisted profile and stale-save rejection"
  )
  await page.goto(origin + "/preferences#application-profile-section", {
    waitUntil: "domcontentloaded",
  })
  await page.waitForLoadState("networkidle")
  assert.equal(
    await page.getByLabel("Application email", { exact: true }).inputValue(),
    "applications@example.invalid"
  )
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    true
  )
  await page.screenshot({
    path: ".local-data/application-profile-mobile.png",
    fullPage: true,
  })
  checks.push("profile reload and mobile layout without horizontal overflow")
  assert.equal((await request(bob, "/api/profile")).data.profile, null)
  const bobCandidate = { ...restored, fullName: "Generated Other QA" }
  assert.equal(
    (await request(bob, "/api/profile", "PUT", bobCandidate, 0)).status,
    200
  )
  const jobIds = Array.from(
    { length: 4 },
    () => `generated-profile-qa:${randomUUID()}`
  )
  const inserted = await admin.from("job_catalog").insert(
    jobIds.map((jobId) => ({
      id: jobId,
      title: "Synthetic engineer",
      company: "Generated profile QA employer",
      country: "Mongolia",
      source: "generated-profile-qa",
      url: "https://synthetic-employer.example.invalid/job",
      is_active: false,
    }))
  )
  assert.ifError(inserted.error)
  jobs.push(...jobIds)
  const rows = [
    { user_id: alice.id, label: "Do you require sponsorship?" },
    { user_id: alice.id, label: "Notice period in days" },
    { user_id: alice.id, label: "I certify the accuracy of this application" },
    { user_id: alice.id, label: "Email" },
    { user_id: bob.id, label: "Notice period in days" },
  ].map((entry, index) => ({
    id: randomUUID(),
    user_id: entry.user_id,
    job_id: jobIds[index % jobIds.length],
    target_url: `https://synthetic-employer.example.invalid/${randomUUID()}`,
    status: "ready",
    automatic: false,
    packet: employerPacket(entry.label),
  }))
  assert.ifError((await admin.from("application_runs").insert(rows)).error)
  const autofilled = await request(
    alice,
    `/api/applications/${rows[3].id}`,
    "POST",
    { action: "autofill", revision: 1, answers: {}, resume, remember: {} }
  )
  assert.equal(autofilled.status, 200)
  assert.equal(autofilled.data.revision, 2)
  const learned = await alice.db
    .from("account_application_questions")
    .select("answer,question")
    .eq("source_application_id", rows[3].id)
  assert.ifError(learned.error)
  assert.equal(
    learned.data.find((row) => row.question.label === "Email").answer,
    null,
    "New automatic fills must not teach answer memory before candidate review"
  )
  const batch = await request(alice, "/api/applications/fill-profile", "POST", {
    continueAutomatic: true,
  })
  assert.equal(batch.status, 200)
  assert.equal(batch.data.updated, 3)
  assert.equal(batch.data.queued, 0)
  assert.equal(batch.data.skipped, 0)
  const actual = await admin
    .from("application_runs")
    .select("id,status,packet,revision")
    .in(
      "id",
      rows.map((row) => row.id)
    )
  assert.ifError(actual.error)
  const byId = new Map(actual.data.map((row) => [row.id, row]))
  assert.equal(byId.get(rows[0].id).packet.answers.question, "No")
  assert.equal(byId.get(rows[1].id).packet.answers.question, "14 days")
  assert.equal(byId.get(rows[0].id).revision, 2)
  assert.ok(
    byId
      .get(rows[0].id)
      .packet.answerEvidence.question.source.includes("Mongolia")
  )
  assert.deepEqual(byId.get(rows[2].id).packet.answers, {})
  assert.equal(byId.get(rows[2].id).revision, 2)
  assert.equal(
    byId.get(rows[2].id).packet.applicationContext.profile.contact.email,
    "applications@example.invalid",
    "Unanswered declarations must still retain the updated profile for later form pages"
  )
  const repeat = await request(
    alice,
    "/api/applications/fill-profile",
    "POST",
    { continueAutomatic: false }
  )
  assert.equal(
    repeat.data.updated,
    0,
    "Identical profile refill must not churn packet revisions"
  )
  assert.equal(
    byId.get(rows[3].id).packet.answers.question,
    "applications@example.invalid"
  )
  assert.deepEqual(byId.get(rows[4].id).packet.answers, {})
  assert.ok(actual.data.every((row) => row.status === "ready"))
  const alerts = await request(alice, "/api/application-questions/alerts")
  assert.equal(alerts.data.alerts.length, 1)
  assert.equal(alerts.data.alerts[0].applicationId, rows[2].id)
  assert.equal(
    (await request(bob, `/api/applications/${rows[0].id}`)).status,
    404
  )
  await page.setViewportSize({ width: 1365, height: 1000 })
  await page.goto(origin + `/applications/${rows[0].id}`, {
    waitUntil: "domcontentloaded",
  })
  await page.waitForLoadState("networkidle")
  await page.getByText("How this answer was filled", { exact: true }).click()
  assert.ok(
    await page.getByText(/Confirmed application profile · Mongolia/).count()
  )
  // A backlog larger than one page must not hide older waiting applications.
  const activity = Array.from({ length: 55 }, (_, index) => ({
    id: randomUUID(),
    user_id: alice.id,
    status: "cancelled",
    automatic: false,
    target_url: `https://synthetic-employer.example.invalid/activity-${randomUUID()}`,
    packet: {
      ...employerPacket("Generated activity"),
      title: `Generated activity ${index}`,
    },
  }))
  assert.ifError((await admin.from("application_runs").insert(activity)).error)
  const firstPage = await request(alice, "/api/applications?limit=50")
  assert.equal(firstPage.status, 200)
  assert.equal(firstPage.data.applications.length, 50)
  assert.equal(firstPage.data.total, 59)
  assert.equal(firstPage.data.counts.needs, 4)
  const secondPage = await request(
    alice,
    "/api/applications?limit=50&offset=50"
  )
  assert.equal(secondPage.data.applications.length, 9)
  assert.equal(
    new Set(
      [...firstPage.data.applications, ...secondPage.data.applications].map(
        (row) => row.id
      )
    ).size,
    59
  )
  const needs = await request(alice, "/api/applications?filter=needs")
  assert.equal(needs.data.total, 4)
  assert.ok(needs.data.applications.some((row) => row.id === rows[2].id))
  assert.equal((await request(bob, "/api/applications")).data.total, 1)
  await page.goto(origin + "/applications", { waitUntil: "domcontentloaded" })
  await page
    .getByRole("button", { name: "Next applications", exact: true })
    .click()
  await page.locator(`a[href="/applications/${rows[0].id}"]`).waitFor()
  await page
    .getByRole("group", { name: "Application status", exact: true })
    .getByRole("button", { name: /Needs you/ })
    .click()
  await page.locator(`a[href="/applications/${rows[2].id}"]`).waitFor()
  assert.ifError(
    (
      await admin
        .from("application_runs")
        .update({ status: "cancelled" })
        .eq("id", rows[2].id)
    ).error
  )
  await page
    .locator(`a[href="/applications/${rows[2].id}"]`)
    .waitFor({ state: "hidden", timeout: 20000 })
  const newRun = {
    ...activity[0],
    id: randomUUID(),
    status: "ready",
    target_url: `https://synthetic-employer.example.invalid/live-${randomUUID()}`,
  }
  assert.ifError((await admin.from("application_runs").insert(newRun)).error)
  await page
    .locator(`a[href="/applications/${newRun.id}"]`)
    .waitFor({ timeout: 20000 })
  checks.push(
    "complete activity counts, server-side Needs you filter, pagination beyond 50, cross-account totals and live additions/status changes without reload"
  )
  assert.deepEqual(errors, [])
  checks.push(
    "bulk fill, source evidence, revision increment, resolved alerts, unresolved declarations, manual-send protection, account isolation and unreviewed-fill memory protection"
  )
  console.log(
    JSON.stringify(
      {
        checks,
        aiExtraction: "stubbed",
        profileAndApplicationStorage: "isolated staging",
        submissions: 0,
        screenshots: [
          ".local-data/application-profile-desktop.png",
          ".local-data/application-profile-mobile.png",
        ],
      },
      null,
      2
    )
  )
} finally {
  await browser?.close()
  for (const id of users) {
    const result = await admin.auth.admin.deleteUser(id)
    if (result.error) throw new Error("Generated QA account cleanup failed")
  }
  for (const id of jobs) {
    const result = await admin.from("job_catalog").delete().eq("id", id)
    if (result.error) throw new Error("Generated QA listing cleanup failed")
  }
}
