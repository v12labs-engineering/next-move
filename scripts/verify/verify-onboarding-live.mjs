// Live, synthetic-only onboarding and auto-apply verification. Never targets a real employer.
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { randomUUID, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { chromium } from "playwright-core"
import { assertStagingTarget } from "../lib/staging.mjs"
const env = parseEnv(await readFile(".env.staging.local", "utf8"))
const config = JSON.parse(await readFile("staging/project.json", "utf8"))
assertStagingTarget(config, env)
const origin = config.appUrl,
  country = "Antarctica"
const expectedDeployment = process.argv
  .find((arg) => arg.startsWith("--deployment="))
  ?.slice(13)
assert.ok(
  expectedDeployment?.startsWith("dpl_"),
  "Pass --deployment=dpl_... for the live release being verified"
)
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const report = {
  origin,
  syntheticOnly: true,
  realEmployerSubmissions: 0,
  checks: [],
  deployment: expectedDeployment,
  startedAt: new Date().toISOString(),
}
const checkpoint = async (label, details = {}) => {
  report.checks.push({ label, ...details })
  await writeFile(
    ".local-data/live-onboarding-evidence.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 }
  )
  console.log(JSON.stringify({ label, ...details }))
}
const must = (r) => {
  assert.ifError(r.error)
  return r.data
}
const count = await admin
  .from("job_catalog")
  .select("id", { count: "exact", head: true })
  .eq("country", country)
  .eq("is_active", true)
must(count)
assert.equal(count.count, 0)
const email = `generated-onboarding-qa-${Date.now()}@example.invalid`,
  password = randomBytes(32).toString("base64url")
let user, browser
const jobs = []
const jar = new Map()
const db = createServerClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (items) => items.forEach((x) => jar.set(x.name, x.value)),
    },
  }
)
const request = async (path, method = "GET", body) => {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  })
  const data = await response.json()
  assert.ok(
    response.ok,
    `${method} ${path}: ${response.status} ${JSON.stringify(data)}`
  )
  return data
}
const resume = `Alex Example\nBackend Engineer\nBerlin, Germany\nEmail: resume-only@example.invalid\n\nBackend Engineer | Synthetic Example Systems | 2020–Present\nBuilt TypeScript backend APIs with PostgreSQL and SQL. Wrote automated tests and maintained reliable services.\n\nBSc Computer Science | Synthetic Example University | 2016–2020\n\nProject Atlas: TypeScript monitoring tools and SQL database services.\nThis is a generated fictional QA resume for a controlled test. No real applicant is represented.`
try {
  user = must(
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { staging_qa: true, synthetic_only: true },
    })
  ).user
  must(await db.auth.signInWithPassword({ email, password }))
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({
    viewport: { width: 1365, height: 980 },
  })
  context.setDefaultTimeout(90000)
  await context.addCookies(
    [...jar].map(([name, value]) => ({
      name,
      value,
      url: origin,
      secure: true,
      sameSite: "Lax",
    }))
  )
  const page = await context.newPage(),
    errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(origin + "/onboarding", { waitUntil: "networkidle" })
  console.log("Onboarding loaded")
  page.on("request", (r) => {
    if (r.url().includes("/api/profile"))
      console.log(r.method() + " " + new URL(r.url()).pathname)
  })
  page.on("response", (r) => {
    if (r.url().includes("/api/profile"))
      console.log("Response " + r.status() + " " + new URL(r.url()).pathname)
  })
  assert.ok((await page.content()).includes(expectedDeployment))
  await page.getByLabel("Resume text", { exact: true }).fill(resume)
  await page.screenshot({
    path: ".local-data/live-onboarding-before-analysis.png",
    fullPage: true,
  })
  const [analyzed] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/profile/analyze") &&
        r.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Build my profile", exact: true }).click(),
  ])
  assert.equal(analyzed.status(), 200, await analyzed.text())
  await page.getByRole("heading", { name: "Here’s what we found" }).waitFor()
  const skills = page.getByLabel("Skills, separated by commas")
  if ((await skills.isVisible()) && !(await skills.inputValue()).trim()) {
    await skills.fill("TypeScript, PostgreSQL, SQL")
    await checkpoint(
      "Review requested missing extracted skills; entered facts from the resume"
    )
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.getByLabel("Add a destination country").click()
  await page.getByRole("combobox", { name: "Search countries" }).fill(country)
  await page.getByRole("combobox", { name: "Search countries" }).press("Enter")
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page
    .getByRole("heading", { name: "Answer once, apply more smoothly" })
    .waitFor()
  await checkpoint(
    "Live resume analysis and five-step onboarding reached Answers"
  )
  for (const [id, value] of Object.entries({
    "application-preferredName": "Alex QA Example",
    "application-givenName": "Alexander",
    "application-familyName": "Example",
    "application-location": "Berlin, Germany",
    "application-email": email,
    "application-phone": "+49 151 00000000",
    "application-linkedin":
      "https://www.linkedin.com/in/generated-onboarding-qa",
    "application-portfolio": "https://example.com/generated-qa",
    "application-notice": "21",
    "application-start": "2027-01-15",
    "application-pay-0-minimum": "80000",
    "application-pay-0-maximum": "100000",
    "application-pay-0-singleAmount": "90000",
    "application-interests":
      "I want to build reliable TypeScript developer tools and improve API reliability.",
  }))
    await page.locator("#" + id).fill(value)
  async function select(id, name) {
    await page.locator("#" + id).click()
    await page.getByRole("option", { name, exact: true }).click()
  }
  await select("application-relocation", "Yes")
  await select("application-travel", "No")
  await select("application-authorized-0", "Yes")
  await select("application-sponsor-now-0", "No")
  await select("application-sponsor-future-0", "Yes")
  await select("application-currency-0", "EUR")
  await page.screenshot({
    path: ".local-data/live-onboarding-answers.png",
    fullPage: true,
  })
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  assert.equal(
    await page.locator("#auto-apply").getAttribute("aria-checked"),
    "true"
  )
  const [savedResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/profile") && r.request().method() === "PUT"
    ),
    page
      .getByRole("button", {
        name: "Confirm and start auto-apply",
        exact: true,
      })
      .click(),
  ])
  assert.equal(savedResponse.status(), 200, await savedResponse.text())
  const saved = (await request("/api/profile")).profile.candidate,
    p = saved.applicationProfile
  assert.deepEqual(saved.autoApply, {
    enabled: true,
    minScore: 80,
  })
  assert.equal(p.contact.email, email)
  assert.equal(p.noticeDays, 21)
  assert.equal(p.earliestStart, "2027-01-15")
  assert.equal(p.eligibility[0].sponsorshipFuture, true)
  assert.equal(p.compensation[0].singleAmount, 90000)
  assert.ok(p.confirmedAt)
  await checkpoint(
    "Live profile save and readback confirmed defaults and answers",
    { autoApply: saved.autoApply, confirmedAt: p.confirmedAt }
  )
  await page.goto(origin + "/preferences#application-profile-section", {
    waitUntil: "domcontentloaded",
  })
  assert.equal(await page.locator("#application-notice").inputValue(), "21")
  assert.equal(await page.locator("#application-email").inputValue(), email)
  await checkpoint("Answers survive a fresh Preferences page load")
  // A synthetic inactive listing scopes the resolver test; it cannot be recommended.
  const jobId = "generated-onboarding-qa:" + randomUUID()
  jobs.push(jobId)
  const token = randomUUID(),
    applicationId = randomUUID()
  const job = {
    id: jobId,
    title: "Backend Engineer",
    company: "Generated onboarding QA employer",
    country,
    source: "generated-onboarding-qa",
    url: origin + "/application-test/" + token,
    description:
      "Build TypeScript backend APIs with PostgreSQL, SQL, automated tests and reliable services.",
    is_active: false,
    last_checked_at: new Date().toISOString(),
  }
  must(await admin.from("job_catalog").insert(job))
  const fields = [
    ["email", "Email", "email"],
    ["legal", "Legal First Name", "text"],
    ["notice", "Notice period in days", "text"],
    ["start", "Earliest start date", "text"],
    ["relocate", "Are you willing to relocate?", "radio"],
    ["travel", "Are you willing to travel?", "radio"],
    ["auth", "Are you authorized to work in Antarctica?", "radio"],
    ["sponsor", "Do you need sponsorship now?", "radio"],
    ["future", "Will you need sponsorship in the future?", "radio"],
    ["salary", "Expected annual base salary in EUR", "number"],
    ["unknown", "Who is your employee referral contact?", "text"],
  ].map(([id, label, kind]) => ({
    id,
    label,
    kind,
    required: true,
    help: "",
    options: kind === "radio" ? ["Yes", "No"] : [],
  }))
  const auditId = randomUUID(),
    packet = {
      title: job.title,
      company: job.company,
      resume: saved.resumeText,
      fields,
      answers: {},
      notices: "Generated QA fixture",
      formHash: randomUUID(),
      tailored: true,
    }
  must(
    await admin
      .from("application_runs")
      .insert({
        id: auditId,
        user_id: user.id,
        job_id: jobId,
        target_url: origin + "/application-test/" + randomUUID(),
        status: "ready",
        automatic: true,
        packet,
      })
  )
  const filled = await request("/api/applications/fill-profile", "POST", {
    continueAutomatic: false,
  })
  assert.equal(filled.updated, 1)
  assert.equal(filled.skipped, 0)
  const audit = must(
    await admin
      .from("application_runs")
      .select("packet,status")
      .eq("id", auditId)
      .single()
  )
  const expected = {
    email,
    legal: "Alexander",
    notice: "21 days",
    start: "2027-01-15",
    relocate: "Yes",
    travel: "No",
    auth: "Yes",
    sponsor: "No",
    future: "Yes",
    salary: "90000",
  }
  for (const [id, value] of Object.entries(expected)) {
    assert.equal(audit.packet.answers[id], value, id)
    assert.match(
      audit.packet.answerEvidence[id].source,
      /Confirmed application profile/
    )
  }
  assert.equal(audit.packet.answers.unknown, undefined)
  await checkpoint(
    "Live automatic-packet resolver reused ten onboarding answers with provenance; unknown referral stayed unanswered",
    { answers: audit.packet.answers, evidence: audit.packet.answerEvidence }
  )
  must(await admin.from("application_runs").delete().eq("id", auditId))
  // Existing synthetic receiver checks preferred/legal names, LinkedIn,
  // authorization, email and uploaded resume against the approved packet.
  must(
    await admin
      .from("application_runs")
      .insert({
        id: applicationId,
        user_id: user.id,
        job_id: jobId,
        target_url: job.url,
        employer_key: "synthetic-temporal-names",
        status: "queued_prepare",
        automatic: true,
        auto_submit_requested_at: new Date().toISOString(),
      })
  )
  must(
    await admin
      .from("application_test_receipts")
      .insert({ token, application_id: applicationId })
  )
  must(
    await admin.from("job_catalog").update({ is_active: true }).eq("id", jobId)
  )
  const started = await request("/api/applications", "POST", {
    jobId,
    autoSubmit: true,
  })
  assert.equal(started.id, applicationId)
  await checkpoint(
    "Live automatic preparation started against the synthetic employer",
    { applicationId }
  )
  let referralAnswered = false,
    lastStatus = "",
    final
  const deadline = Date.now() + 12 * 60 * 1000
  while (Date.now() < deadline) {
    const result = await request("/api/applications/" + applicationId)
    const run = result.application
    if (run.status !== lastStatus) {
      console.log(
        JSON.stringify({
          status: run.status,
          message: run.message,
          tasks: result.tasks.map((x) => ({
            stage: x.stage,
            state: x.state,
            error: x.error_code,
          })),
        })
      )
      lastStatus = run.status
    }
    if (run.status === "submitted") {
      final = run
      break
    }
    if (run.status === "ready" && run.packet?.fields?.length) {
      const missing = run.packet.fields.filter(
        (f) => f.required && f.kind !== "resume" && !run.packet.answers[f.id]
      )
      if (missing.length) {
        assert.ok(
          missing.every((f) => /referral/i.test(f.label)),
          JSON.stringify(missing)
        )
        assert.equal(referralAnswered, false)
        const answers = { ...run.packet.answers }
        for (const f of missing) answers[f.id] = "No employee referral"
        await request("/api/applications/" + applicationId, "PATCH", {
          revision: run.revision,
          answers,
          resume: run.packet.resume,
          remember: {},
        })
        referralAnswered = true
        await checkpoint(
          "Automatic browser asked only for the unknown referral; supplied synthetic answer to continue"
        )
      }
    }
    assert.ok(
      ![
        "failed",
        "needs_attention",
        "submission_unknown",
        "cancelled",
      ].includes(run.status),
      JSON.stringify({
        status: run.status,
        message: run.message,
        tasks: result.tasks,
      })
    )
    await new Promise((r) => setTimeout(r, 5000))
  }
  assert.ok(final, "Automatic application did not finish within 12 minutes")
  assert.equal(
    referralAnswered,
    true,
    "The unknown referral must be requested, never invented"
  )
  const receipt = must(
    await admin
      .from("application_test_receipts")
      .select("submissions,received_at")
      .eq("token", token)
      .single()
  )
  assert.equal(receipt.submissions, 1)
  const run = must(
    await admin
      .from("application_runs")
      .select("approved_packet,packet,automatic,status")
      .eq("id", applicationId)
      .single()
  )
  assert.equal(run.automatic, true)
  assert.deepEqual(run.approved_packet.applicationContext.profile, p)
  report.approvedPacket = run.approved_packet
  await checkpoint(
    "Real automatic browser submission confirmed by synthetic receiver",
    { applicationId, receipt, referralWasRequested: referralAnswered }
  )
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) {
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({
      path: ".local-data/live-onboarding-failure.png",
      fullPage: true,
    })
    .catch(() => {})
  report.passed = false
  report.error = error instanceof Error ? error.message : String(error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  await browser?.close()
  if (user) {
    const runs = await admin
      .from("application_runs")
      .update({ status: "cancelled" })
      .eq("user_id", user.id)
      .neq("status", "submitted")
    must(runs)
    must(await admin.auth.admin.deleteUser(user.id))
  }
  for (const id of jobs)
    must(await admin.from("job_catalog").delete().eq("id", id))
  report.cleanedUp = true
  report.finishedAt = new Date().toISOString()
  await writeFile(
    ".local-data/live-onboarding-evidence.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 }
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      cleanedUp: true,
      checks: report.checks.length,
    })
  )
}
