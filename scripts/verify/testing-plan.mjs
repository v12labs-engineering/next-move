// Temporary quota override for the isolated testing project. No usage is reset.
// Preview: node scripts/verify/testing-plan.mjs
// Apply:   node scripts/verify/testing-plan.mjs --apply
// Restore: node scripts/verify/testing-plan.mjs --restore --apply
import { readFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { createClient } from "@supabase/supabase-js"

const root = new URL("../../", import.meta.url)
const config = JSON.parse(
  await readFile(new URL("staging/project.json", root), "utf8")
)
const env = parseEnv(
  await readFile(new URL(".env.staging.local", root), "utf8")
)
if (
  config.environment !== "staging" ||
  config.supabase.projectName !== "job-search-staging" ||
  config.supabase.projectRef !== "zcaqbiejkvgqxsbrncty" ||
  env.NEXT_PUBLIC_SUPABASE_URL !== "https://zcaqbiejkvgqxsbrncty.supabase.co"
)
  throw new Error(
    "Refusing to change plan limits outside the isolated testing project."
  )

const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  }
)
const fields = "id,monthly_applications,monthly_ai_requests"
const current = await db.from("plans").select(fields).eq("id", "free").single()
if (current.error)
  throw new Error(
    `Could not read testing plan (${current.error.code ?? "network error"}).`
  )
// The largest PostgreSQL integer makes these quotas unreachable in testing,
// while preserving the existing admission functions and complete usage ledger.
const target = process.argv.includes("--restore")
  ? { monthly_applications: 10, monthly_ai_requests: 30 }
  : { monthly_applications: 2147483647, monthly_ai_requests: 2147483647 }
console.log(
  JSON.stringify(
    { project: config.supabase.projectName, before: current.data, target },
    null,
    2
  )
)
if (process.argv.includes("--apply")) {
  const updated = await db
    .from("plans")
    .update(target)
    .eq("id", "free")
    .eq("monthly_applications", current.data.monthly_applications)
    .eq("monthly_ai_requests", current.data.monthly_ai_requests)
    .select(fields)
    .single()
  if (updated.error)
    throw new Error(
      `Testing plan update failed (${updated.error.code ?? "network error"}).`
    )
  const verified = await db
    .from("plans")
    .select(fields)
    .eq("id", "free")
    .single()
  if (
    verified.error ||
    verified.data.monthly_applications !== target.monthly_applications ||
    verified.data.monthly_ai_requests !== target.monthly_ai_requests
  )
    throw new Error("Testing plan verification failed.")
  console.log(JSON.stringify({ verified: verified.data }))
} else
  console.log(
    "Preview only. Use --apply to update, or --restore --apply to restore 10/30."
  )
