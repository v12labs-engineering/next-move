import type { BrowserContext, Page } from "playwright-core"
import { ApplicationCaptchaError } from "@/lib/applications/pipeline"
import { employerAccessGate, findCaptchaSurface } from "./captcha-detection"
import { tryTwoCaptchaGrid } from "./two-captcha"
type SolverResult = {
  solved: boolean
  challengeVisible?: boolean
  instruction: string
}
type Solver = (
  page: Page,
  deadline: number,
  context?: { applicationId: string; revision: number }
) => Promise<SolverResult>
const solvers = new WeakMap<BrowserContext, Solver>()
export function bindCaptchaSolver(context: BrowserContext, solver: Solver) {
  solvers.set(context, solver)
  return () => {
    solvers.delete(context)
  }
}
export async function solveCaptcha(
  page: Page,
  deadline: number,
  context?: { applicationId: string; revision: number }
) {
  const remote = solvers.get(page.context())
  if (remote) return remote(page, deadline, context)
  const began = Date.now()
  let phase = "detection"
  const report = (outcome: string) =>
    console.info("Application CAPTCHA handoff", {
      ...context,
      phase,
      outcome,
      elapsedMs: Date.now() - began,
    })
  try {
    const ready = async () =>
      (await employerAccessGate(page, true)) !== "challenge"
    const surface = await findCaptchaSurface(page)
    report(surface?.kind ?? "no_recaptcha_surface")
    if (surface?.kind === "checkbox") {
      phase = "activate_checkbox"
      report("started")
      await surface.frame
        .locator('#recaptcha-anchor[role="checkbox"]')
        .click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())) })
      const until = Math.min(deadline, Date.now() + 5000)
      while (Date.now() < until) {
        const current = await findCaptchaSurface(page)
        if (current?.kind === "grid") break
        if (await ready()) {
          report("cleared")
          return {
            solved: true,
            instruction:
              "CAPTCHA cleared. Continue the same application and verify its receipt.",
          }
        }
        await page.waitForTimeout(Math.min(250, until - Date.now()))
      }
    }
    phase = "detection"
    if (await ready()) {
      report("no_active_challenge")
      return {
        solved: false,
        challengeVisible: false,
        instruction:
          "There is no active CAPTCHA challenge. A passive reCAPTCHA badge is not a challenge. Do not call solve_captcha again unless an interactive challenge appears. Continue the application; if the form is complete, call begin_submission and submit, then inspect for a receipt or a new challenge.",
      }
    }
    phase = "solver"
    report("started")
    const solved = await tryTwoCaptchaGrid(page, ready, deadline)
    report(solved ? "cleared" : "not_cleared")
    if (!solved) throw new ApplicationCaptchaError()
    return {
      solved: true,
      instruction:
        "Inspect the page and continue the same application. Do not start another application.",
    }
  } catch (error) {
    report(
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "failed"
    )
    throw error
  }
}
