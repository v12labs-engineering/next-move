import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"
import { chromium, type Frame, type Page } from "playwright-core"
import { readNativeReceipt } from "../lib/server/applications/native-receipt"

function fixture(body: string, requiredInputs = 0) {
  const page = {
    context: () => ({ pages: () => [page] }),
    frames: () => [],
    mainFrame: () => ({}),
    url: () => "https://employer.example/application",
    locator: () => ({
      innerText: async () => body,
      count: async () => requiredInputs,
    }),
  } as unknown as Page
  return page
}

for (const body of [
  "Once your application is submitted, you will receive an email.",
  "We will contact you after your application has been received.",
  "Application submitted? Read our FAQ.",
])
  test(`instructions are not receipts: ${body}`, async () => {
    assert.equal(await readNativeReceipt(fixture(body)), null)
  })

test("success text cannot confirm a still-editable required application form", async () => {
  assert.equal(
    await readNativeReceipt(fixture("Your application has been received.", 1)),
    null
  )
})

test("completed receipt with optional newsletter controls remains valid", async () => {
  assert.ok(
    await readNativeReceipt(fixture("Your application has been received."))
  )
})

for (const text of [
  "Your application was submitted successfully and we will contact you soon.",
  "Your application has been received; you may close this page.",
  "After reviewing your application, we have received your application.",
])
  test(`confirmation can include follow-up instructions: ${text}`, async () => {
    assert.ok(await readNativeReceipt(fixture(text)))
  })

test("a transient control inspection failure is retried without inventing a receipt", async () => {
  const page = fixture("Your application has been received.")
  let checks = 0
  page.locator = (() => ({
    innerText: async () => "Your application has been received.",
    count: async () => {
      if (++checks === 1) throw new Error("Frame detached")
      return 0
    },
  })) as unknown as Page["locator"]
  assert.ok(await readNativeReceipt(page, undefined, 500))
  assert.equal(checks, 2)
})

test("receipt text inside a hidden ancestor iframe is not visible evidence", async () => {
  const page = fixture("")
  const root = { parentFrame: () => null }
  const hidden = {
    parentFrame: () => root,
    frameElement: async () => ({
      isVisible: async () => false,
      dispose: async () => {},
    }),
  }
  const frame = {
    parentFrame: () => hidden,
    frameElement: async () => ({
      isVisible: async () => true,
      dispose: async () => {},
    }),
    locator: () => ({
      innerText: async () => "Your application has been received.",
      count: async () => 0,
    }),
    url: () => "https://ats.example/receipt",
  } as unknown as Frame
  page.frames = () => [frame]
  assert.equal(await readNativeReceipt(page), null)
})

test("real DOM receipt checks distinguish forms, newsletter fields and hidden nested frames", async () => {
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      (existsSync(macChrome) ? macChrome : chromium.executablePath()),
    headless: true,
  })
  try {
    const page = await browser.newPage()
    await page.setContent(
      '<p>Once your application is submitted, you will receive an email.</p><form><input type="email" required><button>Submit application</button></form>'
    )
    assert.equal(await readNativeReceipt(page), null)
    await page.setContent(
      '<p>Your application has been received.</p><form><input type="email" required><button>Submit application</button></form>'
    )
    assert.equal(await readNativeReceipt(page), null)
    await page.setContent(
      '<p>Your application has been received; you may close this page.</p><footer><form><input type="email" required><button>Subscribe</button></form></footer>'
    )
    assert.ok(await readNativeReceipt(page))
    const inner = "<p>Your application has been received.</p>"
    const outer = `<iframe srcdoc="${inner.replaceAll('"', "&quot;")}"></iframe>`
    await page.setContent(
      `<iframe style="display:none" srcdoc="${outer.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`
    )
    await page.waitForFunction(() =>
      document
        .querySelector("iframe")
        ?.contentDocument?.querySelector("iframe")
        ?.contentDocument?.body.innerText.includes("received")
    )
    assert.equal(await readNativeReceipt(page), null)
  } finally {
    await browser.close()
  }
})
