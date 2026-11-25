import { createHash } from "node:crypto"
import type { Frame, Page } from "playwright-core"
import { waitForBrowserbaseCaptchaIdle } from "./captcha"

export type VerificationTarget = {
  selector: string
  kind: "code" | "click"
  label: string
  tile: boolean
}
export type VerificationView = {
  mode: "code" | "challenge" | "unsupported"
  frame: Frame
  url: string
  fingerprint: string
  allowApplicationContinuation?: boolean
  targets: VerificationTarget[]
  image: Buffer
  message: string
}
const challengeHost = (url: string) => {
  try {
    const u = new URL(url)
    return (
      ((u.hostname === "www.google.com" ||
        u.hostname === "www.recaptcha.net" ||
        u.hostname === "recaptcha.net") &&
        u.pathname.includes("/recaptcha/")) ||
      u.hostname.endsWith(".hcaptcha.com") ||
      u.hostname === "hcaptcha.com" ||
      u.hostname === "challenges.cloudflare.com"
    )
  } catch {
    return false
  }
}
// No model observes or solves the challenge. These are controls for the owner
// to choose from, bound to a particular rendered verification surface.
export async function readVerificationView(
  page: Page,
  allowApplicationContinuation = false,
  captureImage = true
): Promise<VerificationView> {
  const candidates: { frame: Frame; area: number; challenge: boolean }[] = []
  for (const frame of page.frames()) {
    try {
      let area = 0
      let visible = true
      for (
        let current = frame;
        current.parentFrame();
        current = current.parentFrame()!
      ) {
        const element = await current.frameElement()
        try {
          if (!(await element.isVisible())) {
            visible = false
            break
          }
        } finally {
          await element.dispose()
        }
      }
      if (!visible) continue
      if (frame.parentFrame()) {
        const element = await frame.frameElement()
        if (!(await element.isVisible())) continue
        const box = await element.boundingBox()
        if (!box) continue
        area = box.width * box.height
      }
      candidates.push({ frame, area, challenge: challengeHost(frame.url()) })
    } catch {
      /* A detached frame grants no actions. */
    }
  }
  candidates.sort(
    (a, b) => Number(b.challenge) - Number(a.challenge) || b.area - a.area
  )
  for (const { frame, challenge } of candidates) {
    let surface
    try {
      surface = await frame.evaluate(
        ({ challenge, allowApplicationContinuation }) => {
          // Object methods serialize without server-side transpiler helpers.
          const { visible, path, label } = {
            visible(el: Element) {
              return (
                !!el.getClientRects().length &&
                getComputedStyle(el).visibility !== "hidden" &&
                getComputedStyle(el).display !== "none"
              )
            },
            path(el: Element) {
              const parts: string[] = []
              for (let n: Element | null = el; n; n = n.parentElement) {
                const siblings = Array.from(
                  n.parentElement?.children || []
                ).filter((c) => c.tagName === n!.tagName)
                parts.unshift(
                  `${n.tagName.toLowerCase()}:nth-of-type(${Math.max(0, siblings.indexOf(n)) + 1})`
                )
              }
              return parts.join(" > ")
            },
            label(el: Element) {
              return (
                el.getAttribute("aria-label") ||
                el.textContent ||
                "Inside verification"
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 100)
            },
          }
          if (challenge) {
            const tiles: Element[] = Array.from(document.querySelectorAll("td"))
              .filter(visible)
              .filter((el) =>
                el.querySelector("img,canvas,[style*='background']")
              )
              .sort(
                (a, b) =>
                  a.getBoundingClientRect().top -
                    b.getBoundingClientRect().top ||
                  a.getBoundingClientRect().left -
                    b.getBoundingClientRect().left
              )
            const clicks = Array.from(
              document.querySelectorAll(
                'button,[role="button"],input[type="checkbox"],[role="checkbox"]'
              )
            )
              .filter(visible)
              .filter((el) => !tiles.some((tile) => tile.contains(el)))
            const controls = [...tiles, ...clicks].filter(
              (el) => !(el as HTMLInputElement).disabled
            )
            if (!controls.length || controls.length > 30) return null
            const descriptors = controls.map((el, i) => ({
              selector: path(el),
              kind: "click" as const,
              label: tiles.includes(el) ? `Tile ${i + 1}` : label(el),
              tile: tiles.includes(el),
            }))
            // Visible tile imagery and selection markers bind a human click to the
            // screenshot. No pixel classification or answer inference takes place.
            return {
              mode: "challenge" as const,
              targets: descriptors,
              signature: controls.map((el) => el.outerHTML).join("\n"),
              message: tiles.length
                ? "Choose tiles left to right, top to bottom. Tap one control, then wait for the updated picture. Use the employer's instructions shown in the image."
                : "Choose the verification control shown in the image. Wait for an updated picture after each tap.",
            }
          }
          const inputs = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              'input:not([type="password"]):not([type="hidden"]):not([type="email"]):not([type="file"])'
            )
          )
            .filter(visible)
            .filter((el) => {
              const text = [
                el.name,
                el.id,
                el.placeholder,
                el.getAttribute("aria-label"),
                ...Array.from(el.labels || []).map((l) => l.textContent),
              ].join(" ")
              return (
                el.autocomplete === "one-time-code" ||
                el.maxLength === 1 ||
                /(?:verification|security|otp)[_-](?:input|digit|character)[_-]\d+/i.test(
                  text
                ) ||
                /(?:verification|security|one[ -]?time|confirmation)[ _-]*code|\botp\b/i.test(
                  text
                )
              )
            })
          const segmented =
            inputs.length >= 4 &&
            inputs.length <= 12 &&
            inputs.every(
              (el) =>
                el.maxLength === 1 ||
                /(?:verification|security|otp)[_-](?:input|digit|character)[_-]\d+/i.test(
                  el.id
                )
            )
          if (inputs.length !== 1 && !segmented) return null
          const input = inputs[0]
          if (
            !segmented &&
            input.autocomplete !== "one-time-code" &&
            !/(?:verification|security|one[ -]?time|confirmation)[ _-]*code|\botp\b/i.test(
              [
                input.name,
                input.id,
                input.placeholder,
                input.getAttribute("aria-label"),
                ...Array.from(input.labels || []).map((el) => el.textContent),
              ].join(" ")
            )
          )
            return null
          let form =
            input.closest('form,[role="dialog"]') || input.parentElement
          if (segmented) {
            form = null
            // Find the isolated code widget, not the surrounding application.
            for (
              let parent = input.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              const editable = Array.from(
                parent.querySelectorAll<HTMLInputElement>(
                  "input,textarea,select"
                )
              ).filter(
                (el) =>
                  visible(el) &&
                  !el.disabled &&
                  !el.readOnly &&
                  el.type !== "hidden"
              )
              if (editable.some((el) => !inputs.includes(el))) break
              if (!inputs.every((el) => parent.contains(el))) continue
              const text = parent.textContent || ""
              const codeContext =
                /(?:verification|security|one[ -]?time|confirmation) code|\botp\b/i.test(
                  text
                )
              const controls = Array.from(
                parent.querySelectorAll("button,input[type=submit]")
              ).filter(visible)
              const continuesApplication =
                /verification code was sent|enter.{0,80}code.{0,80}(?:confirm|verif).{0,30}human/i.test(
                  text
                )
              if (
                codeContext &&
                (controls.some(
                  (el) =>
                    /^(?:verify(?: (?:code|email|e-mail))?|confirm(?: (?:code|email|e-mail))?|continue)$/i.test(
                      label(el)
                    ) ||
                    (continuesApplication &&
                      /^submit application$/i.test(label(el)))
                ) ||
                  (!controls.length &&
                    parent.matches('form,fieldset,[role="dialog"]')))
              ) {
                form = parent
                break
              }
            }
          }
          if (!form) return null
          if (
            Array.from(
              form.querySelectorAll<
                HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
              >("input,textarea,select")
            ).some(
              (el) =>
                visible(el) &&
                !inputs.some((input) => input === el) &&
                !el.disabled &&
                !("readOnly" in el && el.readOnly) &&
                !("type" in el && el.type === "hidden")
            )
          )
            return null
          const codeContinuation =
            segmented &&
            /verification code was sent|enter.{0,80}code.{0,80}(?:confirm|verif).{0,30}human/i.test(
              form.textContent || ""
            )
          const verify = Array.from(
            form.querySelectorAll<HTMLButtonElement>(
              'button,input[type="submit"]'
            )
          )
            .filter(visible)
            .filter(
              (el) =>
                /^(?:verify(?: (?:code|email|e-mail))?|confirm(?: (?:code|email|e-mail))?|continue)$/i.test(
                  label(el)
                ) ||
                (codeContinuation &&
                  allowApplicationContinuation &&
                  /^submit application$/i.test(label(el)))
            )
          let continuationForm: HTMLFormElement | null = null
          if (
            codeContinuation &&
            !verify.length &&
            allowApplicationContinuation
          ) {
            continuationForm = input.form
            if (
              continuationForm &&
              !continuationForm.querySelector('input[type="password"]')
            ) {
              const submit = Array.from(
                continuationForm.querySelectorAll<HTMLButtonElement>(
                  'button[type="submit"],input[type="submit"]'
                )
              )
                .filter(visible)
                .filter((el) => /^submit application$/i.test(label(el)))
              if (submit.length !== 1) return null
              verify.push(submit[0])
            }
          }
          if (verify.length > 1) return null
          const targets = [
            ...inputs.map((input) => ({
              selector: path(input),
              kind: "code" as const,
              label: "Verification code",
              tile: false,
            })),
            ...verify.map((el) => ({
              selector: path(el),
              kind: "click" as const,
              label: label(el),
              tile: false,
            })),
          ]
          return {
            mode: "code" as const,
            targets,
            signature: JSON.stringify({
              targets,
              codeContinuation,
              applicationValues: continuationForm
                ? Array.from(
                    continuationForm.querySelectorAll<
                      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
                    >("input,textarea,select")
                  )
                    .filter(
                      (el) =>
                        !inputs.includes(el as HTMLInputElement) &&
                        el.type !== "hidden"
                    )
                    .map((el) => ({ id: el.id, value: el.value }))
                : null,
              action: form instanceof HTMLFormElement ? form.action : null,
              method: form instanceof HTMLFormElement ? form.method : null,
            }),
            message:
              "Reply to the next message with the verification code supplied by the employer. Never send a password. Your reply is used only for this active verification step.",
          }
        },
        { challenge, allowApplicationContinuation }
      )
    } catch {
      continue
    }
    if (!surface) continue
    // Metadata checks never capture screenshots, including CAPTCHA surfaces.
    // Settle challenge transitions so a selected-tile animation does not look
    // like replacement imagery. The DOM and captured pixels still bind clicks.
    const image = !captureImage
      ? Buffer.alloc(0)
      : frame.parentFrame()
        ? await (
            await frame.frameElement()
          ).screenshot({
            type: "png",
            animations: surface.mode === "challenge" ? "disabled" : "allow",
            timeout: 5000,
            mask: [frame.locator("input,textarea")],
          })
        : await page.screenshot({
            type: "png",
            animations: surface.mode === "challenge" ? "disabled" : "allow",
            timeout: 5000,
            mask: page.frames().map((f) => f.locator("input,textarea")),
          })
    return {
      ...surface,
      allowApplicationContinuation,
      frame,
      url: frame.url(),
      fingerprint: createHash("sha256")
        .update(frame.url() + surface.signature)
        .update(surface.mode === "challenge" ? image : "")
        .digest("hex"),
      image,
    }
  }
  return {
    mode: "unsupported",
    frame: page.mainFrame(),
    url: page.url(),
    targets: [],
    fingerprint: "",
    image: !captureImage
      ? Buffer.alloc(0)
      : await page.screenshot({
          type: "png",
          timeout: 5000,
          mask: page.frames().map((f) => f.locator("input,textarea")),
        }),
    message:
      "I have not verified an employer receipt, and no supported code or challenge controls are visible. This page cannot be completed through chat. I will not restart or resend the application.",
  }
}
export async function applyVerificationResponse(
  page: Page,
  view: VerificationView,
  input: { action: "click" | "code"; target?: number; value?: string },
  until = Infinity
) {
  const active = () => {
    if (Date.now() >= until) throw new Error("Verification window expired")
  }
  active()
  await waitForBrowserbaseCaptchaIdle(page, until)
  const fresh = await readVerificationView(
    page,
    view.allowApplicationContinuation,
    view.mode === "challenge"
  )
  if (
    fresh.frame !== view.frame ||
    fresh.url !== view.url ||
    fresh.mode !== view.mode ||
    fresh.fingerprint !== view.fingerprint
  )
    throw new Error("Verification view changed")
  if (input.action === "code") {
    if (view.mode !== "code" || !/^[a-z0-9]{4,12}$/i.test(input.value || ""))
      throw new Error("Invalid verification response")
    const codes = view.targets.filter((t) => t.kind === "code")
    if (codes.length > 1 && input.value!.length !== codes.length)
      throw new Error("Invalid verification response")
    for (const [index, code] of codes.entries()) {
      active()
      await waitForBrowserbaseCaptchaIdle(page, until)
      // Each segment can trigger a rerender or automatic verification.
      // Never type the remaining characters into replacement form controls.
      const current = await readVerificationView(
        page,
        view.allowApplicationContinuation,
        false
      )
      if (
        current.mode !== view.mode ||
        current.frame !== view.frame ||
        current.url !== view.url ||
        current.fingerprint !== view.fingerprint
      )
        throw new Error("Verification view changed")
      await view.frame
        .locator(code.selector)
        .fill(codes.length === 1 ? input.value! : input.value![index], {
          timeout: 5000,
        })
    }
    const verify = view.targets.find((t) => t.kind === "click")
    if (verify) {
      // Filling can auto-verify and replace the page. A replacement application
      // submit control must never inherit the earlier Verify button's selector.
      const after = await readVerificationView(
        page,
        view.allowApplicationContinuation,
        false
      )
      if (
        after.mode !== "code" ||
        after.frame !== view.frame ||
        after.url !== view.url
      )
        return
      if (after.fingerprint !== view.fingerprint)
        throw new Error("Verification view changed")
      active()
      await waitForBrowserbaseCaptchaIdle(page, until)
      await view.frame.locator(verify.selector).click({ timeout: 5000 })
    }
  } else {
    if (view.mode !== "challenge" || !Number.isInteger(input.target))
      throw new Error("Invalid verification response")
    const target = view.targets[input.target!]
    if (!target || target.kind !== "click")
      throw new Error("Invalid verification response")
    active()
    await waitForBrowserbaseCaptchaIdle(page, until)
    await view.frame.locator(target.selector).click({ timeout: 5000 })
  }
}
