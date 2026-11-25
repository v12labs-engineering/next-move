import { z } from "zod"
import { publicApplicationUrl } from "@/lib/applications/url"
import { resumeContacts } from "@/lib/resume/contact"
import { applicationProfileSchema } from "./profile"

export const formFieldSchema = z.object({
  id: z.string().min(1).max(300),
  label: z.string().min(1).max(2000),
  help: z.string().max(5000),
  kind: z.enum([
    "text",
    "email",
    "url",
    "tel",
    "number",
    "textarea",
    "radio",
    "checkbox",
    "select",
    "combobox",
    "yesno",
    "resume",
    "cover_letter",
    "unsupported",
  ]),
  required: z.boolean(),
  options: z.array(z.string().max(1000)).max(500),
  step: z.number().int().min(0).max(7).optional(),
  selector: z.string().max(1000).optional(),
  autocomplete: z.string().max(100).optional(),
})
export type ApplicationField = z.infer<typeof formFieldSchema>
export const packetSchema = z
  .object({
    title: z.string().max(500),
    company: z.string().max(500),
    resume: z.string().min(30).max(50000),
    // Native auto-apply learns questions while operating the employer page.
    fields: z.array(formFieldSchema).max(100),
    answers: z.record(
      z.string(),
      z.union([z.string().max(5000), z.array(z.string().max(1000)).max(100)])
    ),
    notices: z.string().max(15000),
    formHash: z.string(),
    tailored: z.boolean(),
    answerSources: z.record(z.string(), z.string()).optional(),
    answerReuseBlocked: z.array(z.string().max(300)).max(100).optional(),
    answerEvidence: z
      .record(
        z.string(),
        z
          .object({
            answer: z.union([
              z.string().max(5000),
              z.array(z.string().max(1000)).max(100),
            ]),
            source: z.string().max(6000),
            confirmedAt: z.string().nullable(),
          })
          .strict()
      )
      .optional(),
    applicationContext: z
      .object({
        country: z.string().max(100),
        profile: applicationProfileSchema.optional(),
        jobDescription: z.string().max(12000),
      })
      .strict()
      .optional(),
    rememberedAnswers: z
      .record(
        z.string(),
        z.object({
          id: z.uuid(),
          scope: z.enum(["employer", "all"]),
        })
      )
      .optional(),
    stepNotices: z.array(z.string().max(15000)).max(8).optional(),
    engine: z.enum(["computer-v1", "browser-use"]).optional(),
  })
  .strict()
  .refine(
    (packet) => packet.fields.length > 0 || packet.engine === "browser-use",
    {
      message:
        "An application without discovered fields requires the native browser agent",
      path: ["fields"],
    }
  )
export type ApplicationPacket = z.infer<typeof packetSchema>

// Suggest only verbatim experience excerpts. Personal choices, authorization,
// consent and motivation cannot be established by matching resume keywords.
export function suggestExperienceAnswers(
  fields: ApplicationField[],
  highlights: { text: string }[]
) {
  const answers: Record<string, string> = {}
  for (const field of fields) {
    const question = `${field.label} ${field.help}`
    if (
      !["text", "textarea"].includes(field.kind) ||
      /salary|compensation|visa|sponsor|authoriz|citizen|national|gender|disabil|consent|agree|notice|availab|start date|why |motivat|interest|referr|relocat|remote|how many|how long|years|legal|\bage\b|ethnic|racial|\brace\b|relig|health|veteran|sexual|pronoun|demograph|birth|marital|famil/i.test(
        question
      )
    )
      continue
    if (
      !/describe.*(?:experience|project|workflow)|relevant experience|tell us.*(?:built|deployed|operated)/i.test(
        question
      )
    )
      continue
    const words = [
      ...new Set(question.toLowerCase().match(/[a-z]{4,}/g) || []),
    ].filter(
      (w) =>
        ![
          "your",
          "have",
          "with",
          "that",
          "about",
          "please",
          "describe",
          "experience",
          "relevant",
          "tell",
          "been",
          "what",
        ].includes(w)
    )
    const best = highlights
      .map((h) => ({
        text: h.text,
        score: words.filter((w) => h.text.toLowerCase().includes(w)).length,
      }))
      .filter((h) => h.score >= 2 && h.text.length <= 5000)
      .sort((a, b) => b.score - a.score)[0]
    if (best) answers[field.id] = best.text
  }
  return answers
}
export type ApplicationRun = {
  id: string
  job_id: string | null
  target_url: string
  status: string
  revision: number
  packet: ApplicationPacket | null
  approved_revision: number | null
  prepare_attempts?: number
  message: string
  receipt: {
    text: string
    url: string
    confirmedAt: string
    resumeHash: string
  } | null
  created_at: string
  updated_at: string
  started_at: string | null
  auto_submit_requested_at?: string | null
  employer_key?: string | null
  automatic?: boolean
}
export const editableStatuses = ["ready", "queued", "needs_attention"]
export function applicationTarget(value: string): string | null {
  try {
    const target = publicApplicationUrl(value)
    if (!target) return null
    const url = new URL(target)
    // Existing provider normalizations are deduplication optimizations only.
    // Every other public HTTPS employer URL uses the same browser runner.
    const match = url.pathname.match(
      /^\/([\w.-]+)\/([a-f0-9-]{36})(?:\/application)?\/?$/i
    )
    if (url.hostname === "jobs.ashbyhq.com" && match)
      return `${url.origin}/${match[1]}/${match[2]}/application`
    if (
      [
        "job-boards.greenhouse.io",
        "boards.greenhouse.io",
        "job-boards.eu.greenhouse.io",
      ].includes(url.hostname) &&
      /^\/[\w.-]+\/jobs\/\d+\/?$/.test(url.pathname)
    )
      return `${url.origin}${url.pathname.replace(/\/$/, "")}`
    if (
      ["jobs.lever.co", "jobs.eu.lever.co"].includes(url.hostname) &&
      /^\/[\w.-]+\/[a-f0-9-]{36}(?:\/apply)?\/?$/i.test(url.pathname)
    )
      return `${url.origin}${url.pathname.replace(/(?:\/apply)?\/?$/, "")}/apply`
    return target
  } catch {
    return null
  }
}

