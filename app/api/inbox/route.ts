import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson } from "@/lib/server/http"
import { applicationStatusGroups } from "@/lib/applications/activity"

const label = (r: { company?: string | null; target_url: string }) =>
  r.company || new URL(r.target_url).hostname.replace(/^www\./, "")

export async function GET() {
  try {
    const { db, user } = await requireAccount()
    const [needs, events] = await Promise.all([
      db
        .from("application_runs")
        .select(
          "id,status,automatic,auto_submit_requested_at,title:packet->>title,company:packet->>company,updated_at,target_url"
        )
        .eq("user_id", user.id)
        .in("status", [...applicationStatusGroups.needs])
        .or(
          "status.neq.ready,automatic.eq.false,auto_submit_requested_at.is.null"
        )
        .order("updated_at", { ascending: false })
        .limit(100),
      db
        .from("application_events")
        .select("id,application_id,status,created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(60),
    ])
    if (needs.error) throw needs.error
    if (events.error) throw events.error
    const ids = [...new Set(events.data.map((e) => e.application_id))]
    const runs = ids.length
      ? await db
          .from("application_runs")
          .select("id,title:packet->>title,company:packet->>company,target_url")
          .in("id", ids)
      : { data: [], error: null }
    if (runs.error) throw runs.error
    const byId = new Map(runs.data.map((r) => [r.id, r]))
    return privateJson({
      needs: needs.data
        .filter(
          (r) =>
            !(r.status === "ready" && r.automatic && r.auto_submit_requested_at)
        )
        .map((r) => ({
          id: r.id,
          status: r.status,
          automatic: r.automatic,
          title: r.title || "Application being prepared",
          company: label(r),
          updated_at: r.updated_at,
        })),
      events: events.data.flatMap((e) => {
        const run = byId.get(e.application_id)
        if (!run) return []
        return [
          {
            id: e.id,
            applicationId: e.application_id,
            status: e.status,
            created_at: e.created_at,
            title: run.title || "Application",
            company: label(run),
          },
        ]
      }),
    })
  } catch (e) {
    return apiError(e)
  }
}
