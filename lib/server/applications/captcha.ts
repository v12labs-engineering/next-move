import type { ConsoleMessage, Page } from "playwright-core"

type CaptchaState = {
  active: boolean
  deadline?: number
}
const sessions = new WeakMap<Page, CaptchaState>()

// Register before navigation: the provider can start solving on page load or
// immediately after Submit. Never forward arbitrary employer console messages.
export function trackBrowserbaseCaptcha(page: Page) {
  const state: CaptchaState = { active: false }
  sessions.set(page, state)
  const onConsole = (message: ConsoleMessage) => {
    switch (message.text()) {
      case "browserbase-solving-started":
        state.active = true
        state.deadline ??= Date.now() + 30_000
        console.info("Application CAPTCHA solver", { phase: "started" })
        break
      case "browserbase-solving-finished":
        state.active = false
        console.info("Application CAPTCHA solver", { phase: "finished" })
        break
      case "browserbase-solving-errored":
        state.active = false
        console.info("Application CAPTCHA solver", { phase: "errored" })
        break
    }
  }
  page.on("console", onConsole)
  return () => {
    page.off("console", onConsole)
    sessions.delete(page)
  }
}

// An action may itself trigger a challenge. Hold its result while the provider
// is active, but leave blocked-page handling to the caller's readiness check.
// In particular, a CAPTCHA after Submit must enter receipt inspection, not
// throw a pre-click verification error or invite another Submit click.
export async function waitForBrowserbaseCaptchaIdle(
  page: Page,
  until = Infinity
) {
  const state = sessions.get(page)
  if (!state?.active) return
  const ends = Math.min(state.deadline ?? Date.now() + 30_000, until)
  while (state.active && Date.now() < ends) {
    const remaining = ends - Date.now()
    if (remaining <= 0) break
    await page.waitForTimeout(Math.min(250, remaining))
  }
  if (state.active)
    throw new Error("Browserbase CAPTCHA solver still active at timeout")
}

// Readiness callbacks are polled by the automatic wait and human relay. They
// must never start another solver window, or delay each Telegram response.
export async function browserbaseCaptchaReady(
  page: Page,
  ready: () => Promise<boolean>
) {
  const state = sessions.get(page)
  if (state?.active) return false
  const clear = await ready()
  if (!clear || state?.active) return false
  if (state) state.deadline = undefined
  return true
}

export async function waitForBrowserbaseCaptcha(
  page: Page,
  ready: () => Promise<boolean>,
  until = Infinity
) {
  const state = sessions.get(page)
  if (!state) return false
  const began = Date.now()
  const ends = Math.min(began + 30_000, state.deadline ?? Infinity, until)
  const verifiedReady = () => browserbaseCaptchaReady(page, ready)
  while (Date.now() < ends) {
    if (await verifiedReady()) return true
    // A blocked page can start solving late. Errors/repeated challenges and
    // delayed starts all share this original bounded readiness window.
    const remaining = ends - Date.now()
    if (remaining <= 0) break
    await page.waitForTimeout(Math.min(250, remaining))
  }
  if (await verifiedReady()) return true
  if (state.active)
    throw new Error("Browserbase CAPTCHA solver still active at timeout")
  return false
}
