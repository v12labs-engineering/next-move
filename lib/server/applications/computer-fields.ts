import { z } from "zod"
import {
  packetSchema,
  type ApplicationField,
  type ApplicationPacket,
} from "@/lib/applications"
import {
  observedLocationAnswer,
  validFieldAnswer,
} from "@/lib/applications/answers"
import { formHash } from "./browser"
import { applicationFieldDescription as fieldDescription } from "./form-planner"
import {
  ComputerBrowser,
  computerFieldId,
  questionControl,
  type ComputerControl,
} from "./computer-browser"

export const normalize = (s: string) =>
  s.replace(/\s+/g, " ").trim().toLowerCase()
export const prohibited =
  /sign[ -]?(?:in|up)|log[ -]?in|register|create account|purchase|\bpay\b|delete|accept all|allow all/i
export const finalAction =
  /submit|send (?:my |your )?application|finish|complete application|bewerbung absenden|postuler|enviar candidatura/i
export const isFinalAction = (control: ComputerControl) =>
  finalAction.test(control.label) ||
  // Some forms submit through a JavaScript button labelled Apply. It is only
  // a final action inside an observed form, never a generic navigation link.
  (/^apply(?: now)?$/.test(normalize(control.label)) &&
    !!control.scope &&
    control.scope !== "body" &&
    !control.href)
export const nextAction =
  /^(?:next|continue|next step|save and continue|weiter|suivant)(?:\s*[→>])?$/i
export type ComputerFieldDescription = z.infer<typeof fieldDescription>
export type Binding = { field: ApplicationField; controls: ComputerControl[] }
export type Receipt = { text: string; url: string; confirmedAt: string }

export function matchesApprovedControl(
  field: ApplicationField,
  answer: ApplicationPacket["answers"][string],
  control: ComputerControl,
  observed: ComputerControl
) {
  const values = Array.isArray(answer) ? answer : answer?.trim() ? [answer] : []
  const selected = values.includes(control.label || control.value)
  return (
    observed.valid &&
    (field.kind === "unsupported"
      ? !field.required &&
        !observed.checked &&
        (["radio", "checkbox"].includes(observed.type) || !observed.value)
      : observed.type === "file"
        ? observed.value ===
          (field.kind === "resume" || values.length ? "[file selected]" : "")
        : ["radio", "checkbox"].includes(observed.type)
          ? observed.checked === selected
          : observed.tag === "select"
            ? observed.selectedText === (values[0] || "")
            : field.kind === "yesno"
              ? observed.selectionObservable
                ? observed.checked === selected
                : values.length > 0
              : ["checkbox", "radio"].includes(field.kind)
                ? observed.checked === selected
                : field.kind === "combobox" && observed.dropdown
                  ? !observed.dropdown.expanded &&
                    JSON.stringify(
                      observed.dropdown.selectedLabels ??
                        (observed.value ? [observed.value] : [])
                    ) === JSON.stringify(values)
                  : observed.value === (values[0] || ""))
  )
}

export class OmittedRequiredControls extends Error {
  constructor(controls: ComputerControl[]) {
    // Only observation-generated references enter model feedback or logs. Never
    // include page labels, selectors, current values or provider diagnostics.
    const targets = controls
      .map((c) => c.target)
      .filter((t) => /^c\d+$/.test(t))
    super(
      `A required employer question was omitted; include observed targets ${targets.join(", ")}`
    )
  }
}

// native validation. It mirrors that question, so it is covered when it is.
const unlabeledInput = (c: ComputerControl) =>
  c.tag === "input" &&
  c.type === "text" &&
  !c.label &&
  !c.id &&
  !c.name &&
  !c.role &&
  !!c.group

// The dropdown carries the question as its label or shares the proxy's group.
const proxyQuestion = (dropdown: ComputerControl, proxy: ComputerControl) =>
  dropdown.group === proxy.group || dropdown.label.trim() === proxy.group.trim()

