import { createInterface } from "node:readline"
import { chromium } from "playwright-core"
import { solveCaptcha } from "../../lib/server/applications/captcha-solver"
const input = JSON.parse(
  (
    await createInterface({ input: process.stdin })
      [Symbol.asyncIterator]()
      .next()
  ).value || "{}"
)
console.info = (message, data) =>
  process.stdout.write(JSON.stringify({ type: "log", message, data }) + "\n")
let browser
try {
  if (input.key) process.env.TWOCAPTCHA_API_KEY = input.key
  else delete process.env.TWOCAPTCHA_API_KEY
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    throw new Error("Invalid browser port")
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${input.port}`)
  let page
  for (const candidate of browser.contexts()[0].pages()) {
    const cdp = await candidate.context().newCDPSession(candidate)
    try {
      const { targetInfo } = await cdp.send("Target.getTargetInfo")
      if (targetInfo.targetId === input.pageId) page = candidate
    } finally {
      await cdp.detach()
    }
  }
  if (!page) throw new Error("Missing current page")
  const result = await solveCaptcha(
    page,
    Date.now() + Math.min(260000, input.timeoutMs),
    input.context
  )
  process.stdout.write(JSON.stringify({ type: "result", result }) + "\n")
} catch {
  process.stdout.write(JSON.stringify({ type: "failure" }) + "\n")
  process.exitCode = 1
} finally {
  await browser?.close()
}
