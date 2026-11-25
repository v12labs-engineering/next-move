import { z } from "zod"

const maxHighlights = 6
const maxHighlightLength = 6000
const maxBlockLength = Math.floor(maxHighlightLength / maxHighlights)

export function resumeBlocks(text: string) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const passages: string[] = []
  for (let paragraph of paragraphs) {
    while (paragraph.length > maxBlockLength) {
      // Prefer a line break to keep résumé bullets and headings together.
      const window = paragraph.slice(0, maxBlockLength + 1)
      const lineBreak = window.lastIndexOf("\n")
      const wordBreak = window.search(/\s(?=\S*$)/)
      let end =
        lineBreak > 0 ? lineBreak : wordBreak > 0 ? wordBreak : maxBlockLength
      if (end > 1 && /[\uD800-\uDBFF]/.test(paragraph[end - 1])) end--
      passages.push(paragraph.slice(0, end).trimEnd())
      paragraph = paragraph.slice(end).trimStart()
    }
    if (paragraph) passages.push(paragraph)
  }
  return passages.map((text, index) => ({ id: `block-${index + 1}`, text }))
}

export const selectionSchema = z
  .object({ blockIds: z.array(z.string()).min(1).max(maxHighlights) })
  .strict()

// AI selects references only. Every highlighted word comes from source text.
export function assembleResume(
  source: string,
  selection: z.infer<typeof selectionSchema>,
  keywords: readonly string[] = []
) {
  const parsed = selectionSchema.parse(selection)
  const blocks = new Map(resumeBlocks(source).map((b) => [b.id, b.text]))
  const ids = [...new Set(parsed.blockIds)]
  const highlights = ids.map((id) => {
    const text = blocks.get(id)
    if (!text) throw new Error("AI returned an unknown source reference.")
    return { id, text }
  })
  if (
    highlights.reduce((sum, b) => sum + b.text.length, 0) > maxHighlightLength
  )
    throw new Error("Selected highlights are too long.")
  return {
    content: prioritizeResumeBullets(source, keywords),
    highlights,
  }
}

export const resumeKeywordTarget = 80

const keywordSchema = z.string().trim().min(1).max(100)

export const resumeKeywordEvidenceSchema = z.object({
  keywords: z.array(keywordSchema).max(24),
  supportedKeywords: z.array(keywordSchema).max(24),
})

export type ResumeKeywordEvidence = z.infer<typeof resumeKeywordEvidenceSchema>

function comparableText(text: string) {
  return text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ")
}

function keywordPattern(keyword: string) {
  const literal = comparableText(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?<![\\p{L}\\p{N}_+#])${literal}(?![\\p{L}\\p{N}_+#])`,
    "u"
  )
}

export function groundResumeKeywords(
  jobDescription: string,
  source: string,
  proposed: readonly string[]
): ResumeKeywordEvidence {
  const job = comparableText(jobDescription)
  const resume = comparableText(source)
  const seen = new Set<string>()
  const keywords = proposed.filter((term) => {
    const normalized = comparableText(term)
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return keywordPattern(term).test(job)
  })
  return {
    keywords,
    supportedKeywords: keywords.filter((term) =>
      keywordPattern(term).test(resume)
    ),
  }
}

export function resumeKeywordCoverage(
  content: string,
  { keywords, supportedKeywords }: ResumeKeywordEvidence
) {
  const resume = comparableText(content)
  const supported = new Set(supportedKeywords)
  const matched = keywords.filter(
    (term) => supported.has(term) && keywordPattern(term).test(resume)
  )
  return {
    matched,
    missing: keywords.filter((term) => !matched.includes(term)),
    total: keywords.length,
    percent: keywords.length
      ? Math.floor((matched.length * 100) / keywords.length)
      : null,
  }
}

// Reorder only unambiguously standalone bullets in the same list.
function prioritizeResumeBullets(source: string, keywords: readonly string[]) {
  if (!keywords.length) return source
  const patterns = keywords.map(keywordPattern)
  return source.replace(
    /(?:^[ \t]*[-*•▪◦][ \t]+[^\r\n]+(?:\r?\n|(?![\s\S]))){2,}/gm,
    (list, offset: number) => {
      if (!/^(?:[ \t]*\r?\n|$)/.test(source.slice(offset + list.length)))
        return list
      const newline = list.includes("\r\n") ? "\r\n" : "\n"
      const suffix = list.endsWith(newline) ? newline : ""
      const bullets = (suffix ? list.slice(0, -suffix.length) : list).split(
        /\r?\n/
      )
      const indent = bullets[0].match(/^[ \t]*/)?.[0]
      if (bullets.some((bullet) => bullet.match(/^[ \t]*/)?.[0] !== indent))
        return list
      return (
        bullets
          .map((text) => ({
            text,
            score: patterns.filter((pattern) =>
              pattern.test(comparableText(text))
            ).length,
          }))
          .sort((a, b) => b.score - a.score)
          .map(({ text }) => text)
          .join(newline) + suffix
      )
    }
  )
}

const highlightEvidenceSchema = z.object({
  highlights: z.array(z.object({ text: z.string() })).optional(),
})

export function resumeDraftContent(content: string, evidence: unknown) {
  const parsed = highlightEvidenceSchema.safeParse(evidence)
  const highlights = parsed.success ? parsed.data.highlights : undefined
  if (!highlights?.length) return content
  const prefix = `RELEVANT EXPERIENCE\n\n${highlights.map(({ text }) => text).join("\n\n")}\n\nFULL RESUME\n\n`
  return content.startsWith(prefix) ? content.slice(prefix.length) : content
}
