import assert from "node:assert/strict"
import test from "node:test"
import { autoApplyAccounts } from "@/workflows/auto-apply"
import { autoApplyForAccount } from "@/lib/server/applications/auto-apply"

test("automatic sweep traverses beyond 1,000 accounts and ready accounts do not rescore catalogue rows", async (t) => {
  const oldFetch = globalThis.fetch,
    oldEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auto-fixture.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-key"
  t.after(() => {
    globalThis.fetch = oldFetch
    process.env = oldEnv
  })
  const ids = Array.from(
    { length: 1001 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  )
  let sweep = true
  const operations: string[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const op = url.pathname.split("/").at(-1)!
    operations.push(op)
    if (op === "account_profiles") {
      if (sweep) {
        const after = url.searchParams.get("user_id")?.replace("gt.", "")
        return Response.json(
          ids
            .filter((id) => !after || id > after)
            .slice(0, 100)
            .map((user_id) => ({ user_id }))
        )
      }
      return Response.json({
        version: 1,
        data: {
          fullName: "Example Nurse",
          headline: "Registered Nurse",
          currentLocation: null,
          targetRoles: ["Nurse"],
          skills: ["Patient care"],
          experienceYears: 3,
          workModes: ["onsite"],
          sponsorshipRequired: false,
          excludedCompanies: [],
          resumeText:
            "Registered nurse delivering patient care and maintaining accurate records in hospital wards. Coordinated clinical handovers with colleagues.",
          autoApply: { enabled: true, minScore: 80 },
        },
      })
    }
    if (op === "account_countries")
      return Response.json([
        { country: "Germany", added_at: new Date().toISOString() },
      ])
    if (op === "read_account_matches_for")
      return Response.json({
        profileVersion: 1,
        generation: "ready",
        jobs: [],
        total: 0,
        // Catalog drift alone (stale, current profile) must not re-dispatch.
        matching: { stale: true, profileCurrent: true, status: "ready" },
      })
    throw new Error(`Unexpected expensive or side-effecting operation: ${op}`)
  }
  const visited: string[] = []
  let after: string | null = null
  for (;;) {
    const page = await autoApplyAccounts(after)
    if (!page.length) break
    visited.push(...page)
    after = page.at(-1)!
  }
  assert.deepEqual(visited, ids)
  sweep = false
  operations.length = 0
  assert.deepEqual(await autoApplyForAccount(ids[0]), {
    started: [],
    limited: false,
  })
  assert.deepEqual(
    operations.sort(),
    ["account_countries", "account_profiles", "read_account_matches_for"].sort()
  )
})