export function applicationUnavailableReason(job: {
  url: string
  isActive?: boolean
}) {
  if (job.isActive === false) return "This listing is closed."
  if (!applicationTarget(job.url)) return "A public HTTPS job link is required."
  return null
}

// Name meaning is independent of the input's transport type. Keep this grounded
// in observed labels/autocomplete, never a model-supplied replacement label.
export function applicationNamePurpose(
  field: ApplicationField
):
  | "fullName"
  | "givenName"
  | "familyName"
  | "preferredName"
  | "legalGivenName"
  | "legalFamilyName"
  | undefined {
  if (field.kind !== "text") return
  if (
    /reference|referee|referral|emergency|recruiter|manager|supervisor|company|employer|organization|school|university|previous|former|alternate|other|passport|birth|signature|consent|agree/i.test(
      `${field.label} ${field.help}`
    )
  )
    return
  const label = field.label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^(.+)\s+\1$/, "$1")
    .replace(/\((?:required|optional)\)/g, "")
    .replace(/\(s\)/g, "s")
    .replace(/[()*_:/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please )?(?:enter|provide|type|write) /, "")
    .replace(/^(?:your|applicant|candidate)(?:'s)? /, "")
  if (/^preferred (?:full name|name|first (?:and|&) last name)$/.test(label))
    return "preferredName"
  if (/^legal (?:first|given) names?$/.test(label)) return "legalGivenName"
  if (/^legal (?:(?:last|family) names?|surnames?)$/.test(label))
    return "legalFamilyName"
  const purpose =
    /^(?:full name|name|first (?:and|&) last name|name first (?:and|&) last)$/.test(
      label
    )
      ? "fullName"
      : /^(?:(?:first|given) names?|forenames?|first names? given names?|given names? first names?)$/.test(
            label
          )
        ? "givenName"
        : /^(?:(?:last|family) names?|surnames?|last names? surnames?|surnames? last names?)$/.test(
              label
            )
          ? "familyName"
          : undefined
  const autocomplete = field.autocomplete?.trim().split(/\s+/).at(-1)
  const hint =
    autocomplete === "name"
      ? "fullName"
      : autocomplete === "given-name"
        ? "givenName"
        : autocomplete === "family-name"
          ? "familyName"
          : undefined
  if (!purpose && !/^(?:first|last|given|family|contact)?$/.test(label)) return
  // A generic Name label commonly has a more precise autocomplete hint. A
  // contradictory specific label stays unresolved instead of choosing a side.
  if (purpose && hint && purpose !== hint && label !== "name") return
  return hint || purpose
}

// Copy confirmed identity and exact public links. Never infer authorization,
// salary, demographics, availability or consent from a resume.
export function profileAnswers(
  fields: ApplicationField[],
  profile: {
    fullName: string
    resumeText: string
    givenName?: string
    familyName?: string
  },
  email: string
) {
  const answers: Record<string, string> = {}
  const name = profile.fullName.trim().split(/\s+/)
  const contact = resumeContacts(profile.resumeText)
  for (const field of fields) {
    if (!["text", "email", "url", "tel"].includes(field.kind)) continue
    if (
      /country code|area code|extension|\bext\b/i.test(field.label) ||
      /(?:^|\s)tel-(?:country-code|area-code|local|local-prefix|local-suffix|extension)$/.test(
        field.autocomplete || ""
      )
    )
      continue
    if (
      /\b(?:references?|referee|referral|emergency|recruiter|manager|supervisor|previous|former|alternate|other|consent|agree|salary|sponsor|authorization|gender|pronoun)\b/i.test(
        field.label
      )
    )
      continue
    const autocomplete = field.autocomplete?.split(/\s+/).at(-1)
    const purpose: Record<string, string> = {
      name: "full name",
      "given-name": "first name",
      "family-name": "last name",
      email: "email",
      tel: "phone",
      "tel-national": "phone",
    }
    const label =
      (autocomplete && purpose[autocomplete]) ||
      field.label
        .replace(/^(.+)\s+\1$/i, "$1")
        .replace(/\((?:required|optional)\)/gi, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\blinked in\b/gi, "linkedin")
        .replace(/\bgit hub\b/gi, "github")
        .replace(/[*_:]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    const namePurpose = applicationNamePurpose(field)
    const nameValue =
      namePurpose === "fullName"
        ? profile.fullName.trim()
        : namePurpose === "givenName"
          ? profile.givenName?.trim() || (name.length === 2 ? name[0] : "")
          : namePurpose === "familyName"
            ? profile.familyName?.trim() || (name.length === 2 ? name[1] : "")
            : ""
    if (nameValue) answers[field.id] = nameValue
    if (
      /^(?:your |contact )?e-?mail(?: address)?$/.test(label) ||
      field.kind === "email"
    ) {
      const value = contact.email || email
      if (z.email().safeParse(value).success) answers[field.id] = value
    }
    if (
      /^(?:your |contact )?(?:phone|mobile|cell|telephone|tel)(?: (?:phone|number|no\.?))?$/.test(
        label
      ) ||
      field.kind === "tel"
    ) {
      if (contact.phone) answers[field.id] = contact.phone
    }
    for (const site of ["linkedin", "github"] as const) {
      if (
        new RegExp(`^(?:your )?${site}(?: profile)?(?: (?:url|link))?$`).test(
          label
        ) &&
        contact[site]
      )
        answers[field.id] = contact[site]
    }
  }
  return answers
}
export function fillMissingProfileAnswers(
  packet: ApplicationPacket,
  profile: { fullName: string; resumeText: string },
  email: string
) {
  const answers = { ...packet.answers }
  for (const [id, value] of Object.entries(
    profileAnswers(packet.fields, profile, email)
  )) {
    const current = answers[id]
    if (
      current === undefined ||
      (typeof current === "string" && !current.trim())
    )
      answers[id] = value
  }
  return packetSchema.parse({ ...packet, answers })
}
export function missingAnswers(packet: ApplicationPacket): string[] {
  const missing: string[] = []
  if (new Set(packet.fields.map((f) => f.id)).size !== packet.fields.length)
    missing.push("Duplicate employer question")
  for (const field of packet.fields) {
    const value = packet.answers[field.id]
    const values = Array.isArray(value)
      ? value
      : value?.trim()
        ? [value.trim()]
        : []
    if (field.kind === "resume") continue
    if (field.kind === "unsupported") {
      if (field.required) missing.push(field.label)
      continue
    }
    if (field.required && values.length === 0) {
      missing.push(field.label)
      continue
    }
    if (
      values.length &&
      field.options.length &&
      values.some((v) => !field.options.includes(v))
    )
      missing.push(field.label)
    if (field.kind !== "checkbox" && values.length > 1)
      missing.push(field.label)
    if (
      values.length &&
      field.kind === "email" &&
      !z.email().safeParse(values[0]).success
    )
      missing.push(field.label)
    if (
      values.length &&
      field.kind === "url" &&
      !/^https?:\/\/\S+$/.test(values[0])
    )
      missing.push(field.label)
    if (
      values.length &&
      field.kind === "number" &&
      !Number.isFinite(Number(values[0]))
    )
      missing.push(field.label)
  }
  if (
    Object.keys(packet.answers).some(
      (id) => !packet.fields.some((f) => f.id === id)
    )
  )
    missing.push("Unknown question")
  return [...new Set(missing)]
}
export function statusLabel(
  status: string,
  run?: Pick<ApplicationRun, "automatic" | "packet">
) {
  if (status === "ready" && run?.automatic)
    return run.packet && missingAnswers(run.packet).length
      ? "Waiting for your answers"
      : "Continuing automatically"
  return (
    (
      {
        queued_prepare: "In queue · Waiting to prepare",
        preparing: "In flight · Preparing application",
        ready: "Application prepared",
        queued: "In queue · Waiting to send",
        running: "In flight · Checking application",
        submitting: "In flight · Sending application",
        submitted: "Submission confirmed",
        submission_unknown: "Ready to retry",
        needs_attention: "Your attention needed",
        cancelled: "Cancelled",
      } as Record<string, string>
    )[status] ?? status
  )
}
