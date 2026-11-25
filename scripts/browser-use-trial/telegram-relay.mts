// Explicit operator pilot: route one live employer challenge through the existing
// owner-bound Telegram inbox. Never logs or stores a plaintext verification code.
import { readFile, writeFile, unlink, stat } from "node:fs/promises"
import { parseEnv } from "node:util"
import { createHash } from "node:crypto"
import { chromium } from "playwright-core"
import { supabaseServerClient } from "../../lib/server/supabase-server"
import { TelegramVerificationBridge } from "../../lib/server/applications/telegram-verification-bridge"
import { readVerificationView } from "../../lib/server/applications/verification-surface"
import { openVerificationCode } from "../../lib/server/telegram/verification"
import { sendTelegram } from "../../lib/server/telegram/api"
import { persistApplicationReceipt } from "../../lib/server/applications/receipt"
const base = ".local-data/browser-use-trial"
const env = {
  ...parseEnv(await readFile(".env.staging.local", "utf8")),
  ...parseEnv(await readFile(".env.telegram.local", "utf8")),
}
Object.assign(process.env, env, { TELEGRAM_ENABLED: "true" })
const verified = JSON.parse(
  await readFile(base + "/telegram-config-verified.json", "utf8")
)
if (
  !verified.matches ||
  Date.now() - Date.parse(verified.verifiedAt) > 30 * 60_000
)
  throw Error("Telegram configuration must be verified")
const id = "0c9caffb-b905-4971-a40f-7bc7f01c36b1",
  revision = 5
const session = JSON.parse(await readFile(base + "/session.json", "utf8"))
const response = JSON.parse(
  await readFile(base + "/submission-response.json", "utf8")
)
if (
  response.sessionId !== session.id ||
  response.status !== 428 ||
  JSON.parse(response.body).code !== "captcha-failed"
)
  throw Error("Active employer verification not confirmed")
const db = supabaseServerClient(15000)
const run = await db
  .from("application_runs")
  .select("status,revision,approved_revision,user_id,packet,receipt")
  .eq("id", id)
  .single()
if (
  run.error ||
  run.data.status !== "submitting" ||
  run.data.revision !== revision ||
  run.data.approved_revision !== revision ||
  run.data.receipt
)
  throw Error("Application no longer waiting for verification")
const connection = await db
  .from("telegram_connections")
  .select("thread_id")
  .eq("user_id", run.data.user_id)
  .single()
if (connection.error || !connection.data)
  throw Error("Telegram account not linked")
const browser = await chromium.connectOverCDP(session.connectUrl)
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().includes("careerpuck.com"))!
if (!page) throw Error("Existing application page unavailable")
const view = await readVerificationView(page, true)
await writeFile(
  base + "/telegram-view.json",
  JSON.stringify({
    mode: view.mode,
    targets: view.targets.map((t) => ({ kind: t.kind, label: t.label })),
    sessionId: session.id,
  }),
  { mode: 0o600 }
)
if (view.mode !== "code") throw Error("Employer code surface is not supported")
const ends = Math.min(
    Date.now() + 8 * 60_000,
    (await stat(base + "/submission-started.json")).mtimeMs + 9 * 60_000
  ),
  expiresAt = new Date(ends).toISOString()
const task = await db
  .from("application_tasks")
  .select("attempts")
  .eq("application_id", id)
  .eq("revision", revision)
  .eq("stage", "submit")
  .maybeSingle()