export function validationProxy(
  control: ComputerControl,
  bound: ComputerControl[]
) {
  return (
    unlabeledInput(control) &&
    bound.some(
      (b) =>
        b.target !== control.target &&
        b.role === "combobox" &&
        b.frame === control.frame &&
        b.scope === control.scope &&
        proxyQuestion(b, control)
    )
  )
}

// Planners mislabel kinds and over-collect targets on real forms (searchable
// dropdowns called "select", the next question's control or the submit button
// appended, toggle buttons proposed as questions). Observed controls decide the
// kind and the single target, so one slip no longer rejects the whole page.
export function groundFieldDescriptions(
  browser: Pick<ComputerBrowser, "control" | "observation">,
  epoch: number,
  descriptions: ComputerFieldDescription[]
): ComputerFieldDescription[] {
  const grounded: ComputerFieldDescription[] = []
  for (const description of descriptions) {
    const controls = description.targets.map((target) =>
      browser.control(epoch, target)
    )
    // Toggle/"Dropbox"/"Enter manually" buttons are not questions.
    if (controls.every((c) => c.type !== "file" && !questionControl(c)))
      continue
    if (
      description.kind === "unsupported" &&
      controls.every((c) => !c.label && !c.required && c.type !== "file")
    )
      continue
    if (controls.some((c) => c.type === "file")) {
      grounded.push(description)
      continue
    }
    // Drop only noise: submit/flyout buttons and unlabeled validation proxies.
    let kept = controls.filter((c) => questionControl(c) && !unlabeledInput(c))
    let proxy = controls.find(unlabeledInput)
    if (!kept.length && proxy) {
      // A validation proxy stands in for its visible dropdown; act on that.
      const dropdowns = browser.observation.controls.filter(
        (c) =>
          c.role === "combobox" &&
          c.frame === proxy!.frame &&
          c.scope === proxy!.scope &&
          proxyQuestion(c, proxy!)
      )
      if (dropdowns.length !== 1) {
        grounded.push(description)
        continue
      }
      kept = dropdowns
      proxy = undefined
    }
    if (!kept.length) kept = controls
    const first = kept[0]
    let kind = description.kind
    // Several dropdowns in one field: keep the first; the rest are bound by
    // their own fields or caught by the omitted-required check.
    if (first.tag === "select" || first.role === "combobox") {
      kind = first.tag === "select" ? "select" : "combobox"
      kept = [first]
    } else if (first.tag === "textarea") kind = "textarea"
    else if (
      first.tag === "input" &&
      ["text", "email", "tel", "url", "number", "search"].includes(
        first.type
      ) &&
      !["radio", "checkbox"].includes(first.role) &&
      ["select", "radio", "checkbox", "yesno", "textarea", "combobox"].includes(
        kind
      )
    )
      kind = "text"
    grounded.push({
      ...description,
      kind,
      targets: kept.map((c) => c.target),
    })
  }
  return grounded
}

