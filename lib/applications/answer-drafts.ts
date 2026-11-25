import { z } from "zod"
import type { ApplicationField, ApplicationPacket } from "./index"
import { canReuseQuestion, validSavedAnswer } from "./questions"

// Opinion/motivation proposals can be reviewed without pretending to know an
// applicant's history, eligibility, identity or other missing personal facts.
export function canDraftAnswer(field: ApplicationField) {
  if (
    !canReuseQuestion(field) ||
    !["text", "textarea", "cover_letter"].includes(field.kind) ||
    field.options.length
  )
    return false
  const question = `${field.label} ${field.help}`
  if (
    /salary|compensation|remuneration|pay expectation|notice period|availab|start date|relocat|travel|visa|sponsor|authoriz|eligib|immigra|citizen|nationality|gender|disabil|demograph|ethnic|veteran|criminal|convict|reference|referr|phone|e-?mail|address|full name|first name|last name|birth|\bage\b|experience|accomplish|achievement|previous|your background|how many|how long|education|degree|university|college|employment|worked|history|portfolio|linkedin|github|\bskills?\b|leaving|left your/i.test(
      question
    )
  )
    return false
  return /\bthink\b|believ|opinion|perspective|\bview\b|most important|biggest.*(?:problem|challenge|risk)|how would|how should|your approach|\bwhy\b|motivat|interest|excite|attract|prioriti[sz]/i.test(
    question
  )
}

export const answerDraftsSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            fieldId: z.string().max(300),
            answer: z.string().trim().min(1).max(2500),
          })
          .strict()
      )
      .max(10),
  })
  .strict()
export type AnswerProposal = { answer: string; source: string }
export function acceptAnswerDrafts(
  packet: ApplicationPacket,
  fields: ApplicationField[],
  input: unknown
) {
  const parsed = answerDraftsSchema.safeParse(input)
  const proposals: Record<string, AnswerProposal> = {}
  if (!parsed.success) return proposals
  for (const draft of parsed.data.answers) {
    const field = fields.find((f) => f.id === draft.fieldId)
    if (
      !field ||
      !canDraftAnswer(field) ||
      validSavedAnswer(field, packet.answers[field.id] ?? null) ||
      proposals[field.id] ||
      !validSavedAnswer(field, draft.answer)
    )
      continue
    // The generator gets no personal-history evidence. Reject common claims of
    // past accomplishments even if a model ignores that instruction.
    if (
      /\bI(?:'ve| have) (?:worked|built|led|managed|developed|published|earned|spent)|\bI (?:worked|built|led|managed|developed|published|earned)|\bmy (?:experience|background|degree)|\bwith \d+ years/i.test(
        draft.answer
      )
    )
      continue
    proposals[field.id] = {
      answer: draft.answer,
      source: "AI-generated draft — proposed answer, not yet confirmed by you",
    }
  }
  return proposals
}
