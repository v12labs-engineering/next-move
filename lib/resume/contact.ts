import { z } from "zod"

// Keep only unambiguous, source-backed contact details. Do not choose between
// different phone numbers or profiles, or invent a telephone country code.
export function resumeContacts(text: string) {
  const unique = (
    values: string[],
    key = (value: string) => value.toLowerCase()
  ) => {
    const candidates = new Map(values.map((value) => [key(value), value]))
    return candidates.size === 1 ? [...candidates.values()][0] : undefined
  }
  const emails = (
    text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []
  ).filter((value) => z.email().safeParse(value).success)
  const phones: string[] = []
  for (const line of text.split(/\r?\n/)) {
    // Dates, project metrics and reference contacts are not candidate phones.
    if (
      /\breferences?\b|\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present|current)\b/i.test(
        line
      )
    )
      continue
    const labelled =
      /\b(?:phone|mobile|cell|tel(?:ephone)?)\s*(?:number|no\.?)?\s*[:=]?\s*(\+?[\d(][\d \t().-]*\d)/gi
    const matches = [...line.matchAll(labelled)]
    const values = matches.length
      ? matches.map((match) => match[1])
      : [
          ...line.matchAll(
            /(?:^|[^\w@/\-])((?:\+\d|\(\d|\d)[\d \t().-]*\d)(?!\w)/g
          ),
        ].map((match) => match[1])
    for (const value of values) {
      const digits = value.replace(/\D/g, "")
      if (digits.length >= (matches.length ? 7 : 10) && digits.length <= 15) {
        // An unlabelled number must stand alone on a line, or in a contact header.
        if (
          matches.length ||
          /@|linkedin\.com|github\.com/i.test(line) ||
          line.trim() === value.trim()
        )
          phones.push(value.trim())
      }
    }
  }
  const links: Record<"linkedin" | "github", string[]> = {
    linkedin: [],
    github: [],
  }
  for (const match of text.matchAll(
    /(?:^|[^\w@./-])((?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/in\/|github\.com\/)[^\s<>"|]+)/gi
  )) {
    const raw = match[1].replace(/[.,;:!?)\]}]+$/, "")
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
      if (url.username || url.password || url.port) continue
      const host = url.hostname.replace(/^www\./, "")
      if (host === "linkedin.com" && /^\/in\/[^/]+/i.test(url.pathname))
        links.linkedin.push(url.href)
      if (host === "github.com" && /^\/[^/]+\/?$/.test(url.pathname))
        links.github.push(url.href)
    } catch {
      // Malformed source links stay unanswered.
    }
  }
  const linkKey = (value: string) => {
    const url = new URL(value)
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}${url.hash}`
  }
  return {
    email: unique(emails),
    phone: unique(phones, (value) => value.replace(/\D/g, "")),
    linkedin: unique(links.linkedin, linkKey),
    github: unique(links.github, linkKey),
  }
}
