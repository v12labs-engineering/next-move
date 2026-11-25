import { createHash } from "node:crypto"
import { type Page, type Frame } from "playwright-core"
import {
  applicationTarget,
  type ApplicationField,
  type ApplicationPacket,
} from "@/lib/applications"
import { publicRequestGuard, guardApplicationRequests } from "./network"
import { resumePdf } from "@/lib/server/resume/pdf"
import { withBrowserSession } from "./browser-session"
import type { BoatBatchAccount } from "./boat-batch"
import { applicationFailure } from "@/lib/applications/pipeline"
import { trackBrowserbaseCaptcha } from "./captcha"
import { employerAccessGate } from "./captcha-detection"
export { employerAccessGate } from "./captcha-detection"
export type ApplicationSurface = Page | Frame

export function applicationPauseReason(error: unknown) {
  // The run banner and task panel must describe the same safe failure. A second
  // classifier hid employer restrictions and mistook execution time for quota.
  return `${applicationFailure(error).message} Nothing has been submitted.`
}

export function permittedTarget(url: string) {
  if (applicationTarget(url)) return true
  if (process.env.APP_ENV !== "staging" || !process.env.APPLICATION_TEST_ORIGIN)
    return false
  const u = new URL(url)
  return (
    u.origin === process.env.APPLICATION_TEST_ORIGIN &&
    /^\/application-test\/[a-f0-9-]{36}$/.test(u.pathname) &&
    !u.search &&
    !u.hash
  )
}
export function formHash(fields: ApplicationField[], notices: string) {
  return createHash("sha256")
    .update(JSON.stringify({ fields, notices }))
    .digest("hex")
}
// Recruiters download many attachments; a generic "resume.pdf" loses the
// candidate. Use the resume's own heading only when it reads as a name.
export function documentFileName(content: string, kind = "Resume") {
  const heading = content.trim().split("\n")[0]?.trim() || ""
  const name = /^\p{L}[\p{L}'.-]*(?: \p{L}[\p{L}'.-]*){1,3}$/u.test(heading)
    ? heading.slice(0, 60)
    : ""
  return `${[...name.split(" ").filter(Boolean), kind].join("_").replace(/[^\p{L}\p{N}_.-]/gu, "")}.pdf`
}
export async function resumeFile(content: string) {
  return {
    name: documentFileName(content),
    mimeType: "application/pdf",
    buffer: Buffer.from(await resumePdf(content)),
  }
}
export async function coverLetterFile(letter: string, resume: string) {
  return {
    name: documentFileName(resume, "Cover_Letter"),
    mimeType: "application/pdf",
    buffer: Buffer.from(await resumePdf(letter, "Cover Letter")),
  }
}
export type EmployerHandoff = (page: Page, sessionId: string) => Promise<void>
export async function withEmployerBrowser<T>(
  url: string,
  run: (
    page: Page,
    sessionId: string,
    release: () => Promise<void>
  ) => Promise<T>,
  handoff?: EmployerHandoff,
  account?: BoatBatchAccount
) {
  if (!permittedTarget(url)) throw new Error("Unsupported destination")
  const guard = publicRequestGuard()
  const syntheticOrigin =
    process.env.APP_ENV === "staging"
      ? process.env.APPLICATION_TEST_ORIGIN
      : undefined
  const checkRequest = async (target: string) => {
    if (syntheticOrigin && new URL(target).origin === syntheticOrigin) return
    await guard(target)
  }
  await checkRequest(url)
  return await withBrowserSession(
    async (browser, sessionId, release) => {
      const context = browser.contexts()[0]
      const page = context.pages()[0] || (await context.newPage())
      await guardApplicationRequests(context, page, checkRequest)
      page.setDefaultTimeout(12000)
      const stopCaptchaTracking = trackBrowserbaseCaptcha(page)
      try {
        await page.goto(applicationTarget(url) || url, {
          waitUntil: "domcontentloaded",
          timeout: 40000,
        })
        await page
          .locator('a[href],button,input:not([type="hidden"]),iframe')
          .first()
          .waitFor({ state: "attached", timeout: 25000 })
        const gate = await employerAccessGate(page)
        if (gate) {
          console.info("Application employer access gate", {
            gate,
            phase: "open",
          })
          if (!handoff) throw new Error("Human verification required")
          await handoff(page, sessionId)
        }
        return await run(page, sessionId, release)
      } finally {
        stopCaptchaTracking()
      }
    },
    { account }
  )
}
export async function finalSubmitControl(page: ApplicationSurface) {
  let control = page.getByRole("button", {
    name: /^(?:Submit(?: (?:my )?application)?|Send (?:my )?application|Apply(?: now)?|Bewerbung absenden|Postuler|Enviar candidatura)$/i,
  })
  if ((await control.count()) === 0)
    control = page.locator(
      'form button[type="submit"]:visible,form input[type="submit"]:visible,[role="form"] button[type="submit"]:visible'
    )
  if ((await control.count()) !== 1)
    throw new Error("Final submit action is ambiguous")
  return control
}
export async function submitAndConfirm(
  page: ApplicationSurface,
  packet?: ApplicationPacket
) {
  await (await finalSubmitControl(page)).click({ timeout: 12000 })
  const confirmation = page
    .getByText(
      /(?:Thank(?: you|s) for (?:applying|your application)|Your application (?:has been|was) (?:successfully )?(?:submitted|received)|Application (?:submitted|received)|Bewerbung.*(?:eingegangen|erfolgreich)|candidature.*(?:reçue|envoyée))/i
    )
    .first()
  await confirmation.waitFor({ state: "visible", timeout: 25000 })
  // A form still present with field validation isn't a submission receipt.
  if (packet) {
    for (const field of packet.fields) {
      const selector =
        field.selector ||
        `[id=${JSON.stringify(field.step ? field.id.slice(field.id.indexOf(":") + 1) : field.id)}]`
      if (
        await page
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false)
      )
        throw new Error("Confirmation is ambiguous")
    }
  } else if (
    await page
      .locator(
        'form input:not([type="hidden"]):visible,form textarea:visible,form select:visible'
      )
      .count()
  )
    throw new Error("Confirmation is ambiguous")
  return {
    text: (await confirmation.innerText()).slice(0, 2000),
    url: page.url(),
    confirmedAt: new Date().toISOString(),
  }
}
