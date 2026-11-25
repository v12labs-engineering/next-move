import { NextResponse } from "next/server"
import type { Job } from "@/lib/jobs"
import { refineVisaSignals } from "@/lib/server/visa-signal"
import { requireOperator } from "@/lib/server/operator"
import { apiError, HttpError, readJson } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  try {
    requireOperator(request)
    const body = (await readJson(request)) as { jobs?: Job[] }
    const jobs = body.jobs ?? []
    if (!Array.isArray(jobs) || jobs.length > 20)
      throw new HttpError(400, "Send at most 20 jobs.")
    const refined = await refineVisaSignals(jobs)
    return NextResponse.json({ ok: true, jobs: refined })
  } catch (error) {
    return apiError(error)
  }
}
