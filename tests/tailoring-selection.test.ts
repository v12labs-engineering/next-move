import assert from "node:assert/strict"
import test from "node:test"
import { tailorResume } from "../lib/server/tailoring"
import { applicationFailure } from "../lib/applications/pipeline"
import { extractText, getDocumentProxy } from "unpdf"
import {
  assembleResume,
  groundResumeKeywords,
  resumeBlocks,
  resumeDraftContent,
  resumeKeywordCoverage,
} from "../lib/resume"
import { resumePdf } from "../lib/server/resume/pdf"
const source =
  "Documented TypeScript and React development. Built backend services and SQL APIs."

test("a long resume without blank lines has selectable verbatim passages", () => {
  const resume = Array.from(
    { length: 90 },
    (_, index) =>
      `Project ${index}: Built and maintained TypeScript services for production workloads.`
  ).join("\n")
  const blocks = resumeBlocks(resume)
  assert.ok(blocks.length >= 6)
  assert.equal(blocks.map(({ text }) => text).join("\n"), resume)
  const selection = blocks.slice(0, 6)
  const tailored = assembleResume(resume, {
    blockIds: selection.map(({ id }) => id),
  })
  assert.deepEqual(tailored.highlights, selection)
  assert.equal(tailored.content, resume)
})

for (const valid of [true, false])
  test(`tailoring ${valid ? "selects only" : "rejects references outside"} the actual source blocks`, async (t) => {
    const old = { ...process.env }
    Object.assign(process.env, {
      TAILORING_BASE_URL: "https://model.example.test/v1",
      TAILORING_API_KEY: "fixture",
      TAILORING_MODEL: "fixture-model",
      TAILORING_REASONING: "none",
    })
    t.after(() => {
      process.env = old
    })
    let calls = 0
    t.mock.method(
      globalThis,
      "fetch",
      async (_input: unknown, init: RequestInit) => {
        calls++
        const body = JSON.parse(String(init.body))
        assert.deepEqual(
          body.response_format.json_schema.schema.properties.blockIds.items
            .enum,
          ["block-1"]
        )
        assert.equal(
          body.response_format.json_schema.schema.properties.blockIds.maxItems,
          1
        )
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  keywords: ["TypeScript", "Fluent German", "invented"],
                  blockIds: [valid ? "block-1" : "invented-block"],
                  fit: {
                    missing: ["Fluent German"],
                  },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        })
      }
    )
    const result = tailorResume(source, {
      title: "Engineer",
      description: "Fluent German required. TypeScript services.",
      company: "Fixture",
    })
    if (valid) {
      const tailored = await result
      assert.equal(tailored.content, source)
      assert.equal(tailored.highlights[0].text, source)
      assert.deepEqual(tailored.coverage, {
        matched: ["TypeScript"],
        missing: ["Fluent German"],
        total: 2,
        percent: 50,
      })
      assert.deepEqual(tailored.fit, {
        meetsRequired: false,
        missing: ["Fluent German"],
      })
    } else
      await assert.rejects(result, (error) => {
        assert.equal(applicationFailure(error).code, "invalid_model_response")
        assert.equal(applicationFailure(error).retryable, true)
        return true
      })
    assert.equal(calls, 1)
  })
test("invalid model-selection diagnostics stay private and can retry preparation", () => {
  for (const error of [
    new Error("AI returned an unknown source reference."),
    new Error("Selected highlights are too long."),
    Object.assign(new Error("private provider answer payload"), {
      name: "AI_NoObjectGeneratedError",
    }),
  ]) {
    const failure = applicationFailure(error)
    assert.equal(failure.code, "invalid_model_response")
    assert.equal(failure.retryable, true)
    assert.doesNotMatch(failure.message, /private|payload/)
  }
})

test("a lone surrogate before an early break still splits the resume", () => {
  const blocks = resumeBlocks(`\uD800\n${"x".repeat(3000)}`)
  assert.ok(blocks.length > 1)
  assert.ok(blocks.every((block) => block.text.length > 0))
})

test("a tailored resume renders as one copy with keywords prioritized within the original role", async () => {
  const source = [
    "Alex Example",
    "EXPERIENCE",
    "Example Company",
    "- Wrote internal documentation.",
    "- Built TypeScript services and SQL APIs.",
    "",
    "EDUCATION",
    "Example University",
  ].join("\n")
  const evidence = groundResumeKeywords(
    "TypeScript, SQL, Java, CI/CD and service design.",
    source,
    [
      "TypeScript",
      "TYPESCRIPT",
      "SQL",
      "Java",
      "CI/CD",
      "service design",
      "JavaScript",
    ]
  )
  const { content } = assembleResume(
    source,
    { blockIds: ["block-1"] },
    evidence.supportedKeywords
  )
  assert.match(content, /Example Company\n- Built TypeScript/)
  assert.deepEqual(resumeKeywordCoverage(content, evidence), {
    matched: ["TypeScript", "SQL"],
    missing: ["Java", "CI/CD", "service design"],
    total: 5,
    percent: 40,
  })
  const pdf = await getDocumentProxy(await resumePdf(content))
  try {
    const { text, totalPages } = await extractText(pdf, { mergePages: true })
    assert.equal(totalPages, 1)
    for (const value of ["Alex Example", "TypeScript", "Example University"])
      assert.equal(text.split(value).length, 2)
    assert.doesNotMatch(text, /RELEVANT EXPERIENCE|FULL RESUME/)
  } finally {
    await pdf.loadingTask.destroy()
  }
})

test("coverage excludes partial and unsupported matches and checks the actual draft", () => {
  const evidence = groundResumeKeywords(
    "C, C++, Java, React, automated testing",
    "C++, JavaScript, React, automated\ntesting",
    ["C", "C++", "Java", "React", "automated testing"]
  )
  assert.deepEqual(
    resumeKeywordCoverage("C, C++ and Java with automated testing", evidence),
    {
      matched: ["C++", "automated testing"],
      missing: ["C", "Java", "React"],
      total: 5,
      percent: 40,
    }
  )
  assert.equal(
    resumeKeywordCoverage("React", groundResumeKeywords("", "React", ["React"]))
      .percent,
    null
  )
})

test("legacy cleanup removes the generated prefix and preserves candidate edits", () => {
  const evidence = { highlights: [{ text: "Original highlight." }] }
  const prefix = "RELEVANT EXPERIENCE\n\nOriginal highlight.\n\nFULL RESUME\n\n"
  assert.equal(
    resumeDraftContent(prefix + "Edited resume", evidence),
    "Edited resume"
  )
  const editedPrefix = prefix.replace("Original", "Edited")
  assert.equal(
    resumeDraftContent(editedPrefix + source, evidence),
    editedPrefix + source
  )
})