// Model proposals are grounded in an observed control; URLs, selectors, values,
// required flags and option sets cannot be invented or weakened by the model.
export function bindComputerFields(
  browser: ComputerBrowser,
  epoch: number,
  descriptions: ComputerFieldDescription[],
  step: number
): Binding[] {
  const used = new Set<string>()
  const bindings = groundFieldDescriptions(browser, epoch, descriptions).map(
    (description) => {
      let controls = description.targets.map((target) => {
        if (used.has(target))
          throw new Error("An employer control was mapped twice")
        used.add(target)
        return browser.control(epoch, target)
      })
      if (description.kind === "combobox" && controls.length > 1) {
        const dropdown = controls.filter((c) => c.role === "combobox")
        if (
          dropdown.length !== 1 ||
          controls.some(
            (c) =>
              c !== dropdown[0] &&
              c.role !== "option" &&
              !(c.tag === "button" && !c.label)
          )
        )
          throw new Error(
            "Map a dropdown to its control and observed options only"
          )
        controls = dropdown
      }
      if (controls.some((c) => c.type === "file")) {
        const files = controls.filter((c) => c.type === "file")
        if (
          files.length !== 1 ||
          controls.some(
            (c) =>
              c !== files[0] &&
              !(
                (c.tag === "button" &&
                  /^upload(?: file| resume| cv)?$/i.test(c.label)) ||
                // Some upload widgets wrap the file input in a link. This is
                // observed DOM ancestry, not a guessed label or destination.
                // Keep only the file; the wrapper is never clicked or followed.
                (c.tag === "a" &&
                  c.frame === files[0].frame &&
                  c.scope === files[0].scope &&
                  files[0].selector.startsWith(`${c.selector} > `))
              )
          )
        )
          throw new Error(
            "Map an upload to its file control and upload button only"
          )
        controls = files
      }
      if (
        controls.length > 1 &&
        !["radio", "checkbox", "yesno"].includes(description.kind)
      )
        throw new Error("Map separate employer inputs to separate fields")
      if (
        controls.some((c) => !questionControl(c)) &&
        !(
          description.kind === "yesno" &&
          controls.every(
            (c) =>
              c.tag === "button" &&
              c.type !== "submit" &&
              /^(yes|no)$/i.test(c.label)
          )
        )
      )
        throw new Error("Only observed question controls can become fields")
      if (new Set(controls.map((c) => c.frame)).size !== 1)
        throw new Error("Question spans unrelated frames")
      controls.sort(
        (a, b) =>
          browser.observation.controls.indexOf(a) -
          browser.observation.controls.indexOf(b)
      )
      if (
        (description.kind === "radio" ||
          controls.every((c) => c.type === "radio" || c.role === "radio")) &&
        new Set(controls.map((c) => c.name).filter(Boolean)).size > 1
      )
        throw new Error("Question spans unrelated radio groups")
      const first = controls[0]
      const grouped =
        controls.length > 1 ||
        ["radio", "checkbox", "yesno"].includes(description.kind)
      // Composite inputs may share a heading (Phone) while the dropdown has
      // its own question (Country). Keep both, rather than asking for a second
      // phone number. A displayed selected option is not a question label.
      const dropdownLabel =
        first.label &&
        !first.options.includes(first.label) &&
        !first.dropdown?.selectedLabels?.includes(first.label) &&
        first.label !== first.value &&
        normalize(first.label).replace(/\*$/, "").trim() !==
          normalize(first.group).replace(/\*$/, "").trim()
          ? `${first.group}: ${first.label}`
          : first.group
      const label = grouped
        ? first.group || description.label
        : first.role === "combobox" && first.group
          ? dropdownLabel
          : // Upload inputs are often named after their button ("Attach");
            // their observed id/name ("resume", "cover_letter") names the slot.
            first.type === "file" &&
              /^(?:attach|upload|browse|choose file|select file|add file)$/i.test(
                first.label.trim()
              ) &&
              /resume|\bcv\b|cover.?letter/i.test(`${first.id} ${first.name}`)
            ? (first.id || first.name)
                .replace(/[_-]+/g, " ")
                .replace(/^./, (c) => c.toUpperCase())
            : first.label ||
              first.group ||
              (first.type === "file" ? first.context.split("\n")[0] : "") ||
              description.label
      if (
        (grouped ? !first.group : !first.label && !first.group) &&
        !normalize(
          browser.observation.text + controls.map((c) => c.context).join(" ")
        ).includes(normalize(label))
      )
        throw new Error("Question label is not visible")
      const assistiveUpload =
        first.type === "file" &&
        !first.required &&
        !first.id &&
        !first.name &&
        /autofill/i.test(first.context)
      let kind = assistiveUpload ? ("unsupported" as const) : description.kind
      // Search-backed dropdowns are editable text inputs, but their native role
      // still requires exact option selection and a stable approved question.
      if (
        first.role === "combobox" &&
        first.tag !== "select" &&
        kind === "text"
      )
        kind = "combobox"
      if (
        kind === "radio" &&
        controls.length === 2 &&
        controls.every(
          (c) =>
            c.tag === "button" && c.type !== "submit" && c.selectionObservable
        ) &&
        controls
          .map((c) => c.label.toLowerCase())
          .sort()
          .join(",") === "no,yes"
      )
        kind = "yesno"
      // The same native choice group can be described as radio or yes/no by the
      // model. Ground its type in the controls so approved answers remain stable.
      if (
        kind === "yesno" &&
        controls.every((c) => c.type === "radio" || c.role === "radio")
      )
        kind = "radio"
      if (kind !== "unsupported") {
        if (
          (kind === "radio" &&
            !controls.every((c) => c.type === "radio" || c.role === "radio")) ||
          (kind === "checkbox" &&
            !controls.every(
              (c) => c.type === "checkbox" || c.role === "checkbox"
            )) ||
          (kind === "select" && first.tag !== "select") ||
          (first.tag === "select" && kind !== "select") ||
          (first.tag === "textarea" && kind !== "textarea")
        )
          throw new Error("Question kind does not match observed controls")
      }
      if (
        first.type === "file" &&
        !(
          kind === "resume" &&
          /resume|\bcv\b|curriculum|lebenslauf/i.test(label)
        ) &&
        !(
          kind === "cover_letter" &&
          /cover(?:ing)? letter|motivation letter|anschreiben|lettre de motivation/i.test(
            label
          )
        )
      )
        kind = "unsupported"
      if (
        first.type !== "file" &&
        (kind === "resume" || kind === "cover_letter")
      )
        throw new Error("Document upload must target a file control")
      if (
        ["email", "tel", "url", "number"].includes(first.type) &&
        kind !== first.type
      )
        throw new Error("Employer field type changed")
      const options = (
        first.tag === "select" ||
        (first.role === "combobox" && first.options.length > 0)
          ? first.options
          : ["radio", "checkbox", "yesno"].includes(kind)
            ? controls.map((c) => c.label || c.value).filter(Boolean)
            : description.options
      ).filter((option) => option.trim().length > 0)
      if (
        options.some(
          (option) =>
            !normalize(browser.observation.text).includes(normalize(option)) &&
            !first.options.includes(option) &&
            !browser.observation.controls.some(
              (c) =>
                c.frame === first.frame &&
                normalize(c.label || c.value) === normalize(option)
            )
        )
      )
        throw new Error("Employer option was not observed")
      const field: ApplicationField = {
        id: computerFieldId(controls, label, step),
        label,
        kind,
        required:
          !assistiveUpload &&
          (description.required || controls.some((c) => c.required)),
        help: "",
        options,
        step,
        autocomplete: first.autocomplete || undefined,
      }
      return { field, controls }
    }
  )
  if (new Set(bindings.map((b) => b.field.id)).size !== bindings.length)
    throw new Error("Duplicate employer question")
  const scopes = new Set(
    bindings.flatMap((b) => b.controls.map((c) => `${c.frame}:${c.scope}`))
  )
  const omitted = browser.observation.controls.filter(
    (c) =>
      questionControl(c) &&
      c.required &&
      scopes.has(`${c.frame}:${c.scope}`) &&
      !used.has(c.target) &&
      !validationProxy(
        c,
        bindings.flatMap((b) => b.controls)
      )
  )
  if (omitted.length) throw new OmittedRequiredControls(omitted)
  return bindings
}

