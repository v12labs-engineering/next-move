import {
  applicationProfileFresh,
  applicationCurrencies,
  type ApplicationProfile,
} from "./profile"
import {
  missingAnswers,
  profileAnswers,
  applicationNamePurpose,
  type ApplicationField,
  type ApplicationPacket,
} from "./index"
import { countryCode, countryName, countryOptions } from "../location/countries"

const normalize = (value: string) =>
  value.toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim()

// Search-backed location controls may add an administrative region to an
// approved city/country. Preserve every supplied component in order and require
// a unique observed option. Never turn this into a relocation preference.
export function observedLocationAnswer(
  field: ApplicationField,
  answer: string | string[] | undefined
): string | undefined {
  if (field.kind !== "combobox" || typeof answer !== "string") return
  const question = `${field.label} ${field.help}`
  if (
    !/location|where.*(?:based|live|located)|city of residence/i.test(
      question
    ) ||
    /relocat|prefer|office|willing|desired|authorized|sponsor/i.test(question)
  )
    return
  const parts = answer.split(",").map(normalize)
  if (parts.length < 2 || parts.some((p) => !p)) return
  const matches = field.options.filter((option) => {
    const candidate = option.split(",").map(normalize)
    if (candidate[0] !== parts[0] || candidate.at(-1) !== parts.at(-1))
      return false
    let previous = -1
    return parts.every((part) => {
      const index = candidate.indexOf(part, previous + 1)
      previous = index
      return index >= 0
    })
  })
  if (matches.length) return matches.length === 1 ? matches[0] : undefined
  // A generic Location control can offer a country alongside regions. Use an
  // exact known country option only when the question does not demand city,
  // state or street precision. This changes granularity, not the supplied fact.
  if (/city|state|province|town|street|address|postal|zip/i.test(question))
    return
  const country = countryName(parts.at(-1)!)
  const choices = country
    ? field.options.filter((option) => countryName(option) === country)
    : []
  return choices.length === 1 ? choices[0] : undefined
}
const blocked =
  /consent|agree|terms|privacy|certif|declar|attest|acknowledg|gender|disabil|veteran|ethnic|racial|\brace\b|religio|sexual|pronoun|birth|marital|criminal|convict|\breferr|referee|nationality|citizenship|citizen|passport|security clearance/i
export function profileQuestionAllowed(field: ApplicationField) {
  return (
    !["resume", "unsupported", "checkbox"].includes(field.kind) &&
    !blocked.test([field.label, field.help, ...field.options].join(" "))
  )
}
export function validFieldAnswer(
  field: ApplicationField,
  answer: string | string[]
) {
  return (
    missingAnswers({
      title: "",
      company: "",
      resume: "Validation packet with a sufficiently long resume.",
      tailored: true,
      formHash: "",
      notices: "",
      fields: [field],
      answers: { [field.id]: answer },
    }).length === 0
  )
}
function booleanAnswer(field: ApplicationField, value: boolean) {
  // Only explicit binary options are safe. "Yes, if ..." carries extra meaning.
  const target = value ? "yes" : "no"
  if (field.options.length) {
    const matches = field.options.filter(
      (option) => normalize(option) === target
    )
    return matches.length === 1 ? matches[0] : undefined
  }
  return ["text", "textarea", "yesno"].includes(field.kind)
    ? value
      ? "Yes"
      : "No"
    : undefined
}

