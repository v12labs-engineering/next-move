import { ApplicationSubmissionError } from "@/lib/applications/pipeline"
import type { supabaseServerClient } from "@/lib/server/supabase-server"

type Receipt = {
  text: string
  url: string
  confirmedAt: string
  resumeHash: string
}

// Retrying this database transaction never repeats the employer action. A lost
// RPC response is reconciled against the exact authoritative saved receipt.
export async function persistApplicationReceipt(
  db: ReturnType<typeof supabaseServerClient>,
  id: string,
  revision: number,
  receipt: Receipt
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const saved = await db.rpc("confirm_application", {
        p_id: id,
        p_revision: revision,
        p_receipt: receipt,
      })
      if (!saved.error && saved.data === true) return
    } catch {
      /* Reconcile transport failure without exposing its payload. */
    }
    try {
      const current = await db
        .from("application_runs")
        .select("status,revision,approved_revision,receipt")
        .eq("id", id)
        .single()
      if (
        current.error ||
        current.data.revision !== revision ||
        current.data.approved_revision !== revision
      )
        break
      if (current.data.status === "submitted") {
        const actual = current.data.receipt
        if (
          actual &&
          Object.entries(receipt).every(([key, value]) => actual[key] === value)
        )
          return
        break
      }
      if (current.data.status !== "submitting") break
    } catch {
      break
    }
  }
  throw new ApplicationSubmissionError("receipt_persistence_failed")
}
