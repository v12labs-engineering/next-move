import { z } from "zod"
import {
  missingAnswers,
  type ApplicationField,
  type ApplicationPacket,
} from "../applications"
import { validSavedAnswer } from "../applications/questions"

const answerSchema = z.union([
  z.string().max(5000),
  z.array(z.string().max(1000)).max(100),
])
export const telegramStateSchema = z
  .object({
    answers: z.record(z.string(), answerSchema),
    confirmed: z.array(z.string()),
    initialized: z.boolean(),
    editing: z.boolean(),
    choicePage: z.number().int().min(0).max(62).optional(),
    aiDraftUnavailable: z.boolean().optional(),
    proposals: z
      .record(
        z.string(),
        z.object({ answer: answerSchema, source: z.string() })
      )
      .default({}),
  })
  .strict()
export type TelegramState = z.infer<typeof telegramStateSchema>
export type TelegramRequest = {
  id: string
  user_id: string
  application_id: string
  revision: number
  version: number
  packet: ApplicationPacket
  state: TelegramState
  expires_at: string
  provider_message_id?: string | null
  ai_draft_attempted?: boolean
  automatic?: boolean
}
export type TelegramAction =
  | "use"
  | "edit"
  | "confirm"
  | "send"
  | "pause"
  | "open"
  | `choose:${number}`
  | `page:${number}`
export function actionId(
  q: Pick<TelegramRequest, "id" | "version">,
  action: TelegramAction
) {
  return `tg:${q.id}:${q.version}:${action}`
}
export function parseAction(value: string) {
  const match =
    /^tg:([a-f0-9-]{36}):([1-9][0-9]*):(use|edit|confirm|send|pause|open|choose:(?:0|[1-9][0-9]{0,2})|page:(?:0|[1-9][0-9]?))$/.exec(
      value
    )
  if (
    !match ||
    !z.uuid().safeParse(match[1]).success ||
    !Number.isSafeInteger(Number(match[2]))
  )
    return null
  return {
    id: match[1],
    version: Number(match[2]),
    action: match[3] as TelegramAction,
  }
}
// Replies to the current bot prompt bind edits directly to the saved turn.
// The displayed turn code is a fallback for messages sent outside that reply.
export function editCode(q: Pick<TelegramRequest, "id" | "version">) {
  return `${q.id.replaceAll("-", "").slice(0, 8)}-${q.version}`
}
export function unresolvedFields(packet: ApplicationPacket) {
  return packet.fields.filter((field) => {
    const answer = packet.answers[field.id]
    return (
      field.kind !== "resume" &&
      (field.required ||
        (Array.isArray(answer) ? answer.length > 0 : !!answer?.trim())) &&
      !validSavedAnswer(field, answer ?? null)
    )
  })
}
export function currentQuestion(q: TelegramRequest) {
  return unresolvedFields(q.packet).find(
    (field) => !q.state.confirmed.includes(field.id)
  )
}
const choicesPerPage = 8
function fieldChoices(field: ApplicationField) {
  if (
    !["select", "combobox", "radio", "checkbox", "yesno"].includes(field.kind)
  )
    return []
  return field.options.length
    ? field.options
    : field.kind === "yesno"
      ? ["Yes", "No"]
      : []
}
function choicePage(q: TelegramRequest, choices: string[]) {
  return Math.min(
    q.state.choicePage ?? 0,
    Math.max(0, Math.ceil(choices.length / choicesPerPage) - 1)
  )
}

const fieldTypes: Record<ApplicationField["kind"], string> = {
  text: "Text",
  textarea: "Long text",
  email: "Email address",
  tel: "Phone number",
  url: "URL",
  number: "Number",
  select: "Select · choose one",
  combobox: "Combobox · choose one",
  radio: "Radio buttons · choose one",
  checkbox: "Checkboxes · choose one or more",
  yesno: "Yes / No",
  resume: "Resume upload",
  cover_letter: "Cover letter · uploaded as PDF",
  unsupported: "Unsupported control",
}

