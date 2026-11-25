// Real Browser Use + model + Chrome on Boat; fictional data and local receiver.
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { getVercelOidcToken } from "@vercel/oidc"
import { withBoatSession } from "../../lib/server/applications/boat-session"
import {
  runNativeApplication,
  solveCaptcha,
} from "../../lib/server/applications/native-agent"
import type { ApplicationPacket } from "../../lib/applications"
const env = parseEnv(await readFile(".env.staging.local", "utf8"))
for (const key of [
  "TAILORING_BASE_URL",
  "TAILORING_MODEL",
  "TAILORING_API_KEY",
  "BROWSER_USE_MODEL",
  "TWOCAPTCHA_API_KEY",
])
  if (env[key]) process.env[key] = env[key]
process.env.VERCEL_OIDC_TOKEN = await getVercelOidcToken({
  project: "prj_y2XdyM0PSbTvcLIT70cX9pKTz6CE",
  team: "team_xP5ofTY8NOOv2tFfvu6RJrBL",
})
const began = Date.now()
const report: Record<string, unknown> = {}
try {
  await withBoatSession(
    async (browser, id) => {
      report.sessionId = id
      const page = await browser.contexts()[0].newPage()
      if (process.argv.includes("--captcha")) {
        await page.goto("https://2captcha.com/demo/recaptcha-v2", {
          waitUntil: "domcontentloaded",
        })
        await page
          .frameLocator('iframe[src*="recaptcha"][src*="anchor"]')
          .locator("#recaptcha-anchor")
          .waitFor({ state: "visible", timeout: 30000 })
        const result = await solveCaptcha(page, Date.now() + 260000)
        assert.equal(result.solved, true)
        const token = await page
          .locator('[name="g-recaptcha-response"]')
          .inputValue()
        assert.ok(
          token.length > 20,
          "reCAPTCHA must produce a verified response token"
        )
        report.captchaSolved = true
      } else {
        await page.route("https://synthetic.example/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<h1>Synthetic Engineer at Test Company</h1><form onsubmit="event.preventDefault();window.submissions=(window.submissions||0)+1;document.body.innerHTML='<h1>Your application has been received.</h1>'">
<label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
<label>Country<select name="country" required><option></option><option>Germany</option><option>India</option></select></label>
<fieldset><legend>Work authorization</legend><label><input type="radio" name="authorization" value="Yes" required>Yes</label><label><input type="radio" name="authorization" value="No">No</label></fieldset>
<label>Experience<textarea name="experience" required></textarea></label><label>Resume<input type="file" name="resume" required></label>
<label><input type="checkbox" name="marketing">Optional marketing</label><button type="submit">Submit application</button></form>`,
          })
        )
        await page.goto("https://synthetic.example/application")
        const fields = [
          ["name", "Name", "text", []],
          ["email", "Email", "email", []],
          ["country", "Country", "select", ["Germany", "India"]],
          ["authorization", "Work authorization", "radio", ["Yes", "No"]],
          ["experience", "Experience", "textarea", []],
          ["resume", "Resume", "resume", []],
        ] as const
        const packet: ApplicationPacket = {
          title: "Synthetic Engineer",
          company: "Test Company",
          resume:
            "Test Candidate\nSynthetic QA engineer. Built TypeScript APIs and SQL services.",
          fields: fields.map(([id, label, kind, options]) => ({
            id,
            label,
            kind,
            options: [...options],
            required: true,
            help: "",
          })),
          answers: {
            name: "Test Candidate",
            email: "synthetic@example.test",
            country: "Germany",
            authorization: "No",
            experience: "Built TypeScript APIs and SQL services.",
          },
          notices: "",
          formHash: "synthetic",
          tailored: true,
        }
        let intent = 0,
          receipts = 0,
          turns = 0
        const result = await runNativeApplication(page, packet, {
          sessionId: id,
          deadline: Date.now() + 400000,
          reserveDecision: async () => {
            assert.ok(++turns <= 60)
          },
          savedAnswers: async () => packet,
          beginSubmission: async () => {
            intent++
            for (const name of ["name", "email", "country", "experience"])
              assert.equal(
                await page.locator(`[name="${name}"]`).inputValue(),
                packet.answers[name]
              )
            assert.equal(
              await page
                .locator('[name="authorization"][value="No"]')
                .isChecked(),
              true
            )
            assert.equal(
              await page.locator('[name="marketing"]').isChecked(),
              false
            )
            assert.equal(
              await page
                .locator('[name="resume"]')
                .evaluate((el: HTMLInputElement) => el.files?.length),
              1
            )
          },
          recordReceipt: async () => {
            receipts++
          },
        })
        assert.equal(result.needsAnswers, false)
        assert.equal(intent, 1)
        assert.equal(receipts, 1)
        assert.equal(await page.evaluate("window.submissions"), 1)
        Object.assign(report, {
          formFilled: true,
          resumeUploaded: true,
          submissionCount: 1,
          receiptVerified: true,
          turns,
        })
      }
    },
    { env }
  )
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error instanceof Error ? error.message : "failed"
  process.exitCode = 1
}
report.elapsedMs = Date.now() - began
await writeFile(
  process.argv.includes("--captcha")
    ? "/private/tmp/boat-captcha-result.json"
    : "/private/tmp/boat-form-result.json",
  JSON.stringify(report, null, 2)
)
console.log(report)
