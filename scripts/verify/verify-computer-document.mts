import assert from "node:assert/strict"
import { chromium, type Page } from "playwright-core"
import { ComputerBrowser } from "../../lib/server/applications/computer-browser"
import { bindComputerFields } from "../../lib/server/applications/computer-fields"

// Generated DOM only: no accounts, model calls, provider secrets or employer traffic.
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  const page: Page = await browser.newPage()
  for (const type of ["radio", "checkbox"] as const) {
    const question =
      type === "radio"
        ? "Are you authorized to work in the US?"
        : "Which locations do you approve?"
    await page.setContent(
      `<form><section><p>${question}</p><div><label><input type="${type}" name="choices" value="Yes">Yes</label></div><div><label><input type="${type}" name="choices" value="No">No</label></div></section><label><input type="checkbox" name="consent">I agree to processing my application</label></form>`
    )
    const computer = new ComputerBrowser(page)
    const screen = await computer.observe()
    const choices = screen.controls.filter((c) => c.name === "choices")
    assert.equal(choices.length, 2)
    assert.deepEqual(
      choices.map((c) => c.group),
      [question, question]
    )
    const [binding] = bindComputerFields(
      computer,
      screen.epoch,
      [
        {
          targets: choices.map((c) => c.target),
          label: question,
          kind: type,
          required: false,
          options: ["Yes", "No"],
        },
      ],
      0
    )
    assert.equal(binding.field.label, question)
    assert.deepEqual(binding.field.options, ["Yes", "No"])
    assert.match(
      screen.controls.find((c) => c.name === "consent")!.label,
      /I agree/
    )
  }
  await page.setContent(
    `<form><section><label>May we share your information? *</label><div><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="true">No</button><input type="checkbox" tabindex="-1" name="sharing"></div></section><label><input type="checkbox" name="consent">I agree to processing my application</label></form>`
  )
  const computer = new ComputerBrowser(page)
  const screen = await computer.observe()
  const choices = screen.controls.filter((c) => c.name === "sharing")
  assert.equal(
    choices.length,
    2,
    "Only the two actual Yes/No controls represent the backing checkbox"
  )
  assert.ok(choices.every((c) => c.tag === "button" && c.selectionObservable))
  const [binding] = bindComputerFields(
    computer,
    screen.epoch,
    [
      {
        targets: choices.map((c) => c.target),
        label: "May we share your information?",
        kind: "radio",
        required: true,
        options: [],
      },
    ],
    0
  )
  assert.equal(binding.field.id, "sharing")
  assert.equal(binding.field.kind, "yesno")
  assert.equal(choices.find((c) => c.label === "No")?.checked, true)
  assert.ok(
    screen.controls.some((c) => c.name === "consent" && c.type === "checkbox")
  )
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "wrapped radio choices retain their question",
        "wrapped checkbox choices retain their question",
        "separate consent is not grouped",
        "Yes/No button backing checkbox is not a separate question",
      ],
    })
  )
} finally {
  await browser.close()
}
