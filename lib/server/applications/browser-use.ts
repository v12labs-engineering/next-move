import WebSocket, { createWebSocketStream } from "ws"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
import { join } from "node:path"
import type { BrowserContext, Page } from "playwright-core"
import { z } from "zod"
import { tailoringConfig } from "@/lib/server/tailoring"

export type BrowserUseRun = {
  logContext?: { applicationId: string; revision: number }
  task: string
  tools: Record<string, { description: string | undefined }>
  files?: string[]
  pageId?: string
  timeout: number
  reserveDecision: () => Promise<void>
  execute: (name: string, args: unknown, pageId?: string) => Promise<unknown>
}
export type BrowserUseRunner = (run: BrowserUseRun) => Promise<void>
const sessions = new WeakMap<BrowserContext, BrowserUseRunner>()
const pageTargets = new WeakMap<Page, string>()

// Resolve only a page in this application's existing browser context. Never
// open a replacement page or fall back to the original tab after a switch.
export async function browserUsePage(page: Page, target: string) {
  for (const candidate of page.context().pages()) {
    let id = pageTargets.get(candidate)
    if (!id) {
      try {
        const cdp = await candidate.context().newCDPSession(candidate)
        try {
          const targetInfo = (await cdp.send("Target.getTargetInfo")).targetInfo
          id = targetInfo.targetId
          pageTargets.set(candidate, targetInfo.targetId)
        } finally {
          await cdp.detach().catch(() => {})
        }
      } catch (error) {
        if (candidate.isClosed()) continue
        throw error
      }
    }
    if (id === target) return candidate
  }
  throw new Error("Browser Use active page is no longer available")
}

export function bindBrowserUse(
  context: BrowserContext,
  runner: BrowserUseRunner
) {
  sessions.set(context, runner)
  return () => {
    sessions.delete(context)
  }
}

export async function runBrowserUse(page: Page, run: BrowserUseRun) {
  const runner = sessions.get(page.context())
  if (!runner) throw new Error("Browser Use worker is not connected")
  const cdp = await page.context().newCDPSession(page)
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo")
    pageTargets.set(page, targetInfo.targetId)
    await runner({ ...run, pageId: targetInfo.targetId })
  } finally {
    await cdp.detach().catch(() => {})
  }
}

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    actions: z.array(z.string().regex(/^[a-z_]+$/)).max(10),
    failed: z.boolean().optional(),
    timing: z
      .object({
        phase: z.enum([
          "dom_snapshot",
          "first_input",
          "sdk_import",
          "agent_ready",
          "browser_connect",
          "model",
          "native_action",
          "reserve_decision",
          "agent_run",
          "get_saved_answers",
          "report_form",
          "request_missing_answers",
          "request_verification",
          "solve_captcha",
          "begin_submission",
          "report_submission",
        ]),
        durationMs: z.number().int().nonnegative(),
        elapsedMs: z.number().int().nonnegative(),
        turn: z.number().int().nonnegative(),
        ok: z.boolean(),
      })
      .optional(),
  }),
  z.object({ type: z.literal("reserve") }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    arguments: z.unknown(),
    pageId: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,128}$/)
      .optional(),
  }),
  z.object({ type: z.literal("complete") }),
  z.object({
    type: z.literal("failure"),
    code: z
      .string()
      .regex(/^[A-Za-z]+$/)
      .optional(),
    validation: z
      .array(
        z.object({
          path: z.string().max(200),
          code: z.string().regex(/^[a-z_]+$/),
        })
      )
      .max(5)
      .optional(),
    location: z
      .string()
      .regex(/^[\w.-]+:\d+$/)
      .optional(),
  }),
])

export class BrowserUseWorkerError extends Error {
  readonly diagnostic: string
  readonly code: "temporary_unavailable" | "configuration"
  constructor(
    event: Extract<z.infer<typeof eventSchema>, { type: "failure" }>
  ) {
    super("Browser Use agent failed")
    this.name = "BrowserUseWorkerError"
    this.diagnostic = event.validation?.some(
      (item) => item.path === "task" && item.code === "string_too_long"
    )
      ? "browser_use_task_too_long"
      : event.code === "ValidationError"
        ? "browser_use_validation"
        : "browser_use_agent_failure"
    this.code =
      this.diagnostic === "browser_use_task_too_long"
        ? "configuration"
        : "temporary_unavailable"
  }
}

export function browserUseConfiguration(
  env: Partial<NodeJS.ProcessEnv> = process.env
) {
  if (env.BROWSER_USE_WORKER_URL) {
    const url = new URL(env.BROWSER_USE_WORKER_URL)
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )
    )
      throw new Error("Browser Use worker requires HTTPS")
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Invalid Browser Use worker URL")
    if (
      !env.BROWSER_USE_WORKER_TOKEN ||
      env.BROWSER_USE_WORKER_TOKEN.length < 32
    )
      throw new Error("Browser Use worker token is not configured")
    return {
      url: url.href.replace(/\/$/, ""),
      token: env.BROWSER_USE_WORKER_TOKEN,
    }
  }
  if (env.VERCEL || !env.BROWSER_USE_PYTHON)
    throw new Error("Browser Use Python worker is not configured")
  return { python: env.BROWSER_USE_PYTHON }
}

export function browserUseModelConfiguration(
  env: Partial<NodeJS.ProcessEnv> = process.env
) {
  const modelId = env.BROWSER_USE_MODEL?.trim()
  const baseURL = env.BROWSER_USE_BASE_URL?.trim()
  if (baseURL) {
    return tailoringConfig({
      NODE_ENV: "production",
      TAILORING_BASE_URL: baseURL,
      TAILORING_MODEL: modelId,
      TAILORING_API_KEY: env.BROWSER_USE_API_KEY,
      AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY,
      VERCEL_OIDC_TOKEN: env.VERCEL_OIDC_TOKEN,
    })
  }
  if (
    env.APPLICATION_BROWSER_PROVIDER === "boat" &&
    env.TAILORING_OLLAMA_MODEL?.trim()
  )
    throw new Error("Boat Browser Use model endpoint is not configured")
  const inherited = tailoringConfig(env)
  return { ...inherited, modelId: modelId || inherited.modelId }
}

