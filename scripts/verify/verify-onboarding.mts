import assert from "node:assert/strict"
import { createServer } from "node:http"
import { build } from "esbuild"
import { chromium } from "playwright-core"
import { candidateSchema, emptyCandidate } from "../../lib/candidate"

// Local component integration test: all API requests are intercepted, so this
// cannot save a real profile, call an AI provider or submit an application.
const resume =
  "Alex Example\nBackend engineer building TypeScript APIs and PostgreSQL services. Experienced in testing and delivering reliable software."
const candidate = {
  ...emptyCandidate,
  fullName: "Alex Example",
  headline: "Backend engineer",
  targetRoles: ["Backend engineer"],
  skills: ["TypeScript"],
  experienceYears: 5,
  currentLocation: "Berlin, Germany",
  resumeText: resume,
}
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {OnboardingForm} from './components/onboarding/onboarding-form'; createRoot(document.getElementById('root')).render(<OnboardingForm {...(window.fixture || {})} />);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "local-router",
      setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({
          path: args.path,
          namespace: "stub",
        }))
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path.endsWith("navigation")
            ? "export const useRouter = () => ({push: () => {}, refresh: () => {}});"
            : 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }',
          resolveDir: process.cwd(),
        }))
      },
    },
  ],
})
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html")
  res.end(
    '<div id="root"></div><script>' +
      bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") +
      "</script>"
  )
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
})
try {
  for (const enabled of [true, false]) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    let saved: unknown
    await page.route("**/api/**", async (route) => {
      const request = route.request()
      if (request.url().endsWith("/analyze")) {
        await route.fulfill({ json: { candidate } })
      } else if (
        request.method() === "PUT" &&
        request.url().endsWith("/profile")
      ) {
        saved = request.postDataJSON()
        await route.fulfill({ json: { ok: true, version: 1 } })
      } else {
        await route.fulfill({
          status: 500,
          json: { error: "Unexpected test request" },
        })
      }
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator("textarea").fill(resume)
    await page
      .getByRole("button", { name: "Build my profile", exact: true })
      .click()
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    assert.equal(
      await page
        .getByRole("heading", { name: "Answer once, apply more smoothly" })
        .count(),
      1
    )
    assert.equal(
      await page.locator("#application-pay-0-singleAmount").isVisible(),
      true
    )
    await page.locator("#application-notice").fill("30")
    await page.locator("#application-pay-0-minimum").fill("80000")
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    assert.equal(
      await page
        .getByRole("heading", { name: "Answer once, apply more smoothly" })
        .count(),
      1,
      "invalid salary must stay on the answers step"
    )
    await page.locator("#application-pay-0-minimum").fill("")
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    assert.equal(
      await page.locator("#auto-apply").getAttribute("aria-checked"),
      "true"
    )
    assert.equal(await page.locator("#auto-apply-daily-limit").count(), 0)
    if (!enabled) await page.locator("#auto-apply").click()
    await page.getByRole("button", { name: "Back", exact: true }).click()
    assert.equal(await page.locator("#application-notice").inputValue(), "30")
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    assert.equal(
      await page.locator("#auto-apply").getAttribute("aria-checked"),
      String(enabled)
    )
    await page
      .getByRole("button", {
        name: enabled
          ? "Confirm and start auto-apply"
          : "Confirm and find matches",
        exact: true,
      })
      .click()
    await page.getByRole("button", { name: /Profile ready/ }).waitFor()
    assert.ok(saved && typeof saved === "object" && "autoApply" in saved)
    assert.deepEqual(saved.autoApply, {
      enabled,
      minScore: 80,
    })
    const profile = candidateSchema.parse(saved)
    assert.equal(profile.applicationProfile?.noticeDays, 30)
    assert.ok(profile.applicationProfile?.confirmedAt)
    assert.deepEqual(errors, [])
    await page.close()
  }
  for (const autoApply of [
    undefined,
    { enabled: false, minScore: 90, dailyLimit: 2 },
  ]) {
    const page = await browser.newPage()
    await page.addInitScript(
      (fixture) => {
        Object.assign(window, { fixture })
      },
      {
        initial: { ...candidate, targetCountries: ["Germany"], autoApply },
        editing: "preferences",
      }
    )
    await page.goto(`http://127.0.0.1:${address.port}`)
    assert.equal(
      await page.locator("#auto-apply").getAttribute("aria-checked"),
      "false",
      "existing profiles must not be opted in"
    )
    assert.equal(await page.locator("#auto-apply-daily-limit").count(), 0)
    await page.close()
  }
  const replacementText =
    "Alex Example\nProduct Designer with five years of experience. Designed accessible prototypes in Figma and led usability testing for checkout flows."
  const replacement = {
    ...candidate,
    headline: "Product Designer",
    jobCategories: ["design"],
    targetRoles: ["Product Designer"],
    skills: ["Figma", "Usability testing"],
    resumeText: replacementText,
  }
  const page = await browser.newPage()
  await page.addInitScript((fixture) => Object.assign(window, { fixture }), {
    initial: {
      ...candidate,
      targetCountries: ["India"],
      workModes: ["remote"],
      excludedCompanies: ["Example Employer"],
    },
    editing: "profile",
  })
  let savedReplacement: unknown
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    if (request.url().endsWith("/resume/import")) {
      assert.equal(request.headers()["x-file-name"], "replacement.docx")
      await route.fulfill({ json: { text: replacementText } })
    } else if (request.url().endsWith("/profile/analyze")) {
      assert.deepEqual(request.postDataJSON(), { resumeText: replacementText })
      await route.fulfill({ json: { candidate: replacement } })
    } else if (
      request.method() === "PUT" &&
      request.url().endsWith("/profile")
    ) {
      savedReplacement = request.postDataJSON()
      await route.fulfill({ json: { ok: true, version: 1 } })
    } else {
      await route.abort()
    }
  })
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page
    .getByRole("button", { name: "Replace resume", exact: true })
    .click()
  await page.locator("#resume-file").setInputFiles({
    name: "replacement.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("fixture processed by the mocked import endpoint"),
  })
  await page
    .getByRole("button", { name: "Build my profile", exact: true })
    .click()
  const profileSaved = page.waitForResponse(
    (response) => response.request().method() === "PUT"
  )
  await page.getByRole("button", { name: "Save profile", exact: true }).click()
  await profileSaved
  const savedProfile = candidateSchema.parse(savedReplacement)
  assert.deepEqual(savedProfile.targetRoles, ["Product Designer"])
  assert.deepEqual(savedProfile.jobCategories, ["design"])
  assert.deepEqual(savedProfile.skills, ["Figma", "Usability testing"])
  assert.deepEqual(savedProfile.workModes, ["remote"])
  assert.deepEqual(savedProfile.excludedCompanies, ["Example Employer"])
  await page.close()
  console.log(
    "Passed: onboarding and resume replacement, including refreshed roles, skills and categories."
  )
} finally {
  await browser.close()
  server.close()
}
