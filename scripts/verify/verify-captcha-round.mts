// Isolated synthetic CAPTCHA/provider: no employer or real solver traffic.
import assert from "node:assert/strict"
import { chromium, type Browser } from "playwright-core"
import { readFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { withBoatSession } from "../../lib/server/applications/boat-session"
import { tryTwoCaptchaGrid } from "../../lib/server/applications/two-captcha"
const refreshChallenge = process.argv.includes("--refresh")
async function verify(browser: Browser, boatId?: string) {
  const previousKey = process.env.TWOCAPTCHA_API_KEY
  const previousFetch = globalThis.fetch
  try {
    process.env.TWOCAPTCHA_API_KEY = "synthetic-only"
    const page = await browser.newPage()
    const pixels =
      'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="30" height="30"%3E%3Crect width="30" height="30" fill="blue"/%3E%3C/svg%3E'
    const reload = refreshChallenge
      ? `<button aria-label="Get a new challenge" onclick="document.body.dataset.refreshes='1';document.querySelectorAll('img').forEach(img=>img.src=img.src.replace('blue','red'))">Reload</button>`
      : ""
    const html = `<div class="rc-imageselect-desc-wrapper">Select all images with bicycles</div><table>${Array.from({ length: 3 }, () => `<tr>${Array.from({ length: 3 }, () => `<td onclick="this.classList.add('rc-imageselect-tileselected')"><img src='${pixels}'></td>`).join("")}</tr>`).join("")}</table>${reload}<button onclick="document.body.dataset.cleared='true';parent.postMessage('clear','*')">Verify</button>`
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().includes("/bframe")
          ? html
          : '<input id="candidate" value="Synthetic Candidate"><input id="resume" type="file"><script>onmessage=()=>document.querySelector("iframe").style.display="none"</script><iframe src="https://www.google.com/recaptcha/api2/bframe" width="400" height="400"></iframe>',
      })
    )
    await page.goto("https://synthetic.example/", { waitUntil: "networkidle" })
    await page
      .locator("#resume")
      .setInputFiles({
        name: "fixture.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("Synthetic resume attachment"),
      })
    const frame = page.frames().find((f) => f.url().includes("/bframe"))!
    let captures = 0
    const locator = frame.locator.bind(frame)
    frame.locator = (...args: Parameters<typeof frame.locator>) => {
      const result = locator(...args)
      const screenshot = result.screenshot.bind(result)
      result.screenshot = (...args: Parameters<typeof result.screenshot>) => {
        captures++
        return screenshot(...args)
      }
      return result
    }
    let polls = 0
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).origin, "https://api.2captcha.com")
      const request = JSON.parse(String(init?.body))
      if (String(input).endsWith("createTask")) {
        assert.equal(request.task.rows, 3)
        assert.ok(request.task.body.length)
        return Response.json({ errorId: 0, taskId: 1 })
      }
      if (refreshChallenge && polls++ === 0)
        return Response.json({ errorId: 12 })
      return Response.json({
        errorId: 0,
        status: "ready",
        solution: { click: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      })
    }
    const began = Date.now()
    if (boatId) {
      const cdp = await page.context().newCDPSession(page)
      const { targetInfo } = await cdp.send("Target.getTargetInfo")
      await cdp.detach()
      const mock = `let polls=0;globalThis.fetch=async(url)=>Response.json(String(url).endsWith('createTask')?{errorId:0,taskId:1}:${refreshChallenge ? "polls++===0?{errorId:12}:" : ""}{errorId:0,status:'ready',solution:{click:[1,2,3,4,5,6,7,8,9]}})`
      const config =
        JSON.stringify({
          pageId: targetInfo.targetId,
          key: "synthetic-only",
          timeoutMs: 30000,
        }) + "\n"
      const env = parseEnv(await readFile(".env.staging.local", "utf8"))
      const command = `cd /home/user/application-worker && echo '${Buffer.from(mock).toString("base64")}' | base64 -d > /tmp/mock-captcha.mjs && echo '${Buffer.from(config).toString("base64")}' | base64 -d | node --import /tmp/mock-captcha.mjs captcha-worker.mjs`
      const response = await previousFetch(
        `https://boat.dev/api/v1/sandboxes/${boatId}/commands`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.BOAT_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ command, timeoutSeconds: 45 }),
        }
      )
      assert.equal(response.ok, true)
      const result = await response.json()
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line))
      assert.equal(
        events.find(
          (e: { type: string; result?: { solved: boolean } }) =>
            e.type === "result"
        )?.result.solved,
        true,
        JSON.stringify(events)
      )
    } else {
      assert.equal(
        await tryTwoCaptchaGrid(
          page,
          () => frame.evaluate(() => document.body.dataset.cleared === "true"),
          Date.now() + 30000
        ),
        true
      )
    }
    assert.equal(await frame.locator(".rc-imageselect-tileselected").count(), 9)
    if (!boatId) assert.equal(captures, refreshChallenge ? 2 : 1)
    assert.equal(
      await page.locator("#candidate").inputValue(),
      "Synthetic Candidate"
    )
    assert.equal(
      await page
        .locator("#resume")
        .evaluate((input: HTMLInputElement) => input.files?.[0]?.name),
      "fixture.pdf"
    )
    if (refreshChallenge)
      assert.equal(
        await frame.evaluate(() => document.body.dataset.refreshes),
        "1"
      )
    console.log(
      JSON.stringify({
        passed: true,
        tiles: 9,
        gridCaptures: boatId ? undefined : captures,
        solverHost: boatId ? "boat" : "local",
        refreshedChallenge: refreshChallenge,
        savedInputsPreserved: true,
        elapsedMs: Date.now() - began,
      })
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.TWOCAPTCHA_API_KEY
    else process.env.TWOCAPTCHA_API_KEY = previousKey
  }
}
if (process.argv.includes("--boat")) {
  const env = parseEnv(await readFile(".env.staging.local", "utf8"))
  await withBoatSession(verify, { env })
} else {
  const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  })
  try {
    await verify(browser)
  } finally {
    await browser.close()
  }
}
