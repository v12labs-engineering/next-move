import { unzipSync } from "fflate"
import { load } from "cheerio"
import { extractText, getDocumentProxy } from "unpdf"
import { HttpError } from "@/lib/server/http"
import { resumeContacts } from "@/lib/resume/contact"

// Hyperlink captions often say only "LinkedIn" or "Email". Preserve the actual
// embedded contact target as source text without fetching or following it.
function contactLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null
  try {
    const url = new URL(value)
    if (url.protocol === "mailto:") {
      const email = resumeContacts(decodeURIComponent(url.pathname)).email
      return email ? `Email: ${email}` : null
    }
    if (url.protocol === "tel:") {
      const phone = resumeContacts(
        `Phone: ${decodeURIComponent(url.pathname)}`
      ).phone
      return phone ? `Phone: ${phone}` : null
    }
    if (!["https:", "http:"].includes(url.protocol)) return null
    if (
      !["linkedin.com", "github.com"].includes(
        url.hostname.replace(/^www\./, "")
      )
    )
      return null
    const contacts = resumeContacts(value)
    return contacts.linkedin || contacts.github || null
  } catch {
    return null
  }
}

function appendContactLinks(text: string, targets: unknown[]) {
  const links = [
    ...new Set(targets.map(contactLink).filter((link) => link !== null)),
  ].filter((link) => !text.includes(link))
  return [text, ...links].join("\n").trim()
}

export async function extractResume(
  bytes: Uint8Array,
  name: string
): Promise<string> {
  if (!bytes.length || bytes.length > 2_000_000)
    throw new HttpError(413, "Resume must be between 1 byte and 2 MB.")
  let text = ""
  if (/\.txt$/i.test(name)) {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (text.includes("\u0000"))
      throw new HttpError(400, "Choose a UTF-8 text resume.")
  } else if (/\.pdf$/i.test(name)) {
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
      throw new HttpError(400, "Invalid PDF file.")
    const pdf = await getDocumentProxy(bytes, { maxImageSize: 1_000_000 })
    try {
      if (pdf.numPages > 20)
        throw new HttpError(400, "Choose a resume with 20 pages or fewer.")
      text = (await extractText(pdf, { mergePages: true })).text
      const targets: unknown[] = []
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber)
        const annotations = await page.getAnnotations()
        for (const annotation of annotations)
          if (annotation.subtype === "Link") targets.push(annotation.url)
      }
      text = appendContactLinks(text, targets)
    } finally {
      await pdf.loadingTask.destroy()
    }
  } else if (/\.docx$/i.test(name)) {
    let count = 0,
      total = 0
    const files = unzipSync(bytes, {
      filter(entry) {
        count++
        total += entry.originalSize
        if (
          count > 1000 ||
          total > 10_000_000 ||
          entry.originalSize > 2_000_000
        )
          throw new HttpError(
            400,
            "This document expands beyond the resume size limit."
          )
        return ["word/document.xml", "word/_rels/document.xml.rels"].includes(
          entry.name
        )
      },
    })
    const xml = files["word/document.xml"]
    if (!xml) throw new HttpError(400, "Invalid DOCX file.")
    const $ = load(new TextDecoder().decode(xml), { xml: true })
    text = $("w\\:p")
      .toArray()
      .map((p) =>
        $(p)
          .find("w\\:t")
          .toArray()
          .map((t) => $(t).text())
          .join("")
      )
      .join("\n")
    const relationships = files["word/_rels/document.xml.rels"]
    if (relationships) {
      const rels = load(new TextDecoder().decode(relationships), { xml: true })
      const used = new Set(
        $("w\\:hyperlink")
          .toArray()
          .map((link) => $(link).attr("r:id"))
      )
      const targets = rels("Relationship")
        .toArray()
        .filter(
          (rel) =>
            used.has(rels(rel).attr("Id")) &&
            rels(rel).attr("TargetMode") === "External" &&
            rels(rel).attr("Type")?.endsWith("/hyperlink")
        )
        .map((rel) => rels(rel).attr("Target"))
      text = appendContactLinks(text, targets)
    }
  } else throw new HttpError(415, "Choose a PDF, DOCX or UTF-8 text resume.")
  text = text.replace(/\r\n?/g, "\n").trim()
  if (text.length < 100)
    throw new HttpError(
      400,
      "Too little resume text was found. Paste a text version if this is a scanned document."
    )
  if (text.length > 30_000)
    throw new HttpError(400, "Resume text exceeds 30,000 characters.")
  return text
}
