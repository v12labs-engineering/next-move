import type { Page } from "playwright-core"
import { visibleCaptchaFrame } from "./captcha-detection"

const heading =
  /^(?:(?:candidate |account )?(?:sign[ -]?in|log[ -]?in)(?: (?:to|with) .+)?|create (?:an? |your )?(?:account|ibmid)|(?:sign[ -]?in|log[ -]?in) or (?:create (?:an? )?account|sign[ -]?up)|sign[ -]?up)$/i
const guest =
  /\b(?:apply|continue|proceed) as (?:a )?guest\b|\b(?:apply|continue|proceed) without (?:an? account|(?:signing|logging) in)\b/i

// This reads the rendered employer surface and never enters account details.
// Email collection alone is also used by guest-first application flows.
export async function hasEmployerAccountGate(page: Page) {
  let accountGate = false
  for (const frame of page.frames()) {
    try {
      if (!(await visibleCaptchaFrame(frame))) continue
      const visible = { visible: true } as const
      if (
        (await frame
          .getByRole("button", { name: guest })
          .filter(visible)
          .count()) ||
        (await frame
          .getByRole("link", { name: guest })
          .filter(visible)
          .count()) ||
        (await frame.locator('input[type="file"]:visible').count())
      )
        return false
      if (
        (await frame
          .getByRole("heading", { name: heading })
          .filter(visible)
          .count()) &&
        (await frame
          .locator(
            'input[type="password"]:visible,input[type="email"]:visible,input[autocomplete="email"]:visible,input[autocomplete="username"]:visible'
          )
          .count())
      )
        accountGate = true
    } catch (error) {
      if (!frame.isDetached()) throw error
    }
  }
  return accountGate
}