if (task.error) throw Error("Task checkpoint unavailable")
const published = await db.from("application_tasks").upsert(
  {
    application_id: id,
    revision,
    stage: "submit",
    state: "running",
    attempts: task.data?.attempts || 1,
    error_code: "telegram_verification_required",
    message:
      "Reply to the Telegram verification prompt to continue this application.",
    output: { browserAssistance: { sessionId: session.id, expiresAt } },
    updated_at: new Date().toISOString(),
  },
  { onConflict: "application_id,revision,stage" }
)
if (published.error) throw Error("Verification checkpoint unavailable")
let receipt: { text: string; url: string; confirmedAt: string } | null = null
const ready = async () => {
  for (const frame of page.frames()) {
    if (
      ![
        "app.careerpuck.com",
        "job-boards.greenhouse.io",
        "boards.greenhouse.io",
      ].includes(new URL(frame.url()).hostname)
    )
      continue
    const text = await frame
      .locator("body")
      .innerText()
      .catch(() => "")
    const match = text.match(
      /Thank(?: you|s) for (?:applying|your application)[.!]?|Your application (?:has been |was )?(?:successfully )?(?:submitted|received)[.!]?/i
    )
    if (
      match &&
      !(await frame
        .locator("#first_name")
        .isVisible()
        .catch(() => false))
    ) {
      receipt = {
        text: match[0],
        url: frame.url(),
        confirmedAt: new Date().toISOString(),
      }
      return true
    }
  }
  return false
}
let confirmed = false
try {
  const bridge = await TelegramVerificationBridge.connect(db, page, {
    id,
    revision,
    sessionId: session.id,
    expiresAt,
    at: { stage: "submit", status: "submitting" },
  })
  if (!bridge) throw Error("Telegram verification unavailable")
  await bridge.start()
  console.log(
    JSON.stringify({
      telegramPromptSent: true,
      sessionId: session.id,
      codeBoxes: view.targets.filter((t) => t.kind === "code").length,
      expiresAt,
    })
  )
  while (Date.now() < ends) {
    const current = await db
      .from("application_runs")
      .select("status,revision,approved_revision")
      .eq("id", id)
      .single()
    if (
      current.error ||
      current.data.status !== "submitting" ||
      current.data.revision !== revision ||
      current.data.approved_revision !== revision
    )
      throw Error("Approval no longer active")
    if (await ready()) {
      confirmed = true
      break
    }
    const pending = await db
      .from("application_tasks")
      .select("output")
      .eq("application_id", id)
      .eq("revision", revision)
      .eq("stage", "submit")
      .eq("output->browserAssistance->>sessionId", session.id)
      .single()
    if (pending.error) throw Error("Verification checkpoint changed")
    const challenge = pending.data.output?.telegramChallenge
    if (challenge?.state === "queued" && challenge.command?.action === "code") {
      const code = openVerificationCode(challenge.command.value)
      await writeFile(
        base + "/telegram-verification-permit.json",
        JSON.stringify({
          sessionId: session.id,
          codeHash: createHash("sha256")
            .update(code.toUpperCase())
            .digest("hex"),
          expiresAt: Math.min(Date.now() / 1000 + 120, ends / 1000),
        }),
        { mode: 0o600 }
      )
    }
    if (
      await bridge.poll(async () => {
        await new Promise((r) => setTimeout(r, 800))
        return ready()
      })
    ) {
      confirmed = true
      break
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (confirmed && receipt) {
    const result = receipt as { text: string; url: string; confirmedAt: string }
    await persistApplicationReceipt(db, id, revision, {
      ...result,
      resumeHash: createHash("sha256")
        .update(run.data.packet.resume)
        .digest("hex"),
    })
    await writeFile(
      base + "/verified-receipt.json",
      JSON.stringify({ ...result, sessionId: session.id }),
      { mode: 0o600 }
    )
    await writeFile(
      base + "/receipt-confirmed.json",
      JSON.stringify({ sessionId: session.id, status: "submitted" }),
      { mode: 0o600 }
    )
    await sendTelegram(
      connection.data.thread_id,
      "Prenuvo confirmed receipt of your application. Your application is now marked submitted."
    )
    console.log(JSON.stringify({ receiptConfirmed: true, status: "submitted" }))
  } else {
    await db
      .from("application_runs")
      .update({
        status: "submission_unknown",
        message:
          "Telegram verification expired without a verified employer receipt. Do not retry automatically.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("revision", revision)
      .eq("status", "submitting")
    await sendTelegram(
      connection.data.thread_id,
      "The verification window expired without a confirmed employer receipt. The application is not marked submitted, and it will not be sent again automatically."
    )
    console.log(
      JSON.stringify({
        receiptConfirmed: false,
        reason: "verification-expired",
      })
    )
  }
} catch (error) {
  await db
    .from("application_runs")
    .update({
      status: "submission_unknown",
      message:
        "Telegram verification stopped without a verified employer receipt. Do not retry automatically.",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("revision", revision)
    .eq("status", "submitting")
  await sendTelegram(
    connection.data.thread_id,
    "Verification stopped before an employer receipt could be confirmed. Your application is not marked submitted; it will not be sent again automatically."
  ).catch(() => {})
  throw error
} finally {
  await db
    .from("application_tasks")
    .update({
      output: null,
      error_code: null,
      state: confirmed ? "completed" : "blocked",
      message: confirmed
        ? ""
        : "Verification did not produce a confirmed employer receipt.",
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", id)
    .eq("revision", revision)
    .eq("stage", "submit")
    .eq("output->browserAssistance->>sessionId", session.id)
  await unlink(base + "/telegram-verification-permit.json").catch(() => {})
  await browser.close()
}