function resolveField(
  field: ApplicationField,
  profile: ApplicationProfile,
  country: string,
  now: Date
): { answer: string; source: string } | undefined {
  if (!profileQuestionAllowed(field)) return
  const namePurpose = applicationNamePurpose(field)
  const nameContact =
    namePurpose === "legalGivenName"
      ? "givenName"
      : namePurpose === "legalFamilyName"
        ? "familyName"
        : namePurpose === "givenName" ||
            namePurpose === "familyName" ||
            namePurpose === "preferredName"
          ? namePurpose
          : undefined
  if (nameContact) {
    const answer = profile.contact[nameContact]
    if (answer)
      return {
        answer,
        source: `Confirmed application profile · ${nameContact === "givenName" ? "legal first/given name" : nameContact === "familyName" ? "legal last/family name" : "preferred full name"}`,
      }
  }
  const label = normalize(field.label)
    .replace(/^(.+)\s+\1$/, "$1")
    .replace(/\((?:required|optional)\)/g, "")
    .replace(/[*_:]/g, " ")
    .replace(/e-mail/g, "email")
    .replace(/linked in/g, "linkedin")
    .replace(/git hub/g, "github")
    .replace(/\s+/g, " ")
    .trim()
  const question = normalize(`${field.label} ${field.help}`)
  const contactLabels: Record<string, keyof ApplicationProfile["contact"]> = {
    email: "email",
    "email address": "email",
    "your email": "email",
    phone: "phone",
    "phone number": "phone",
    "mobile number": "phone",
    linkedin: "linkedin",
    "linkedin url": "linkedin",
    "linkedin profile": "linkedin",
    github: "github",
    "github url": "github",
    portfolio: "portfolio",
    "portfolio url": "portfolio",
    "personal website": "portfolio",
    website: "portfolio",
  }
  const autocomplete = field.autocomplete?.split(/\s+/).at(-1)
  // Residence is already confirmed profile data. Resolve it before the AI
  // fallback, which intentionally excludes unresolved personal facts.
  const residenceCountry =
    /^(?:(?:your|current|home) )?country(?: of residence)?$/.test(label) ||
    /^(?:select|choose)(?: your| a)? country$/.test(label) ||
    /^(?:what|which) country do you (?:live|reside) in\??$/.test(label) ||
    autocomplete === "country" ||
    autocomplete === "country-name"
  const residenceLocation =
    /^(?:(?:your|current|home) )?location$/.test(label) ||
    /^where (?:are you (?:based|located)|do you live)\??$/.test(label)
  if (
    (residenceCountry || residenceLocation) &&
    profile.contact.location &&
    !/relocat|prefer|office|willing|desired|authoriz|sponsor|citizen|nationality|birth|phone|dial|calling|country code|employer|company|previous|former|reference|emergency/.test(
      question
    )
  ) {
    const location = profile.contact.location.trim()
    const value = residenceCountry
      ? countryName(location.split(",").at(-1)!)
      : location
    if (value) {
      const matches = field.options.filter((option) =>
        residenceCountry
          ? countryName(option) === value
          : normalize(option) === normalize(value)
      )
      const answer = field.options.length
        ? matches.length === 1
          ? matches[0]
          : matches.length === 0 && residenceLocation
            ? observedLocationAnswer(field, value)
            : undefined
        : autocomplete === "country" && residenceCountry
          ? countryCode(value)
          : value
      if (answer)
        return { answer, source: "Confirmed application profile · location" }
    }
  }
  const contact =
    contactLabels[label] ||
    (/^(?:your |contact )?email(?: address)?$/.test(label) ||
    autocomplete === "email" ||
    field.kind === "email"
      ? "email"
      : undefined) ||
    (/^(?:your |contact )?(?:phone|mobile|telephone)(?: number)?$/.test(
      label
    ) || autocomplete === "tel"
      ? "phone"
      : undefined) ||
    (/^(?:your )?linkedin(?: profile)?(?: (?:url|link))?$/.test(label)
      ? "linkedin"
      : undefined) ||
    (/^(?:your )?github(?: profile)?(?: (?:url|link))?$/.test(label)
      ? "github"
      : undefined)
  if (
    contact &&
    /reference|referee|emergency|recruiter|manager|supervisor|company|employer|previous|former|alternate|other|salary|sponsor|authoriz|country code|area code|extension/.test(
      question
    )
  )
    return
  if (contact && profile.contact[contact])
    return {
      answer: profile.contact[contact],
      source: `Confirmed application profile · ${contact}`,
    }
  if (!applicationProfileFresh(profile, now)) return

  const eligibility = profile.eligibility.find(
    (entry) => entry.country === country
  )
  const mentionsOtherCountry =
    countryOptions.some(
      (name) =>
        name !== country &&
        new RegExp(
          `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i"
        ).test(question)
    ) ||
    (country !== "United States" &&
      /\b(?:USA|US|U\.S\.(?:A\.)?)\b/.test(`${field.label} ${field.help}`)) ||
    (country !== "United Kingdom" &&
      /\b(?:uk|u\.k\.|great britain)\b/i.test(question))
  if (
    mentionsOtherCountry &&
    /sponsor|authoriz|right to work|eligible to work|salary|compensation/.test(
      question
    )
  )
    return
  // Reject negations, conditional assertions, and compound claims rather than
  // turning a fragment into an answer to a different question.
  if (
    /\b(?:not|never|without|unless|except|if|only|previously|ever|past)\b|\bdont\b|\bcannot\b/.test(
      question
    )
  )
    return
  const boolean = (value: boolean | null | undefined, source: string) => {
    if (value === null || value === undefined) return
    const answer = booleanAnswer(field, value)
    return answer
      ? {
          answer,
          source: `Confirmed application profile · ${country} · ${source}`,
        }
      : undefined
  }
  if (/sponsor/.test(question)) {
    if (!/need|requir|request|seeking/.test(question)) return
    if (!eligibility || /authoriz|right to work|relocat|citizen/.test(question))
      return
    if (
      /\band\b/.test(question) &&
      !/now and.*future|currently and.*future/.test(question)
    )
      return
    const future = /future|later|at any (?:point|time)/.test(question)
    const both =
      /at any (?:point|time)/.test(question) ||
      (future && /now|currently|present/.test(question))
    const value = both
      ? eligibility.sponsorshipNow === true ||
        eligibility.sponsorshipFuture === true
        ? true
        : eligibility.sponsorshipNow === false &&
            eligibility.sponsorshipFuture === false
          ? false
          : null
      : future
        ? eligibility.sponsorshipFuture
        : eligibility.sponsorshipNow
    return boolean(
      value,
      both
        ? "sponsorship now or later"
        : future
          ? "future sponsorship"
          : "current sponsorship"
    )
  }
  if (/authoriz.*work|right to work|eligible to work/.test(question)) {
    if (
      /\b(?:eu|eea|europe|schengen)\b|european union|economic area|all countries|any country|worldwide|in the future|will you be|at.*start/.test(
        question
      )
    )
      return
    if (/\band\b|\bor\b|require|need|permanent|unrestrict/.test(question))
      return
    return boolean(eligibility?.authorized, "current work authorization")
  }
  if (
    /^(?:are you |would you be )?(?:willing|open|able) to relocate\??$/.test(
      label
    )
  )
    return boolean(profile.willingToRelocate, "relocation preference")
  if (/^(?:are you |would you be )?(?:willing|open) to travel\??$/.test(label))
    return boolean(profile.willingToTravel, "travel preference")
  if (/notice period/.test(question)) {
    if (
      profile.noticeDays === null ||
      /month|week|business|working|current employer|contractual/.test(question)
    )
      return
    if (field.kind === "number" && !/\bdays?\b/.test(question)) return
    return {
      answer:
        field.kind === "number"
          ? String(profile.noticeDays)
          : `${profile.noticeDays} days`,
      source: `Confirmed application profile · notice period: ${profile.noticeDays} days`,
    }
  }
  const start =
    /earliest.*start|when (?:can|could) you start|available (?:start date|to start)|start date/.test(
      question
    )
  const within = question.match(/(?:start|available).*within (\d{1,3}) days/)
  if (start || within) {
    if (profile.noticeDays === null && !profile.earliestStart) return
    const today = Date.parse(now.toISOString().slice(0, 10))
    const notice = today + (profile.noticeDays ?? 0) * 86400000
    const available = Math.max(
      notice,
      profile.earliestStart ? Date.parse(profile.earliestStart) : today
    )
    if (within)
      return boolean(
        available <= today + Number(within[1]) * 86400000,
        "availability and notice period"
      )
    if (!["text", "textarea"].includes(field.kind)) return
    return {
      answer: new Date(available).toISOString().slice(0, 10),
      source:
        "Confirmed application profile · earliest start and notice period",
    }
  }
  if (
    /salary|compensation|remuneration|\bctc\b|pay expectation/.test(question) &&
    /expect|desired|seek|target|looking|requirements/.test(question)
  ) {
    if (
      /current|previous|minimum acceptable|negotiab|\bnet\b|after.tax|take.home|\band\b|less than|more than|below|above|between|at least|\d/.test(
        question
      )
    )
      return
    const pay = profile.compensation.find((entry) => entry.country === country)
    if (!pay || pay.minimum === null || pay.maximum === null) return
    const currencies = (
      question.toUpperCase().match(/\b[A-Z]{3}\b/g) ?? []
    ).filter((code) => applicationCurrencies.includes(code))
    if (currencies.some((currency) => currency !== pay.currency)) return
    const period = /annual|year|annum/.test(question)
      ? "year"
      : /month/.test(question)
        ? "month"
        : /hour/.test(question)
          ? "hour"
          : null
    if (period && period !== pay.period) return
    const basis = /base/.test(question)
      ? "base"
      : /total|\bctc\b/.test(question)
        ? "total"
        : null
    if (basis && basis !== pay.basis) return
    // Numeric fields must state all units; no currency, period or basis guesses.
    const numeric =
      field.kind === "number" ||
      /single (?:number|amount)|numbers? only/.test(question)
    const amount =
      pay.singleAmount ?? (pay.minimum === pay.maximum ? pay.minimum : null)
    if (numeric && (!currencies.length || !period || !basis || amount === null))
      return
    const answer = numeric
      ? String(amount)
      : `${pay.minimum === pay.maximum ? pay.minimum : `${pay.minimum}–${pay.maximum}`} ${pay.currency} per ${pay.period} (${pay.basis === "base" ? "base salary" : "total compensation"})`
    return {
      answer,
      source: `Confirmed application profile · ${country} · ${pay.minimum}–${pay.maximum} ${pay.currency}/${pay.period}, ${pay.basis}`,
    }
  }
}

export function fillApplicationProfile(
  packet: ApplicationPacket,
  profile: ApplicationProfile | undefined,
  country: string,
  now = new Date()
): ApplicationPacket {
  if (!profile?.enabled || !profile.confirmedAt) return packet
  const answers = { ...packet.answers }
  const evidence = { ...packet.answerEvidence }
  for (const field of packet.fields) {
    // Deliberately blank is still a candidate choice.
    if (field.id in answers || packet.answerReuseBlocked?.includes(field.id))
      continue
    const result = resolveField(field, profile, country, now)
    if (!result || !validFieldAnswer(field, result.answer)) continue
    answers[field.id] = result.answer
    evidence[field.id] = {
      answer: result.answer,
      source: result.source,
      confirmedAt: profile.confirmedAt,
    }
  }
  return { ...packet, answers, answerEvidence: evidence }
}

export function fillApplicationIdentity(
  packet: ApplicationPacket,
  identity: { fullName: string; resumeText: string; email: string }
): ApplicationPacket {
  const answers = { ...packet.answers },
    evidence = { ...packet.answerEvidence }
  for (const [id, value] of Object.entries(
    profileAnswers(packet.fields, identity, identity.email)
  )) {
    if (id in answers || packet.answerReuseBlocked?.includes(id)) continue
    const field = packet.fields.find((field) => field.id === id)
    if (
      !field ||
      /reference|referee|emergency|recruiter|manager|supervisor|company|employer|previous|former|alternate|other/i.test(
        `${field.label} ${field.help}`
      )
    )
      continue
    answers[id] = value
    evidence[id] = {
      answer: value,
      source: "Confirmed name, resume contact details or account email",
      confirmedAt: null,
    }
  }
  return { ...packet, answers, answerEvidence: evidence }
}
