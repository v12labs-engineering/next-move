import { verifiedContext } from "../lib/staging.mjs"
import { supabaseServerClient } from "../../lib/server/supabase-server"

if (!process.argv.includes("--staging"))
  throw new Error(
    "Use --staging to inspect the verified isolated staging deployment"
  )
const { env } = await verifiedContext()
Object.assign(process.env, env)
const result = await supabaseServerClient(30_000).rpc(
  "matching_operational_status"
)
if (result.error) throw result.error
console.log(JSON.stringify(result.data, null, 2))
