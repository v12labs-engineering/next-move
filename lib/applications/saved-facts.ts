import type { ApplicationField, ApplicationPacket } from "./index"
import { validFieldAnswer } from "./answers"
import { applicationCurrencies } from "./profile"
import { canReuseQuestion } from "./questions"

// Scope/ownership and employer opt-outs are enforced by the library reader.
// Retain destination and question units when handing facts to either engine.
export type SavedAnswerExample = {
  question: string
  help: string
  answer: string | string[]
  country: string
  confirmedAt: string | null
}

const normalize = (text: string) =>
  text.toLowerCase().replace(/\s+/g, " ").trim()
const salaryQuestion = (text: string) =>
  /salary|compensation|remuneration|\bctc\b|\bpay\b/i.test(text) &&
  /expect|desired|seek|target|looking|requirements?|would.*like/i.test(text) &&
  !/current|previous|history|minimum acceptable|negotiab|less than|more than|below|above|at least|\band\b|\bor\b/i.test(
    text
  )

function salaryUnits(text: string) {
  const value = normalize(text)
  const currency = [
    ...new Set(
      (text.toUpperCase().match(/\b[A-Z]{3}\b/g) ?? []).filter((code) =>
        applicationCurrencies.includes(code)
      )
    ),
  ]
  if (value.includes("€")) currency.push("EUR")
  if (value.includes("£")) currency.push("GBP")
  if (value.includes("₹")) currency.push("INR")
  return {
    currency: [...new Set(currency)].sort().join(","),
    period: /annual|year|annum/.test(value)
      ? "year"
      : /month/.test(value)
        ? "month"
        : /hour/.test(value)
          ? "hour"
          : "",
    basis: /\bbase\b/.test(value)
      ? "base"
      : /\btotal\b|\bctc\b/.test(value)
        ? "total"
        : "",
    tax: /\bgross\b/.test(value)
      ? "gross"
      : /\bnet\b|after.tax/.test(value)
        ? "net"
        : "",
  }
}

function salaryAnswer(
  field: ApplicationField,
  saved: SavedAnswerExample
): string | undefined {
  const target = `${field.label} ${field.help}`
  const source = `${saved.question} ${saved.help}`
  if (
    !salaryQuestion(target) ||
    !salaryQuestion(source) ||
    typeof saved.answer !== "string"
  )
    return
  // Multiple alternatives, conditions, pay scales and currency symbols without
  // a currency code need an explicit answer; never perform conversions here.
  if (
    /\bor\b|\bif\b|equivalent|bonus|equity|stock|commission|benefit|part.time|per day|weekly|\blakhs?\b|\blpa\b|\bthousands?\b|\$/i.test(
      `${source} ${target} ${saved.answer}`
    )
  )
    return
  const from = salaryUnits(`${source} ${saved.answer}`)
  const to = salaryUnits(target)
  for (const key of ["currency", "period", "basis", "tax"] as const) {
    if (to[key] && from[key] && to[key] !== from[key]) return
    // An unqualified salary expectation can be relayed verbatim into a free
    // text compensation question. Explicit currency/period/tax must be known.
    if (key !== "basis" && to[key] && !from[key]) return
  }
  const numeric =
    field.kind === "number" ||
    /single (?:number|amount)|numbers? only/i.test(target)
  if (numeric) {
    if (
      ["currency", "period", "basis"].some(
        (key) => !to[key as keyof typeof to] || !from[key as keyof typeof from]
      )
    )
      return
    const amount = saved.answer.trim().replace(/,/g, "")
    return /^\d+(?:\.\d+)?$/.test(amount) ? amount : undefined
  }
  if (!["text", "textarea"].includes(field.kind)) return
  // Keep units stated only by the source question: a bare number must not
  // silently change from monthly to annual or base to total compensation.
  const answerUnits = salaryUnits(saved.answer)
  const suffix = [
    !answerUnits.currency ? from.currency : "",
    !answerUnits.period && from.period ? `per ${from.period}` : "",
    !answerUnits.basis && from.basis
      ? from.basis === "base"
        ? "base salary"
        : "total compensation"
      : "",
    !answerUnits.tax ? from.tax : "",
  ]
    .filter(Boolean)
    .join(" ")
  return [saved.answer.trim(), suffix].filter(Boolean).join(" ")
}

// Deliberately narrow: total software tenure is not years with a language,
// leadership, cloud platform, or other specialized experience.
const softwareYears =
  "(?:professional )?software (?:engineering|development) experience"
const totalYearsQuestion = new RegExp(
  `^how many years of ${softwareYears} do you have[?*]*$`,
  "i"
)
const minimumYearsQuestion = new RegExp(
  `^do you have (?:at least )?(\\d+(?:\\.\\d+)?)\\+? years of ${softwareYears}[?*]*$`,
  "i"
)

function experienceAnswer(
  field: ApplicationField,
  saved: SavedAnswerExample
): string | undefined {
  if (
    !totalYearsQuestion.test(saved.question.trim()) ||
    typeof saved.answer !== "string" ||
    !/^\d+(?:\.\d+)?(?: years?)?$/i.test(saved.answer.trim())
  )
    return
  if (
    !["", "required", "optional"].includes(normalize(saved.help)) ||
    !["", "required", "optional"].includes(normalize(field.help))
  )
    return
  const years = Number.parseFloat(saved.answer)
  const target = field.label.trim()
  if (
    totalYearsQuestion.test(target) &&
    ["text", "textarea", "number"].includes(field.kind)
  )
    return String(years)
  const threshold = target.match(minimumYearsQuestion)
  if (!threshold) return
  const answer = years >= Number(threshold[1]) ? "Yes" : "No"
  if (field.options.length)
    return field.options.find(
      (option) => normalize(option) === normalize(answer)
    )
  if (["text", "textarea", "yesno"].includes(field.kind)) return answer
}

export function fillSavedApplicationFacts(
  packet: ApplicationPacket,
  saved: SavedAnswerExample[]
): ApplicationPacket {
  const country = packet.applicationContext?.country
  if (!country) return packet
  const answers = { ...packet.answers }
  const evidence = { ...packet.answerEvidence }
  for (const field of packet.fields) {
    if (
      field.id in answers ||
      packet.answerReuseBlocked?.includes(field.id) ||
      !canReuseQuestion(field)
    )
      continue
    const candidates = saved
      .filter((row) => row.country === country)
      .flatMap((row) => {
        const answer = salaryAnswer(field, row) ?? experienceAnswer(field, row)
        return answer && validFieldAnswer(field, answer)
          ? [{ answer, row }]
          : []
      })
    // Conflicting prior statements require review; do not choose a convenient
    // salary or tenure just because one was returned first by the database.
    if (
      !candidates.length ||
      new Set(candidates.map((c) => normalize(c.answer))).size !== 1
    )
      continue
    const { answer, row } = candidates[0]
    answers[field.id] = answer
    evidence[field.id] = {
      answer,
      source: `Your saved answer · ${row.question}`,
      confirmedAt: row.confirmedAt,
    }
  }
  return { ...packet, answers, answerEvidence: evidence }
}
