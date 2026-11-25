import { withBoatSession, type BoatOptions } from "./boat-session"
import Browserbase from "@browserbasehq/sdk"
import { chromium, type Browser } from "playwright-core"
import {
  bindBrowserUse,
  browserUseRunner,
  browserUseConfiguration,
} from "./browser-use"
import { applicationFailure } from "@/lib/applications/pipeline"

type BrowserEnvironment = Partial<NodeJS.ProcessEnv>
type SessionOptions = {
  env?: BrowserEnvironment
  fetcher?: typeof fetch
  connect?: typeof chromium.connectOverCDP
  account?: BoatOptions["account"]
}

// A silent CDP transport can leave browser cleanup pending indefinitely.
// Cleanup must not hold the task result or prevent an independent API release.
async function cleanupBrowserOperation(
  close: () => Promise<unknown>,
  reportReleaseFailure = false
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser cleanup timed out")),
          5_000
        )
      }),
    ])
  } catch {
    if (reportReleaseFailure)
      console.warn("Application browser cleanup deferred to session timeout")
  } finally {
    clearTimeout(timer)
  }
}

const nearestBrowserRegion: Record<string, string> = {
  iad: "us-east-1",
  cle: "us-east-1",
  yul: "us-east-1",
  gru: "us-east-1",
  sfo: "us-west-2",
  pdx: "us-west-2",
  fra: "eu-central-1",
  cdg: "eu-central-1",
  lhr: "eu-central-1",
  dub: "eu-central-1",
  arn: "eu-central-1",
  cpt: "eu-central-1",
  icn: "ap-southeast-1",
  hnd: "ap-southeast-1",
  kix: "ap-southeast-1",
  hkg: "ap-southeast-1",
  sin: "ap-southeast-1",
  bom: "ap-southeast-1",
  syd: "ap-southeast-1",
}

export function applicationBrowserProvider(
  env: BrowserEnvironment = process.env
) {
  if (
    env.APPLICATION_BROWSER_PROVIDER &&
    !["browserbase", "boat"].includes(env.APPLICATION_BROWSER_PROVIDER)
  )
    throw new Error("Application browser provider must be browserbase or boat")
  return env.APPLICATION_BROWSER_PROVIDER === "boat" ? "boat" : "browserbase"
}

export async function withBrowserSession<T>(
  run: (
    browser: Browser,
    sessionId: string,
    release: () => Promise<void>
  ) => Promise<T>,
  options: SessionOptions = {}
) {
  const env = options.env || process.env
  const provider = applicationBrowserProvider(env)
  if (
    env.APPLICATION_FORM_PLANNER &&
    env.APPLICATION_FORM_PLANNER !== "browser-use"
  )
    throw new Error("Application planner must be browser-use")
  if (provider === "boat") return withBoatSession(run, options)
  browserUseConfiguration(env)
  // Every observation makes many CDP round trips, so the browser runs near the
  // worker instead of the provider's Oregon default. Unknown worker locations
  // keep that default; BROWSERBASE_REGION overrides after measuring.
  const requestedRegion =
    env.BROWSERBASE_REGION ||
    nearestBrowserRegion[env.VERCEL_REGION?.replace(/\d+$/, "") || ""]
  const browserRegion = (
    ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"] as const
  ).find((value) => value === requestedRegion)
  if (requestedRegion && !browserRegion)
    throw new Error("Browserbase browser region is not configured")
  if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID)
    throw new Error("Browserbase browser is not configured")
  const bb = new Browserbase({
    apiKey: env.BROWSERBASE_API_KEY,
    fetch: options.fetcher,
    maxRetries: 0,
    timeout: 20_000,
  })
  let remote: Awaited<ReturnType<typeof bb.sessions.create>> | undefined
  let browser: Browser | undefined
  let enteredCallback = false
  let unbind: (() => void) | undefined
  const started = Date.now()
  let callbackStarted = started
  let region: string | undefined
  let releasePromise: Promise<void> | undefined
  const release = () =>
    (releasePromise ??= (async () => {
      const releasing = Date.now()
      let releaseRequested = false
      let providerElapsedMs: number | undefined
      let providerState: string | undefined
      let proxyBytes: number | undefined
      unbind?.()
      unbind = undefined
      // This can run immediately after final evidence capture. Cleanup is
      // idempotent, so the outer finally still covers every earlier failure.
      await Promise.all([
        ...(browser ? [cleanupBrowserOperation(() => browser!.close())] : []),
        ...(remote?.id
          ? [
              cleanupBrowserOperation(async () => {
                const closed = await bb.sessions.update(remote!.id, {
                  projectId: env.BROWSERBASE_PROJECT_ID!,
                  status: "REQUEST_RELEASE",
                })
                releaseRequested = true
                providerState = closed.status
                proxyBytes = closed.proxyBytes
                const elapsed =
                  Date.parse(closed.endedAt || "") -
                  Date.parse(closed.startedAt)
                if (Number.isFinite(elapsed) && elapsed >= 0)
                  providerElapsedMs = elapsed
              }, true),
            ]
          : []),
      ])
      if (remote)
        console.info("Application browser timing", {
          sessionId: remote.id,
          region,
          clientMs: Date.now() - started,
          workMs: enteredCallback ? releasing - callbackStarted : 0,
          cleanupMs: Date.now() - releasing,
          releaseRequested,
          providerState,
          providerElapsedMs,
          proxyBytes,
        })
    })())
  try {
    remote = await bb.sessions.create({
      projectId: env.BROWSERBASE_PROJECT_ID,
      proxies: true,
      ...(browserRegion ? { region: browserRegion } : {}),
      // Cover the sending worker's 770s budget and its bounded cleanup.
      api_timeout: 800,
      // Python disconnects between discovery and filling; only our explicit
      // release (or the timeout backstop) should end the shared browser.
      keepAlive: true,
      browserSettings: {
        // 2Captcha owns detected challenges; avoid competing automatic solvers.
        solveCaptchas: false,
        recordSession: true,
        logSession: false,
      },
    })
    region = remote.region
    if (!remote.connectUrl) throw new Error("Missing browser connection")
    browser = await (options.connect || chromium.connectOverCDP.bind(chromium))(
      remote.connectUrl,
      { timeout: 20_000 }
    )
    const context = browser.contexts()[0]
    if (!context) throw new Error("Missing browser context")
    unbind = bindBrowserUse(context, browserUseRunner(remote.connectUrl))
    enteredCallback = true
    callbackStarted = Date.now()
    return await run(browser, remote.id, release)
  } catch (error) {
    if (enteredCallback) throw error
    // Connection errors may contain keys, control URLs or provider response bodies.
    const status =
      error instanceof Browserbase.APIError ? error.status : undefined
    const capacity = [402, 403, 429].includes(status || 0)
    throw Object.assign(
      new Error(
        capacity
          ? "Browserbase browser capacity or account limit reached"
          : "Browserbase browser could not start"
      ),
      {
        status,
        code: applicationFailure(error).code,
      }
    )
  } finally {
    await release()
  }
}
