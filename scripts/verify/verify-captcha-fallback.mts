import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { ComputerBrowser } from "../../lib/server/applications/computer-browser"

// Owned synthetic pages and a fake provider: no employer, real CAPTCHA, account,
// or paid service is contacted. Exercise the real cross-origin DOM and pixels.
const browser = await chromium.launch({
  executablePath:
    process.env.APPLICATION_TEST_CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
})
const originalFetch = globalThis.fetch
const originalKey = process.env.TWOCAPTCHA_API_KEY
let creates = 0,
  polls = 0
process.env.TWOCAPTCHA_API_KEY = "synthetic-only-key"
try {
  const context = await browser.newContext()
  const image = (i: number) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${[0, 8].includes(i) ? "blue" : "gray"}"/></svg>`)}`
  const challenge = `<style>body{margin:0}table{border-collapse:collapse}td{padding:0;width:100px;height:100px}img{display:block;width:100px;height:100px}.rc-imageselect-tileselected{outline:3px solid blue;outline-offset:-3px}</style>
    ${process.argv.includes("--animated") ? "<style>@keyframes selectedPulse{from{filter:brightness(0.3)}to{filter:brightness(1)}}.rc-imageselect-tileselected{animation:selectedPulse 800ms linear}</style>" : ""}
    <div class="rc-imageselect-desc-wrapper">Select all blue squares</div>
    <table>${[0, 1, 2].map((r) => `<tr>${[0, 1, 2].map((c) => `<td class="tile${r * 3 + c === 0 ? " rc-imageselect-tileselected" : ""}" data-index="${r * 3 + c}"><img src="${image(r * 3 + c)}"></td>`).join("")}</tr>`).join("")}</table>
    <button id="verify">Verify</button>
    <script>document.querySelectorAll('.tile').forEach(t=>t.onclick=()=>t.classList.toggle('rc-imageselect-tileselected'));document.querySelector('#verify').onclick=()=>{const a=[...document.querySelectorAll('.rc-imageselect-tileselected')].map(t=>Number(t.dataset.index));if(JSON.stringify(a)==='[0,8]')parent.postMessage('fixture-verified','*')}</script>`
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (
      url.hostname === "www.google.com" &&
      url.pathname === "/recaptcha/api2/bframe"
    )
      return await route.fulfill({ contentType: "text/html", body: challenge })
    assert.equal(url.href, "https://captcha-fixture.test/application")
    await route.fulfill({
      contentType: "text/html",
      body: `<input value="private-synthetic-application-answer"><iframe src="https://www.google.com/recaptcha/api2/bframe" style="width:340px;height:410px"></iframe><button id="submit">Submit application</button><output id="result"></output><script>document.body.dataset.submissions='0';document.querySelector('#submit').onclick=()=>document.body.dataset.submissions=String(Number(document.body.dataset.submissions)+1);window.onmessage=e=>{if(e.data==='fixture-verified'){document.querySelector('iframe').style.display='none';document.querySelector('#result').textContent='verified'}}</script>`,
    })
  })
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, "https://api.2captcha.com")
    const body = JSON.parse(String(init?.body))
    if (url.pathname === "/createTask") {
      creates++
      assert.equal(body.task.comment, "Select all blue squares")
      const png = Buffer.from(body.task.body, "base64")
      assert.equal(png.readUInt32BE(16), 300)
      assert.equal(png.readUInt32BE(20), 300)
      return Response.json({ errorId: 0, taskId: 1 })
    }
    assert.equal(url.pathname, "/getTaskResult")
    polls++
    return Response.json({
      errorId: 0,
      status: "ready",
      solution: { click: [1, 9] },
    })
  }
  const page = await context.newPage()
  await page.goto("https://captcha-fixture.test/application")
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "Verify", exact: true })
    .waitFor()
  await new ComputerBrowser(page).waitForCaptcha()
  assert.equal(await page.locator("#result").textContent(), "verified")
  assert.equal(await page.locator("body").getAttribute("data-submissions"), "0")
  assert.equal(creates, 1)
  assert.equal(polls, 1)
  console.log(
    JSON.stringify({
      passed: true,
      browser: "Chromium",
      provider: "synthetic",
      grid: "3x3",
      croppedImage: "300x300",
      employerSubmissions: 0,
      creates,
      polls,
    })
  )
} finally {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.TWOCAPTCHA_API_KEY
  else process.env.TWOCAPTCHA_API_KEY = originalKey
  await browser.close()
}
