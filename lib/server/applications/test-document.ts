import { unzipSync } from "fflate"
import { load } from "cheerio"
import { extractText, getDocumentProxy } from "unpdf"
import { resumePdf } from "@/lib/server/resume/pdf"

async function pdfText(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    maxImageSize: 1_000_000,
  })
  try {
    if (pdf.numPages > 20) throw new Error("Too many pages")
    return (await extractText(pdf, { mergePages: true })).text
      .replace(/\s+/g, " ")
      .trim()
  } finally {
    await pdf.loadingTask.destroy()
  }
}

// Used only by the staging receiver to verify its generated fixture upload.
export async function testResumeMatches(bytes: Uint8Array, approved: string) {
  try {
    if (!bytes.length || bytes.length > 1_000_000) return false
    if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
      const actual = await pdfText(bytes)
      const expected = await pdfText(await resumePdf(approved))
      return actual === expected
    }
    let total = 0
    const xml = unzipSync(bytes, {
      filter(entry) {
        total += entry.originalSize
        if (total > 10_000_000 || entry.originalSize > 2_000_000)
          throw new Error("Document too large")
        return entry.name === "word/document.xml"
      },
    })["word/document.xml"]
    if (!xml) return false
    const $ = load(new TextDecoder().decode(xml), { xmlMode: true })
    return (
      $("w\\:t")
        .map((_i, element) => $(element).text())
        .get()
        .join("") === approved.replace(/\n/g, "")
    )
  } catch {
    return false
  }
}
