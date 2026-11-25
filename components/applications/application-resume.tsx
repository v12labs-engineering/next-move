"use client"

import { useState } from "react"
import { Download, Eye, SquarePen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ApplicationResume({
  id,
  revision,
  value,
  readOnly,
  busy,
  dirty,
  onChange,
}: {
  id: string
  revision: number
  value: string
  readOnly: boolean
  busy: boolean
  dirty: boolean
  onChange: (value: string) => void
}) {
  const [view, setView] = useState<"preview" | "text">("preview")
  const previewId = `resume-preview-${id}`
  const textId = `resume-text-${id}`

  return (
    <section aria-label="Tailored resume" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Tailored resume
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          Version {revision}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 p-3">
          <div
            role="group"
            aria-label="Resume view"
            className="inline-flex rounded-lg bg-muted p-1"
          >
            {(
              [
                {
                  key: "preview",
                  label: "Preview",
                  icon: Eye,
                  panel: previewId,
                },
                {
                  key: "text",
                  label: readOnly ? "Resume text" : "Edit text",
                  icon: SquarePen,
                  panel: textId,
                },
              ] as const
            ).map(({ key, label, icon: Icon, panel }) => (
              <Button
                key={key}
                type="button"
                variant="ghost"
                aria-pressed={view === key}
                aria-controls={panel}
                onClick={() => setView(key)}
                className={cn(
                  "min-h-11 gap-2 rounded-md px-3 text-xs active:translate-y-0",
                  view === key
                    ? "bg-card text-foreground shadow-xs hover:bg-card"
                    : "text-muted-foreground"
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {label}
              </Button>
            ))}
          </div>
          <div className="flex gap-1.5" aria-label="Download resume">
            {[
              { label: "PDF", href: `/api/applications/${id}/resume` },
              {
                label: "DOCX",
                href: `/api/applications/${id}/resume?format=docx`,
              },
            ].map(({ label, href }) => (
              <Button
                key={label}
                variant="ghost"
                asChild
                className="min-h-11 gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground"
              >
                <a href={href}>
                  <Download aria-hidden className="size-3.5" />
                  {label}
                </a>
              </Button>
            ))}
          </div>
        </div>
        <div id={previewId} hidden={view !== "preview"}>
          <iframe
            key={revision}
            title="Resume PDF preview"
            src={`/api/applications/${id}/resume?inline=1&v=${revision}`}
            className="h-[32rem] w-full bg-muted/30 sm:h-[70vh]"
          />
        </div>
        <div id={textId} hidden={view !== "text"}>
          <label htmlFor={`resume-editor-${id}`} className="sr-only">
            Resume to submit
          </label>
          <textarea
            id={`resume-editor-${id}`}
            className="block min-h-[28rem] w-full resize-y bg-transparent p-4 font-mono text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:bg-muted/20"
            value={value}
            disabled={readOnly || busy}
            maxLength={50000}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
          <p className="max-w-[60ch] text-xs leading-relaxed text-muted-foreground">
            {view === "preview"
              ? "This PDF is used when your application is sent. Save text edits to update the preview."
              : readOnly
                ? "The resume text saved with this application."
                : "Edit the text, then save your changes in Application status to update the PDF."}
          </p>
          {dirty && (
            <span className="rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              Unsaved changes
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
