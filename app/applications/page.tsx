import { ApplicationsPage } from "@/components/applications/applications-page"
import type { ResumeDraftRow } from "@/components/resume/resume-drafts"
import { requirePageAccount } from "@/lib/server/session"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { catalogJob, type CatalogRow } from "@/lib/server/catalog/job"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const { db, user } = await requirePageAccount()
  const [drafts, followup, { view }] = await Promise.all([
    db
      .from("resume_drafts")
      .select("id,profile_version,created_at,evidence")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),
    process.env.FIRECRAWL_API_KEY?.trim()
      ? supabaseServerClient()
          .rpc("recent_manual_followup_jobs", { p_user_id: user.id })
          .order("applied_at", { ascending: false })
          .order("job_id")
      : null,
    searchParams,
  ])
  if (drafts.error) throw new Error("Could not load your drafts.")
  if (followup?.error)
    console.error("Could not load manual follow-up eligibility", {
      code: followup.error.code,
    })
  const recent = (followup?.data ?? []) as { job: CatalogRow }[]
  return (
    <ApplicationsPage
      drafts={drafts.data as ResumeDraftRow[]}
      initialView={view === "drafts" ? "drafts" : "pipeline"}
      manualFollowupJobs={recent.map(({ job }) => catalogJob(job, "applied"))}
    />
  )
}
