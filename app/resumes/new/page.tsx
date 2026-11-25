import { notFound } from "next/navigation"
import { requirePageAccount } from "@/lib/server/session"
import { AppShell } from "@/components/shell/app-shell"
import { TailorResumeButton } from "@/components/resume/tailor-resume-button"
export default async function NewResumePage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>
}) {
  const { db } = await requirePageAccount()
  const id = (await searchParams).job
  if (!id || id.length > 500) notFound()
  const { data: job, error } = await db
    .from("job_catalog")
    .select("id,title,company,description")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error("Could not load this job.")
  if (!job) notFound()
  return (
    <AppShell
      title="Tailor your resume"
      description="We pick the passages from your saved resume that fit this role and place them before your full career history."
    >
      <div className="max-w-[65ch] space-y-6">
        <section
          aria-label="Target role"
          className="space-y-2 rounded-xl border bg-card p-4 shadow-xs sm:p-6"
        >
          <h2 className="text-sm font-semibold tracking-tight">
            Tailoring for
          </h2>
          <p className="font-heading text-xl leading-snug">{job.title}</p>
          <p className="text-[13px] text-muted-foreground">{job.company}</p>
        </section>

        <ul className="space-y-3 rounded-xl border bg-card p-4 text-[13px] leading-relaxed text-muted-foreground shadow-xs sm:p-6">
          <li>
            Your resume text and this job description are sent to our AI
            provider when you continue.
          </li>
          <li>
            Profile analysis, tailoring and application navigation share your
            plan&apos;s monthly AI requests. Failed provider requests count
            toward this limit.
          </li>
          <li>Review the draft before using it.</li>
        </ul>

        {job.description?.length >= 100 ? (
          <TailorResumeButton jobId={job.id} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            This listing does not have enough description text for tailoring
            yet.
          </p>
        )}
      </div>
    </AppShell>
  )
}
