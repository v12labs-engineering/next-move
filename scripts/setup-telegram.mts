import { readFile, writeFile, chmod } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { parseEnv } from "node:util"
import { spawnSync } from "node:child_process"
import { z } from "zod"
import { telegramApi } from "../lib/server/telegram/api"
import { createClient } from "@supabase/supabase-js"

// Tokens enter via the ignored local file, never argv or console output.
try {
  const manifest = JSON.parse(
    await readFile(new URL("../staging/project.json", import.meta.url), "utf8")
  )
  const root = new URL("../", import.meta.url).pathname
  const file = new URL("../.env.telegram.local", import.meta.url)
  const values = parseEnv(await readFile(file, "utf8"))
  const staging = z
    .object({
      NEXT_PUBLIC_SUPABASE_URL: z.string(),
      SUPABASE_SERVICE_ROLE_KEY: z.string(),
    })
    .parse(
      parseEnv(
        await readFile(
          new URL("../.env.staging.local", import.meta.url),
          "utf8"
        )
      )
    )
  if (
    new URL(staging.NEXT_PUBLIC_SUPABASE_URL).hostname !==
    `${manifest.supabase.projectRef}.supabase.co`
  )
    throw new Error("Supabase target differs from the existing project.")
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(values.TELEGRAM_BOT_TOKEN || ""))
    throw new Error("Enter the BotFather token using the setup wizard first.")
  const config: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: z.string().parse(values.TELEGRAM_BOT_TOKEN),
    TELEGRAM_BOT_USERNAME: values.TELEGRAM_BOT_USERNAME || "setup_probe_bot",
    TELEGRAM_WEBHOOK_SECRET:
      values.TELEGRAM_WEBHOOK_SECRET || randomBytes(32).toString("hex"),
    TELEGRAM_APP_ORIGIN: manifest.appUrl,
    TELEGRAM_ENABLED: "true",
  }
  Object.assign(process.env, config)
  const me = await telegramApi(
    "getMe",
    {},
    z.object({ id: z.number(), is_bot: z.literal(true), username: z.string() })
  )
  config.TELEGRAM_BOT_USERNAME = me.username
  process.env.TELEGRAM_BOT_USERNAME = me.username
  const saved = { ...values, ...config, TELEGRAM_ENABLED: "false" }
  await writeFile(
    file,
    Object.entries(saved)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 }
  )
  await chmod(file, 0o600)
  console.log(
    JSON.stringify({
      bot: `@${me.username}`,
      credentialsVerified: true,
      savedPrivately: ".env.telegram.local",
      destination: manifest.appUrl,
    })
  )
  const db = createClient(
    staging.NEXT_PUBLIC_SUPABASE_URL,
    staging.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )
  const schema = await db.from("telegram_requests").select("id").limit(1)
  console.log(
    JSON.stringify({
      supabase: manifest.supabase.projectRef,
      telegramSchemaReady: !schema.error,
    })
  )
  if (process.argv.includes("--sync-vercel")) {
    const linked = JSON.parse(
      await readFile(
        new URL("../.vercel/project.json", import.meta.url),
        "utf8"
      )
    )
    if (
      linked.projectId !== manifest.vercel.projectId ||
      linked.orgId !== manifest.vercel.teamId
    )
      throw new Error("Vercel project linkage differs from the existing app.")
    if (schema.error)
      throw new Error(
        "Apply and verify the Telegram migration before enabling the deployed bot."
      )
    for (const [key, value] of Object.entries(config)) {
      const command = spawnSync(
        "vercel",
        [
          "--scope",
          manifest.vercel.teamSlug,
          "env",
          "add",
          key,
          "production",
          "--force",
          "--yes",
          ...(/TOKEN|SECRET/.test(key) ? ["--sensitive"] : []),
        ],
        { cwd: root, input: value, encoding: "utf8", timeout: 60000 }
      )
      if (command.status !== 0)
        throw new Error(
          `Could not save ${key} on the existing Vercel project. No secret was printed.`
        )
      console.log(
        `Saved ${key} to the existing Vercel project's production environment.`
      )
    }
    console.log(
      "Redeploy the reviewed Telegram release so the new environment takes effect before registering its webhook."
    )
  }
  if (process.argv.includes("--register-webhook")) {
    if (schema.error) throw new Error("Telegram migration is not ready.")
    const callback = `${config.TELEGRAM_APP_ORIGIN}/api/webhooks/telegram`
    // A signed, empty update proves the deployed endpoint can authenticate with
    // this exact secret. It cannot modify an application or send a message.
    const probe = await fetch(callback, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": config.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 0 }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
    if (!probe.ok)
      throw new Error(
        `Deployed Telegram callback is not ready (HTTP ${probe.status}). Redeploy the configured release first.`
      )
    const current = await telegramApi(
      "getWebhookInfo",
      {},
      z.object({ url: z.string() })
    )
    if (current.url && current.url !== callback)
      throw new Error(
        "This bot has a different existing webhook. Use a dedicated bot rather than replacing another integration."
      )
    await telegramApi(
      "setWebhook",
      {
        url: callback,
        secret_token: config.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      },
      z.literal(true)
    )
    const info = await telegramApi(
      "getWebhookInfo",
      {},
      z.object({
        url: z.string(),
        pending_update_count: z.number(),
        last_error_date: z.number().optional(),
      })
    )
    if (info.url !== callback)
      throw new Error("Telegram webhook readback did not match the app.")
    console.log(
      JSON.stringify({
        webhookRegistered: true,
        callback: info.url,
        pendingUpdates: info.pending_update_count,
        hasDeliveryError: !!info.last_error_date,
      })
    )
  }
} catch (error) {
  // Only our safe errors are printed; never print fetch URLs, provider bodies or stacks.
  console.error(
    error instanceof Error &&
      !/https?:|\b\d+:[A-Za-z0-9_-]+/.test(error.message)
      ? error.message
      : "Telegram setup could not complete. Credentials were not printed."
  )
  process.exitCode = 1
}
