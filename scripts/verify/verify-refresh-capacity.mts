import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@supabase/ssr"
import { chromium } from "playwright-core"
import { stagingContext } from "../lib/staging.mjs"

// Run the staging-configured local server with a 50 MiB guard to reproduce full
// storage without changing the real database guard. Generated accounts only.
const base = "http://localhost:3003"
const { env } = await stagingContext()
assert.ok(env.NEXT_PUBLIC_SUPABASE_URL)
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY)
assert.ok(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const password = randomBytes(32).toString("base64url")
const email = `generated-refresh-qa-${randomBytes(8).toString("hex")}@example.invalid`
const user = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { staging_qa: true },
})
assert.ifError(user.error)
assert.ok(user.data.user)
const id = user.data.user.id
let browser
try {
  const jar = new Map<string, string>()
  const account = createServerClient(
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
  assert.ifError(
    (await account.auth.signInWithPassword({ email, password })).error
  )
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        Origin: base,
        "Content-Type": "application/json",
        ...(method === "PUT" ? { "If-Match": "0" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
  const saved = await request("/api/profile", "PUT", {
    fullName: "Generated Refresh QA",
    headline: "Software Engineer",
    currentLocation: null,
    targetRoles: ["Software Engineer"],
    skills: ["TypeScript"],
    experienceYears: null,
    targetCountries: ["India"],
    targetLocations: [],
    workModes: ["remote", "hybrid", "onsite"],
    sponsorshipRequired: null,
    excludedCompanies: [],
    resumeText:
      "Fictional staging profile for refresh verification. No applications or AI requests are authorized by this fixture.",
  })
  assert.equal(saved.status, 200, JSON.stringify(await saved.json()))
  assert.equal((await fetch(base + "/api/job-search")).status, 401)
  for (const method of ["GET", "POST"]) {
    const response = await request(
      "/api/job-search",
      method,
      method === "POST" ? {} : undefined
    )
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get("cache-control") ?? "",
      /private.*no-store/
    )
    assert.equal((await response.json()).blocked, "storage_limit")
  }
  const admitted = await admin
    .from("job_search_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", id)
  assert.ifError(admitted.error)
  assert.equal(admitted.count, 0, "Blocked refresh must not consume quota")
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
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(base + "/jobs")
  const message = page
    .getByRole("status")
    .filter({ hasText: "catalogue storage is full" })
  await message.waitFor({ timeout: 120000 })
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh jobs", exact: true })
      .isDisabled(),
    true
  )
  const reload = page.getByRole("button", {
    name: "Reload saved matches",
    exact: true,
  })
  assert.equal(await reload.isEnabled(), true)
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/state" && response.ok(),
    { timeout: 120000 }
  )
  await reload.click()
  const state = (await (await refreshed).json()).state
  assert.ok(
    state.jobs.length > 0,
    "Real saved jobs remain available during a collection block"
  )
  await page.screenshot({
    path: ".local-data/refresh-capacity-browser.png",
    fullPage: true,
  })
  assert.deepEqual(errors, [])
  await writeFile(
    ".local-data/refresh-capacity-verification.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        generatedAccountOnly: true,
        storageBlockVisible: true,
        primaryCollectionDisabled: true,
        savedReloadWorking: true,
        existingMatches: state.jobs.length,
        blockedRequestsAdmitted: admitted.count,
        clientErrors: errors,
        aiCalls: 0,
        employerSubmissions: 0,
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  console.log(
    "Storage block, zero quota consumption, real saved matches and browser controls verified."
  )
} finally {
  await browser?.close()
  assert.ifError((await admin.auth.admin.deleteUser(id)).error)
}
