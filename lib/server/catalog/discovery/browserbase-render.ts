import Browserbase from "@browserbasehq/sdk"
import { chromium, type Browser } from "playwright-core"
import {
  browserRequestGuard,
  publicRequestGuard,
} from "../../applications/network"
import { readBounded } from "./seeds"
import { robotsAllowed } from "./validate"
import { DiscoveryBrowserError, type RenderCareerLinks } from "./browserbase"

/** Public, read-only discovery browser. No application context, proxy or LLM. */
export function browserbaseCareerRenderer(
  env: Partial<NodeJS.ProcessEnv>,
  options: {
    fetch?: typeof fetch
    guard?: (url: string) => Promise<void>
    connect?: typeof chromium.connectOverCDP
  } = {}
): RenderCareerLinks {
  if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID)
    throw new Error("Browserbase discovery requires API key and project ID")
  const transport = options.fetch ?? fetch
  const bb = new Browserbase({
    apiKey: env.BROWSERBASE_API_KEY,
    maxRetries: 0,
    timeout: 15_000,
    fetch: transport,
  })
  return async (url, signal) => {
    const guard = options.guard ?? publicRequestGuard(),
      robots = new Map<string, Promise<string>>()
    async function allowed(value: string) {
      signal.throwIfAborted()
      await guard(value)
      const target = new URL(value)
      if (!robots.has(target.origin)) {
        if (robots.size >= 16)
          throw new Error("Discovery origin budget reached")
        robots.set(
          target.origin,
          (async () => {
            const response = await transport(`${target.origin}/robots.txt`, {
              redirect: "error",
              cache: "no-store",
              headers: { "User-Agent": "JobSearchCatalog/1.0" },
              signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            })
            if (
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 429
            ) {
              await response.body?.cancel()
              return ""
            }
            if (!response.ok) {
              await response.body?.cancel()
              throw new Error("Robots unavailable")
            }
            return (await readBounded(response, 512_000)).toString("utf8")
          })()
        )
      }
      if (
        !robotsAllowed(
          await robots.get(target.origin)!,
          target.pathname + target.search
        )
      )
        throw new Error("Employer robots rules exclude this path")
    }
    let browser: Browser | undefined,
      sessionId = "",
      releaseRequested = false,
      phase = "robots",
      failed = false,
      status: number | undefined
    const abort = () => {
      void browser?.close().catch(() => {})
    }
    signal.addEventListener("abort", abort, { once: true })
    let links: string[] = []
    try {
      await allowed(url) // Do not spend a session on a refused/private destination.
      signal.throwIfAborted()
      phase = "create"
      const session = await bb.sessions.create(
        {
          projectId: env.BROWSERBASE_PROJECT_ID,
          api_timeout: 120,
          keepAlive: false,
          proxies: false,
          browserSettings: {
            solveCaptchas: false,
            recordSession: false,
            logSession: false,
          },
          userMetadata: { purpose: "catalog-source-discovery" },
        },
        { signal }
      )
      sessionId = session.id
      signal.throwIfAborted()
      phase = "connect"
      browser = await (
        options.connect ?? chromium.connectOverCDP.bind(chromium)
      )(session.connectUrl, {
        timeout: 10_000,
      })
      signal.throwIfAborted()
      phase = "guard"
      const context = browser.contexts()[0]
      if (!context) throw new Error("Missing discovery browser context")
      await context.clearCookies()
      const page = context.pages()[0] ?? (await context.newPage())
      let requests = 0
      const install = await browserRequestGuard(context, page, allowed)
      context.on("page", (other) => {
        if (other !== page) void other.close().catch(() => {})
      })
      await context.routeWebSocket("**/*", (socket) => socket.close())
      await context.route("**/*", async (route) => {
        const request = route.request()
        try {
          if (
            ++requests > 150 ||
            request.method() !== "GET" ||
            ["image", "media", "font"].includes(request.resourceType())
          )
            return await route.abort()
          await guard(request.url())
          if (request.isNavigationRequest()) {
            await install(request.frame())
            await allowed(request.url())
          }
          await route.continue()
        } catch {
          await route.abort().catch(() => {})
        }
      })
      phase = "navigate"
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      })
      if (!response?.ok()) throw new Error("Career-page navigation failed")
      phase = "extract"
      await page
        .waitForFunction(
          () =>
            Array.from(document.querySelectorAll("a[href],iframe[src]")).some(
              (el) =>
                /ashbyhq\.com|greenhouse\.io|lever\.co|smartrecruiters\.com|myworkdayjobs\.com/.test(
                  el.getAttribute("href") ?? el.getAttribute("src") ?? ""
                )
            ),
          undefined,
          { timeout: 8_000 }
        )
        .catch(() => {})
      signal.throwIfAborted()
      links = await page
        .locator("a[href],iframe[src]")
        .evaluateAll((elements) =>
          elements.slice(0, 500).flatMap((el) => {
            const raw = el.getAttribute("href") ?? el.getAttribute("src")
            try {
              return raw ? [new URL(raw, document.baseURI).href] : []
            } catch {
              return []
            }
          })
        )
    } catch (error) {
      // CDP and SDK errors may include signed control URLs or credentials.
      failed = true
      status = error instanceof Browserbase.APIError ? error.status : undefined
    } finally {
      signal.removeEventListener("abort", abort)
      if (browser) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            browser.close(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 3000)
            }),
          ])
        } catch {
          /* Provider release is independent of the CDP connection. */
        } finally {
          clearTimeout(timer)
        }
      }
      if (sessionId) {
        try {
          await bb.sessions.update(sessionId, {
            projectId: env.BROWSERBASE_PROJECT_ID!,
            status: "REQUEST_RELEASE",
          })
          releaseRequested = true
        } catch {
          /* Server-side 120-second expiry bounds uncertain cleanup. */
        }
      }
    }
    if (failed)
      throw new DiscoveryBrowserError(
        phase,
        sessionId,
        releaseRequested,
        status
      )
    return { links, sessionId, releaseRequested }
  }
}
