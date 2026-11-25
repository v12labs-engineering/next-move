import { existsSync } from "node:fs"
import { chromium } from "playwright-core"
import {
  browserRequestGuard,
  publicRequestGuard,
} from "@/lib/server/applications/network"
import {
  employerAccessGate,
  findCaptchaSurface,
} from "@/lib/server/applications/captcha-detection"
import { tryTwoCaptchaGrid } from "@/lib/server/applications/two-captcha"
import { asPublicUrl } from "./registry-job-postings.mjs"
import { JobPageError, type RenderJobs } from "./registry-job-scraper.mjs"

export async function openRegistryJobBrowser() {
  const executable =
    process.env.REGISTRY_CHROME_PATH ||
    (existsSync(chromium.executablePath())
      ? chromium.executablePath()
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  const browser = await chromium.launch({
    headless: true,
    executablePath: executable,
    chromiumSandbox: true,
  })
  const guard = publicRequestGuard()
  const solverConfigured = Boolean(process.env.TWOCAPTCHA_API_KEY?.trim())
  const renderPage: RenderJobs = async (url, permitted, beforeNavigate) => {
    await beforeNavigate(url)
    const context = await browser.newContext({
      serviceWorkers: "block",
      locale: "en-IN",
    })
    const timeout = setTimeout(
      () => {
        void context
          .close({ reason: "Job listing render timed out" })
          .catch(() => {})
      },
      solverConfigured ? 125_000 : 35_000
    )
    try {
      await context.route("**/*", async (route) => {
        const request = route.request()
        const target = asPublicUrl(request.url())
        const type = request.resourceType()
        if (
          !target ||
          ["media", "font"].includes(type) ||
          (!solverConfigured && type === "image")
        ) {
          await route.abort()
          return
        }
        const challengeHost =
          /(?:^|\.)(?:recaptcha\.net|gstatic\.com|challenges\.cloudflare\.com)$/.test(
            target.hostname
          ) ||
          (target.hostname === "www.google.com" &&
            target.pathname.startsWith("/recaptcha/"))
        if (
          request.isNavigationRequest() &&
          !permitted(target) &&
          !challengeHost
        ) {
          await route.abort()
          return
        }
        if (
          !["GET", "HEAD"].includes(request.method()) &&
          !(
            permitted(target) &&
            /\/wday\/cxs\/[^/]+\/[^/]+\/jobs$/.test(target.pathname)
          ) &&
          !(solverConfigured && challengeHost)
        ) {
          await route.abort()
          return
        }
        await route.continue()
      })
      const page = await context.newPage()
      const attach = await browserRequestGuard(context, page, guard)
      page.on("frameattached", (frame) => {
        void attach(frame).catch(() => {})
      })
      const response = await page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: 12_000,
      })
      const final = asPublicUrl(page.url())
      if (!final || !permitted(final))
        throw new JobPageError(
          "unavailable",
          "Browser redirected outside employer evidence"
        )
      await beforeNavigate(final)
      if ([401, 404, 410].includes(response?.status() ?? 0)) {
        const status = response!.status()
        throw new JobPageError(
          status === 401 ? "auth_required" : "unavailable",
          "HTTP " + status
        )
      }
      if (response?.status() === 429)
        throw new JobPageError("retry_due", "HTTP 429")
      await page
        .locator(
          "main a[href*='/job'],[data-job-id],.job-card,[itemtype$='JobPosting'],script[type='application/ld+json']"
        )
        .first()
        .waitFor({ state: "attached", timeout: 2400 })
        .catch(() => {})
      const access = await employerAccessGate(page, true)
      if (access === "sign_in")
        throw new JobPageError("auth_required", "Visible sign-in form")
      const challenge =
        access === "challenge" ||
        response?.headers()["cf-mitigated"] === "challenge" ||
        /^(?:just a moment|attention required|request rejected)\b/i.test(
          await page.title()
        )
      if (challenge) {
        if (!solverConfigured)
          throw new JobPageError("captcha", "2Captcha key is unavailable")
        const surface = await findCaptchaSurface(page)
        if (surface?.kind === "checkbox")
          await surface.frame
            .locator('#recaptcha-anchor[role="checkbox"]')
            .click({ timeout: 3000 })
            .catch(() => {})
        const solved = await tryTwoCaptchaGrid(
          page,
          async () => {
            const active = await employerAccessGate(page)
            return (
              !active &&
              !/^(?:just a moment|attention required|request rejected)\b/i.test(
                await page.title()
              )
            )
          },
          Date.now() + 90_000
        )
        if (!solved)
          throw new JobPageError("captcha", "Public challenge did not clear")
      }
      if (response?.status() === 403 && !challenge)
        throw new JobPageError("restricted", "HTTP 403")
      const pages: Awaited<ReturnType<RenderJobs>> = []
      const more = page
        .getByRole("button", {
          name: /^(?:load|show) more (?:jobs|positions|openings|vacancies)$/i,
        })
        .first()
      for (let step = 0; step <= 3; step++) {
        const current = asPublicUrl(page.url())
        if (!current || !permitted(current)) break
        const html = await page.content()
        if (html.length > 5_000_000)
          throw new JobPageError("partial", "Rendered page exceeded HTML limit")
        const canContinue = await more.isVisible().catch(() => false)
        pages.push({
          url: current,
          html,
          incomplete: step === 3 && canContinue,
        })
        if (!canContinue || step === 3) break
        try {
          await more.click({ timeout: 1600 })
          await page
            .waitForLoadState("domcontentloaded", { timeout: 1800 })
            .catch(() => {})
          await page.waitForTimeout(650)
        } catch {
          pages[pages.length - 1].incomplete = true
          break
        }
      }
      for (const frame of page.frames().slice(1, 6)) {
        const target = asPublicUrl(frame.url())
        if (!target || !permitted(target)) continue
        try {
          await beforeNavigate(target)
          const html = await frame.content()
          if (html.length <= 2_500_000) pages.push({ url: target, html })
        } catch {}
      }
      return pages
    } finally {
      clearTimeout(timeout)
      await context.close().catch(() => {})
    }
  }
  const render: RenderJobs = async (...args) => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        renderPage(...args),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => {
              reject(
                new JobPageError(
                  "unavailable",
                  "Playwright listing render timed out"
                )
              )
            },
            solverConfigured ? 130_000 : 40_000
          )
        }),
      ])
    } finally {
      clearTimeout(deadline)
    }
  }
  return { render, close: () => browser.close() }
}