export function sameQuestion(a: ApplicationField, b: ApplicationField) {
  const meaning = (field: ApplicationField) => {
    const label = normalize(field.label)
    return field.kind === "combobox"
      ? label.replace(/:\s*(?:start typing|select|search)\.{0,3}$/, "").trim()
      : label
  }
  // A native text input may be described semantically as a URL/email/phone.
  // Preserve its answer across that description drift only at the same ID;
  // moving controls or changing between distinct typed fields still needs review.
  const sameKind =
    a.kind === b.kind ||
    (a.id === b.id &&
      ((a.kind === "text" && ["url", "email", "tel"].includes(b.kind)) ||
        (b.kind === "text" && ["url", "email", "tel"].includes(a.kind))))
  return (
    meaning(a) === meaning(b) &&
    sameKind &&
    a.required === b.required &&
    (JSON.stringify(a.options) === JSON.stringify(b.options) ||
      // A closed search-backed dropdown exposes no options. That is missing
      // observation data, rather than a different question or approved value.
      (a.kind === "combobox" && (!a.options.length || !b.options.length)))
  )
}
// Replay a reviewed packet only when every current question can be grounded
// uniquely. Different IDs, question meanings, choices or additional fields send
// the whole screen back through perception; no candidate answers are inferred.
export function approvedFieldDescriptions(
  browser: ComputerBrowser,
  packet: ApplicationPacket,
  step: number
): ComputerFieldDescription[] | undefined {
  const questions = browser.observation.controls.filter(questionControl)
  const fields = packet.fields.filter((field) => (field.step || 0) === step)
  if (!fields.length) return
  const descriptions: ComputerFieldDescription[] = []
  for (const field of fields) {
    const groups = new Map<string, ComputerControl[]>()
    for (const control of questions) {
      const choice = ["radio", "checkbox", "yesno"].includes(field.kind)
      const group =
        choice && (control.name || control.group)
          ? `${control.frame}:${control.scope}:${control.type}:${control.role}:${control.name || control.group}`
          : `${control.frame}:${control.selector}`
      const list = groups.get(group) || []
      list.push(control)
      groups.set(group, list)
    }
    const candidates = [...groups.values()].filter(
      (controls) => computerFieldId(controls, field.label, step) === field.id
    )
    if (
      candidates.length !== 1 ||
      candidates[0].some((control) => control.required) !== field.required
    )
      return
    descriptions.push({
      targets: candidates[0].map((control) => control.target),
      label: field.label,
      kind: field.kind,
      required: field.required,
      options: field.kind === "combobox" ? [] : field.options,
    })
  }
  try {
    const bindings = bindComputerFields(
      browser,
      browser.observation.epoch,
      descriptions,
      step
    )
    if (
      bindings.length !== fields.length ||
      bindings.some(
        ({ field }, i) =>
          field.id !== fields[i].id || !sameQuestion(fields[i], field)
      )
    )
      return
    const mapped = bindings.flatMap((binding) => binding.controls)
    if (
      questions.some(
        (control) =>
          !mapped.includes(control) && !validationProxy(control, mapped)
      )
    )
      return
    return descriptions
  } catch {
    return undefined
  }
}

