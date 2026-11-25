import { verifiedContext, runSupabase } from "../lib/staging.mjs"

try {
  const context = await verifiedContext()
  const args = [
    "db",
    "push",
    "--project-ref",
    context.ref,
    "--skip-vault",
    "--yes",
    "--agent",
    "yes",
    "--output-format",
    "text",
  ]
  // The pinned CLI uses the authenticated account's temporary login role.
  // Explicit targeting avoids modifying the original project's CLI linkage.
  runSupabase(context, [...args, "--dry-run"])
  if (!process.argv.includes("--apply"))
    console.log("Dry run complete. No migration was applied.")
  else {
    runSupabase(context, args)
    console.log(
      "Staging migration command completed. Run staging:check to inspect applied history."
    )
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
