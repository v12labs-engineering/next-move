import assert from "node:assert/strict"
import test from "node:test"
import { zipSync, strToU8 } from "fflate"
import { extractResume } from "@/lib/server/resume/import"
import { postingSponsorship } from "@/lib/jobs/sponsorship"
import { profileAnswers } from "@/lib/applications"

const text =
  "Alice Example\nBackend engineer building reliable payments APIs with Python and Postgres. Five years of experience delivering production systems."
test("resume import extracts UTF-8 text and DOCX paragraphs", async () => {
  assert.equal(await extractResume(strToU8(text), "resume.txt"), text)
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  const docx = zipSync({ "word/document.xml": strToU8(xml) })
  assert.equal(await extractResume(docx, "resume.docx"), text)
})
test("resume import rejects unsupported, malformed, oversized and empty files", async () => {
  await assert.rejects(extractResume(strToU8(text), "resume.exe"), /PDF, DOCX/)
  await assert.rejects(
    extractResume(strToU8(text), "resume.pdf"),
    /Invalid PDF/
  )
  await assert.rejects(
    extractResume(new Uint8Array(2_000_001), "resume.txt"),
    /2 MB/
  )
  await assert.rejects(
    extractResume(strToU8("short"), "resume.txt"),
    /Too little/
  )
  await assert.rejects(
    extractResume(
      zipSync({ "large.txt": new Uint8Array(2_000_001) }),
      "resume.docx"
    ),
    /expands/
  )
})
test("DOCX import preserves referenced contact hyperlinks for application autofill", async () => {
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:hyperlink r:id="contact"><w:r><w:t>LinkedIn</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`
  const rels = `<Relationships><Relationship Id="contact" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.linkedin.com/in/alice-example" TargetMode="External"/><Relationship Id="unreferenced" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://linkedin.com/in/someone-else" TargetMode="External"/></Relationships>`
  const result = await extractResume(
    zipSync({
      "word/document.xml": strToU8(xml),
      "word/_rels/document.xml.rels": strToU8(rels),
    }),
    "resume.docx"
  )
  assert.deepEqual(
    profileAnswers(
      [
        {
          id: "linkedin",
          label: "LinkedIn URL",
          help: "",
          kind: "url",
          required: true,
          options: [],
        },
      ],
      { fullName: "Alice Example", resumeText: result },
      "login@example.test"
    ),
    {
      linkedin: "https://www.linkedin.com/in/alice-example",
    }
  )
  assert.equal(result.includes("someone-else"), false)
})
test("PDF import extracts actual text from a valid one-page PDF", async () => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  const stream =
    "BT /F1 10 Tf 30 700 Td (Alice Example) Tj 0 -20 Td (Backend engineer building reliable payments APIs with Python and) Tj 0 -20 Td (Postgres. Five years of experience delivering production systems.) Tj ET"
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  objects.push(
    "<< /Type /Annot /Subtype /Link /Rect [30 600 90 620] /A << /Type /Action /S /URI /URI (https://linkedin.com/in/alice-example) >> >>"
  )
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n"
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const result = await extractResume(strToU8(pdf), "resume.pdf")
  assert.ok(result.includes("Backend engineer"))
  assert.ok(result.includes("production systems"))
  assert.ok(result.includes("https://linkedin.com/in/alice-example"))
})
test("role sponsorship evidence separates explicit support, refusal and unknown", () => {
  assert.equal(
    postingSponsorship("We provide visa sponsorship for this position.").signal,
    "confirmed"
  )
  assert.equal(
    postingSponsorship("Visa sponsorship is available.").signal,
    "confirmed"
  )
  for (const phrase of [
    "No visa sponsorship",
    "We cannot sponsor visas",
    "We do not provide visa sponsorship",
    "Visa sponsorship is not available",
    "You must already have the right to work",
  ])
    assert.equal(postingSponsorship(phrase).signal, "no", phrase)
  assert.equal(
    postingSponsorship("Relocation support. Employer is a registered sponsor.")
      .signal,
    "possible"
  )
  assert.equal(postingSponsorship("").signal, "possible")
})
