import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { stagingContext } from "../lib/staging.mjs"
import { visibleRecommendations } from "../../lib/jobs/recommendations.ts"
import { getCandidate } from "../../lib/server/account-store.ts"

const { env, config } = await stagingContext(),
  base = config.appUrl
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false }, db: { retry: false } }
)
const created = [],
  report = {
    base,
    generatedAccountsOnly: true,
    applicationSubmissions: 0,
    aiCalls: 0,
    checks: [],
  }
let browser
try {
  assert.equal((await fetch(base + "/api/job-search")).status, 401)
  const small = await admin
    .from("job_catalog_sources")
    .select("id")
    .gte("published_count", 1)
    .lte("published_count", 5)
    .lt("last_success_at", new Date(Date.now() - 3600000).toISOString())
    .order("id")
    .limit(1000)
  assert.ifError(small.error)
  let sample
  for (let offset = 0; offset < small.data.length && !sample; offset += 80) {
    const samples = await admin
      .from("job_catalog")
      .select("title,country,source")
      .eq("is_active", true)
      .eq("country", "India")
      .in(
        "source",
        small.data.slice(offset, offset + 80).map((s) => s.id)
      )
      .order("id")
      .limit(100)
    assert.ifError(samples.error)
    sample = samples.data.find(
      (j) =>
        j.title.length >= 3 &&
        j.title.length <= 100 &&
        (j.source === "linkedin" ||
          /^(ashby|greenhouse|lever|smartrecruiters|workday):/.test(
            j.source
          )) &&
        /engineer|developer|designer|manager|analyst|nurse|accountant|specialist|consultant|technician|sales/i.test(
          j.title
        ) &&
        !/enthusiast|general application|apply here|talent pool/i.test(j.title)
    )
  }
  assert.ok(
    sample,
    "A real small-board India posting is needed for the free-tier live test"
  )
  const profile = {
    fullName: "Generated On-Demand QA",
    headline: sample.title,
    currentLocation: null,
    targetRoles: [sample.title],
    skills: ["Communication"],
    experienceYears: null,
    targetCountries: [sample.country],
    targetLocations: [],
    workModes: ["remote", "hybrid", "onsite"],
    sponsorshipRequired: null,
    excludedCompanies: [],
    resumeText:
      "Fictional staging verification profile. This text checks account isolation and public catalogue matching. No AI provider or employer application receives this generated profile.",
  }
  if (process.argv.includes("--saved-profile-scope")) {
    const { accountId } = JSON.parse(
      await readFile(".local-data/profile-discovery-baseline.json", "utf8")
    )
    const saved = await getCandidate({ db: admin, user: { id: accountId } })
    assert.ok(saved, "The confirmed account must have a saved profile")
    // Only coarse search preferences enter this fictional QA account. The
    // person's resume, identity, history and application settings stay private.
    profile.targetRoles = saved.candidate.targetRoles
    profile.targetCountries = saved.candidate.targetCountries
    profile.targetLocations = saved.candidate.targetLocations ?? []
    profile.headline = saved.candidate.targetRoles[0]
    report.searchScope = {
      roles: profile.targetRoles,
      countries: profile.targetCountries,
    }
  }
  const accounts = []
  for (let i = 0; i < 2; i++) {
    const email = `generated-on-demand-qa-${randomBytes(8).toString("hex")}@example.invalid`,
      password = randomBytes(32).toString("base64url")
    const u = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { staging_qa: true, synthetic_only: true },
    })
    assert.ifError(u.error)
    created.push(u.data.user.id)
    const jar = new Map(),
      db = createServerClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        {
          cookies: {
            getAll: () => [...jar].map(([name, value]) => ({ name, value })),
            setAll: (values) => {
              for (const cookie of values) jar.set(cookie.name, cookie.value)
            },
          },
        }
      )
    assert.ifError(
      (await db.auth.signInWithPassword({ email, password })).error
    )
    const request = (path, options = {}) =>
      fetch(base + path, {
        ...options,
        headers: {
          Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
          Origin: base,
          "Content-Type": "application/json",
          ...(options.method === "PUT" ? { "If-Match": "0" } : {}),
          ...options.headers,
        },
        signal: AbortSignal.timeout(120000),
      })
    const saved = await request("/api/profile", {
      method: "PUT",
      body: JSON.stringify(profile),
    })
    assert.equal(saved.status, 200)
    assert.equal((await request("/api/job-search")).status, 200)
    assert.equal((await (await request("/api/job-search")).json()).search, null)
    assert.ok((await db.from("job_search_runs").select("id").limit(1)).error)
    assert.ok(
      (
        await db.rpc("claim_job_search_dispatch", {
          p_id: randomBytes(16).toString("hex"),
        })
      ).error
    )
    accounts.push({ db, jar, request })
  }
  const actor = accounts[0]
  assert.equal(
    (
      await actor.request("/api/job-search", {
        method: "POST",
        headers: { Origin: "https://example.invalid" },
        body: "{}",
      })
    ).status,
    403
  )
  assert.equal(
    (
      await actor.request("/api/job-search", {
        method: "POST",
        body: JSON.stringify({ sourceIds: ["ashby:arbitrary"] }),
      })
    ).status,
    400
  )
  const initialResponse = await actor.request("/api/state")
  assert.equal(initialResponse.status, 200)
  const initial = (await initialResponse.json()).state,
    baseline = visibleRecommendations(initial.jobs, false, false).sort(
      (a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt)
    )[0]
  assert.ok(baseline)
  report.sample = {
    title: sample.title,
    country: sample.country,
    source: sample.source,
  }
  report.initialMatches = initial.jobs.length
  const { chromium } = await import("playwright-core")
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  })
  await context.addCookies(
    [...actor.jar].map(([name, value]) => ({
      name,
      value,
      url: base,
      sameSite: "Lax",
    }))
  )
  const page = await context.newPage(),
    clientErrors = [],
    states = []
  page.on("pageerror", (e) => clientErrors.push(e.message))
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/state" && response.ok()) {
      try {
        states.push((await response.json()).state)
      } catch {}
    }
  })
  await page.goto(base + "/jobs")
  const find = page.getByRole("button", {
    name: "Refresh jobs",
    exact: true,
  })
  await find.waitFor({ state: "visible", timeout: 120000 })
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Refresh jobs" && !b.disabled
      ),
    null,
    { timeout: 120000 }
  )
  const existing = page
    .locator(`a[href=${JSON.stringify(baseline.url)}]`)
    .first()
  await existing.waitFor({ state: "visible", timeout: 120000 })
  const admittedResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/job-search" &&
      r.request().method() === "POST"
  )
  await find.click()
  assert.ok(
    await existing.isVisible(),
    "Cached matches must remain visible while search starts"
  )
  const admitted = await admittedResponse
  assert.ok([200, 202].includes(admitted.status()))
  const admission = await admitted.json()
  assert.ok(admission.search, JSON.stringify(admission))
  const id = admission.search.id
  report.requestReused = Boolean(admission.reused)
  report.searchId = id
  const duplicate = await Promise.all(
    accounts.map(async (a) => {
      const response = await a.request("/api/job-search", {
        method: "POST",
        body: "{}",
      })
      assert.ok([200, 202].includes(response.status))
      return response.json()
    })
  )
  assert.ok(
    duplicate.every((r) => r.search?.id === id),
    "Equivalent requests must share the same run"
  )
  report.checks.push(
    "existing matches remain visible",
    "duplicate and cross-account equivalent requests reuse work",
    "anonymous, forged-input, cross-origin and operator access denial"
  )
  await page.reload()
  await page
    .getByRole("region", { name: "Coverage for your search" })
    .waitFor({ timeout: 120000 })
  const persisted = await (await actor.request("/api/job-search")).json()
  assert.equal(persisted.search.id, id)
  report.checks.push("progress survives browser reload")
  let status = persisted.search,
    last = ""
  const deadline = Date.now() + 10 * 60000
  while (
    ["queued", "running"].includes(status.status) &&
    Date.now() < deadline
  ) {
    const summary = `${status.status}:${status.processedSources}/${status.plannedSources}`
    if (summary !== last) {
      console.log(summary)
      last = summary
    }
    await new Promise((resolve) => setTimeout(resolve, 10000))
    const response = await actor.request("/api/job-search")
    assert.equal(response.status, 200)
    status = (await response.json()).search
  }
  assert.ok(
    !["queued", "running", "failed"].includes(status.status),
    JSON.stringify(status)
  )
  report.final = status
  const run = await admin
    .from("job_search_runs")
    .select("roles,countries,sources,results,workflow_id")
    .eq("id", id)
    .single()
  assert.ifError(run.error)
  assert.ok(run.data.workflow_id)
  assert.ok(run.data.sources.length <= 96)
  assert.deepEqual(run.data.countries, [...profile.targetCountries].sort())
  assert.deepEqual(
    run.data.roles,
    [
      ...new Set(profile.targetRoles.map((role) => role.trim().toLowerCase())),
    ].sort()
  )
  assert.ok(!JSON.stringify(run.data).includes(profile.resumeText))
  report.checks.push(
    "bounded hosted workflow and canonical saved-profile scope"
  )
  const published = Object.entries(run.data.results)
    .filter(([, result]) => result.status === "published")
    .map(([source]) => source)
  report.freshPublicationVerified = false
  if (published.length) {
    const fresh = await admin
      .from("job_catalog")
      .select("id,source,last_checked_at")
      .in("source", published)
      .gte("last_checked_at", status.createdAt)
      .eq("is_active", true)
      .limit(100)
    assert.ifError(fresh.error)
    assert.ok(fresh.data.length)
    report.freshPublicationVerified = true
    report.observedFreshRecords = fresh.data.length
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="status"]')].some((n) =>
          /newly discovered listings|Live checks finished|Processed \d+ career boards|Live checks paused/.test(
            n.textContent
          )
        ),
      null,
      { timeout: 120000 }
    )
    const until = Date.now() + 120000
    while (
      Date.now() < until &&
      !states.some((s) =>
        s.jobs.some(
          (j) =>
            published.includes(j.source) &&
            Date.parse(j.lastCheckedAt) >= Date.parse(status.createdAt)
        )
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.ok(
      states.some((s) =>
        s.jobs.some(
          (j) =>
            published.includes(j.source) &&
            Date.parse(j.lastCheckedAt) >= Date.parse(status.createdAt)
        )
      ),
      "Fresh published matching jobs must arrive in the browser without a manual reload"
    )
    report.checks.push(
      "fresh real source snapshots published and delivered to browser automatically"
    )
    const loaded = states.at(-1)
    report.newMatchingRecords = loaded.jobs.filter(
      (job) =>
        job.match?.reviewable &&
        Date.parse(job.seenAt) >= Date.parse(status.createdAt) &&
        !initial.jobs.some((before) => before.id === job.id)
    ).length
    report.finalMatches = loaded.jobs.length
  } else {
    assert.ok(
      status.status === "paused" ||
        status.reason === "no_sources" ||
        status.status === "partial"
    )
    report.checks.push(
      "free-tier pause or source limits reported without fabricated fresh results"
    )
  }
  assert.deepEqual(clientErrors, [])
  await page
    .getByRole("button", { name: "Reload saved matches", exact: true })
    .waitFor({ state: "visible", timeout: 120000 })
  await page.screenshot({
    path: ".local-data/on-demand-live.png",
    fullPage: true,
  })
  const usage = await admin.rpc("catalog_storage_usage")
  assert.ifError(usage.error)
  report.storage = usage.data
  report.clientErrors = clientErrors.length
  report.ok = true
} finally {
  if (browser) await browser.close()
  for (const id of created)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error)
  report.generatedAccountsDeleted = created.length
  report.measuredAt = new Date().toISOString()
  await writeFile(
    ".local-data/on-demand-e2e-receipt.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 }
  )
}
console.log(JSON.stringify(report, null, 2))
