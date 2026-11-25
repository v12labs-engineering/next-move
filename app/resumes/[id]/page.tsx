import { resumeDraftContent, resumeKeywordEvidenceSchema } from "@/lib/resume"
import { notFound } from "next/navigation"
import { z } from "zod"
import { requirePageAccount } from "@/lib/server/session"
import { AppShell } from "@/components/shell/app-shell"
import { ResumeEditor } from "@/components/resume/resume-editor"
export default async function ResumePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { db, user } = await requirePageAccount()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) notFound()
  const { data, error } = await db
    .from("resume_drafts")
    .select("id,content,evidence")
    .eq("id", id.data)
    .eq("user_id", user.id)
    .maybeSingle()
  if (error) throw new Error("Could not load your draft.")
  if (!data) notFound()
  const keywordEvidence = resumeKeywordEvidenceSchema.safeParse(
    data.evidence?.keywordEvidence
  )
  return (
    <AppShell
      title="Review your resume"
      description="Check the job keywords, layout and every claim before applying."
    >
      <ResumeEditor
        id={data.id}
        initial={resumeDraftContent(data.content, data.evidence)}
        keywordEvidence={
          keywordEvidence.success ? keywordEvidence.data : undefined
        }
      />
    </AppShell>
  )
}