// Read standard, explicitly labeled controls without asking a model to repeat
// DOM metadata. This proposes a mapping only; review still merges answers,
// resolves new questions and checks notices before any write or submission.
export function observedFieldDescriptions(
  browser: ComputerBrowser,
  step: number
): ComputerFieldDescription[] | undefined {
  const questions = browser.observation.controls.filter(questionControl)
  if (!questions.length) return
  const questionLabel = (c: ComputerControl) =>
    c.label ||
    c.group ||
    (c.type === "file" ? c.context.split("\n")[0].trim() : "")
  const groups = new Map<string, ComputerControl[]>()
  for (const control of questions) {
    if (
      validationProxy(
        control,
        questions.filter((c) => c !== control)
      )
    )
      continue
    const choice =
      ["radio", "checkbox"].includes(control.type) ||
      ["radio", "checkbox"].includes(control.role) ||
      control.tag === "button"
    const label = choice ? control.group : questionLabel(control)
    // An unnamed upload and a custom/ambiguous input still need perception.
    if (!label) return
    const key = choice
      ? `${control.frame}:${control.scope}:${control.type}:${control.role}:${control.group}`
      : control.target
    const group = groups.get(key) || []
    group.push(control)
    groups.set(key, group)
  }
  const descriptions: ComputerFieldDescription[] = []
  for (const controls of groups.values()) {
    const first = controls[0]
    const label = first.group || questionLabel(first)
    let kind: ApplicationField["kind"]
    if (first.role === "combobox") kind = "combobox"
    else if (first.tag === "select") kind = "select"
    else if (first.tag === "textarea") kind = "textarea"
    else if (first.type === "file")
      kind = /cover(?:ing)? letter|motivation letter/i.test(label)
        ? "cover_letter"
        : /resume|\bcv\b|curriculum/i.test(label) && !/autofill/i.test(label)
          ? "resume"
          : "unsupported"
    else if (first.type === "radio" || first.role === "radio") kind = "radio"
    else if (first.type === "checkbox" || first.role === "checkbox")
      kind = "checkbox"
    else if (
      first.tag === "button" &&
      controls.length === 2 &&
      controls.every((c) => /^(yes|no)$/i.test(c.label))
    )
      kind = "yesno"
    else if (
      first.tag === "input" &&
      ["text", "email", "tel", "url", "number", "date"].includes(first.type)
    )
      kind =
        first.type === "date"
          ? "text"
          : (first.type as ApplicationField["kind"])
    else return
    descriptions.push({
      targets: controls.map((c) => c.target),
      label,
      kind,
      required: controls.some((c) => c.required),
      options: [],
    })
  }
  try {
    const bindings = bindComputerFields(
      browser,
      browser.observation.epoch,
      descriptions,
      step
    )
    const mapped = bindings.flatMap((b) => b.controls)
    if (
      questions.some((c) => !mapped.includes(c) && !validationProxy(c, mapped))
    )
      return
    return descriptions
  } catch {
    return
  }
}

