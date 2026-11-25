import type { Frame, Page } from "playwright-core"

export async function visibleCaptchaFrame(frame: Frame) {
  for (
    let current = frame;
    current.parentFrame();
    current = current.parentFrame()!
  ) {
    const element = await current.frameElement()
    try {
      if (!(await element.isVisible())) return false
    } finally {
      await element.dispose()
    }
  }
  return true
}

// A passive badge is not a challenge. Inspect actual controls in trusted frames,
// including frames nested inside an embedded employer application.
export async function findCaptchaSurface(page: Page) {
  let checkbox: { kind: "checkbox"; frame: Frame } | null = null
  for (const frame of page.frames()) {
    try {
      // Newly attached employer frames may not have navigated yet. Their empty
      // URL is not a CAPTCHA surface and must not abort the entire application.
      const url = URL.parse(frame.url())
      if (!url || url.protocol !== "https:") continue
      const recaptcha = [
        "www.google.com",
        "www.recaptcha.net",
        "recaptcha.net",
      ].includes(url.hostname)
      if (
        !recaptcha ||
        !/^\/recaptcha\/(api2|enterprise)\/(bframe|anchor)$/.test(url.pathname)
      )
        continue
      if (!(await visibleCaptchaFrame(frame))) continue
      if (url.pathname.endsWith("/bframe"))
        return { kind: "grid" as const, frame }
      const control = frame.locator('#recaptcha-anchor[role="checkbox"]')
      if (
        (await control.count()) &&
        (await control.isVisible()) &&
        (await control.getAttribute("aria-checked")) === "false"
      )
        checkbox = { kind: "checkbox", frame }
    } catch (error) {
      // Frames can disappear after a solved challenge; other failures must remain
      // visible rather than being mistaken for "no CAPTCHA".
      if (frame.isDetached()) continue
      throw error
    }
  }
  return checkbox
}

// Sign-in pages and challenges both need a person; they are logged apart to
// measure how often account-gated portals stop automation.
export async function employerAccessGate(page: Page, includeCheckbox = false) {
  if (
    await page
      .locator('iframe[src*="bframe"]:visible,iframe[src*="challenge"]:visible')
      .count()
  )
    return "challenge" as const
  const captcha = await findCaptchaSurface(page)
  if (
    captcha?.kind === "grid" ||
    (includeCheckbox && captcha?.kind === "checkbox")
  )
    return "challenge" as const
  for (const frame of page.frames()) {
    try {
      if (!frame.parentFrame() || !(await visibleCaptchaFrame(frame))) continue
      if (
        await frame
          .locator(
            'iframe[src*="bframe"]:visible,iframe[src*="challenge"]:visible'
          )
          .count()
      )
        return "challenge" as const
    } catch (error) {
      // Aggregators remove ad/embedded frames while this snapshot is inspected.
      // Skip only frames confirmed detached; preserve actual inspection errors.
      if (frame.isDetached()) continue
      throw error
    }
  }
  if (await page.locator('input[type="password"]:visible').count())
    return "sign_in" as const
  return null
}
