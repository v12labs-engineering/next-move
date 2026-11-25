import type { VisaConfidence } from "@/lib/location/relocation-data"
import type { Job } from "@/lib/jobs"

const VALID: VisaConfidence[] = [
  "confirmed",
  "strong",
  "possible",
  "weak",
  "no",
]

const endpoint = process.env.LLM_BASE_URL ?? "http://127.0.0.1:8317/v1"
const model = process.env.LLM_MODEL ?? "gpt-5.5"
const apiKey = process.env.LLM_API_KEY ?? "local-dev-key"

export function parseVisaSignal(
  raw: string
): { signal: VisaConfidence; reason: string } | null {
  try {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start < 0 || end < 0) return null
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      signal?: string
      reason?: string
    }
    if (!obj.signal || !VALID.includes(obj.signal as VisaConfidence))
      return null
    return {
      signal: obj.signal as VisaConfidence,
      reason: String(obj.reason ?? ""),
    }
  } catch {
    return null
  }
}

async function refineOne(job: Job): Promise<Job> {
  const prompt = `You judge visa sponsorship for a job. Reply ONLY JSON {"signal": one of ${VALID.join("|")}, "reason": short}. Title: ${job.title} at ${job.company} (${job.country}). Source: ${job.source}.`
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  })
  if (!res.ok) return job
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const parsed = parseVisaSignal(data.choices?.[0]?.message?.content ?? "")
  if (!parsed) return job
  return {
    ...job,
    visaSignal: parsed.signal,
    visaSignalSource: "llm",
    visaSignalReason: parsed.reason,
  }
}

export async function refineVisaSignals(jobs: Job[]): Promise<Job[]> {
  try {
    return await Promise.all(jobs.map((j) => refineOne(j).catch(() => j)))
  } catch {
    return jobs
  }
}
