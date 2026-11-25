import Link from "next/link"
import { Download, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CompanyMark } from "@/components/jobs/company-mark"
import { relativeTime } from "@/lib/utils"

export type ResumeDraftRow = {
  id: string
  profile_version: number
  created_at: string
  evidence: { job?: { title?: string; company?: string } } | null
}

export function ResumeDrafts({ drafts }: { drafts: ResumeDraftRow[] }) {
  return (
    <>
      {drafts.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-10 text-center">
          <FileText className="mx-auto size-8 text-muted-foreground/60" />
          <p className="mt-3 font-heading text-lg">No drafts yet</p>
          <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">
            Choose a job and select Tailor resume to draft one for that role.
          </p>
          <div className="mt-5 flex justify-center">
            <Button asChild>
              <Link href="/jobs">Browse jobs</Link>
            </Button>
          </div>
        </div>
      ) : (
        <section aria-label="Resume drafts" className="space-y-2">
          <h2 className="text-sm font-semibold tracking-tight">
            {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
          </h2>
          <ul className="overflow-hidden rounded-xl border bg-card shadow-xs">
            {drafts.map((draft) => {
              const title = draft.evidence?.job?.title ?? "Resume draft"
              const company = draft.evidence?.job?.company
              return (
                <li
                  key={draft.id}
                  className="group relative flex items-center gap-4 border-b px-4 py-3.5 transition-colors duration-150 ease-out-expo last:border-b-0 hover:bg-muted/40"
                >
                  {company ? (
                    <CompanyMark name={company} />
                  ) : (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <FileText className="size-4" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/resumes/${draft.id}`}
                      className="block truncate font-medium text-foreground transition-colors group-hover:text-primary after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                    >
                      {title}
                    </Link>
                    <p className="truncate text-[13px] text-muted-foreground">
                      {company && (
                        <span className="text-foreground/80">{company} · </span>
                      )}
                      <time
                        dateTime={draft.created_at}
                        title={new Date(draft.created_at).toLocaleString()}
                        suppressHydrationWarning
                      >
                        {relativeTime(draft.created_at)}
                      </time>
                      {" · "}
                      <span className="tabular-nums">
                        Profile v{draft.profile_version}
                      </span>
                    </p>
                  </div>
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="relative z-10"
                  >
                    <a
                      href={`/api/resumes/${draft.id}/download?format=docx`}
                      aria-label={`Download ${title} as DOCX`}
                    >
                      <Download className="size-4" />
                      <span className="hidden sm:inline">DOCX</span>
                    </a>
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </>
  )
}