function replyInstruction(field: ApplicationField) {
  switch (field.kind) {
    case "email":
      return "Enter an email address, e.g. name@example.com."
    case "tel":
      return "Enter your phone number including the country code."
    case "url":
      return "Enter a complete URL starting with https:// or http://."
    case "number":
      return "Enter a number using the units in the question."
    case "textarea":
    case "cover_letter":
      return "Write your answer; multiple lines are supported."
    case "checkbox":
      return 'Use a JSON array of exact options, e.g. ["Option A","Option B"].'
    default:
      return "Enter your answer."
  }
}
export function parseAnswer(field: ApplicationField, text: string) {
  const input = text.trim()
  let answer: string | string[] = input
  if (field.kind === "checkbox") {
    try {
      answer = z.array(z.string()).parse(JSON.parse(input))
    } catch {
      return null
    }
  } else if (field.options.length) {
    const matches = field.options.filter(
      (v) => v.toLowerCase() === input.toLowerCase()
    )
    if (matches.length !== 1) return null
    answer = matches[0]
  }
  return validSavedAnswer(field, answer) ? answer : null
}
export function transition(
  q: TelegramRequest,
  action: TelegramAction,
  text?: string
) {
  const state = structuredClone(q.state)
  const field = currentQuestion(q)
  if (action === "pause") return { state, pause: true, finish: false }
  if (action === "open") return { state, pause: false, finish: false }
  if (action === "send") {
    if (field || missingAnswers({ ...q.packet, answers: state.answers }).length)
      throw new Error("Complete and confirm every required answer first.")
    return { state, pause: false, finish: true }
  }
  if (!field || field.kind === "unsupported")
    throw new Error("Review this application in the app.")
  if (action.startsWith("choose:") || action.startsWith("page:")) {
    const choices = fieldChoices(field)
    const index = Number(action.split(":")[1])
    if (!choices.length || !Number.isSafeInteger(index) || index < 0)
      throw new Error("Use the choices on the latest question.")
    if (action.startsWith("page:")) {
      if (index >= Math.ceil(choices.length / choicesPerPage))
        throw new Error("That choice page is unavailable.")
      state.choicePage = index
    } else {
      const page = choicePage(q, choices)
      if (
        index >= choices.length ||
        Math.floor(index / choicesPerPage) !== page
      )
        throw new Error("Use the choices on the latest question.")
      const option = choices[index]
      let answer: string | string[] = option
      if (field.kind === "checkbox") {
        const previous = state.answers[field.id]
        const selected = new Set(Array.isArray(previous) ? previous : [])
        if (selected.has(option)) selected.delete(option)
        else selected.add(option)
        answer = choices.filter((value) => selected.has(value))
      }
      // An empty checkbox draft is allowed while toggling, but cannot confirm.
      if (
        !answerSchema.safeParse(answer).success ||
        (!(Array.isArray(answer) && !answer.length) &&
          !validSavedAnswer(field, answer))
      )
        throw new Error("Enter a valid answer using the displayed options.")
      state.answers[field.id] = answer
    }
    state.editing = false
  } else if (action === "edit") {
    state.editing = true
    delete state.choicePage
    // The next version's code is the only text edit accepted.
  } else if (text !== undefined) {
    if (!state.editing && !q.automatic)
      throw new Error("Choose Edit answer first.")
    const prefix = `${editCode(q)}:`
    if (!text.startsWith(prefix))
      throw new Error(`Reply with ${prefix} followed by your answer.`)
    const answer = parseAnswer(field, text.slice(prefix.length))
    if (answer === null)
      throw new Error(
        "Enter a valid answer using the displayed options and format."
      )
    state.answers[field.id] = answer
    state.editing = false
    delete state.choicePage
    if (q.automatic) state.confirmed.push(field.id)
  } else if (action === "use") {
    const proposal = state.proposals[field.id]
    if (!proposal || !validSavedAnswer(field, proposal.answer))
      throw new Error("Please enter your answer.")
    state.answers[field.id] = proposal.answer
    state.confirmed.push(field.id)
    state.editing = false
    delete state.choicePage
  } else if (action === "confirm") {
    if (
      state.editing ||
      !validSavedAnswer(field, state.answers[field.id] ?? null)
    )
      throw new Error("Enter your answer before confirming.")
    state.confirmed.push(field.id)
    delete state.choicePage
  }
  // A direct answer completes this question. Automatic applications already
  // have permission to send; manual applications retain their final review.
  if (q.automatic && action.startsWith("choose:") && field.kind !== "checkbox")
    state.confirmed.push(field.id)
  const finish =
    !!q.automatic &&
    !currentQuestion({ ...q, state }) &&
    !missingAnswers({ ...q.packet, answers: state.answers }).length
  return { state, pause: false, finish }
}
type QuestionButton = { action: TelegramAction; label: string }
export function questionKeyboard(
  q: Pick<TelegramRequest, "id" | "version">,
  prompt: { buttons: QuestionButton[][] }
) {
  return prompt.buttons.map((row) =>
    row.map((button) => ({
      text: button.label,
      callback_data: actionId(q, button.action),
    }))
  )
}
export function questionMessage(
  q: TelegramRequest,
  origin: string
): { text: string; buttons: QuestionButton[][]; forceReply?: boolean } {
  const field = currentQuestion(q)
  const url = `${origin}/applications/${q.application_id}`
  const heading = `${q.packet.company} · ${q.packet.title}`
  if (!field)
    return {
      text: `${heading}\n\nAnswers:\n${q.packet.fields
        .filter((f) => f.kind !== "resume" && f.id in q.state.answers)
        .map((f) => `${f.label}: ${JSON.stringify(q.state.answers[f.id])}`)
        .join(
          "\n"
        )}\n\nResume prepared. View it on the application page: ${url}\n\nEmployer notices:\n${q.packet.notices || "No employer notices were recorded."}\n\nYou can review and approve this prepared application here.\n\nApprove & send authorizes submitting this exact application to this employer.`,
      buttons: [
        [{ action: "send", label: "Approve & send" }],
        [{ action: "pause", label: "Pause" }],
      ],
    }
  if (field.kind === "unsupported")
    return {
      text: `${heading}\n\nThis question needs the application page: ${field.label}\n${url}`,
      buttons: [[{ action: "pause", label: "Pause" }]],
    }
  const candidate = q.state.answers[field.id]
  const proposal = q.state.proposals[field.id]
  const hasCandidate = validSavedAnswer(field, candidate ?? null)
  const choices = fieldChoices(field)
  const page = choicePage(q, choices)
  const start = page * choicesPerPage
  const visibleChoices = choices.slice(start, start + choicesPerPage)
  const choiceButtons: QuestionButton[][] = visibleChoices.map((option, i) => {
    const selected = Array.isArray(candidate)
      ? candidate.includes(option)
      : candidate === option
    const marker =
      field.kind === "checkbox" ? (selected ? "☑" : "☐") : selected ? "●" : "○"
    // Full option text stays in the message; keep button labels readable.
    const short = Array.from(option)
    const label = short.length > 60 ? `${short.slice(0, 57).join("")}…` : option
    return [
      {
        action: `choose:${start + i}`,
        label: `${marker} ${start + i + 1}. ${label}`,
      },
    ]
  })
  if (choices.length > choicesPerPage) {
    choiceButtons.push([
      ...(page > 0
        ? [{ action: `page:${page - 1}` as const, label: "‹ Previous choices" }]
        : []),
      ...(start + choicesPerPage < choices.length
        ? [{ action: `page:${page + 1}` as const, label: "More choices ›" }]
        : []),
    ])
  }
  const selecting = choices.length > 0
  const editingText =
    !selecting &&
    (q.state.editing || (!!q.automatic && !proposal && !hasCandidate))
  const showProposal =
    !!proposal && !(selecting && Array.isArray(candidate) && !candidate.length)
  return {
    text: `${heading}\n\nQuestion: ${field.label}\nType: ${fieldTypes[field.kind]} · ${field.required ? "Required" : "Optional"}${field.help ? `\n${field.help}` : ""}${selecting ? `\n\nChoices${choices.length > choicesPerPage ? ` ${start + 1}–${start + visibleChoices.length} of ${choices.length}` : ""}:\n${visibleChoices.map((option, i) => `${start + i + 1}. ${option}`).join("\n")}\n\n${field.kind === "checkbox" ? "Tap to select or clear choices, then confirm your answer." : q.automatic ? "Tap your answer to continue automatically." : "Tap a choice, then confirm your answer."}` : field.options.length ? `\nOptions: ${JSON.stringify(field.options)}` : ""}\n\n${
      editingText
        ? `${replyInstruction(field)}\nReply to this message, or send ${editCode(q)}: followed by your answer.`
        : hasCandidate
          ? `Your ${selecting ? "selected" : "edited"} answer: ${JSON.stringify(candidate)}\nConfirm this answer to continue.`
          : showProposal
            ? `Suggested answer: ${JSON.stringify(proposal.answer)}\nSource: ${proposal.source}`
            : selecting
              ? "No choices selected yet."
              : q.state.aiDraftUnavailable
                ? "An AI suggestion could not be generated. Choose Enter answer to continue."
                : "No confirmed answer is available. Choose Enter answer."
    }\n\n${url}`,
    forceReply: editingText,
    buttons: editingText
      ? []
      : [
          ...choiceButtons,
          ...(!q.state.editing && hasCandidate
            ? [[{ action: "confirm" as const, label: "Confirm answer" }]]
            : !q.state.editing && showProposal
              ? [[{ action: "use" as const, label: "Use answer" }]]
              : []),
          ...(!selecting
            ? [
                [
                  {
                    action: "edit",
                    label:
                      proposal || hasCandidate ? "Edit answer" : "Enter answer",
                  } satisfies QuestionButton,
                ],
              ]
            : []),
          [{ action: "pause", label: "Pause" }],
        ],
  }
}
