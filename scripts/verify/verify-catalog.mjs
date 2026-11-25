import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { stagingContext } from "../lib/staging.mjs"

// Generated profiles only. No existing account or resume is read or modified.
const { env, config } = await stagingContext()
const base = process.env.CATALOG_QA_BASE_URL ?? "http://localhost:3002"
assert.ok(
  ["http://localhost:3002", "http://127.0.0.1:3002", config.appUrl].includes(
    base
  ),
  "Use a local staging-configured server or the exact staging origin in the manifest."
)
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const createdIds = [],
  receipts = []
let browser
try {
  assert.equal((await fetch(base + "/api/state")).status, 401)
  for (const role of ["Backend Engineer", "Registered Nurse"]) {
    const email = `generated-catalog-qa-${randomBytes(8).toString("hex")}@example.invalid`
    const password = randomBytes(32).toString("base64url")
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { staging_qa: true, synthetic_only: true },
    })
    assert.ifError(created.error)
    createdIds.push(created.data.user.id)
    const jar = new Map()
    const db = createServerClient(
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
      (await db.auth.signInWithPassword({ email, password })).error
    )
    const request = (path, options = {}) =>
      fetch(base + path, {
        ...options,
        headers: {
          Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
          Origin: base,
          "Content-Type": "application/json",
          ...(options.method === "PUT" ? { "If-Match": "0" } : {}),
        },
        signal: AbortSignal.timeout(60000),
      })
    const nurse = role === "Registered Nurse"
    const profile = {
      fullName: "Generated QA Candidate",
      headline: role,
      currentLocation: null,
      targetRoles: [role],
      skills: nurse
        ? ["Patient care", "Clinical records"]
        : ["TypeScript", "SQL", "Node.js"],
      experienceYears: 6,
      targetCountries: ["Germany", "India"],
      targetLocations: [],
      workModes: ["remote", "hybrid", "onsite"],
      sponsorshipRequired: null,
      excludedCompanies: [],
      resumeText: nurse
        ? "Fictional QA profile, not a real applicant. Registered Nurse providing patient care, maintaining clinical records and coordinating hospital ward handovers. Six years of generated test experience."
        : "Fictional QA profile, not a real applicant. Backend Engineer building TypeScript and Node.js APIs with SQL databases. Six years of generated test experience in software delivery and testing.",
    }
    const saved = await request("/api/profile", {
      method: "PUT",
      body: JSON.stringify(profile),
    })
    assert.equal(saved.status, 200)
    const response = await request("/api/state")
    assert.equal(response.status, 200)
    const { state } = await response.json()
    assert.ok(
      state.jobs.every(
        (job) => job.match?.relevant && !Object.hasOwn(job, "description")
      )
    )
    assert.deepEqual(state.catalog.coverage.map((row) => row.country).sort(), [
      "Germany",
      "India",
    ])
    if (nurse)
      assert.equal(state.jobs.length, 0, "Nursing is outside the software-role scope")
    else
      assert.ok(
        state.jobs.length > 0,
        "Real catalogue should provide at least one engineering recommendation for this QA case"
      )
    for (const row of state.catalog.coverage)
      assert.equal(
        row.relevantVacancies,
        state.jobs.filter(
          (job) => job.country === row.country && job.match?.reviewable
        ).length
      )
    receipts.push({
      syntheticRole: role,
      relevantJobs: state.jobs.length,
      coverage: state.catalog.coverage,
    })
    if (process.argv.includes("--browser") && !nurse) {
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
        [...jar].map(([name, value]) => ({
          name,
          value,
          url: base,
          sameSite: "Lax",
        }))
      )
      const page = await context.newPage()
      await page.goto(base + "/jobs")
      await page
        .getByRole("heading", {
          name: "Coverage for your profession and preferences",
        })
        .waitFor()
      await page.screenshot({
        path: ".local-data/catalog-qa.png",
        fullPage: true,
      })
      // Next.js also uses role=alert for its screen-reader route announcer.
      const errors = page.getByRole("main").getByRole("alert")
      assert.equal(
        await errors.count(),
        0,
        (await errors.allTextContents()).join("; ")
      )
      receipts.push({
        browser: "Authenticated opportunities and coverage rendered",
        screenshot: ".local-data/catalog-qa.png",
      })
      await browser.close()
      browser = undefined
    }
    assert.ifError((await db.auth.signOut()).error)
  }
  console.log(
    JSON.stringify({ ok: true, generatedProfilesOnly: true, receipts }, null, 2)
  )
} finally {
  if (browser) await browser.close()
  for (const id of createdIds)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error)
}
