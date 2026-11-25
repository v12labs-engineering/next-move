import { randomUUID } from "node:crypto"
import type { Page } from "playwright-core"
import {
  ApplicationCaptchaError,
  ApplicationSubmissionError,
  type AssistanceStage,
} from "@/lib/applications/pipeline"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { telegramEnabled } from "@/lib/server/telegram/config"
import { sendTelegram, type TelegramButton } from "@/lib/server/telegram/api"
import {
  openVerificationCode,
  sendVerificationPhoto,
} from "@/lib/server/telegram/verification"
import { applicationTelegramAction } from "@/lib/telegram/applications"
import {
  applyVerificationResponse,
  readVerificationView,
  type VerificationView,
} from "./verification-surface"

type Database = ReturnType<typeof supabaseServerClient>
type Context = {
  id: string
  revision: number
  sessionId: string
  expiresAt: string
  at: AssistanceStage
  codeOnly?: boolean
}
export class TelegramVerificationBridge {
  private nonce = ""
  private steps = 0
  private lastScan = 0
  private view: VerificationView | undefined
  private readonly assistance: { sessionId: string; expiresAt: string }
  private constructor(
    private db: Database,
    private page: Page,
    private context: Context,
    private thread: string,
    private label: string,
    private userId: string
  ) {
    this.assistance = {
      sessionId: context.sessionId,
      expiresAt: context.expiresAt,
    }
  }
  static async connect(db: Database, page: Page, context: Context) {
    if (!telegramEnabled()) return null
    const run = await db
      .from("application_runs")
      .select("user_id,title:packet->>title,company:packet->>company")
      .eq("id", context.id)
      .eq("revision", context.revision)
      .eq("status", context.at.status)
      .maybeSingle()
    if (run.error) throw run.error
    if (!run.data) return null
    const connection = await db
      .from("telegram_connections")
      .select("thread_id")
      .eq("user_id", run.data.user_id)
      .maybeSingle()
    if (connection.error) throw connection.error
    if (!connection.data) return null
    return new TelegramVerificationBridge(
      db,
      page,
      context,
      connection.data.thread_id,
      [run.data.company, run.data.title].filter(Boolean).join(" · ") ||
        "Your application",
      run.data.user_id
    )
  }

  private report(outcome: string) {
    console.info("Application verification relay", {
      applicationId: this.context.id,
      revision: this.context.revision,
      outcome,
      elapsedMs: this.lastScan ? Date.now() - this.lastScan : 0,
    })
  }

