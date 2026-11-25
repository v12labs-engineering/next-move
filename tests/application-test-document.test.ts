import assert from "node:assert/strict"
import test from "node:test"
import {
  documentFileName,
  resumeFile,
} from "../lib/server/applications/browser"
import { resumeDocx } from "../lib/server/resume/pdf"
import { testResumeMatches } from "../lib/server/applications/test-document"

const source =
  "Test Candidate\n\nEXPERIENCE\nBuilt TypeScript APIs and SQL databases for a generated fictional staging project.\n- Tested browser uploads and durable application receipts."
test("the synthetic receiver accepts the actual runner PDF and rejects a different approved resume", async () => {
  const upload = await resumeFile(source)
  assert.equal(upload.name, "Test_Candidate_Resume.pdf")
  assert.equal(await testResumeMatches(upload.buffer, source), true)
  assert.equal(
    await testResumeMatches(
      upload.buffer,
      source + "\nAn invented qualification."
    ),
    false
  )
})
test("upload names use the resume heading only when it reads as a name", () => {
  assert.equal(
    documentFileName("José O'Neil-Smith\nEXPERIENCE"),
    "José_ONeil-Smith_Resume.pdf"
  )
  assert.equal(
    documentFileName("SUMMARY: 10 years building APIs"),
    "Resume.pdf"
  )
  assert.equal(
    documentFileName("Ada Lovelace\n...", "Cover_Letter"),
    "Ada_Lovelace_Cover_Letter.pdf"
  )
})
test("the synthetic receiver retains legacy DOCX checks and rejects malformed files", async () => {
  const docx = new Uint8Array(await (await resumeDocx(source)).arrayBuffer())
  assert.equal(await testResumeMatches(docx, source), true)
  assert.equal(await testResumeMatches(docx, "Different resume"), false)
  assert.equal(
    await testResumeMatches(
      new TextEncoder().encode("Invalid document"),
      source
    ),
    false
  )
})