export function mergeComputerFields(
  packet: ApplicationPacket,
  fields: ApplicationField[],
  notices: string,
  step: number,
  approved?: ApplicationPacket
) {
  const previous = packet.fields.filter((f) => (f.step || 0) === step)
  const answers = { ...packet.answers }
  for (const old of previous) delete answers[old.id]
  for (const field of fields) {
    const fitsObservedOptions = (
      answer: ApplicationPacket["answers"][string]
    ) =>
      validFieldAnswer(
        field,
        observedLocationAnswer(field, answer) ?? answer
      ) &&
      (field.kind !== "combobox" ||
        !field.options.length ||
        (Array.isArray(answer) ? answer : answer ? [answer] : []).every(
          (value) =>
            field.options.includes(value) ||
            !!observedLocationAnswer(field, value)
        ))
    const matches = previous.filter((old) => sameQuestion(old, field))
    if (
      matches.length === 1 &&
      matches[0].id in packet.answers &&
      fitsObservedOptions(packet.answers[matches[0].id])
    )
      answers[field.id] =
        observedLocationAnswer(field, packet.answers[matches[0].id]) ??
        packet.answers[matches[0].id]
    else if (approved) {
      // A fresh browser session replays earlier choices before conditional fields appear.
      // Restore a user answer only when the original question's meaning agrees.
      const original = approved.fields.filter(
        (old) => (old.step || 0) === step && sameQuestion(old, field)
      )
      if (
        original.length === 1 &&
        original[0].id in approved.answers &&
        fitsObservedOptions(approved.answers[original[0].id])
      )
        answers[field.id] =
          observedLocationAnswer(field, approved.answers[original[0].id]) ??
          approved.answers[original[0].id]
    }
  }
  const stepNotices = [...(packet.stepNotices || [])]
  stepNotices[step] = notices
  const allFields = [
    ...packet.fields.filter((f) => (f.step || 0) !== step),
    ...fields,
  ]
  const allNotices = stepNotices.join("\n\n").slice(0, 15000)
  return packetSchema.parse({
    ...packet,
    engine: "computer-v1",
    fields: allFields,
    answers,
    stepNotices,
    notices: allNotices,
    formHash: formHash(allFields, allNotices),
  })
}
