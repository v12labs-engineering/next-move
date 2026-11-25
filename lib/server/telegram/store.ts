import { createHash } from "node:crypto"
import { packetSchema } from "@/lib/applications"
import {
  canReuseQuestion,
  sameSavedQuestion,
  validSavedAnswer,
  type SavedQuestion,
} from "@/lib/applications/questions"
import {
  currentQuestion,
  unresolvedFields,
  telegramStateSchema,
  type TelegramRequest,
} from "@/lib/telegram"
import { supabaseServerClient } from "@/lib/server/supabase-server"

export const linkHash = (token: string) =>
  createHash("sha256").update(token).digest("hex")
export function parseRequest(
  row: Omit<TelegramRequest, "packet" | "state"> & {
    packet: unknown
    state: unknown
  }
): TelegramRequest {
  return {
    ...row,
    packet: packetSchema.parse(row.packet),
    state: telegramStateSchema.parse(row.state),
  }
}
export async function initializeRequest(q: TelegramRequest, thread: string) {
  if (q.state.initialized) return q
  const db = supabaseServerClient()
  const country = q.packet.applicationContext?.country || ""
  const saved = await db
    .from("account_application_questions")
    .select("question,answer,company,country,reuse_scope,answered_at")
    .eq("user_id", q.user_id)
    .eq("country", country)
    .not("answer", "is", null)
    .order("answered_at", { ascending: false })
    .limit(1000)
  if (saved.error) throw saved.error
  const state = structuredClone(q.state)
  for (const field of unresolvedFields(q.packet)) {
    if (!canReuseQuestion(field)) continue
    const row = saved.data.find(
      (r) =>
        sameSavedQuestion(field, r.question) &&
        validSavedAnswer(field, r.answer) &&
        (r.company === q.packet.company || r.reuse_scope === "all")
    ) as SavedQuestion | undefined
    if (row?.answer !== null && row?.answer !== undefined)
      state.proposals[field.id] = {
        answer: row.answer,
        source: `Your saved answer · ${row.company}`,
      }
    // The application runner already uses AI SDK to select grounded resume
    // passages. Reuse these before considering a separately labeled opinion draft.
    const evidence = q.packet.answerEvidence?.[field.id]
    const excerpt = q.packet.answerSources?.[field.id]
    if (
      !state.proposals[field.id] &&
      (evidence || excerpt) &&
      validSavedAnswer(field, evidence?.answer ?? excerpt ?? null)
    )
      state.proposals[field.id] = {
        answer: evidence?.answer ?? excerpt!,
        source:
          evidence?.source || "Resume passage selected during preparation",
      }
  }
  state.initialized = true
  const changed = await db.rpc("transition_telegram_request", {
    p_thread: thread,
    p_id: q.id,
    p_version: q.version,
    p_state: state,
    p_message: null,
  })
  if (changed.error) throw changed.error
  return changed.data ? { ...q, state, version: q.version + 1 } : null
}
export async function activeRequest(thread: string) {
  const db = supabaseServerClient()
  const connection = await db
    .from("telegram_connections")
    .select("user_id")
    .eq("thread_id", thread)
    .maybeSingle()
  if (connection.error) throw connection.error
  if (!connection.data) return null
  const result = await db
    .from("telegram_requests")
    .select("*,application:application_runs(automatic)")
    .eq("user_id", connection.data.user_id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("selected_at", { ascending: false, nullsFirst: false })
    .order("created_at")
    .order("id")
    .limit(1)
    .maybeSingle()
  if (result.error) throw result.error
  return result.data
    ? parseRequest({
        ...result.data,
        automatic: result.data.application?.automatic === true,
      })
    : null
}
export async function changeRequest(
  q: TelegramRequest,
  thread: string,
  messageId: string,
  change: { state: TelegramRequest["state"]; finish: boolean; pause: boolean }
) {
  if (change.finish && currentQuestion({ ...q, state: change.state }))
    throw new Error("Unconfirmed answer")
  const result = await supabaseServerClient().rpc(
    "transition_telegram_request",
    {
      p_thread: thread,
      p_id: q.id,
      p_version: q.version,
      p_state: change.state,
      p_message: messageId,
      p_finish: change.finish,
      p_pause: change.pause,
    }
  )
  if (result.error) throw result.error
  return result.data as {
    applicationId: string
    revision: number | null
  } | null
}
