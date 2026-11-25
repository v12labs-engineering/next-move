import {
  missingAnswers,
  packetSchema,
  formFieldSchema,
  type ApplicationField,
  type ApplicationPacket,
} from "@/lib/applications"
import { readAshbyForm, fillApprovedForm } from "./ashby"
import {
  formHash,
  resumeFile,
  finalSubmitControl,
  type ApplicationSurface,
} from "./browser"

function sameFields(a: ApplicationField[], b: ApplicationField[]) {
  return (
    JSON.stringify(a.map((f) => formFieldSchema.parse(f))) ===
    JSON.stringify(b.map((f) => formFieldSchema.parse(f)))
  )
}

// Serialized into the managed browser. Read only the application form, never
// interpret employer text as instructions, and retain unknown required controls.
export function readNativeForm(step: number) {
  const roots = Array.from(
    document.querySelectorAll<HTMLElement>('form,[role="form"]')
  ).filter(
    (root) =>
      root.getClientRects().length &&
      getComputedStyle(root).visibility !== "hidden"
  )
  if (!roots.length)
    roots.push(
      ...Array.from(
        document.querySelectorAll<HTMLElement>("main,article")
      ).filter((el) => el.querySelector('input[type="file"]'))
    )
  const ranked = roots
    .map((root) => {
      const text = root.innerText || ""
      const inputs = Array.from(
        root.querySelectorAll<HTMLInputElement>("input")
      )
      const email = inputs.some(
        (e) =>
          e.type === "email" ||
          /email/i.test(`${e.id} ${e.name} ${e.autocomplete}`)
      )
      const name = inputs.some((e) =>
        /name/i.test(`${e.id} ${e.name} ${e.autocomplete}`)
      )
      const file = inputs.some((e) => e.type === "file")
      const application =
        /appl(?:y|ication)|resume|curriculum|bewerb|candidat|postuler|solliciteer/i.test(
          text
        )
      const unrelated =
        /newsletter|subscribe|\b(?:sign[ -]?(?:in|up)|log[ -]?in|create account|register)\b/i.test(
          text
        ) && !file
      return {
        root,
        unrelated,
        score: unrelated
          ? 0
          : (file ? 10 : 0) +
            (email ? 4 : 0) +
            (name ? 2 : 0) +
            (application ? 6 : 0),
      }
    })
    .filter(
      (f) => !f.unrelated && (f.score >= 6 || (step > 0 && roots.length === 1))
    )
    .sort((a, b) => b.score - a.score)
  if (!ranked.length) throw new Error("Application form not found")
  if (ranked[1]?.score === ranked[0].score)
    throw new Error("Ambiguous application forms")
  const form = ranked[0].root
  const path = (element: Element) => {
    const parts: string[] = []
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      if (current.id) {
        parts.unshift(`[id=${JSON.stringify(current.id)}]`)
        break
      }
      const tag = current.tagName.toLowerCase()
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (e) => e.tagName === current!.tagName
          )
        : [current]
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`)
    }
    return parts.join(" > ")
  }
  const scope = path(form)
  const fields: ApplicationField[] = []
  const seen = new Set<string>()
  for (const control of Array.from(
    form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input,textarea,select")
  )) {
    if (
      control.type === "hidden" ||
      control.disabled ||
      ["submit", "button", "reset"].includes(control.type)
    )
      continue
    if (
      control.type !== "file" &&
      (!control.getClientRects().length ||
        getComputedStyle(control).visibility === "hidden")
    )
      continue
    const choices = ["radio", "checkbox"].includes(control.type)
    const accessibleName = (
      control.getAttribute("aria-label") ||
      Array.from(control.labels || [])
        .map((l) => l.textContent?.trim())
        .join(" ") ||
      control.getAttribute("placeholder") ||
      ""
    ).trim()
    const rawId =
      choices && control.name
        ? `name:${control.name}`
        : control.id ||
          (control.name
            ? `name:${control.name}`
            : accessibleName
              ? `label:${accessibleName}`
              : "")
    if (!rawId || seen.has(rawId)) {
      if (seen.has(rawId) && choices) continue
      fields.push({
        id: `${step}:unidentified-${fields.length}`,
        label: "Unidentified employer field",
        help: "",
        kind: "unsupported",
        required: true,
        options: [],
        step,
      })
      continue
    }
    seen.add(rawId)
    const selector =
      choices && control.name
        ? `${scope} input[name=${JSON.stringify(control.name)}]`
        : control.id
          ? `${scope} [id=${JSON.stringify(control.id)}]`
          : path(control)
    const members = Array.from(
      form.querySelectorAll<HTMLInputElement>(
        choices && control.name
          ? `input[name=${JSON.stringify(control.name)}]`
          : control.id
            ? `[id=${JSON.stringify(control.id)}]`
            : control.name
              ? `[name=${JSON.stringify(control.name)}]`
              : ":not(*)"
      )
    )
    if (!members.length) members.push(control as HTMLInputElement)
    const group = control.closest(
      "fieldset,.field,.application-question,.input-wrapper,.select__container"
    )
    const text = (accessibleName || control.name || control.id).trim()
    const label = (
      choices && members.length > 1
        ? group?.querySelector("legend")?.textContent?.trim() || text
        : text
    ).slice(0, 2000)
    const required =
      members.some(
        (m) => m.required || m.getAttribute("aria-required") === "true"
      ) || /\*\s*$/.test(label)
    let kind: ApplicationField["kind"] = "unsupported"
    let options: string[] = []
    if (choices) {
      kind = control.type as "checkbox" | "radio"
      options = members.map(
        (m) =>
          Array.from(m.labels || [])
            .map((l) => l.textContent?.trim())
            .join(" ") || m.value
      )
    } else if (control.tagName === "TEXTAREA") kind = "textarea"
    else if (control.tagName === "SELECT") {
      kind = "select"
      options = Array.from((control as HTMLSelectElement).options)
        .filter((o) => o.value && !o.disabled)
        .map((o) => o.text.trim())
    } else if (control.type === "file") {
      kind = /resume|\bcv\b/i.test(`${control.id} ${control.name} ${label}`)
        ? "resume"
        : "unsupported"
    } else if (control.getAttribute("role") === "combobox") kind = "combobox"
    else if (["text", "email", "url", "tel", "number"].includes(control.type)) {
      kind = control.type as ApplicationField["kind"]
      if (/^e-?mail(?: address)?\*?$/i.test(label)) kind = "email"
    }
    fields.push({
      id: `${step}:${rawId}`,
      label,
      help: (
        control.getAttribute("aria-description") ||
        (control.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
      ).slice(0, 5000),
      kind,
      required: kind === "resume" || required,
      options,
      step,
      selector,
      ...(control.autocomplete
        ? { autocomplete: control.autocomplete.slice(0, 100) }
        : {}),
    })
  }
  for (const [index, control] of Array.from(
    form.querySelectorAll<HTMLElement>(
      '[role="combobox"],[contenteditable="true"],[role="checkbox"],[role="radio"]'
    )
  ).entries()) {
    if (
      !control.getClientRects().length ||
      control.matches("input,select") ||
      control.querySelector('input,select,[role="combobox"]')
    )
      continue
    const combo = control.getAttribute("role") === "combobox"
    fields.push({
      id: `${step}:custom-${index}`,
      label:
        control.getAttribute("aria-label") || "Unsupported employer control",
      help: "",
      kind: combo ? "combobox" : "unsupported",
      required: !combo || control.getAttribute("aria-required") === "true",
      options: [],
      step,
      selector: path(control),
    })
  }
  // Exclude dynamic field values and option menus from notices and hashes.
  const copy = form.cloneNode(true) as HTMLFormElement
  copy
    .querySelectorAll(
      "input,textarea,select,[role='listbox'],[class*='single-value']"
    )
    .forEach((e) => e.remove())
  const notices = (copy.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15000)
  return { fields, notices }
}

export async function readEmployerForm(page: ApplicationSurface, step = 0) {
  if (await page.locator(".ashby-application-form-container").count()) {
    const form = await page.evaluate(readAshbyForm)
    return {
      fields: form.fields.map((f) => ({
        ...f,
        id: step ? `${step}:${f.id}` : f.id,
        step,
      })),
      notices: form.notices,
    }
  }
  const form = await page.evaluate(readNativeForm, step)
  // Only required custom selects need their options enumerated. Optional
  // demographic/consent controls remain untouched and blank.
  for (const field of form.fields.filter(
    (f) => f.kind === "combobox" && f.required
  )) {
    const control = page.locator(field.selector!)
    await control.click()
    const options = page.getByRole("option")
    await options.first().waitFor({ state: "visible", timeout: 4000 })
    field.options = (await options.allTextContents())
      .map((s) => s.trim())
      .filter(Boolean)
    await control.press("Escape")
    if (!field.options.length || field.options.length > 500)
      throw new Error("Unsupported employer choices")
  }
  return form
}

export async function fillEmployerForm(
  page: ApplicationSurface,
  packet: ApplicationPacket
) {
  if (!packet.fields.some((f) => f.selector)) {
    // Keep original Ashby packet semantics, including conditional-field checks.
    const { fields } = await page.evaluate(readAshbyForm)
    const answers = Object.fromEntries(
      packet.fields
        .filter((f) => f.id in packet.answers)
        .map((f) => [
          f.step ? f.id.slice(f.id.indexOf(":") + 1) : f.id,
          packet.answers[f.id],
        ])
    )
    await fillApprovedForm(page, { ...packet, fields, answers }, true)
    return
  }
  for (const field of packet.fields) {
    const answer = packet.answers[field.id]
    const values = Array.isArray(answer)
      ? answer
      : answer?.trim()
        ? [answer]
        : []
    if (!field.selector) {
      if (field.required) throw new Error("Unsupported employer control")
      continue
    }
    const control = page.locator(field.selector)
    if (field.kind === "resume")
      await control.setInputFiles(await resumeFile(packet.resume))
    else if (field.kind === "checkbox" || field.kind === "radio") {
      for (const [i, option] of field.options.entries()) {
        if (field.kind === "checkbox")
          await control.nth(i).setChecked(values.includes(option))
        else if (values.includes(option)) await control.nth(i).check()
      }
      if (
        field.kind === "radio" &&
        !values.length &&
        (await control.evaluateAll((nodes) =>
          nodes.some((n) => (n as HTMLInputElement).checked)
        ))
      )
        throw new Error("Unapproved default answer")
    } else if (field.kind === "combobox") {
      if (values.length) {
        await control.click()
        await page.getByRole("option", { name: values[0], exact: true }).click()
      } else {
        const selected = await control.evaluate(
          (el) =>
            !!el
              .closest(".select__control")
              ?.querySelector("[class*='single-value']")
        )
        if (selected) throw new Error("Unapproved default answer")
      }
    } else if (field.kind === "select") {
      await control.selectOption(values.length ? { label: values[0] } : "")
    } else if (field.kind === "unsupported") {
      if (
        field.required ||
        values.length ||
        (await control.evaluateAll((nodes) =>
          nodes.some((n) => !!(n as HTMLInputElement).value)
        ))
      )
        throw new Error("Unsupported employer control")
    } else await control.fill(values[0] || "")
  }
}

export function mergeFormStep(
  packet: ApplicationPacket,
  form: { fields: ApplicationField[]; notices: string },
  step: number
) {
  const previous = packet.fields.filter((f) => (f.step || 0) === step)
  const answers = { ...packet.answers }
  // A changed label/type/options invalidates the old answer. Hidden/removed
  // fields cannot silently retain data that was approved for another question.
  for (const field of previous) {
    if (!form.fields.some((f) => sameFields([f], [field])))
      delete answers[field.id]
  }
  const stepNotices = [...(packet.stepNotices || [])]
  stepNotices[step] = form.notices
  const fields = [
    ...packet.fields.filter((f) => (f.step || 0) !== step),
    ...form.fields,
  ]
  const notices = stepNotices.join("\n\n").slice(0, 15000)
  return packetSchema.parse({
    ...packet,
    fields,
    answers,
    notices,
    stepNotices,
    formHash: formHash(fields, notices),
  })
}

export async function assertNoHumanChallenge(page: ApplicationSurface) {
  if (
    await page
      .locator(
        'input[type="password"]:visible,iframe[src*="bframe"]:visible,iframe[src*="challenge"]:visible'
      )
      .count()
  )
    throw new Error("Human verification required")
}

// Bounded traversal of explicitly labelled Next/Continue steps. The callback
// persists the complete version before the only final-submit action is exposed.
export async function walkEmployerForms(
  page: ApplicationSurface,
  initial: ApplicationPacket,
  options: {
    automatic: boolean
    savedAnswers?: (packet: ApplicationPacket) => Promise<ApplicationPacket>
    beforeSubmit: (packet: ApplicationPacket) => Promise<void>
  }
) {
  let packet = initial
  for (let step = 0; step < 8; step++) {
    for (let conditional = 0; conditional < 8; conditional++) {
      await assertNoHumanChallenge(page)
      const form = await readEmployerForm(page, step)
      const previous = packet.fields.filter((f) => (f.step || 0) === step)
      const changed = !sameFields(previous, form.fields)
      const noticesChanged = packet.stepNotices
        ? packet.stepNotices[step] !== form.notices
        : initial.notices !== form.notices
      packet = mergeFormStep(packet, form, step)
      if (options.savedAnswers) packet = await options.savedAnswers(packet)
      if (
        (!options.automatic && (changed || noticesChanged)) ||
        missingAnswers({
          ...packet,
          fields: form.fields,
          answers: Object.fromEntries(
            form.fields
              .filter((f) => f.id in packet.answers)
              .map((f) => [f.id, packet.answers[f.id]])
          ),
        }).length
      )
        return { packet, needsAnswers: true }
      await fillEmployerForm(page, {
        ...packet,
        fields: form.fields,
        answers: Object.fromEntries(
          form.fields
            .filter((f) => f.id in packet.answers)
            .map((f) => [f.id, packet.answers[f.id]])
        ),
      })
      const after = await readEmployerForm(page, step)
      if (!sameFields(form.fields, after.fields)) {
        if (conditional === 7) throw new Error("Too many conditional questions")
        continue
      }
      if (
        await page
          .locator(
            "input:invalid:visible,textarea:invalid:visible,select:invalid:visible"
          )
          .count()
      )
        throw new Error("Employer rejected a field")
      const next = page.getByRole("button", {
        name: /^(?:Next|Continue|Next step|Save and continue)$/i,
      })
      if (await next.count()) {
        if ((await next.count()) !== 1) throw new Error("Ambiguous next step")
        const signature = await page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>('form,[role="form"]')
          )
            .map(
              (f) =>
                f.innerText +
                Array.from(f.querySelectorAll("input,textarea,select"))
                  .map((e) => e.id)
                  .join()
            )
            .join()
        )
        await next.click()
        await page.waitForFunction(
          (before) =>
            Array.from(
              document.querySelectorAll<HTMLElement>('form,[role="form"]')
            )
              .map(
                (f) =>
                  f.innerText +
                  Array.from(f.querySelectorAll("input,textarea,select"))
                    .map((e) => e.id)
                    .join()
              )
              .join() !== before,
          signature,
          { timeout: 12000 }
        )
        break
      }
      await assertNoHumanChallenge(page)
      await finalSubmitControl(page)
      await options.beforeSubmit(packet)
      return { packet, needsAnswers: false }
    }
  }
  throw new Error("Employer form exceeds eight steps")
}
