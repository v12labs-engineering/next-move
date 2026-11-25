// Replays Motional's observed tool sequence against generated browser fixtures.
// All HTTP requests are intercepted. No employer, CAPTCHA provider or Telegram
// recipient is contacted; the fixture has a simple verification button.
import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { bindBrowserUse } from "../../lib/server/applications/browser-use"
import { bindCaptchaSolver } from "../../lib/server/applications/captcha-solver"
import { bindDocumentUpload } from "../../lib/server/applications/browser-documents"
import { runNativeApplication } from "../../lib/server/applications/native-agent"
import { readVerificationView } from "../../lib/server/applications/verification-surface"
import { ApplicationCaptchaError } from "../../lib/applications/pipeline"
import type { ApplicationPacket } from "../../lib/applications"
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : chromium.executablePath()),
  headless: true,
})
const packet: ApplicationPacket = {
  title: "Synthetic engineer",
  company: "Generated fixture",
  tailored: true,
  resume: "Generated QA candidate. Verified fictional engineering experience.",
  fields: [],
  answers: {},
  notices: "",
  formHash: "fixture",
}
let checks = 0
try {
  for (const tool of [
    "request_missing_answers",
    "request_verification",
    "solve_captcha",
  ]) {
    for (const codeOnly of [false, true])
      for (const fallback of [false, true]) {
        const context = await browser.newContext()
        await context.route("**/*", async (route) => {
          const challenge =
            new URL(route.request().url()).hostname === "www.google.com"
          await route.fulfill({
            contentType: "text/html",
            body: challenge
              ? `<h1>Generated verification fixture</h1><button onclick="parent.postMessage('fixture-verified','*')">Complete synthetic verification</button>`
              : `<h1>Generated employer fixture</h1><button onclick="window.fixtureSubmissions=(window.fixtureSubmissions||0)+1;this.remove();document.querySelector('iframe').hidden=false">Submit application</button><iframe hidden src="https://www.google.com/recaptcha/api2/bframe"></iframe><script>addEventListener('message',e=>{if(e.data==='fixture-verified'){document.querySelector('iframe').remove();document.body.insertAdjacentHTML('beforeend','<p>Your application has been received.</p>')}})</script>`,
          })
        })
        const page = await context.newPage()
        await page.goto("https://generated-employer.example/application")
        let intents = 0,
          receipts = 0,
          human = 0
        const clear = async () => {
          await page
            .frameLocator("iframe")
            .getByRole("button", { name: "Complete synthetic verification" })
            .click()
          await page.locator("iframe").waitFor({ state: "detached" })
        }
        const unbindUpload = bindDocumentUpload(
          context,
          async () => "/tmp/generated-resume.pdf"
        )
        const unbindSolver = bindCaptchaSolver(context, async () => {
          assert.equal(
            (await readVerificationView(page, true, false)).mode,
            "challenge"
          )
          if (fallback) throw new ApplicationCaptchaError()
          await clear()
          return { solved: true, instruction: "Generated verification cleared" }
        })
        const unbindAgent = bindBrowserUse(context, async (run) => {
          await run.execute("begin_submission", {})
          await page
            .getByRole("button", { name: "Submit application", exact: true })
            .click()
          await run.execute(tool, {})
          await run.execute("report_submission", {
            text: "Your application has been received.",
          })
        })
        try {
          const result = runNativeApplication(page, packet, {
            codeVerificationOnly: codeOnly,
            sessionId: "generated-fixture",
            savedAnswers: async () => ({}),
            reserveDecision: async () => {},
            beginSubmission: async () => {
              intents++
            },
            humanVerification: async (ready) => {
              assert.equal(await ready(), false)
              human++
              await clear()
              assert.equal(await ready(), true)
            },
            recordReceipt: async (_packet, receipt) => {
              receipts++
              assert.equal(receipt.text, "Your application has been received.")
            },
          })
          if (codeOnly && fallback)
            await assert.rejects(result, ApplicationCaptchaError)
          else assert.equal((await result).needsAnswers, false)
          assert.equal(intents, 1)
          assert.equal(receipts, codeOnly && fallback ? 0 : 1)
          assert.equal(human, !codeOnly && fallback ? 1 : 0)
          assert.equal(await page.evaluate("window.fixtureSubmissions"), 1)
          checks++
        } finally {
          unbindAgent()
          unbindSolver()
          unbindUpload()
          await context.close()
        }
      }
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      noEmployerContacted: true,
      noRealChallengeSolved: true,
    })
  )
} finally {
  await browser.close()
}