  private async publish(view: VerificationView) {
    if (this.context.codeOnly && view.mode !== "code")
      throw view.mode === "challenge"
        ? new ApplicationCaptchaError()
        : new ApplicationSubmissionError("verification_unavailable")
    if (view.mode !== "code" && !view.image.length)
      view = await readVerificationView(
        this.page,
        this.context.at.status === "submitting"
      )
    if (Date.now() >= Date.parse(this.context.expiresAt))
      throw new Error("Human verification required; assistance time expired")
    this.view = view
    this.nonce = randomUUID()
    this.lastScan = Date.now()
    const challenge = {
      id: this.nonce,
      mode: view.mode,
      targetCount: view.targets.length,
      state: "waiting",
      replyMessageId: "",
    }
    const output = {
      browserAssistance: this.assistance,
      telegramChallenge: challenge,
    }
    const changed = await this.db
      .from("application_tasks")
      .update({ output })
      .eq("application_id", this.context.id)
      .eq("revision", this.context.revision)
      .eq("stage", this.context.at.stage)
      .eq("state", "running")
      .eq("error_code", "telegram_verification_required")
      .eq("output->browserAssistance->>sessionId", this.context.sessionId)
      .select("application_id")
      .maybeSingle()
    if (changed.error) throw changed.error
    if (!changed.data)
      throw new Error("Application task lease no longer active")
    const buttons: TelegramButton[][] = []
    if (view.mode === "challenge") {
      const tiles = view.targets
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.tile)
      for (let i = 0; i < tiles.length; i += 4)
        buttons.push(
          tiles.slice(i, i + 4).map(({ t, i }) => ({
            text: t.label,
            callback_data: `hv:${this.nonce}:click:${i}`,
          }))
        )
      buttons.push(
        ...view.targets.flatMap((t, i) =>
          t.tile
            ? []
            : [
                [
                  {
                    text: t.label || "Verification control",
                    callback_data: `hv:${this.nonce}:click:${i}`,
                  },
                ],
              ]
        )
      )
    }
    if (!this.context.codeOnly)
      buttons.push([
        {
          text: "Open live employer browser",
          callback_data: applicationTelegramAction(
            this.context.id,
            this.context.revision,
            "browser"
          ),
        },
      ])
    buttons.push([
      {
        text: "Check application status",
        callback_data: applicationTelegramAction(
          this.context.id,
          this.context.revision,
          "status"
        ),
      },
    ])
    const message =
      view.mode === "unsupported" && this.context.at.status !== "submitting"
        ? "No supported verification prompt is visible. This sign-in or device step cannot be completed through chat. Nothing has been submitted."
        : view.message
    const connection = await this.db
      .from("telegram_connections")
      .select("user_id")
      .eq("user_id", this.userId)
      .eq("thread_id", this.thread)
      .maybeSingle()
    if (connection.error) throw connection.error
    if (!connection.data) throw new Error("Approval no longer active")
    if (view.mode !== "code")
      await sendVerificationPhoto(
        this.thread,
        view.image,
        `${this.label}\n\n${message}\n\nThis is the existing backend session. No new browser or application is being opened.`,
        buttons
      )
    if (view.mode === "code") {
      const segments = view.targets.filter(
        (target) => target.kind === "code"
      ).length
      const length = segments > 1 ? `${segments}-character` : "4–12 character"
      const replyMessageId = await sendTelegram(
        this.thread,
        `${this.label}\n\nReply to THIS message with only the employer's ${length} verification code (letters or digits). Never send a password. The code is used only in this active session; it is not saved to your profile.`,
        [],
        true,
        true
      )
      const bound = await this.db
        .from("application_tasks")
        .update({
          output: {
            ...output,
            telegramChallenge: { ...challenge, replyMessageId },
          },
        })
        .eq("application_id", this.context.id)
        .eq("revision", this.context.revision)
        .eq("stage", this.context.at.stage)
        .eq("state", "running")
        .eq("output->telegramChallenge->>id", this.nonce)
        .eq("output->telegramChallenge->>state", "waiting")
      if (bound.error) throw bound.error
      this.report("prompt_published")
    }
  }
  async start() {
    await this.publish(
      await readVerificationView(
        this.page,
        this.context.at.status === "submitting",
        false
      )
    )
  }
  async poll(ready: () => Promise<boolean>) {
    if (Date.now() >= Date.parse(this.context.expiresAt))
      throw new Error("Human verification required; assistance time expired")
    const row = await this.db
      .from("application_tasks")
      .select("output")
      .eq("application_id", this.context.id)
      .eq("revision", this.context.revision)
      .eq("stage", this.context.at.stage)
      .eq("state", "running")
      .eq("output->browserAssistance->>sessionId", this.context.sessionId)
      .maybeSingle()
    if (row.error) throw row.error
    if (!row.data) throw new Error("Application task lease no longer active")
    const output = row.data.output,
      c = output?.telegramChallenge
    if (c?.id !== this.nonce) throw new Error("Verification view changed")
    if (c.state !== "queued") {
      if (
        this.view?.mode === "unsupported" &&
        Date.now() - this.lastScan > 5000
      ) {
        this.lastScan = Date.now()
        const fresh = await readVerificationView(
          this.page,
          this.context.at.status === "submitting",
          false
        )
        if (fresh.mode !== "unsupported") await this.publish(fresh)
      }
      return false
    }
    // Claim before touching the browser, and remove the encrypted payload from
    // durable storage. An interrupted action is never replayed automatically.
    const claimed = await this.db
      .from("application_tasks")
      .update({
        output: {
          ...output,
          telegramChallenge: { ...c, state: "executing", command: null },
        },
      })
      .eq("application_id", this.context.id)
      .eq("revision", this.context.revision)
      .eq("stage", this.context.at.stage)
      .eq("state", "running")
      .eq("output->telegramChallenge->>id", this.nonce)
      .eq("output->telegramChallenge->>state", "queued")
      .select("application_id")
      .maybeSingle()
    if (claimed.error) throw claimed.error
    if (!claimed.data) return false
    this.report("response_claimed")
    if (++this.steps > 20)
      throw new Error("Human verification required; chat action limit reached")
    try {
      if (!this.view) throw new Error("Verification view changed")
      const action = c.command?.action
      if (action !== "click" && action !== "code")
        throw new Error("Invalid verification response")
      await applyVerificationResponse(
        this.page,
        this.view,
        {
          action,
          target: c.command.target,
          value:
            action === "code"
              ? openVerificationCode(c.command.value)
              : undefined,
        },
        Date.parse(this.context.expiresAt)
      )
      this.report("response_applied")
    } catch (error) {
      this.report(
        error instanceof Error && error.message === "Verification view changed"
          ? "view_changed"
          : error instanceof Error &&
              error.message === "Verification window expired"
            ? "window_expired"
            : "apply_failed"
      )
      await sendTelegram(
        this.thread,
        "That verification view changed or the response could not be applied. Use the next picture or code prompt. No application submit action was repeated."
      )
    }
    if (await ready()) {
      this.report("prompt_cleared")
      await sendTelegram(
        this.thread,
        "Your verification response was applied. I am checking the employer's result; this is not yet a confirmed application receipt."
      )
      return true
    }
    await this.publish(
      await readVerificationView(
        this.page,
        this.context.at.status === "submitting",
        false
      )
    )
    return false
  }
}
