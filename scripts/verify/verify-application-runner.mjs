import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { randomUUID, randomBytes, createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { assertStagingTarget } from "../lib/staging.mjs"
import { spawnSync } from "node:child_process"
// Every candidate value below is generated here. No existing account, profile,
// resume, inbox or personal document is read. No email is sent.
const syntheticOnly = process.argv.includes("--synthetic-only")
const progressUI = process.argv.includes("--progress-ui")
const pipelineRetry = process.argv.includes("--pipeline-retry")
const pipelineBlocked = process.argv.includes("--pipeline-blocked")
const humanAssistance = process.argv.includes("--human-assistance")
const fieldAssistance = process.argv.includes("--field-assistance")
const temporalNames = process.argv.includes("--temporal-names")
assert.ok(
  !temporalNames ||
    (syntheticOnly &&
      !fieldAssistance &&
      !humanAssistance &&
      !pipelineRetry &&
      !pipelineBlocked),
  "Temporal name verification is a separate synthetic-only check"
)
assert.ok(
  !fieldAssistance || syntheticOnly,
  "Field assistance is synthetic-only"
)
assert.ok(
  !humanAssistance || (syntheticOnly && !pipelineRetry && !pipelineBlocked),
  "Human assistance is a separate synthetic-only check"
)
assert.ok(
  !pipelineBlocked || (syntheticOnly && !pipelineRetry),
  "Expected provider-limit verification is a separate synthetic-only check"
)
assert.ok(
  !pipelineRetry || syntheticOnly,
  "Retry fault injection is synthetic-only"
)
const localOriginArg = process.argv
  .find((arg) => arg.startsWith("--origin="))
  ?.slice(9)
const deploymentArg = process.argv
  .find((arg) => arg.startsWith("--deployment="))
  ?.slice(13)
if (deploymentArg)
  assert.match(
    deploymentArg,
    /^https:\/\/job-search-[a-z0-9]+-v12labs-projects\.vercel\.app$/,
    "Expected a deployment of the linked staging project"
  )
const originArg = deploymentArg || localOriginArg
if (localOriginArg)
  assert.ok(
    /^http:\/\/localhost:\d+$/.test(localOriginArg),
    "Local verification requires localhost"
  )
const receiverOrigin = process.argv
  .find((arg) => arg.startsWith("--receiver-origin="))
  ?.slice(18)
if (receiverOrigin) {
  const url = new URL(receiverOrigin)
  assert.ok(
    syntheticOnly && url.protocol === "https:" && url.origin === receiverOrigin,
    "Receiver overrides require synthetic-only mode and an HTTPS origin"
  )
}
const automaticQueue = process.argv.includes("--automatic-queue")
const automatic =
  syntheticOnly || automaticQueue || process.argv.includes("--automatic")
assert.ok(
  !(syntheticOnly && automaticQueue),
  "Synthetic-only mode tests automatic continuation"
)
const suffix =
  (automaticQueue ? "-automatic-queue" : automatic ? "-automatic" : "") +
  (temporalNames ? "-temporal-names" : "")
const syntheticResume =
  "Test Candidate\n\nThis is generated fictional QA data and does not describe a real applicant.\n\nEXPERIENCE\nSynthetic Backend Engineer at Example Test Company. Built TypeScript APIs with SQL databases, observability and automated tests for a fictional staging project.\n\nSKILLS\nTypeScript, SQL, Node.js, testing.\n\nEDUCATION\nSynthetic BSc at Example Test University.\n\n" +
  "Generated QA project detail: tested request validation, SQL persistence, browser form uploads and recovery with fictional fixtures.\n".repeat(
    24
  )
const e = parseEnv(await readFile(".env.staging.local", "utf8"))
const c = JSON.parse(await readFile("staging/project.json", "utf8"))
assertStagingTarget(c, e)
const admin = createClient(
  e.NEXT_PUBLIC_SUPABASE_URL,
  e.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const generatedAccounts = []
async function createSyntheticAccount() {
  const email = `generated-runner-qa-${Date.now()}-${randomBytes(4).toString("hex")}@example.invalid`,
    password = randomBytes(32).toString("base64url")
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { staging_qa: true, synthetic_only: true },
  })
  assert.ifError(created.error)
  generatedAccounts.push(created.data.user.id)
  return { email, password, id: created.data.user.id }
}
async function session(email, password) {
  const jar = new Map()
  const db = createServerClient(
    e.NEXT_PUBLIC_SUPABASE_URL,
    e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
        setAll: (vs) => {
          for (const v of vs) jar.set(v.name, v.value)
        },
      },
    }
  )
  const login = await db.auth.signInWithPassword({ email, password })
  assert.ifError(login.error)
  return {
    db,
    snapshot: async (id, name, expected) => {
      const { chromium } = await import("playwright-core")
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROME_EXECUTABLE_PATH ||
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
      })
      try {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1100 },
        })
        await context.addCookies(
          [...jar].map(([name, value]) => ({
            name,
            value,
            url: originArg || c.appUrl,
          }))
        )
        const page = await context.newPage()
        const response = await page.goto(
          `${originArg || c.appUrl}/applications/${id}`,
          { waitUntil: "domcontentloaded", timeout: 60000 }
        )
        assert.equal(response.status(), 200)
        await page
          .getByRole("heading", { name: "Application progress", exact: true })
          .waitFor({ timeout: 30000 })
        await page
          .getByRole("region", { name: "Application progress", exact: true })
          .locator("summary")
          .click()
        for (const text of expected)
          await page
            .getByText(text, { exact: true })
            .first()
            .waitFor({ timeout: 30000 })
        await page.screenshot({
          path: `.local-data/application-pipeline-${name}.png`,
          fullPage: true,
        })
        console.log(
          JSON.stringify({ browserVerified: name, taskPanelVisible: true })
        )
      } finally {
        await browser.close()
      }
    },
    request: async (path, method = "GET", body) => {
      const init = {
        method,
        redirect: "manual",
        headers: {
          Cookie: Array.from(jar, ([k, v]) => `${k}=${v}`).join("; "),
          Origin: originArg || c.appUrl,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(65000),
      }
      let r
      if (deploymentArg) {
        // CLI supplies the existing deployment protection authorization. App
        // cookies and request bodies stay in stdin, never process arguments.
        const config = [
          `request = ${JSON.stringify(method)}`,
          `include`,
          `silent`,
          `show-error`,
          ...Object.entries(init.headers).map(
            ([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`
          ),
          ...(body
            ? [`data-binary = ${JSON.stringify(JSON.stringify(body))}`]
            : []),
        ].join("\n")
        const result = spawnSync(
          "vercel",
          [
            "curl",
            path,
            "--deployment",
            deploymentArg,
            "--scope",
            "v12labs-projects",
            "--",
            "--config",
            "-",
          ],
          {
            input: config,
            encoding: "utf8",
            maxBuffer: 2_000_000,
            timeout: 65000,
          }
        )
        assert.equal(result.status, 0, "Protected deployment request failed")
        const chunks = result.stdout.split(/\r?\n\r?\n/)
        while (chunks[0]?.includes("200 Connection established")) chunks.shift()
        const header = chunks.shift() || ""
        const status = Number(header.match(/^HTTP\/\S+ (\d+)/)?.[1])
        assert.ok(status, "Expected an HTTP response from the staged app")
        const headers = new Headers()
        for (const line of header.split(/\r?\n/).slice(1)) {
          const colon = line.indexOf(":")
          if (colon > 0)
            headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
        }
        r = new Response(chunks.join("\n\n"), { status, headers })
      } else r = await fetch((originArg || c.appUrl) + path, init)
      const d = await r.json().catch(() => ({}))
      console.log(
        JSON.stringify({ method, path, status: r.status, error: d.error })
      )
      return { r, d }
    },
  }
}
async function verify() {
  const account = await createSyntheticAccount()
  const candidate = {
    fullName: "Test Candidate",
    headline: "Synthetic Backend Engineer",
    currentLocation: null,
    experienceYears: null,
    targetRoles: ["Backend Engineer"],
    skills: ["TypeScript", "SQL", "Node.js"],
    workModes: ["remote", "hybrid", "onsite"],
    sponsorshipRequired: null,
    excludedCompanies: [],
    resumeText: syntheticResume,
    ...(temporalNames
      ? {
          applicationProfile: {
            enabled: true,
            confirmedAt: new Date().toISOString(),
            contact: {
              preferredName: "Test Candidate",
              givenName: "Test Middle",
              familyName: "Candidate",
              linkedin: "https://linkedin.com/in/synthetic-computer-candidate",
            },
          },
        }
      : {}),
  }
  const profile = await admin
    .from("account_profiles")
    .insert({ user_id: account.id, data: candidate })
  assert.ifError(profile.error)
  assert.ifError(
    (
      await admin
        .from("account_countries")
        .insert({ user_id: account.id, country: "Germany" })
    ).error
  )
  const a = await session(account.email, account.password)
  const matching = syntheticOnly ? null : await a.request("/api/state")
  if (matching) {
    assert.equal(matching.r.status, 200)
    assert.ok(matching.d.state.jobs.some((job) => job.match?.relevant))
  }
  assert.equal((await a.request("/api/profile")).r.status, 200)
  // Reference only public listing metadata; the private run's destination is the
  // synthetic employer below. No QA listing is inserted into the catalogue.
  let sourceJob = null
  if (automatic && !syntheticOnly) {
    // /api/state intentionally omits full descriptions. Read only public listing
    // facts through the synthetic user's normal RLS-scoped client.
    const relevantIds = matching.d.state.jobs
      .filter((job) => job.match?.relevant && job.isActive !== false)
      .slice(0, 100)
      .map((job) => job.id)
    const listings = await a.db
      .from("job_catalog")
      .select("id,description")
      .in("id", relevantIds)
      .eq("is_active", true)
      .gte("last_checked_at", new Date(Date.now() - 7 * 86400000).toISOString())
    assert.ifError(listings.error)
    sourceJob = listings.data.find((job) => job.description?.length >= 100)
    assert.ok(
      sourceJob,
      "Need one current public listing for the synthetic account's API test"
    )
  }
  const id = randomUUID(),
    token = randomUUID(),
    target = `${receiverOrigin || c.appUrl}/application-test/${token}`
  const created = await admin
    .from("application_runs")
    .insert({
      id,
      user_id: account.id,
      target_url: target,
      status:
        automatic && !syntheticOnly ? "queued_prepare" : "needs_attention",
      prepare_attempts: automatic && !syntheticOnly ? 1 : 0,
      automatic,
      ...(temporalNames
        ? { employer_key: "synthetic-temporal-names" }
        : fieldAssistance
          ? { employer_key: "synthetic-field-assistance" }
          : humanAssistance
            ? { employer_key: "synthetic-human-assistance" }
            : {}),
      ...(sourceJob
        ? { job_id: sourceJob.id, employer_key: "synthetic-test-employer" }
        : {}),
    })
    .select("id")
    .single()
  assert.ifError(created.error)
  assert.ifError(
    (
      await admin
        .from("application_test_receipts")
        .insert({ token, application_id: id })
    ).error
  )
  let restoredRetryFixture = false
  let assistanceObserved = false
  if (pipelineRetry) {
    // A missing synthetic receiver produces a real browser timeout. Restore it
    // only after the deployed worker has persisted its retry decision.
    assert.ifError(
      (
        await admin
          .from("application_test_receipts")
          .delete()
          .eq("token", token)
      ).error
    )
  }
  await writeFile(
    `.local-data/application-runner-fixture${suffix}.json`,
    JSON.stringify({
      id,
      token,
      target,
      email: account.email,
      password: account.password,
    }),
    { mode: 0o600 }
  )
  const sourceCheck = await admin
    .from("account_profiles")
    .select("data")
    .eq("user_id", account.id)
    .single()
  assert.equal(sourceCheck.data.data.resumeText, syntheticResume)
  assert.equal(sourceCheck.data.data.fullName, "Test Candidate")
  assert.ok(account.email.endsWith("@example.invalid"))
  console.log(
    JSON.stringify({
      syntheticSourceVerified: true,
      resumeHash: createHash("sha256").update(syntheticResume).digest("hex"),
      destinations: [
        `${e.APPLICATION_BROWSER_PROVIDER || "browserbase"} isolated test browser`,
        target,
        "configured Vercel AI Gateway",
      ],
    })
  )
  if (automatic && !syntheticOnly) {
    // Fixture insertion bypasses normal creation, so reserve the same one attempt
    // that a newly created customer application would reserve before starting.
    const quota = await a.db.rpc("reserve_tailoring_attempt")
    assert.ifError(quota.error)
    assert.equal(quota.data, true)
    const started = await a.request("/api/applications", "POST", {
      jobId: sourceJob.id,
      autoSubmit: true,
    })
    assert.equal(started.r.status, 201)
    assert.equal(started.d.id, id)
    const owned = (await a.request(`/api/applications/${id}`)).d.application
    assert.equal(
      owned.target_url,
      target,
      "Only the synthetic destination may be used"
    )
    assert.equal(owned.automatic, true)
  } else {
    assert.equal(
      (
        await a.request(`/api/applications/${id}`, "POST", {
          action: "retry",
          revision: 1,
        })
      ).r.status,
      200
    )
  }
  if (syntheticOnly) {
    // The private synthetic run has no catalogue listing. The normal retry API
    // starts the real durable workflow; restore its generated initial consent
    // after retry's revision invalidation, before browser preparation completes.
    assert.ifError(
      (
        await admin
          .from("application_runs")
          .update({
            auto_submit_requested_at: new Date().toISOString(),
          })
          .eq("id", id)
          .in("status", ["queued_prepare", "preparing"])
      ).error
    )
  }
  async function waitFor(statuses) {
    for (let i = 0; i < 150; i++) {
      const { d } = await a.request(`/api/applications/${id}`)
      if (
        (humanAssistance || fieldAssistance) &&
        !assistanceObserved &&
        d.tasks?.some(
          (task) =>
            task.state === "running" &&
            ["human_verification_required", "employer_control_help"].includes(
              task.error_code
            )
        )
      ) {
        assistanceObserved = true
        const denied = await b.request(
          `/api/applications/${id}/browser?revision=${d.application.revision}`
        )
        assert.equal(denied.r.status, 404)
        const access = await a.request(
          `/api/applications/${id}/browser?revision=${d.application.revision}`
        )
        assert.equal(access.r.status, 302)
        assert.equal(access.r.headers.get("cache-control"), "private, no-store")
        const liveUrl = access.r.headers.get("location")
        assert.ok(liveUrl && new URL(liveUrl).protocol === "https:")
        // Private QA artifact only; never print the provider capability URL.
        await writeFile(
          ".local-data/application-human-assistance-view.json",
          JSON.stringify({ id, liveUrl }),
          { mode: 0o600 }
        )
        await a.snapshot(id, "human-assistance", ["Open employer browser"])
        if (fieldAssistance) {
          const beforeHelp = await admin
            .from("application_test_receipts")
            .select("submissions")
            .eq("token", token)
            .single()
          assert.ifError(beforeHelp.error)
          assert.equal(
            beforeHelp.data.submissions,
            0,
            "Field assistance must precede any receiver submission"
          )
        }
        console.log(
          JSON.stringify({
            humanAssistanceReady: true,
            sameBrowser: true,
            ownerOnly: true,
            deadlineMinutes: 3,
          })
        )
      }
      if (pipelineRetry && !restoredRetryFixture) {
        const failed = d.tasks?.find(
          (task) =>
            task.stage === "read_employer_form" && task.state === "retry_wait"
        )
        if (failed) {
          assert.equal(failed.attempts, 1)
          assert.equal(failed.error_code, "temporary_unavailable")
          assert.ok(failed.next_retry_at)
          assert.match(failed.message, /automatically/)
          assert.ifError(
            (
              await admin
                .from("application_test_receipts")
                .insert({ token, application_id: id })
            ).error
          )
          restoredRetryFixture = true
          console.log(
            JSON.stringify({
              retryObserved: true,
              stage: failed.stage,
              attempts: failed.attempts,
              nextRetryAt: failed.next_retry_at,
              errorCode: failed.error_code,
            })
          )
          await a.snapshot(id, "retry", [
            "Retry scheduled",
            "Find and read application form",
          ])
        }
      }
      console.log(
        JSON.stringify({
          state: d.application?.status,
          message: d.application?.message,
        })
      )
      if (statuses.includes(d.application?.status)) return d.application
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw Error("Workflow did not reach review state")
  }
  let run = await waitFor(["ready", "needs_attention"])
  if (pipelineBlocked) {
    assert.equal(run.status, "needs_attention")
    const detail = (await a.request(`/api/applications/${id}`)).d
    const failed = detail.tasks.find((task) => task.state === "blocked")
    assert.ok(failed, "A processing-limit failure must be visible")
    assert.equal(failed.error_code, "processing_limit")
    assert.equal(failed.attempts, 1)
    assert.equal(failed.next_retry_at, null)
    const receipt = await admin
      .from("application_test_receipts")
      .select("submissions")
      .eq("token", token)
      .single()
    assert.ifError(receipt.error)
    assert.equal(receipt.data.submissions, 0)
    await a.snapshot(id, "blocked", [
      "Application progress",
      "Your attention needed",
    ])
    const evidence = {
      passed: true,
      id,
      syntheticOnly: true,
      noEmployerContacted: true,
      stage: failed.stage,
      errorCode: failed.error_code,
      attempts: failed.attempts,
      nextRetryAt: null,
      submissions: 0,
    }
    await writeFile(
      ".local-data/application-pipeline-blocked-verification.json",
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 }
    )
    console.log(JSON.stringify(evidence))
    return
  }
  assert.equal(run.status, "ready", run.message)
  if (pipelineRetry) {
    assert.ok(
      restoredRetryFixture,
      "A real transient error and retry must be observed"
    )
    const detail = (await a.request(`/api/applications/${id}`)).d
    const task = (stage) =>
      detail.tasks.find(
        (task) => task.stage === stage && task.revision === run.revision
      )
    assert.equal(task("read_employer_form").attempts, 2)
    assert.equal(task("read_employer_form").state, "completed")
    assert.equal(
      task("load_source").attempts,
      1,
      "Completed source loading must not repeat"
    )
    for (const stage of ["tailor_resume", "validate_packet"])
      assert.equal(task(stage).state, "completed")
    console.log(
      JSON.stringify({
        checkpointReuseVerified: true,
        discoveryAttempts: 2,
        sourceAttempts: 1,
      })
    )
  }
  assert.ok(run.packet.tailored)
  assert.equal(run.packet.engine, "browser-use")
  if (progressUI) await a.snapshot(id, "seven-tasks", ["View all 7 tasks"])
  assert.ok(run.packet.resume.includes("RELEVANT EXPERIENCE"))
  if (temporalNames) {
    for (const [id, label, value] of [
      ["_systemfield_name", "Preferred First & Last Name", "Test Candidate"],
      ["legal-first-name", "Legal First Name", "Test Middle"],
      ["legal-last-name", "Legal Last Name", "Candidate"],
      [
        "linkedin",
        "LinkedIn Profile",
        "https://linkedin.com/in/synthetic-computer-candidate",
      ],
    ]) {
      assert.equal(
        run.packet.fields.filter(
          (field) => field.id === id && field.label === label
        ).length,
        1
      )
      assert.equal(run.packet.answers[id], value)
      assert.match(
        run.packet.answerEvidence[id].source,
        /Confirmed application profile/
      )
    }
    assert.equal(run.packet.answers.pronouns, undefined)
    assert.equal(run.packet.answers.pronunciation, undefined)
    console.log(
      JSON.stringify({
        temporalNameMappingVerified: true,
        preferredAndLegalNamesDistinct: true,
        optionalIdentityUnanswered: true,
      })
    )
    if (!deploymentArg) await a.snapshot(id, "temporal-names-ready", [])
  }
  const questionId = (label) => {
    const fields = run.packet.fields.filter(
      (field) => field.label.trim().toLowerCase() === label.toLowerCase()
    )
    assert.equal(fields.length, 1, `Expected one observed question: ${label}`)
    return fields[0].id
  }
  for (const field of run.packet.fields.filter((field) =>
    /optional future contact/i.test(field.label)
  ))
    assert.ok(!run.packet.answers[field.id]?.length)
  assert.equal(
    (
      await a.request(`/api/applications/${id}/approve`, "POST", {
        revision: run.revision,
        consent: true,
      })
    ).r.status,
    422
  )
  const answers = {
    ...run.packet.answers,
    ...(fieldAssistance
      ? { [questionId("Location")]: "Example City, Region, Country" }
      : {}),
    [questionId("Do you have the required work authorization?")]: "No",
    // An unknown personal fact must reach the question gate. A motivation essay
    // may legitimately be drafted from the generated resume without asking us.
    [questionId("Who is your employee referral contact?")]:
      `Generated QA Referral ${randomBytes(6).toString("hex")}`,
  }
  assert.equal(
    (
      await a.request(`/api/applications/${id}`, "PATCH", {
        revision: run.revision,
        answers,
        resume: run.packet.resume,
      })
    ).r.status,
    200
  )
  assert.equal(
    (
      await a.request(`/api/applications/${id}/approve`, "POST", {
        revision: run.revision,
        consent: true,
      })
    ).r.status,
    409
  )
  run = (await a.request(`/api/applications/${id}`)).d.application
  const other = await createSyntheticAccount()
  const b = await session(other.email, other.password)
  assert.equal((await b.request(`/api/applications/${id}`)).r.status, 404)
  assert.equal(
    (
      await b.request(`/api/applications/${id}/approve`, "POST", {
        revision: run.revision,
        consent: true,
      })
    ).r.status,
    404
  )
  assert.equal(
    (
      await b.request(`/api/applications/${id}`, "PATCH", {
        revision: run.revision,
        answers,
        resume: run.packet.resume,
      })
    ).r.status,
    404
  )
  const hidden = await b.db.from("application_runs").select("id").eq("id", id)
  assert.ifError(hidden.error)
  assert.deepEqual(hidden.data, [])
  if (automaticQueue) {
    const restarted = await a.request("/api/applications", "POST", {
      jobId: sourceJob.id,
      autoSubmit: true,
    })
    assert.equal(restarted.r.status, 201)
    assert.equal(restarted.d.id, id)
    const duplicate = await a.request("/api/applications", "POST", {
      jobId: sourceJob.id,
      autoSubmit: true,
    })
    assert.equal(duplicate.r.status, 201)
    assert.equal(duplicate.d.id, id)
  } else if (automatic) {
    assert.ok(
      ["queued", "running", "submitting", "submitted"].includes(run.status),
      "Saving the last missing answer must continue automatic submission without another approval"
    )
  } else {
    const approval = {
      revision: run.revision,
      consent: true,
      ...(automatic
        ? { answers: run.packet.answers, resume: run.packet.resume }
        : {}),
    }
    assert.equal(
      (await a.request(`/api/applications/${id}/approve`, "POST", approval)).r
        .status,
      202
    )
    assert.equal(
      (await a.request(`/api/applications/${id}/approve`, "POST", approval)).r
        .status,
      409
    )
  }
  run = await waitFor(["submitted", "needs_attention", "submission_unknown"])
  assert.equal(run.status, "submitted", run.message)
  if (humanAssistance || fieldAssistance) assert.equal(assistanceObserved, true)
  assert.match(
    run.receipt.text,
    /Thank you for applying|Application submitted|Your application has been received by the synthetic staging employer/i
  )
  const received = await admin
    .from("application_test_receipts")
    .select("submissions")
    .eq("token", token)
    .single()
  assert.ifError(received.error)
  assert.equal(received.data.submissions, 1)
  if (pipelineRetry)
    await a.snapshot(id, "submitted", [
      "Submission confirmed",
      "Verify employer receipt",
    ])
  if (automatic && sourceJob) {
    const state = await a.db
      .from("account_job_states")
      .select("status")
      .eq("job_id", sourceJob.id)
      .single()
    assert.ifError(state.error)
    assert.equal(state.data.status, "applied")
    assert.equal(run.target_url, target)
  }
  const evidence = {
    browserProvider: e.APPLICATION_BROWSER_PROVIDER || "browserbase",
    formEngine: run.packet.engine || "legacy",
    sourceResumeCharacters: syntheticResume.length,
    mode: automaticQueue
      ? "automatic queue"
      : automatic
        ? "automatic continuation"
        : "legacy review",
    passed: true,
    id,
    syntheticOnly: true,
    noEmployerContacted: true,
    humanAssistance,
    fieldAssistance,
    temporalNames,
    checks: [
      ...(temporalNames
        ? [
            "distinct confirmed preferred and legal names",
            "duplicate name and LinkedIn labels deduplicated",
            "optional pronouns and pronunciation unanswered",
          ]
        : []),
      ...(humanAssistance
        ? [
            "human handoff in the same Browserbase session",
            "owner-only short-lived Live View access",
            "receipt check continued without another submit",
          ]
        : []),
      ...(pipelineRetry
        ? [
            "real browser timeout persisted with safe error and retry time",
            "Workflow resumed after backoff",
            "completed source checkpoint reused",
          ]
        : []),
      "managed browser reads form",
      "actual cheap-model tailoring",
      "required-answer gate",
      ...(automatic ? ["last answer resumes without another approval"] : []),
      "stale revision rejected",
      "cross-account read edit approve denied",
      "RLS isolation",
      "approved answers and PDF checked by synthetic receiver",
      automaticQueue
        ? "duplicate start reused the same run"
        : "duplicate approval rejected",
      "one confirmed remote test submission",
    ],
    receipt: run.receipt,
  }
  await writeFile(
    `.local-data/application-runner-verification${suffix}.json`,
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 }
  )
  console.log(JSON.stringify(evidence))
}
try {
  await verify()
} finally {
  for (const userId of generatedAccounts) {
    const removed = await admin.auth.admin.deleteUser(userId)
    assert.ifError(removed.error)
  }
  console.log(
    JSON.stringify({ generatedAccountsDeleted: generatedAccounts.length })
  )
}