export function browserUseRunner(
  connectUrl: string,
  connection?: { url: string; token: string; headers?: Record<string, string> }
): BrowserUseRunner {
  return async (run) => {
    const started = performance.now()
    let firstEvent = true
    const timing = (phase: string, began: number, ok = true) =>
      console.info("Browser Use timing", {
        ...run.logContext,
        phase,
        durationMs: Math.round(performance.now() - began),
        elapsedMs: Math.round(performance.now() - started),
        ok,
      })
    const config = connection || browserUseConfiguration()
    const model = browserUseModelConfiguration()
    const input = JSON.stringify({
      connectUrl,
      pageId: run.pageId,
      task: run.task,
      tools: run.tools,
      files: run.files,
      model,
    })
    const abort = new AbortController()
    const timer = setTimeout(
      () => abort.abort(),
      Math.max(1, Math.min(run.timeout, 720_000))
    )
    let completed = false
    const consume = async (
      line: string,
      reply: (value: unknown) => Promise<void>
    ) => {
      if (line.length > 2_000_000)
        throw new Error("Browser Use response exceeded limit")
      const event = eventSchema.parse(JSON.parse(line))
      if (firstEvent) {
        firstEvent = false
        timing("worker_first_event", started)
      }
      if (event.type === "progress") {
        if (event.timing) {
          console.info("Browser Use timing", {
            ...run.logContext,
            ...event.timing,
          })
          return
        }
        console.info("Browser Use native actions", {
          ...run.logContext,
          actions: event.actions,
          failed: event.failed ?? false,
        })
        return
      }
      if (event.type === "failure") throw new BrowserUseWorkerError(event)
      if (event.type === "complete") {
        completed = true
        return
      }
      if (event.type === "reserve") {
        const began = performance.now()
        let ok = false
        try {
          await run.reserveDecision()
          await reply({ ok: true })
          ok = true
        } finally {
          timing("reserve_database", began, ok)
        }
      } else if (event.type === "tool") {
        const began = performance.now()
        let ok = false
        try {
          await reply(
            await run.execute(event.name, event.arguments, event.pageId)
          )
          ok = true
        } finally {
          timing("business_tool", began, ok)
        }
      }
    }
    try {
      if ("python" in config && config.python) {
        const directory = await mkdtemp(
          join(tmpdir(), "application-browser-use-")
        )
        const child = spawn(
          config.python,
          [join(process.cwd(), "workers/browser-use/agent.py")],
          {
            stdio: ["pipe", "pipe", "ignore"],
            signal: abort.signal,
            env: {
              NODE_ENV: process.env.NODE_ENV,
              ...Object.fromEntries(
                Object.entries(process.env).filter(([key]) =>
                  [
                    "PATH",
                    "HOME",
                    "TMPDIR",
                    "LANG",
                    "SSL_CERT_FILE",
                    "SSL_CERT_DIR",
                  ].includes(key)
                )
              ),
              TMPDIR: directory,
            },
          }
        )
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", () =>
            reject(new Error("Browser Use Python worker could not start"))
          )
          child.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(
                  new BrowserUseWorkerError({
                    type: "failure",
                    code: "WorkerExit",
                  })
                )
          )
        })
        // Attach immediately: startup/abort can fail while stdout is being read.
        void exited.catch(() => {})
        child.stdin.on("error", () => {})
        child.stdin.write(input + "\n")
        try {
          for await (const line of createInterface({ input: child.stdout }))
            await consume(line, async (value) => {
              child.stdin.write(JSON.stringify(value) + "\n")
            })
          await exited
        } finally {
          child.kill("SIGKILL")
          await exited.catch(() => {})
          await rm(directory, { recursive: true, force: true })
        }
      } else {
        const url = new URL(`${config.url}/run`)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        const socket = new WebSocket(url, {
          headers: {
            ...("headers" in config ? config.headers : {}),
            Authorization: `Bearer ${config.token}`,
          },
          maxPayload: 2_000_000,
          handshakeTimeout: Math.max(1, Math.min(run.timeout, 30_000)),
        })
        const stream = createWebSocketStream(socket, {
          encoding: "utf8",
          readableObjectMode: true,
          decodeStrings: false,
        })
        const cancel = () =>
          stream.destroy(new Error("Browser Use worker timed out"))
        abort.signal.addEventListener("abort", cancel, { once: true })
        // stream writes wait for the connection to open; errors propagate to iteration.
        stream.write(input)
        if (abort.signal.aborted) cancel()
        try {
          for await (const message of stream) {
            await consume(String(message), async (value) => {
              if (abort.signal.aborted || socket.readyState !== WebSocket.OPEN)
                throw new Error("Browser Use worker disconnected")
              await new Promise<void>((resolve, reject) =>
                socket.send(JSON.stringify(value), (error) =>
                  error ? reject(error) : resolve()
                )
              )
            })
            if (completed) break
          }
        } finally {
          abort.signal.removeEventListener("abort", cancel)
          stream.destroy()
          socket.terminate()
        }
      }
      if (!completed)
        throw new BrowserUseWorkerError({
          type: "failure",
          code: "IncompleteStream",
        })
    } finally {
      timing("worker_total", started, completed)
      clearTimeout(timer)
      abort.abort()
    }
  }
}
