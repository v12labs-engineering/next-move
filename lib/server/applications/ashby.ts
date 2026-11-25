import type { ApplicationField, ApplicationPacket } from "@/lib/applications"
import { resumeFile, type ApplicationSurface } from "./browser"

export const fieldGroups =
  ".ashby-application-form-field-entry,fieldset.ashby-application-form-input-radio-group,fieldset.ashby-application-form-input-checkbox-group"
// Runs in the browser: DOM only. No employer scripts, prompts or hidden state are
// interpreted as instructions. Unknown controls are retained for manual fallback.
export function readAshbyForm() {
  const fields = Array.from(
    document.querySelectorAll(
      ".ashby-application-form-field-entry,fieldset.ashby-application-form-input-radio-group,fieldset.ashby-application-form-input-checkbox-group"
    )
  ).map((entry) => {
    const label = entry.querySelector<HTMLLabelElement>(":scope > label")
    const input = entry.querySelector<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input,textarea,select")
    const id = label?.htmlFor || input?.id || ""
    const required =
      !!input?.required ||
      !!label?.className.match(/(?:^|\s)_required_/) ||
      label?.getAttribute("data-required") === "true"
    const title =
      label?.innerText.trim() ||
      entry.querySelector<HTMLElement>("p")?.innerText.trim() ||
      "Unidentified employer question"
    const options = Array.from(
      entry.querySelectorAll<HTMLLabelElement>(
        ".ashby-application-form-input-radio-group-option-label,.ashby-application-form-input-checkbox-group-option-label"
      )
    ).map((el) => el.innerText.trim())
    let kind: ApplicationField["kind"] = "unsupported"
    if (entry.querySelector(".ashby-application-form-input-yesno")) {
      kind = "yesno"
      options.push("Yes", "No")
    } else if (entry.matches("fieldset"))
      kind = entry.querySelector('input[type="radio"]') ? "radio" : "checkbox"
    else if (input?.tagName === "TEXTAREA") kind = "textarea"
    else if (input?.tagName === "SELECT") {
      kind = "select"
      options.push(
        ...Array.from((input as HTMLSelectElement).options)
          .filter((o) => o.value)
          .map((o) => o.text.trim())
      )
    } else if (input?.type === "file")
      kind = id === "_systemfield_resume" ? "resume" : "unsupported"
    else if (
      input &&
      !entry.querySelector('[role="combobox"]') &&
      ["text", "email", "url", "tel", "number"].includes(input.type)
    )
      kind = input.type as ApplicationField["kind"]
    const help = Array.from(entry.querySelectorAll("p"))
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 5000)
    return { id, label: title.slice(0, 2000), help, kind, required, options }
  })
  // Employer limits and privacy terms are visible during approval. Bound the
  // surrounding form text; don't take a full job page containing unrelated data.
  const container = document.querySelector<HTMLElement>(
    ".ashby-application-form-container"
  )
  for (const [index, control] of Array.from(
    container?.querySelectorAll<HTMLInputElement>("input,textarea,select") || []
  ).entries()) {
    if (
      control.type !== "hidden" &&
      !control.closest(
        ".ashby-application-form-field-entry,fieldset.ashby-application-form-input-radio-group,fieldset.ashby-application-form-input-checkbox-group"
      )
    ) {
      fields.push({
        id: `unmapped-${index}`,
        label: "Unrecognized employer field · Manual application required",
        help: "",
        kind: "unsupported",
        required: true,
        options: [],
      })
    }
  }
  const notices = (container?.parentElement?.innerText || "").slice(0, 15000)
  return { fields, notices }
}
export async function fillApprovedForm(
  page: ApplicationSurface,
  packet: ApplicationPacket,
  discoverConditional = false
) {
  for (const field of packet.fields) {
    const value = packet.answers[field.id]
    const values = Array.isArray(value) ? value : value?.trim() ? [value] : []
    const group = page.locator(fieldGroups).filter({
      has: page.locator(
        `label[for=${JSON.stringify(field.id)}],input[id=${JSON.stringify(field.id)}],textarea[id=${JSON.stringify(field.id)}],select[id=${JSON.stringify(field.id)}]`
      ),
    })
    if (field.kind === "resume") {
      await group
        .locator('input[type="file"]')
        .setInputFiles(await resumeFile(packet.resume))
    } else if (field.kind === "unsupported") {
      if (field.required || values.length)
        throw new Error("Unsupported question")
      const prefilled = await group
        .locator("input,textarea,select")
        .evaluateAll((controls) =>
          controls.some((control) => {
            const input = control as HTMLInputElement
            return ["checkbox", "radio"].includes(input.type)
              ? input.checked
              : !!input.value
          })
        )
      if (prefilled) throw new Error("Unsupported default answer")
    } else if (field.kind === "radio" || field.kind === "checkbox") {
      for (const option of field.options) {
        const input = group.getByLabel(option, { exact: true })
        if (field.kind === "checkbox")
          await input.setChecked(values.includes(option))
        else if (values.includes(option)) await input.check()
      }
      if (
        !values.length &&
        field.kind === "radio" &&
        (await group.locator("input:checked").count())
      )
        throw new Error("Unapproved default answer")
    } else if (field.kind === "yesno") {
      if (values.length)
        await group
          .getByRole("button", { name: values[0], exact: true })
          .click()
      else if (await group.locator('button[aria-pressed="true"]').count())
        throw new Error("Unapproved default answer")
    } else if (field.kind === "select") {
      if (values.length)
        await group.locator("select").selectOption({ label: values[0] })
      else await group.locator("select").selectOption("")
    } else await group.locator("input,textarea").fill(values[0] || "")
  }
  if (discoverConditional) return
  // Conditional questions must be reviewed too. Do not submit a newly revealed
  // control, even when the old packet happened to have sufficient answers.
  const current = await page.evaluate(readAshbyForm)
  if (JSON.stringify(current.fields) !== JSON.stringify(packet.fields))
    throw new Error("Form changed after answers")
  const invalid = await page
    .locator("input:invalid,textarea:invalid,select:invalid")
    .count()
  if (invalid) throw new Error("Employer rejected a field")
}
