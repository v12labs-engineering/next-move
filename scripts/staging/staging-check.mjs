import { readdir, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { verifiedContext, management, runSupabase } from "../lib/staging.mjs"

try {
  const root = resolve(import.meta.dirname, "../..")
  const files = (await readdir(resolve(root, "supabase/migrations")))
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
  const migrations = await Promise.all(
    files.map(async (file) => ({
      file,
      sha256: createHash("sha256")
        .update(await readFile(resolve(root, "supabase/migrations", file)))
        .digest("hex"),
    }))
  )
  console.log(JSON.stringify({ migrations }, null, 2))
  if (!process.argv.includes("--plan")) {
    const context = await verifiedContext()
    console.log(
      `Verified isolated project ${context.ref} (${context.config.supabase.projectName}).`
    )
    runSupabase(context, [
      "migration",
      "list",
      "--project-ref",
      context.ref,
      "--agent",
      "yes",
      "--output-format",
      "text",
    ])
    if (!context.env.SUPABASE_ACCESS_TOKEN) {
      console.log(
        "Auth configuration was not read automatically: verify the exact site and callback URLs in the Supabase dashboard. CLI credentials remain in the CLI credential store."
      )
      process.exit(0)
    }
    const history = await management(context, "/database/migrations")
    const auth = await management(context, "/config/auth")
    console.log(
      JSON.stringify(
        {
          project: context.config.supabase.projectName,
          ref: context.ref,
          appliedMigrations: history.map((m) => ({
            version: m.version,
            name: m.name,
          })),
          auth: {
            siteUrl: auth.site_url,
            smtpConfigured: Boolean(auth.smtp_host),
            emailEnabled: auth.external_email_enabled,
            confirmationsEnabled: auth.mailer_autoconfirm === false,
          },
        },
        null,
        2
      )
    )
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
