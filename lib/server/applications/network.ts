import { randomUUID } from "node:crypto"
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { publicApplicationUrl } from "@/lib/applications/url"
import type { BrowserContext, CDPSession, Frame, Page } from "playwright-core"

const blocked = new BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4")
blocked.addSubnet("2001:db8::", 32, "ipv6")
blocked.addSubnet("2001::", 32, "ipv6")
blocked.addSubnet("2002::", 16, "ipv6")
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")

export function isPublicAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, "ipv4")
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  )
}

// Limitation: hosts resolve here, while the remote Browserbase browser resolves
// them again through its proxy. A host that rebinds between the two lookups is
// not caught. The exposed network is the provider's, never this worker's.
export function publicRequestGuard(
  resolve = async (host: string) =>
    (await lookup(host, { all: true })).map((r) => r.address)
) {
  // Deduplicate concurrent lookups only. Re-check subsequent requests so a
  // hostname that starts resolving privately is not trusted for the session.
  const checked = new Map<string, Promise<void>>()
  return async (value: string) => {
    const target = publicApplicationUrl(value)
    if (!target) throw new Error("A public HTTPS destination is required")
    const host = new URL(target).hostname
    if (!checked.has(host))
      checked.set(
        host,
        (async () => {
          const addresses = await resolve(host)
          if (!addresses.length || addresses.some((a) => !isPublicAddress(a)))
            throw new Error("Destination must resolve only to public addresses")
        })()
      )
    const pending = checked.get(host)!
    try {
      await pending
    } finally {
      if (checked.get(host) === pending) checked.delete(host)
    }
  }
}

// Playwright routing alone does not observe every redirect. Chromium Fetch
// pauses redirected requests too: https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#event-requestPaused
// Install before releasing routed requests, including out-of-process iframes.
export async function browserRequestGuard(
  context: BrowserContext,
  page: Page,
  validate: (url: string) => Promise<void>
) {
  const sessions = new WeakMap<Frame, Promise<CDPSession>>()
  let navigations = 0
  const install = (frame: Frame): Promise<CDPSession> => {
    const existing = sessions.get(frame)
    if (existing) return existing
    const pending = (async () => {
      let session: CDPSession
      try {
        session = await context.newCDPSession(
          frame.parentFrame() ? frame : frame.page()
        )
      } catch (error) {
        const parent = frame.parentFrame()
        if (
          parent &&
          error instanceof Error &&
          error.message.includes("part of the parent frame's session")
        )
          return await install(parent)
        throw error
      }
      session.on("Fetch.requestPaused", async (event) => {
        try {
          if (event.resourceType === "Document" && ++navigations > 40)
            throw new Error("Navigation budget exceeded")
          await validate(event.request.url)
          await session.send("Fetch.continueRequest", {
            requestId: event.requestId,
          })
        } catch {
          await session
            .send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "BlockedByClient",
            })
            .catch(() => {})
        }
      })
      await session.send("Network.setBypassServiceWorker", { bypass: true })
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      })
      return session
    })()
    sessions.set(frame, pending)
    return pending
  }
  await install(page.mainFrame())
  return install
}

export async function guardApplicationRequests(
  context: BrowserContext,
  page: Page,
  validate: (url: string) => Promise<void>
) {
  const install = await browserRequestGuard(context, page, validate)
  let routedNavigations = 0
  await context.route("**/*", async (route) => {
    const request = route.request()
    try {
      if (request.isNavigationRequest() && ++routedNavigations > 40)
        throw new Error("Navigation budget exceeded")
      await validate(request.url())
      let frame: Frame
      try {
        frame = request.frame()
      } catch (error) {
        if (
          !request.isNavigationRequest() ||
          request.method() !== "GET" ||
          !(error instanceof Error) ||
          !error.message.includes(
            "Frame for this navigation request is not available"
          )
        )
          throw error
        // The first navigation can start before Playwright knows the frame.
        // Commit an inert document, then install the redirect guard on the
        // idle tab before making its first real network request.
        const marker = randomUUID()
        const opened = context.waitForEvent("page", {
          timeout: 5000,
          predicate: (candidate) =>
            candidate
              .locator(
                `meta[name="application-navigation"][content="${marker}"]`
              )
              .waitFor({ state: "attached", timeout: 3000 })
              .then(
                () => true,
                () => false
              ),
        })
        await Promise.all([
          opened,
          route.fulfill({
            contentType: "text/html",
            headers: {
              "Cache-Control": "no-store",
              "Content-Security-Policy": "default-src 'none'",
            },
            body: `<!doctype html><meta name="application-navigation" content="${marker}"><title>Opening application</title><p>Opening application…</p>`,
          }),
        ])
          .then(async ([popup]) => {
            await install(popup.mainFrame())
            await popup.reload({ waitUntil: "commit", timeout: 15000 })
          })
          .catch(() => {
            console.warn("Application tab did not finish opening")
          })
        return
      }
      await install(frame)
      return await route.continue()
    } catch {
      return await route.abort()
    }
  })
}
