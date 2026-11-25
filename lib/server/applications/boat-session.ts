import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { chromium, type Browser } from "playwright-core"
import { setTimeout as delay } from "node:timers/promises"
import {
  bindBrowserUse,
  browserUseModelConfiguration,
  browserUseRunner,
} from "./browser-use"
import { bindCaptchaSolver } from "./captcha-solver"
import { ApplicationCaptchaError } from "@/lib/applications/pipeline"
import { bindDocumentUpload } from "./browser-documents"
import {
  boatApi,
  boatWorkerAddress,
  createBoatBrowser,
  hostBoatWorker,
} from "./boat-api"
import { acquireBoatBatch, type BoatBatchAccount } from "./boat-batch"

export type BoatOptions = {
  env?: Partial<NodeJS.ProcessEnv>
  fetcher?: typeof fetch
  connect?: typeof chromium.connectOverCDP
  account?: BoatBatchAccount
}

export async function withBoatSession<T>(
  run: (
    browser: Browser,
    id: string,
    release: () => Promise<void>
  ) => Promise<T>,
  options: BoatOptions = {}
) {
  const env = options.env || process.env
  const fetcher = options.fetcher || fetch
  const api = boatApi(env, fetcher)
  if (env.TAILORING_OLLAMA_MODEL?.trim())
    browserUseModelConfiguration({
      ...env,
      APPLICATION_BROWSER_PROVIDER: "boat",
    })
  const started = Date.now()
  const useBatch = options.account && env.BOAT_APPLICATION_BATCHING !== "false"
  let token = randomBytes(32).toString("hex")
  let batch: Awaited<ReturnType<typeof acquireBoatBatch>> | undefined
  let sessionId: string | undefined
  let closeConfirmed = false
  let sessionRequested = false
  let sandboxStopped = false
  let id: string | undefined,
    url: string | undefined,
    browser: Browser | undefined
  let headers: Record<string, string> = {}
  let unbindCaptcha: (() => void) | undefined
  let unbind: (() => void) | undefined, unbindUpload: (() => void) | undefined
  let stopWatchingBrowser: (() => void) | undefined
  let releasePromise: Promise<void> | undefined
  const release = () =>
    (releasePromise ??= (async () => {
      stopWatchingBrowser?.()
      unbind?.()
      unbindUpload?.()
      unbindCaptcha?.()
      if (url && !sandboxStopped && (!batch || sessionRequested)) {
        const response = await fetcher(`${url}/close`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(batch ? 15_000 : 10_000),
          redirect: "error",
        }).catch(() => null)
        closeConfirmed = response?.ok === true
      }
      if (browser) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            browser.close().catch(() => {}),
            new Promise((resolve) => {
              timer = setTimeout(resolve, 5000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      if (batch) {
        if (sandboxStopped)
          await batch.drain().catch(() =>
            console.warn("Stopped Boat batch could not be drained", {
              sandboxId: id,
            })
          )
        if (sandboxStopped || closeConfirmed || !sessionRequested) {
          await batch
            .release()
            .catch(() =>
              console.warn("Boat browser lease will expire", { sessionId })
            )
        } else {
          console.warn("Boat browser close unconfirmed; lease will expire", {
            sessionId,
          })
        }
      } else if (id && !sandboxStopped) {
        try {
          await api(`/sandboxes/${id}/stop`, {})
        } catch {
          console.warn("Boat cleanup deferred to auto-stop", { sessionId: id })
        }
      }
      if (id)
        console.info("Application browser timing", {
          provider: "boat",
          sessionId,
          sandboxId: id,
          clientMs: Date.now() - started,
        })
    })())
  try {
    let address: URL
    if (useBatch && options.account) {
      batch = await acquireBoatBatch(options.account, api, env)
      id = batch.sandboxId
      sessionId = batch.sessionId
      address = boatWorkerAddress(batch.accessUrl)
      token = createHmac("sha256", batch.workerToken)
        .update(sessionId)
        .digest("hex")
    } else {
      const created = await createBoatBrowser(api, env, token, randomUUID())
      id = created.id
      sessionId = id
      address = await hostBoatWorker(api, created)
    }
    // Exchange the provider's token URL for its scoped access cookie. Neither
    // this cookie nor the per-session worker token is ever logged.
    const access = await fetcher(address, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    })
    const cookie = access.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
    const cookieHeader: Record<string, string> = cookie
      ? { Cookie: cookie }
      : {}
    headers = { ...cookieHeader, Authorization: `Bearer ${token}` }
    const until = Math.min(
      Date.now() + 90_000,
      options.account?.deadline ?? Infinity
    )
    const workerUrl = batch
      ? `${address.origin}/sessions/${sessionId}`
      : address.origin
    const startUrl = batch ? workerUrl : `${workerUrl}/session`
    url = workerUrl
    let ready = false
    while (Date.now() < until) {
      if (batch && !sessionRequested) {
        const health = await fetcher(`${address.origin}/healthz`, {
          headers: cookieHeader,
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        }).catch(() => null)
        const status = health?.ok && (await health.json().catch(() => null))
        if (!status || status.service !== "browser-use-worker") {
          await delay(1000)
          continue
        }
      }
      sessionRequested = true
      const response = await fetcher(startUrl, {
        ...(batch
          ? {
              method: "POST",
              headers: {
                ...cookieHeader,
                Authorization: `Bearer ${batch.workerToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ expiresAt: batch.expiresAt }),
            }
          : { headers }),
        redirect: "manual",
        signal: AbortSignal.timeout(batch ? 15_000 : 5_000),
      }).catch(() => null)
      if (
        batch &&
        response &&
        [401, 403, 409, 410, 422, 500].includes(response.status)
      )
        throw Object.assign(new Error("Boat Chrome session failed to start"), {
          status: [409, 410].includes(response.status) ? 503 : response.status,
        })
      if (response?.ok) {
        const state = await response.json().catch(() => null)
        if (state?.ready && state.recording) {
          ready = true
          break
        }
      }
      await delay(1000)
    }
    if (!ready) {
      if (batch && !sessionRequested)
        await batch
          .drain()
          .catch(() =>
            console.warn("Boat batch could not be drained", { sandboxId: id })
          )
      throw Object.assign(
        new Error("Boat Chrome worker did not become ready"),
        {
          status: 503,
        }
      )
    }
    browser = await (options.connect || chromium.connectOverCDP.bind(chromium))(
      `${workerUrl.replace("https:", "wss:")}/cdp`,
      { headers, timeout: 20_000 }
    )
    const context = browser.contexts()[0]
    if (!context) throw new Error("Boat Chrome has no context")
    // The Boat server replaces this URL with Chrome's loopback CDP endpoint.
    unbind = bindBrowserUse(
      context,
      browserUseRunner("http://127.0.0.1:9222", {
        url: workerUrl,
        token,
        headers,
      })
    )
    unbindCaptcha = bindCaptchaSolver(
      context,
      async (page, deadline, logContext) => {
        const cdp = await page.context().newCDPSession(page)
        let pageId: string
        try {
          pageId = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId
        } finally {
          await cdp.detach()
        }
        const timeoutMs = Math.max(1, Math.min(260_000, deadline - Date.now()))
        const response = await fetcher(`${url}/captcha`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            pageId,
            timeoutMs,
            key: process.env.TWOCAPTCHA_API_KEY,
            context: logContext,
          }),
          signal: AbortSignal.timeout(timeoutMs + 5000),
          redirect: "error",
        })
        if (!response.ok) throw new ApplicationCaptchaError()
        const payload = await response.json()
        for (const event of payload.logs || [])
          if (
            typeof event.message === "string" &&
            event.message.startsWith("Application CAPTCHA")
          )
            console.info(event.message, {
              ...event.data,
              ...logContext,
              providerHost: "boat",
            })
        if (!payload.result) throw new ApplicationCaptchaError()
        return payload.result
      }
    )
    unbindUpload = bindDocumentUpload(context, async (file) => {
      const response = await fetcher(
        `${url}/files/${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers,
          body: new Uint8Array(file.buffer),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        }
      )
      if (!response.ok) throw new Error("Boat document upload failed")
      if (!batch) return `/tmp/.uploads/${file.name}`
      const { path } = await response.json()
      if (path !== `/tmp/application-browser-${sessionId}/uploads/${file.name}`)
        throw new Error("Boat returned an invalid document path")
      return path as string
    })
    console.info("Application browser started", {
      provider: "boat",
      sessionId,
      sandboxId: id,
      startupMs: Date.now() - started,
      recording: true,
    })
    const connectedBrowser = browser
    const sandboxId = id
    const browserSessionId = batch ? `bx_${sessionId}` : sessionId
    // The hosted CDP and agent sockets can stay open after Boat stops the VM.
    // Observe the worker separately and cap operations that wait on silent CDP.
    const browserLost = new Promise<never>((_, reject) => {
      const watch = new AbortController()
      const disconnected = () =>
        reject(
          Object.assign(new Error("Boat browser disconnected"), { status: 503 })
        )
      const deadline = options.account?.deadline ?? started + 900_000
      const timeout = setTimeout(
        () => reject(new Error("Boat browser operation timed out")),
        Math.max(0, deadline - Date.now())
      )
      connectedBrowser.once("disconnected", disconnected)
      stopWatchingBrowser = () => {
        watch.abort()
        clearTimeout(timeout)
        connectedBrowser.off("disconnected", disconnected)
      }
      if (!connectedBrowser.isConnected()) disconnected()
      const probe = async () => {
        while (!watch.signal.aborted) {
          await delay(15_000, undefined, { signal: watch.signal })
          const response = await fetcher(`${workerUrl}/session`, {
            headers,
            redirect: "manual",
            signal: AbortSignal.any([watch.signal, AbortSignal.timeout(5000)]),
          }).catch(() => null)
          await response?.body?.cancel().catch(() => {})
          if (response?.ok || watch.signal.aborted) continue
          const state = await api(
            `/sandboxes/${sandboxId}`,
            undefined,
            undefined,
            5000
          )
            .then(({ sandbox }) => sandbox?.state)
            .catch((error) => (error?.status === 404 ? "stopped" : undefined))
          if (watch.signal.aborted) return
          if (state === "stopped" || state === "archived") {
            sandboxStopped = true
            console.warn("Boat sandbox stopped during browser work", {
              sandboxId,
              sessionId,
            })
            reject(
              Object.assign(
                new Error("Boat sandbox stopped during browser work"),
                { status: 503 }
              )
            )
            return
          }
        }
      }
      void probe().catch((error) => {
        if (!watch.signal.aborted) reject(error)
      })
    })
    return await Promise.race([
      browserLost,
      Promise.resolve().then(() =>
        run(connectedBrowser, browserSessionId, release)
      ),
    ])
  } finally {
    await release()
  }
}
