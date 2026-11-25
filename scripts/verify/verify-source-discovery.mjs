import { validSourceId } from "../../lib/server/catalog/source-identity.ts"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { stagingContext } from "../lib/staging.mjs"
import { scanCatalog } from "../../lib/server/catalog/read.ts"

const { env, config } = await stagingContext()
const base = process.env.SOURCE_DISCOVERY_QA_BASE_URL ?? "http://localhost:3004"
const target = new URL(base)
assert.ok(
  base === config.appUrl ||
    (base === target.origin &&
      !target.username &&
      !target.password &&
      ["127.0.0.1", "localhost"].includes(target.hostname) &&
      target.protocol === "http:" &&
      /^3\d{3}$/.test(target.port)),
  "Use isolated staging or an explicit loopback staging-configured server"
)
const selected = process.env.SOURCE_DISCOVERY_QA_SOURCES?.split(",") ?? [
  "ashby:healthsherpa",
  "ashby:synthesia",
  "lever:hsag",
  "greenhouse:gitlab",
  "greenhouse:datadog",
  "greenhouse:okta",
  "greenhouse:rubrik",
]
assert.ok(selected.length > 0 && selected.every(validSourceId))
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const created = [],
  receipts = []
let browser
const report = {
  generatedProfilesOnly: true,
  realCatalogueOnly: true,
  applicationSubmissions: 0,
  aiCalls: 0,
  base,
  sources: selected,
  receipts,
}
try {
  assert.equal((await fetch(base + "/api/state")).status, 401)
  const credits = await fetch(base + "/data-source-credits.txt")
  assert.equal(credits.status, 200)
  assert.ok(
    (await credits.text()).includes(
      "https://lastroundai.com/blog/salary-transparency-study-2026"
    )
  )
  const directory = await admin
    .from("job_source_directory")
    .select("id,enabled")
    .in("id", selected)
  assert.ifError(directory.error)
  assert.equal(directory.data.length, selected.length)
  assert.ok(directory.data.every((source) => source.enabled))
  const candidates = await admin
    .from("source_candidates")
    .select("id,status,validated_at")
    .in("id", selected)
  assert.ifError(candidates.error)
  assert.equal(candidates.data.length, selected.length)
  assert.ok(candidates.data.every((row) => row.status === "activated"))
  const jobs = []
  await scanCatalog(
    async (after) => {
      let query = admin
        .from("job_catalog")
        .select("*")
        .in("source", selected)
        .eq("is_active", true)
        .order("id")
        .limit(500)
      if (after) query = query.gt("id", after)
      const response = await query
      assert.ifError(response.error)
      return response.data
    },
    (page) => {
      jobs.push(...page)
    }
  )
  for (const source of selected)
    assert.ok(
      jobs.some((job) => job.source === source),
      `No published jobs for ${source}`
    )
  assert.ok(
    jobs.every(
      (job) =>
        job.description.length >= 100 &&
        Date.parse(job.last_checked_at) > Date.now() - 3600000
    )
  )
  receipts.push({
    boundary: "candidate → approved source → published catalogue",
    listingLocationRecords: jobs.length,
    distinctApplicationUrls: new Set(jobs.map((job) => job.url)).size,
    distinctVacancyCountryPairs: new Set(
      jobs.map((job) => `${job.url}\n${job.country}`)
    ).size,
    countries: [...new Set(jobs.map((job) => job.country))].sort(),
    bySource: Object.fromEntries(
      selected.map((id) => [id, jobs.filter((job) => job.source === id).length])
    ),
  })
  if (process.argv.includes("--browser")) {
    const { chromium } = await import("playwright-core")
    browser = await chromium.launch({
      headless: true,
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    })
  }
  for (const kind of [...new Set(selected.map((id) => id.split(":")[0]))]) {
    const sample = jobs.find(
      (job) =>
        (job.source === kind || job.source.startsWith(kind + ":")) &&
        (!process.env.SOURCE_DISCOVERY_QA_COUNTRY ||
          job.country === process.env.SOURCE_DISCOVERY_QA_COUNTRY) &&
        job.title.length >= 3 &&
        job.title.length <= 100
    )
    assert.ok(
      sample,
      `A collected ${kind} job is required for this verification`
    )
    const email = `generated-discovery-qa-${randomBytes(8).toString("hex")}@example.invalid`
    const password = randomBytes(32).toString("base64url")
    const account = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { staging_qa: true, synthetic_only: true },
    })
    assert.ifError(account.error)
    created.push(account.data.user.id)
    const jar = new Map()
    const user = createServerClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      {
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (cookies) => {
            for (const cookie of cookies) jar.set(cookie.name, cookie.value)
          },
        },
      }
    )
    assert.ifError(
      (await user.auth.signInWithPassword({ email, password })).error
    )
    const request = (path, options = {}) =>
      fetch(base + path, {
        ...options,
        headers: {
          Cookie: [...jar]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
          Origin: base,
          "Content-Type": "application/json",
          ...(options.method === "PUT" ? { "If-Match": "0" } : {}),
        },
        signal: AbortSignal.timeout(120000),
      })
    // Exact-title fixtures test integration, not population-level matching quality.
    const profile = {
      fullName: "Generated Discovery QA",
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
      resumeText: `Fictional verification profile, not a real applicant. Interested in ${sample.title}. This generated text is used only to check catalogue rendering and account isolation; it is never sent to an employer or AI provider.`,
    }
    const saved = await request("/api/profile", {
      method: "PUT",
      body: JSON.stringify(profile),
    })
    assert.equal(saved.status, 200)
    const response = await request("/api/state")
    const payload = await response.json()
    assert.equal(
      response.status,
      200,
      `${sample.country}: ${payload.error ?? response.status}`
    )
    const { state } = payload
    assert.ok(
      state.jobs.some(
        (job) => job.source === sample.source && job.url === sample.url
      ),
      "The actual newly collected vacancy must survive authenticated matching"
    )
    assert.ok(
      state.jobs.every(
        (job) => job.match.relevant && job.country === sample.country
      )
    )
    assert.ok(
      (await user.from("source_candidates").select("id").limit(1)).error,
      "Customer must not read operator discovery state"
    )
    assert.ok(
      (
        await user.rpc("activate_source_candidate", {
          p_id: sample.source,
          p_note: "Customer cannot activate sources",
        })
      ).error
    )
    const receipt = {
      boundary: "account → profile API → matching API",
      provider: kind,
      source: sample.source,
      title: sample.title,
      country: sample.country,
      relevantJobs: state.jobs.length,
    }
    if (browser) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
      })
      await context.addCookies(
        [...jar].map(([name, value]) => ({
          name,
          value,
          url: base,
          sameSite: "Lax",
        }))
      )
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(base + "/jobs")
      await page
        .getByRole("region", {
          name: "Coverage for your search",
        })
        .waitFor({ timeout: 120000 })
      const link = page.locator(`a[href=${JSON.stringify(sample.url)}]`).first()
      for (
        let index = 0;
        index < state.jobs.length && (await link.count()) === 0;
        index++
      ) {
        const next = page.getByRole("button", {
          name: "Next page",
          exact: true,
        })
        if (!(await next.count()) || !(await next.isEnabled())) break
        await next.click()
      }
      await link.waitFor({ state: "visible", timeout: 120000 })
      const row = link.locator("xpath=ancestor::li[1]")
      const details = row.getByRole("button", {
        name: "Show details",
        exact: true,
      })
      if (await details.count()) await details.click()
      assert.ok(
        await row
          .getByText(`${sample.company} careers`, { exact: false })
          .count()
      )
      assert.equal(await page.getByRole("main").getByRole("alert").count(), 0)
      assert.deepEqual(errors, [])
      const screenshot = `.local-data/discovery-qa-${kind}.png`
      await page.screenshot({ path: screenshot, fullPage: true })
      receipt.browser = {
        actualVacancyVisible: true,
        sourceLabelVisible: true,
        screenshot,
        clientErrors: errors.length,
      }
      await context.close()
    }
    receipts.push(receipt)
    console.log(
      `Verified ${kind}: authenticated matching, operator access denial${browser ? ", and browser rendering" : ""}`
    )
    assert.ifError((await user.auth.signOut()).error)
  }
  report.ok = true
} finally {
  if (browser) await browser.close()
  for (const id of created)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error)
  report.generatedAccountsDeleted = created.length
  report.measuredAt = new Date().toISOString()
  await writeFile(
    ".local-data/discovery-e2e-receipt.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 }
  )
}
console.log(JSON.stringify(report, null, 2))
