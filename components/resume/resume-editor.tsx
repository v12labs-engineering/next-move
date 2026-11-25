"use client"
import { useState } from "react"
import { CircleCheck, CircleDot, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  resumeKeywordCoverage,
  resumeKeywordTarget,
  type ResumeKeywordEvidence,
} from "@/lib/resume"
export function ResumeEditor({
  id,
  initial,
  keywordEvidence,
}: {
  id: string
  initial: string
  keywordEvidence?: ResumeKeywordEvidence
}) {
  const [content, setContent] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState("")
  const [version, setVersion] = useState(0)
  const clean = content === saved
  const coverage =
    keywordEvidence && resumeKeywordCoverage(content, keywordEvidence)
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="space-y-2">
        <label
          htmlFor="resume-draft"
          className="text-sm font-semibold tracking-tight"
        >
          Draft
        </label>
        {coverage && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              {coverage.percent === null
                ? "Job keyword coverage unavailable."
                : `${coverage.matched.length} of ${coverage.total} job keywords matched (${coverage.percent}%). Target ${resumeKeywordTarget}%.`}
            </p>
            {coverage.missing.length > 0 && (
              <p>Unmatched job keywords · {coverage.missing.join(", ")}</p>
            )}
          </div>
        )}
        <div className="rounded-xl border bg-card shadow-xs transition-[box-shadow,border-color] duration-150 ease-out-expo focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
          <textarea
            id="resume-draft"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={50000}
            spellCheck
            className="mx-auto block min-h-[60vh] w-full max-w-[72ch] resize-y bg-transparent px-6 py-8 text-[15px] leading-relaxed outline-none sm:px-10"
          />
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t bg-card px-4 py-3">
            <p
              role="status"
              className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"
            >
              {clean ? (
                <CircleCheck className="size-3.5" aria-hidden />
              ) : (
                <CircleDot className="size-3.5 text-primary" aria-hidden />
              )}
              {message && clean
                ? message
                : clean
                  ? "All changes saved"
                  : message || "Unsaved edits. Save before downloading."}
            </p>
            <div className="flex flex-wrap gap-2">
              {clean && (
                <>
                  <Button variant="ghost" asChild>
                    <a href={`/api/resumes/${id}/download?format=docx`}>DOCX</a>
                  </Button>
                  <Button variant="outline" asChild>
                    <a href={`/api/resumes/${id}/download`}>
                      <Download className="size-4" aria-hidden />
                      Download PDF
                    </a>
                  </Button>
                </>
              )}
              <Button
                disabled={pending || clean || !content.trim()}
                onClick={async () => {
                  setPending(true)
                  setMessage("")
                  try {
                    const response = await fetch(`/api/resumes/${id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ content }),
                    })
                    const data = await response.json()
                    if (!response.ok)
                      throw new Error(data.error ?? "Could not save.")
                    setSaved(content)
                    setVersion((value) => value + 1)
                    setMessage("Changes saved.")
                  } catch (error) {
                    setMessage(
                      error instanceof Error ? error.message : "Could not save."
                    )
                  } finally {
                    setPending(false)
                  }
                }}
              >
                {pending ? "Saving…" : "Save edits"}
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-semibold tracking-tight">
          PDF preview · used when applying
        </p>
        <iframe
          key={version}
          title="Resume PDF preview"
          src={`/api/resumes/${id}/download?inline=1&v=${version}`}
          className="h-[75vh] w-full rounded-xl border bg-muted shadow-xs xl:sticky xl:top-4"
        />
      </div>
    </div>
  )
}
