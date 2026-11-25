import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { generateText, Output } from "ai"
import { z } from "zod"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { getVercelOidcTokenSync } from "@vercel/oidc"
import {
  assembleResume,
  groundResumeKeywords,
  resumeBlocks,
  resumeDraftContent,
  resumeKeywordCoverage,
  resumeKeywordEvidenceSchema,
  selectionSchema,
} from "@/lib/resume"
import { resolveTailoringConfig } from "@/lib/server/tailoring/config"

export function tailoringConfig(env: Partial<NodeJS.ProcessEnv> = process.env) {
  return resolveTailoringConfig(env, () => {
    try {
      // Functions receive a request-scoped token, unlike build-time env vars.
      return getVercelOidcTokenSync()
    } catch {
      return undefined
    }
  })
}

const tailoringSchema = selectionSchema
  .extend({
    keywords: resumeKeywordEvidenceSchema.shape.keywords,
    fit: z
      .object({
        missing: z
          .array(z.string().max(200))
          .max(10)
          .describe(
            "Explicit mandatory job requirements with no resume evidence"
          ),
      })
      .strict(),
  })
  .strict()

export async function tailorResume(
  source: string,
  job: { title: string; description: string; company: string }
) {
  const config = tailoringConfig()
  const blocks = resumeBlocks(source)
  if (!blocks.length) throw new Error("Resume source is empty")
  const provider = createOpenAICompatible({
    name: "tailoring",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    supportsStructuredOutputs: true,
  })
  const { output, usage } = await generateText({
    model: provider(config.modelId),
    reasoning: config.reasoning,
    output: Output.object({
      schema: tailoringSchema.extend({
        blockIds: z
          .array(z.enum(blocks.map((block) => block.id)))
          .min(1)
          .max(Math.min(6, blocks.length)),
      }),
    }),
    system: await readFile(
      join(process.cwd(), "skills/resume-preparation/SKILL.md"),
      "utf8"
    ),
    prompt: JSON.stringify({ job, resumeBlocks: blocks }),
    maxOutputTokens: 1800,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(45_000),
  })
  const keywordEvidence = groundResumeKeywords(
    job.description,
    source,
    output.keywords
  )
  const resume = assembleResume(
    source,
    { blockIds: output.blockIds },
    keywordEvidence.supportedKeywords
  )
  return {
    ...resume,
    keywordEvidence,
    coverage: resumeKeywordCoverage(resume.content, keywordEvidence),
    fit: {
      meetsRequired: output.fit.missing.length === 0,
      missing: output.fit.missing,
    },
    model: config.modelId,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  }
}

// Draft reuse must preserve the candidate's edits without bypassing the fresh
// qualification assessment required for unattended applications.
export async function tailorApplicationResume(
  source: string,
  job: { title: string; description: string; company: string },
  draft: {
    content: string
    evidence?: {
      highlights?: { text: string }[]
      keywordEvidence?: unknown
    } | null
  } | null,
  automatic: boolean
) {
  if (!draft) {
    const { content, highlights, fit, coverage } = await tailorResume(
      source,
      job
    )
    return { content, highlights, fit, coverage }
  }
  const assessment = automatic ? await tailorResume(source, job) : null
  const content = resumeDraftContent(draft.content, draft.evidence)
  const stored = resumeKeywordEvidenceSchema.safeParse(
    draft.evidence?.keywordEvidence
  )
  const keywordEvidence =
    assessment?.keywordEvidence ?? (stored.success ? stored.data : null)
  return {
    content,
    coverage: keywordEvidence
      ? resumeKeywordCoverage(content, keywordEvidence)
      : null,
    highlights: draft.evidence?.highlights ?? [],
    fit: assessment?.fit ?? null,
  }
}
