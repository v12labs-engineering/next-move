import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { ComputerBrowser } from "../../lib/server/applications/computer-browser"
import { bindComputerFields } from "../../lib/server/applications/computer-fields"
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  const page = await browser.newPage()
  await page.route("**/*", (route) => route.abort())
  await page.setContent(`<form>
 <div><label>Earliest start date</label><div><div><input placeholder="Pick date..." required></div></div></div>
 <div><label>Interview availability date</label><div><div><input placeholder="Pick date..." required></div></div></div>
 <div><label>Contact details</label><input placeholder="First"><input placeholder="Last"></div>
 <div><label>Phone</label><input aria-label="Country" role="combobox"><input aria-label="Number"></div>
 </form>`)
  const cb = new ComputerBrowser(page)
  const screen = await cb.observe({ screenshot: false })
  const controls = screen.controls.filter((c) => c.tag === "input")
  assert.equal(controls[0].label, "Earliest start date")
  assert.equal(controls[1].label, "Interview availability date")
  assert.equal(controls[2].label, "First")
  assert.equal(controls[3].label, "Last")
  assert.equal(controls[4].label, "Country")
  const fields = bindComputerFields(
    cb,
    screen.epoch,
    controls.map((c) => ({
      targets: [c.target],
      label: c.label,
      kind: c.role === "combobox" ? "combobox" : "text",
      required: c.required,
      options: [],
    })),
    0
  )
  assert.notEqual(fields[0].field.id, fields[1].field.id)
  console.log(
    "Verified distinct date question labels and composite-control boundaries; no external requests or submissions."
  )
} finally {
  await browser.close()
}
