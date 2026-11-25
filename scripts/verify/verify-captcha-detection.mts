// Real nested frames and controls; all HTTPS requests are fulfilled locally.
// No real CAPTCHA, provider request, candidate data or employer submission.
import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { employerAccessGate } from "../../lib/server/applications/browser"
import { readVerificationView } from "../../lib/server/applications/verification-surface"
import { solveCaptcha } from "../../lib/server/applications/native-agent"

const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
})
try {
  const page = await browser.newPage()
  let mode: "grid" | "checkbox" | "badge" = "grid"
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url())
    const body =
      u.hostname === "synthetic.example"
        ? '<iframe src="https://embedded.example/form" width="600" height="600"></iframe>'
        : u.hostname === "embedded.example"
          ? `<iframe src="https://www.google.com/recaptcha/api2/${mode === "grid" ? "bframe" : "anchor"}" width="400" height="400"></iframe>`
          : mode === "grid"
            ? '<table><tr><td><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22/%3E"></td></tr></table><button>Verify</button>'
            : mode === "checkbox"
              ? '<div id="recaptcha-anchor" role="checkbox" aria-checked="false" style="width:30px;height:30px;border:1px solid" onclick="this.setAttribute(\'aria-checked\',\'true\')">Check</div>'
              : "<p>Protected by reCAPTCHA</p>"
    return route.fulfill({ contentType: "text/html", body })
  })
  const open = async () => {
    await page.goto("https://synthetic.example/application", {
      waitUntil: "networkidle",
    })
    assert.equal(page.frames().length, 3)
  }
  await open()
  assert.equal(await page.locator('iframe[src*="bframe"]').count(), 0)
  assert.equal(await employerAccessGate(page), "challenge")
  const view = await readVerificationView(page, false, false)
  assert.equal(view.mode, "challenge")
  assert.equal(view.image.length, 0)
  await page.locator("iframe").evaluate((el) => {
    ;(el as HTMLElement).style.display = "none"
  })
  assert.equal(await employerAccessGate(page), null)
  mode = "checkbox"
  await open()
  assert.equal(await employerAccessGate(page), null)
  assert.equal(await employerAccessGate(page, true), "challenge")
  assert.equal((await solveCaptcha(page, Date.now() + 10_000)).solved, true)
  assert.equal(await employerAccessGate(page, true), null)
  mode = "badge"
  await open()
  assert.equal(await employerAccessGate(page, true), null)
  console.log(
    JSON.stringify({
      passed: true,
      nestedGrid: true,
      hiddenAncestorIgnored: true,
      metadataHasNoImage: true,
      checkboxActivated: true,
      checkedAnchorIgnored: true,
      passiveBadgeIgnored: true,
    })
  )
} finally {
  await browser.close()
}
