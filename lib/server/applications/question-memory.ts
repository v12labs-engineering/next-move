import { formFieldSchema, type ApplicationPacket } from "@/lib/applications"
import {
  applyRememberedAnswers,
  canReuseQuestion,
  sameSavedQuestion,
  type ReuseScope,
  type SavedQuestion,
} from "@/lib/applications/questions"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import type { SavedAnswerExample } from "@/lib/applications/saved-facts"
export type { SavedAnswerExample } from "@/lib/applications/saved-facts"

async function readMemory(id: string, packet: ApplicationPacket) {
  const result = await supabaseServerClient().rpc(
    "read_application_question_memory",
    {
      p_id: id,
      p_fields: packet.fields,
    }
  )
  if (result.error) throw result.error
  return (result.data as SavedQuestion[]).map((row) => ({
    ...row,
    question: formFieldSchema.parse(row.question),
  }))
}
export async function fillApplicationMemory(
  id: string,
  packet: ApplicationPacket
) {
  return applyRememberedAnswers(packet, await readMemory(id, packet))
}
export async function applicationReuseChoices(
  id: string,
  packet: ApplicationPacket
) {
  const rows = await readMemory(id, packet)
  const choices: Record<string, ReuseScope> = {}
  for (const field of packet.fields) {
    const row = rows.find((row) => sameSavedQuestion(field, row.question))
    if (row) choices[field.id] = row.reuse_scope
  }
  return choices
}

// Answers the candidate allowed to reuse here, mirroring the SQL memory
// predicates, so the AI fill can recognise reworded versions of them.
export async function savedAnswerLibrary(
  id: string,
  packet?: ApplicationPacket
): Promise<SavedAnswerExample[]> {
  const db = supabaseServerClient()
  const run = await db
    .from("application_runs")
    .select("user_id,employer_key,target_url,packet")
    .eq("id", id)
    .maybeSingle()
  if (run.error || !run.data) return []
  const company = String(
    (run.data.packet as { company?: unknown } | null)?.company ?? ""
  )
  const country = (packet ?? (run.data.packet as ApplicationPacket | null))
    ?.applicationContext?.country
  if (!country) return []
  const employer =
    run.data.employer_key ||
    company.trim().toLowerCase() ||
    String(run.data.target_url ?? "").split("/")[2] ||
    ""
  const rows = await db
    .from("account_application_questions")
    .select(
      "question,answer,question_key,employer_key,country,reuse_scope,reuse_explicit,answered_at"
    )
    .eq("user_id", run.data.user_id)
    .eq("country", country)
    .not("answer", "is", null)
    .order("answered_at", { ascending: false })
    .limit(300)
  if (rows.error) return []
  // Opt-outs can have no answer. Read them separately so neither that filter
  // nor the bounded example window can silently remove an employer override.
  const overrides = await db
    .from("account_application_questions")
    .select("question_key,country")
    .eq("user_id", run.data.user_id)
    .eq("country", country)
    .eq("employer_key", employer)
    .eq("reuse_scope", "never")
    .eq("reuse_explicit", true)
  if (overrides.error) return []
  const optedOut = new Set(
    overrides.data.map((row) => `${row.question_key}|${row.country}`)
  )
  return rows.data
    .filter((row) =>
      row.reuse_scope === "all"
        ? !optedOut.has(`${row.question_key}|${row.country}`)
        : row.reuse_scope === "employer" && row.employer_key === employer
    )
    .flatMap((row) => {
      const question = formFieldSchema.safeParse(row.question)
      const answer = row.answer as unknown
      if (
        !question.success ||
        !canReuseQuestion(question.data) ||
        !(typeof answer === "string" || Array.isArray(answer)) ||
        !answer.length
      )
        return []
      return [
        {
          question: question.data.label,
          answer: answer as string | string[],
          help: question.data.help,
          country: row.country,
          confirmedAt: row.answered_at,
        },
      ]
    })
    .slice(0, 80)
}
