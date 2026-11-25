// Actual review component and Radix controls, generated data, mobile Chrome.
// All requests are intercepted; no account, employer or Telegram is contacted.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { build } from "esbuild"
import { chromium } from "playwright-core"
import { missingAnswers, type ApplicationPacket } from "../../lib/applications"

const labels = [
  "At the time of application, are you 18+ years of age?",
  "Are you legally authorized to work in the US?",
  "Will you now or in the future require sponsorship for work authorization?",
]
const packet: ApplicationPacket = {
  title: "Generated UI test",
  company: "Synthetic employer",
  engine: "browser-use",
  resume:
    "Generated fictional candidate resume. No real applicant is represented.",
  notices: "",
  formHash: "fixture",
  tailored: true,
  answers: {},
  fields: [
    ...labels.map((label, index) => ({
      id: `empty-${index}`,
      label,
      help: "",
      kind: "select" as const,
      required: true,
      options: [],
    })),
    {
      id: "choice",
      label: "Synthetic available choices",
      help: "",
      kind: "select",
      required: true,
      options: ["Yes", "No"],
    },
  ],
}
let run = {
  id: "fixture",
  status: "ready",
  revision: 1,
  automatic: true,
  packet,
  target_url: "https://employer.example/job",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  approved_revision: null,
  receipt: null,
  message: "",
}
let saved: ApplicationPacket["answers"] | undefined
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ApplicationReview} from './components/application-review'; createRoot(document.getElementById('root')).render(<ApplicationReview id="fixture"/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "isolated-review-shell",
      setup(plugin) {
        plugin.onResolve(
          { filter: /^(?:next\/link|@\/components\/app-shell)$/ },
          (args) => ({ path: args.path, namespace: "fixture" })
        )
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "next/link"
              ? `import React from 'react'; export default function Link({children,...props}) {return React.createElement('a',props,children)}`
              : `import React from 'react'; export function AppShell({children,title,description}) {return React.createElement('main',{style:{padding:16,maxWidth:800}},React.createElement('h1',null,title),description,children)}`,
          loader: "js",
          resolveDir: process.cwd(),
        }))
      },
    },
  ],
})
const css = await readFile(".next/dev/static/css/app/layout.css", "utf8").catch(
  () => ""
)
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
})
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/applications/fixture") {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON()
        saved = body.answers
        assert.equal(missingAnswers({ ...packet, answers: saved! }).length, 0)
        run = {
          ...run,
          revision: 2,
          status: "queued",
          packet: { ...packet, answers: saved! },
        }
        return route.fulfill({ json: { revision: 2, queued: true } })
      }
      return route.fulfill({
        json: {
          application: run,
          events: [],
          tasks:
            run.status === "submitting"
              ? [
                  {
                    stage: "submit",
                    revision: run.revision,
                    state: "running",
                    error_code: "telegram_verification_required",
                    message: "Verification code needed",
                    attempts: 1,
                    next_retry_at: null,
                    updated_at: new Date().toISOString(),
                  },
                ]
              : [],
          reuseChoices: {},
        },
      })
    }
    if (url.pathname.includes("/resume"))
      return route.fulfill({
        contentType: "text/html",
        body: "<p>Generated resume preview</p>",
      })
    if (url.pathname === "/app.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: bundle.outputFiles[0].text,
      })
    if (url.pathname === "/style.css")
      return route.fulfill({ contentType: "text/css", body: css })
    if (route.request().isNavigationRequest())
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>',
      })
    await route.fulfill({ json: {} })
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("https://generated-review.example/")
  await page.getByRole("heading", { name: "Employer questions" }).waitFor()
  for (let i = 0; i < labels.length; i++) {
    const answer = page.locator(`#answer-empty-${i}`)
    assert.equal(
      await answer.evaluate((el) => el.tagName),
      "INPUT",
      `Empty dropdown for ${labels[i]} must accept a typed answer`
    )
    await answer.fill(i === 1 ? "No" : "Yes")
  }
  await page.locator("#answer-choice").click()
  await page.getByRole("option", { name: "Yes", exact: true }).waitFor()
  await page.getByRole("option", { name: "No", exact: true }).click()
  await page.screenshot({
    path: ".local-data/dropdowns-mobile.png",
    fullPage: true,
  })
  await page
    .getByRole("button", { name: "Save & continue", exact: true })
    .first()
    .click()
  await page
    .getByRole("status")
    .filter({ hasText: /Waiting to send|Queued/ })
    .first()
    .waitFor({ timeout: 5000 })
  assert.deepEqual(saved, {
    "empty-0": "Yes",
    "empty-1": "No",
    "empty-2": "Yes",
    choice: "No",
  })
  run = { ...run, status: "ready" }
  await page.reload()
  await page
    .getByRole("status")
    .filter({ hasText: "Continuing automatically" })
    .waitFor()
  assert.equal(await page.getByText(/I reviewed this exact resume/).count(), 0)
  assert.equal(
    await page
      .getByRole("button", { name: "Approve & submit application" })
      .count(),
    0
  )
  assert.equal(
    (await page
      .getByRole("button", { name: "Save & continue", exact: true })
      .filter({ hasNot: page.locator("[disabled]") })
      .count()) > 1,
    false
  )
  await page.screenshot({
    path: ".local-data/continuous-application-mobile.png",
    fullPage: true,
  })
  run = { ...run, status: "submitting" }
  await page.reload()
  await page
    .getByRole("heading", { name: "Verification code needed" })
    .waitFor()
  await page.getByText(/Reply to the latest code prompt in Telegram/).waitFor()
  assert.equal(
    await page
      .getByRole("link", { name: "Open employer browser", exact: true })
      .count(),
    0
  )
  await page.screenshot({
    path: ".local-data/automatic-otp-mobile.png",
    fullPage: true,
  })
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      passed: true,
      viewport: "390x844",
      emptyFieldsAnswered: 3,
      populatedDropdownSelected: true,
      saveContinues: true,
      telegramCodePrompt: true,
      noEmployerContacted: true,
    })
  )
} finally {
  await browser.close()
}
