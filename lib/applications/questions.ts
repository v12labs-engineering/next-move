import { z } from "zod"
import {
  missingAnswers,
  type ApplicationField,
  type ApplicationPacket,
} from "./index"

export const reuseScopeSchema = z.enum(["never", "employer", "all"])
export const rememberChoicesSchema = z
  .record(z.string().max(300), reuseScopeSchema)
  .refine((v) => Object.keys(v).length <= 100)
export type ReuseScope = z.infer<typeof reuseScopeSchema>
export type SavedQuestion = {
  id: string
  question: ApplicationField
  answer: string | string[] | null
  reuse_scope: ReuseScope
  reuse_explicit?: boolean
  company: string
  country: string
  source_application_id: string | null
  last_seen_at: string
}
export type QuestionAlert = {
  applicationId: string
  revision: number
  title: string
  company: string
  questions: { id: string; label: string; unsupported: boolean }[]
}
export function canReuseQuestion(field: ApplicationField) {
  return (
    !["resume", "unsupported"].includes(field.kind) &&
    !/consent|agree|terms|privacy|certify|declare|attest|accuracy|acknowledg|datenschutz|bedingungen/i.test(
      [field.label, field.help, ...field.options].join(" ")
    )
  )
}
const normalize = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase()
export function sameSavedQuestion(a: ApplicationField, b: ApplicationField) {
  return (
    normalize(a.label) === normalize(b.label) &&
    normalize(a.help) === normalize(b.help) &&
    a.kind === b.kind &&
    JSON.stringify(a.options) === JSON.stringify(b.options)
  )
}
export function validSavedAnswer(
  field: ApplicationField,
  answer: string | string[] | null
) {
  if (answer === null || ["resume", "unsupported"].includes(field.kind))
    return false
  if (typeof answer === "string" ? !answer.trim() : !answer.length) return false
  return (
    missingAnswers({
      title: "",
      company: "",
      resume: "Synthetic validation placeholder of sufficient length.",
      notices: "",
      formHash: "",
      tailored: true,
      fields: [field],
      answers: { [field.id]: answer },
    }).length === 0
  )
}
// The database already restricts rows to this account, destination and employer
// scope, ordered with employer-specific answers before a global saved answer.
export function applyRememberedAnswers(
  packet: ApplicationPacket,
  rows: SavedQuestion[]
) {
  const answers = { ...packet.answers }
  const blocked: string[] = []
  const remembered: NonNullable<ApplicationPacket["rememberedAnswers"]> = {}
  for (const field of packet.fields) {
    if (!canReuseQuestion(field)) continue
    if (
      rows.some(
        (row) =>
          row.reuse_scope === "never" &&
          row.reuse_explicit &&
          sameSavedQuestion(field, row.question)
      )
    ) {
      blocked.push(field.id)
      continue
    }
    const row = rows.find(
      (r) =>
        r.reuse_scope !== "never" &&
        sameSavedQuestion(field, r.question) &&
        validSavedAnswer(field, r.answer)
    )
    if (!row || row.answer === null) continue
    const absent = !(field.id in answers)
    if (absent) answers[field.id] = structuredClone(row.answer)
    if (
      (absent || packet.rememberedAnswers?.[field.id]?.id === row.id) &&
      JSON.stringify(answers[field.id]) === JSON.stringify(row.answer)
    )
      remembered[field.id] = {
        id: row.id,
        scope: row.reuse_scope as "employer" | "all",
      }
  }
  return {
    ...packet,
    answers,
    rememberedAnswers: remembered,
    answerReuseBlocked: blocked,
  }
}
