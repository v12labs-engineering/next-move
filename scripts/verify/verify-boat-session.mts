import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { withBoatSession } from "../../lib/server/applications/boat-session"
const env = parseEnv(await readFile(".env.staging.local", "utf8"))
const began = Date.now()
await withBoatSession(
  async (browser, id) => {
    await writeFile(
      "/private/tmp/job-boat-test-session.json",
      JSON.stringify({ id }),
      { mode: 0o600 }
    )
    const page = await browser.contexts()[0].newPage()
    await page.goto('data:text/html,<h1>Boat test</h1><input name="test">')
    await page.locator("input").fill("synthetic")
    assert.equal(await page.locator("input").inputValue(), "synthetic")
    console.log({ passed: true, sessionId: id, elapsedMs: Date.now() - began })
  },
  { env }
)
