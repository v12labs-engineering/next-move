import { verifiedContext, management } from "../lib/staging.mjs"

try {
  const context = await verifiedContext()
  if (!context.config.appUrl)
    throw new Error(
      "Set appUrl in staging/project.json to the deployed staging origin first."
    )
  const url = new URL(context.config.appUrl)
  if (
    url.protocol !== "https:" ||
    url.origin !== context.config.appUrl ||
    !url.hostname.endsWith(".vercel.app")
  )
    throw new Error(
      "Staging appUrl must be an exact HTTPS Vercel origin, without paths or wildcards."
    )
  const auth = await management(context, "/config/auth", {
    site_url: url.origin,
    uri_allow_list: `${url.origin}/auth/callback`,
    external_email_enabled: true,
    external_anonymous_users_enabled: false,
    mailer_autoconfirm: false,
  })
  console.log(
    JSON.stringify({
      siteUrl: auth.site_url,
      smtpConfigured: Boolean(auth.smtp_host),
      confirmationsEnabled: auth.mailer_autoconfirm === false,
    })
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
